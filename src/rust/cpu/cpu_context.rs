// Per-CPU context save/restore for cooperative SMP
//
// All architectural CPU state lives at fixed WASM linear memory addresses
// defined in global_pointers.rs (offsets 64–1231).  In SMP mode, before
// running an AP's instruction slice we must swap the live register state in
// those fixed locations for that AP's saved state, and swap back afterwards.
//
// Strategy: one raw-byte memcpy of the entire 64–1231 range per switch.
// The range contains no stored pointers (global_pointers.rs casts raw integer
// constants to pointers at use-time), so a verbatim copy is safe.
//
// Additionally, the TSC interpolation statics in cpu.rs are per-CPU but live
// outside the 64–1231 range; they get their own snapshot struct.

use crate::cpu::cpu::{
    full_clear_tlb, update_state_flags,
    tsc_last_value, tsc_resolution, tsc_speed, tsc_offset, tsc_number_of_same_readings,
};

/// Byte offset in WASM linear memory where per-CPU state begins.
pub const CPU_STATE_START: usize = 64;
/// One past the last byte of per-CPU state (fpu_st[7] ends at 1152 + 8*10 = 1232).
pub const CPU_STATE_END: usize = 1232;
/// Number of bytes covered by one context snapshot.
pub const CPU_CONTEXT_SIZE: usize = CPU_STATE_END - CPU_STATE_START; // 1168

pub const MAX_CPUS: usize = 8;

/// Raw snapshot of WASM linear-memory bytes 64–1231.
#[repr(C, align(16))]
pub struct CpuMemContext {
    pub data: [u8; CPU_CONTEXT_SIZE],
}

impl CpuMemContext {
    const fn zeroed() -> Self {
        CpuMemContext { data: [0u8; CPU_CONTEXT_SIZE] }
    }
}

/// Snapshot of the TSC interpolation statics that live in Rust static storage
/// (not in the 64–1231 WASM memory range).
#[derive(Copy, Clone)]
pub struct TscContext {
    pub last_value: u64,
    pub resolution: u64,
    pub speed: u64,
    pub offset: u64,
    pub same_readings: u64,
}

impl TscContext {
    const fn zeroed() -> Self {
        TscContext {
            last_value: 0,
            resolution: u64::MAX,
            speed: 1,
            offset: 0,
            same_readings: 0,
        }
    }
}

/// Combined per-CPU context.
pub struct CpuContext {
    pub mem: CpuMemContext,
    pub tsc: TscContext,
    /// Whether this context has been initialised (i.e. non-zero data exists).
    pub valid: bool,
}

impl CpuContext {
    const fn zeroed() -> Self {
        CpuContext { mem: CpuMemContext::zeroed(), tsc: TscContext::zeroed(), valid: false }
    }
}

// We need MAX_CPUS separate CpuContext values; can't derive Copy/Clone because
// [u8; 1168] doesn't auto-implement them in older editions, so use a manual
// const-init array.
static mut CPU_CONTEXTS: [CpuContext; MAX_CPUS] = [
    CpuContext::zeroed(), CpuContext::zeroed(), CpuContext::zeroed(), CpuContext::zeroed(),
    CpuContext::zeroed(), CpuContext::zeroed(), CpuContext::zeroed(), CpuContext::zeroed(),
];

// ── Save ──────────────────────────────────────────────────────────────────────

/// Copy the live CPU state (WASM memory bytes 64–1231) and TSC statics into
/// the per-CPU context slot for `cpu_id`.
pub unsafe fn save_cpu_context(cpu_id: usize) {
    debug_assert!(cpu_id < MAX_CPUS, "save_cpu_context: cpu_id {} out of range", cpu_id);
    let ctx = &mut CPU_CONTEXTS[cpu_id];

    // Snapshot WASM linear memory range.
    let src = CPU_STATE_START as *const u8;
    let dst = ctx.mem.data.as_mut_ptr();
    core::ptr::copy_nonoverlapping(src, dst, CPU_CONTEXT_SIZE);

    // Snapshot TSC statics.
    ctx.tsc = TscContext {
        last_value:    tsc_last_value,
        resolution:    tsc_resolution,
        speed:         tsc_speed,
        offset:        tsc_offset,
        same_readings: tsc_number_of_same_readings,
    };

    ctx.valid = true;
}

// ── Restore ───────────────────────────────────────────────────────────────────

/// Restore a previously saved CPU context for `cpu_id` into the live fixed
/// register slots.  Flushes the TLB and refreshes cached state flags
/// afterwards, as required by cpu.rs conventions.
///
/// Calling this when `ctx.valid == false` (e.g. an AP that was never started)
/// is a no-op, which keeps the current live state untouched.
pub unsafe fn restore_cpu_context(cpu_id: usize) {
    debug_assert!(cpu_id < MAX_CPUS, "restore_cpu_context: cpu_id {} out of range", cpu_id);
    let ctx = &CPU_CONTEXTS[cpu_id];
    if !ctx.valid {
        return;
    }

    // Restore WASM linear memory range.
    let src = ctx.mem.data.as_ptr();
    let dst = CPU_STATE_START as *mut u8;
    core::ptr::copy_nonoverlapping(src, dst, CPU_CONTEXT_SIZE);

    // Restore TSC statics.
    tsc_last_value                = ctx.tsc.last_value;
    tsc_resolution                = ctx.tsc.resolution;
    tsc_speed                     = ctx.tsc.speed;
    tsc_offset                    = ctx.tsc.offset;
    tsc_number_of_same_readings   = ctx.tsc.same_readings;

    // The TLB is not saved (it's a 4 MB array).  Flush it so the restored
    // CR3/segment state takes effect cleanly.  JIT-compiled blocks remain valid
    // in the wasm_table; they will be re-entered via normal tlb_miss paths.
    full_clear_tlb();

    // Re-derive CachedStateFlags from the restored segment/mode fields.
    update_state_flags();
}

// ── AP initialisation ─────────────────────────────────────────────────────────

/// Write a minimal real-mode initial state for an Application Processor into
/// its context slot.  Called once per AP when a SIPI vector is received.
///
/// `start_eip` is the logical EIP (typically `sipi_vector << 12`).
/// `cs_selector` is the CS selector value (typically `sipi_vector`).
pub unsafe fn initialize_ap_context(cpu_id: usize, start_eip: u32, cs_selector: u16) {
    debug_assert!(cpu_id > 0 && cpu_id < MAX_CPUS,
        "initialize_ap_context: cpu_id {} is invalid (0 = BSP)", cpu_id);

    let ctx = &mut CPU_CONTEXTS[cpu_id];
    // Zero all state — gives a clean slate (all regs = 0, flags = 0, etc.).
    ctx.mem.data.fill(0);

    // Helper: write a u32 into the context data at (wasm_offset - CPU_STATE_START).
    macro_rules! write_u32 {
        ($wasm_off:expr, $val:expr) => {{
            let off: usize = $wasm_off - CPU_STATE_START;
            let bytes: [u8; 4] = ($val as u32).to_le_bytes();
            ctx.mem.data[off..off + 4].copy_from_slice(&bytes);
        }};
    }
    macro_rules! write_u16 {
        ($wasm_off:expr, $val:expr) => {{
            let off: usize = $wasm_off - CPU_STATE_START;
            let bytes: [u8; 2] = ($val as u16).to_le_bytes();
            ctx.mem.data[off..off + 2].copy_from_slice(&bytes);
        }};
    }
    macro_rules! write_u8 {
        ($wasm_off:expr, $val:expr) => {
            ctx.mem.data[$wasm_off - CPU_STATE_START] = $val as u8;
        };
    }

    // ── instruction_pointer (offset 556) ──────────────────────────────────
    write_u32!(556, start_eip);

    // ── EFLAGS (offset 120): FLAGS_DEFAULT = 0x2 ──────────────────────────
    write_u32!(120, 0x0002u32);

    // ── CR0 (offset 580): bit 4 (ET) set, as in reset_cpu() ───────────────
    write_u32!(580, 1u32 << 30 | 1u32 << 29 | 1u32 << 4);

    // ── CS selector (sreg array at 668, index 1 = CS) ──────────────────────
    // sreg is *mut u16 at offset 668; CS = index 1 → byte offset 668 + 2 = 670
    write_u16!(670, cs_selector);

    // ── CS base address (segment_offsets at 736, index 1 = CS) ─────────────
    // segment_offsets is *mut i32 at 736; CS = index 1 → byte offset 736 + 4 = 740
    let cs_base = (cs_selector as u32) << 4;
    write_u32!(740, cs_base);

    // ── segment_access_bytes (offset 512, 8 bytes for ES..GS/TR/LDTR) ──────
    // All present, DPL0, data RW — same defaults as reset_cpu()
    for i in 0u8..8 {
        let access = if i == 1 /* CS */ {
            0x80 | 0x10 | 0x08 | 0x02  // P + S + E + RW
        } else {
            0x80 | 0x10 | 0x02          // P + S + RW
        };
        write_u8!(512 + i as usize, access);
    }

    // ── FPU control word (offset 1036): 0x037F (default) ───────────────────
    write_u16!(1036, 0x037Fu16);

    // ── fpu_stack_empty (offset 816): 0xFF (all empty) ─────────────────────
    write_u8!(816, 0xFFu8);

    // ── mxcsr (offset 824): 0x1F80 (all masks set, no exceptions) ──────────
    write_u32!(824, 0x1F80u32);

    // ── segment_limits: default 0 (real mode — limit not used) ─────────────
    // Already zeroed above.

    // TSC: inherit BSP's offset so the AP's TSC starts coherent.
    ctx.tsc = TscContext {
        last_value:    0,
        resolution:    tsc_resolution,
        speed:         tsc_speed,
        offset:        tsc_offset,
        same_readings: 0,
    };

    ctx.valid = true;

    dbg_log!(
        "SMP: initialized AP {} context: EIP={:08x} CS={:04x} CS_base={:08x}",
        cpu_id, start_eip, cs_selector, cs_base
    );
}

/// Returns true if the context for `cpu_id` has been initialised.
pub fn is_context_valid(cpu_id: usize) -> bool {
    if cpu_id >= MAX_CPUS {
        return false;
    }
    unsafe { CPU_CONTEXTS[cpu_id].valid }
}

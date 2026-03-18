# SMP Implementation Plan for Stratum

## 0. Executive Summary

The SMP scaffolding compiles and has correct `#[no_mangle]` exports in `lib.rs` /
`js_api.rs`, but **no built `v86.wasm` exists in `build/`** — only a JS-only
bundle (`build/libv86.mjs`) produced by esbuild. Consequently `get_optional_import()`
returns `undefined` for every SMP export. When a WASM build *is* produced, two
further problems prevent guest execution: (1) `cpu_loop_smp` never calls
`do_many_cycles_native()`, and (2) all architectural CPU state sits at fixed WASM
memory addresses with no per-CPU save/restore.

---

## 1. Per-CPU vs Shared State Inventory

All architectural state lives in raw WASM linear memory at the fixed offsets
defined in `src/rust/cpu/global_pointers.rs`. The table below classifies every
field.

### 1.1 Per-CPU (must be saved/restored on context switch)

| Field | Offset | Size | Notes |
|-------|--------|------|-------|
| `reg32[8]` (also `reg8`/`reg16` aliases) | 64 | 32 B | General-purpose registers |
| `last_op_size` | 96 | 4 B | Lazy-flags operand size |
| `flags_changed` | 100 | 4 B | Lazy-flags dirty mask |
| `last_op1` | 104 | 4 B | Lazy-flags first operand |
| `state_flags` (`CachedStateFlags`) | 108 | 4 B | Cached segment/mode bits |
| `last_result` | 112 | 4 B | Lazy-flags result |
| `flags` (EFLAGS) | 120 | 4 B | |
| `segment_access_bytes[8]` | 512 | 8 B | Descriptor access bytes |
| `page_fault` | 540 | 1 B | In-flight page-fault flag |
| `apic_enabled` | 548 | 1 B | Per-CPU APIC enable |
| `acpi_enabled` | 552 | 1 B | Per-CPU ACPI enable |
| `instruction_pointer` (EIP) | 556 | 4 B | |
| `previous_ip` | 560 | 4 B | Saved EIP before each insn |
| `idtr_size` | 564 | 4 B | |
| `idtr_offset` | 568 | 4 B | |
| `gdtr_size` | 572 | 4 B | |
| `gdtr_offset` | 576 | 4 B | |
| `cr[8]` (CR0–CR7) | 580 | 32 B | |
| `cpl` | 612 | 1 B | Current privilege level |
| `in_hlt` | 616 | 1 B | CPU halted flag |
| `last_virt_eip` | 620 | 4 B | JIT cache key |
| `eip_phys` | 624 | 4 B | Translated EIP |
| `sysenter_cs` | 636 | 4 B | |
| `sysenter_esp` | 640 | 4 B | |
| `sysenter_eip` | 644 | 4 B | |
| `prefixes` | 648 | 1 B | Active prefix byte mask |
| `instruction_counter` | 664 | 4 B | Per-CPU cycle counter |
| `sreg[8]` (ES/CS/SS/DS/FS/GS/TR/LDTR) | 668 | 16 B | Segment selectors |
| `dreg[8]` (DR0–DR7) | 684 | 32 B | Debug registers |
| `segment_is_null[8]` | 724 | 8 B | Null-segment flags |
| `segment_offsets[8]` | 736 | 32 B | Segment base addresses |
| `segment_limits[8]` | 768 | 32 B | Segment limits |
| `protected_mode` | 800 | 1 B | |
| `is_32` | 804 | 1 B | 32-bit operand size default |
| `stack_size_32` | 808 | 1 B | 32-bit stack size |
| `fpu_stack_empty` | 816 | 1 B | FPU tag word (empty mask) |
| `mxcsr` | 824 | 4 B | SSE control/status |
| `reg_xmm[8]` (128-bit each) | 832 | 128 B | XMM0–XMM7 |
| `current_tsc` | 960 | 8 B | Per-CPU TSC snapshot |
| `reg_pdpte[4]` | 968 | 32 B | PAE page-directory-pointer entries |
| `fpu_stack_ptr` | 1032 | 1 B | FPU stack top |
| `fpu_control_word` | 1036 | 2 B | |
| `fpu_status_word` | 1040 | 2 B | |
| `fpu_opcode` | 1044 | 4 B | |
| `fpu_ip` | 1048 | 4 B | FPU instruction pointer |
| `fpu_ip_selector` | 1052 | 4 B | |
| `fpu_dp` | 1056 | 4 B | FPU data pointer |
| `fpu_dp_selector` | 1060 | 4 B | |
| `tss_size_32` | 1128 | 1 B | TSS type flag |
| `fpu_st[8]` (F80, 10 B each) | 1152 | 80 B | x87 FPU stack |

**Total per-CPU data: ~552 bytes; raw WASM address range: bytes 64–1231 (1168 bytes).**

### 1.2 Shared (one copy, not switched)

| Field | Offset | Notes |
|-------|--------|-------|
| `memory_size` | 812 | Physical RAM size — same for all CPUs |
| `svga_dirty_bitmap_min/max_offset` | 716, 720 | VGA dirty tracking — global device state |
| `sse_scratch_register` | 1136 | Temporary buffer for SSE ops; never persisted |

### 1.3 Per-CPU state in `static mut` variables (`cpu.rs`)

These live outside WASM linear memory as Rust statics and are **also per-CPU**:

| Variable | Location | Notes |
|----------|----------|-------|
| `tlb_data[0x100000]` | `cpu.rs:324` | Per-CPU virtual→physical mapping |
| `valid_tlb_entries[10000]` / `valid_tlb_entries_count` | `cpu.rs:327-328` | TLB entry list |
| `jit_block_boundary` | `cpu.rs:295` | JIT control flag |
| `tsc_last_value`, `tsc_resolution`, `tsc_speed`, `tsc_offset`, `tsc_number_of_same_readings` | `cpu.rs:305-316` | TSC interpolation state |
| `cpuid_level` | `cpu.rs:293` | Typically the same for all CPUs; treat as shared |
| `in_jit` / `jit_fault` | `cpu.rs:330-332` | JIT execution flags |
| `debug_last_jump` | `cpu.rs:367` | Debug only |
| `CURRENT_CPU_ID` | `apic_mmio.rs:45` | Already switched by `set_current_cpu_id()` |

> **Important:** The TLB arrays are 4 MB+ of data. **Do not save/restore them.**
> Instead, flush the TLB on every context switch via `full_clear_tlb()`. This is
> correct because each AP has its own virtual address space mapping (distinct
> CR3), and the JIT already handles TLB invalidation. The cost of a flush per
> switch is acceptable for a cooperative SMP model with ~100k-cycle quanta.

### 1.4 Truly shared infrastructure (never per-CPU)

- Physical RAM (`mem8` pointer / `memory.rs:32`) — one guest RAM array
- `vga_mem8` / VGA memory — shared device
- JIT code cache (`JIT_STATE` mutex in `jit.rs`) — shared; JIT compilation is
  BSP-only in the initial implementation (safe because WASM is single-threaded)
- `IO_APIC_SMP` (`ioapic_smp.rs`) — one I/O APIC, shared
- `SMP_MANAGER` / `APIC_MANAGER` (`cpu_smp.rs`, `apic_smp.rs`) — shared state
  machines, already protected by `Mutex` (no-op spinlock on wasm32)

---

## 2. Context Save/Restore Design

### 2.1 Storage layout

Allocate a static array inside WASM linear memory (above existing state) to hold
per-CPU context snapshots. Because the WASM `--global-base=4096` linker flag
fixes Rust statics at an address above the OS-visible RAM, the context array
must be placed either:

**Option A (recommended): Rust static array**

```rust
// src/rust/cpu/cpu_context.rs  (new file)
const CPU_CONTEXT_SIZE: usize = 1168; // bytes 64..1231 inclusive
const MAX_CPUS: usize = 8;

#[repr(C, align(16))]
struct CpuContext([u8; CPU_CONTEXT_SIZE]);

static mut CPU_CONTEXTS: [CpuContext; MAX_CPUS] =
    [CpuContext([0u8; CPU_CONTEXT_SIZE]); MAX_CPUS];
```

Total overhead: **9 344 bytes** (≈9 KB) — negligible.

**Option B: JavaScript-side ArrayBuffer**  
Allocate in JS, pass pointer to Rust. More flexible but requires JS coordination.
Prefer Option A for simplicity.

### 2.2 `save_cpu_context(cpu_id: u8)`

```rust
pub unsafe fn save_cpu_context(cpu_id: u8) {
    debug_assert!((cpu_id as usize) < MAX_CPUS);
    let src = 64usize as *const u8;          // start of per-CPU state range
    let dst = CPU_CONTEXTS[cpu_id as usize].0.as_mut_ptr();
    core::ptr::copy_nonoverlapping(src, dst, CPU_CONTEXT_SIZE);
}
```

The raw `memcpy` of bytes 64–1231 captures every per-CPU field in one shot,
including the gaps (unused bytes don't matter). This is safe because:
- WASM is single-threaded — no concurrent mutation
- The range contains no pointers (all absolute WASM memory offsets are encoded
  in Rust `global_pointers.rs` as fixed integer casts, not stored in memory)

### 2.3 `restore_cpu_context(cpu_id: u8)`

```rust
pub unsafe fn restore_cpu_context(cpu_id: u8) {
    debug_assert!((cpu_id as usize) < MAX_CPUS);
    let src = CPU_CONTEXTS[cpu_id as usize].0.as_ptr();
    let dst = 64usize as *mut u8;
    core::ptr::copy_nonoverlapping(src, dst, CPU_CONTEXT_SIZE);
    // TLB is not saved; flush it so the restored CR3 takes effect cleanly.
    full_clear_tlb();
    // Re-derive cached state flags from restored segment descriptors.
    update_state_flags();
}
```

`full_clear_tlb()` and `update_state_flags()` are already `pub unsafe fn` in
`cpu.rs` and safe to call after a restore.

### 2.4 TSC per-CPU statics

The `tsc_*` statics in `cpu.rs` are **not** in the 64–1231 range (they are Rust
statics, not fixed WASM memory). Save/restore them separately:

```rust
pub struct TscSnapshot {
    pub last_value: u64,
    pub resolution: u64,
    pub speed: u64,
    pub offset: u64,
    pub same_readings: u64,
}
static mut TSC_SNAPSHOTS: [TscSnapshot; MAX_CPUS] = [...];

pub unsafe fn save_tsc_context(cpu_id: u8) { ... }
pub unsafe fn restore_tsc_context(cpu_id: u8) { ... }
```

For the **BSP**, TSC is already managed by existing code; only AP TSC snapshots
need explicit save/restore.

### 2.5 Initialization

`initialize_smp(cpu_count)` must zero-initialise each AP's context and then
write a valid initial register state (EIP = SIPI vector × 0x1000, CS = SIPI
vector, EFLAGS = 0x2, all other regs = 0, real-mode segment defaults). This
mirrors what `reset_cpu()` does for the BSP.

```rust
pub unsafe fn initialize_ap_context(cpu_id: u8, start_eip: u32) {
    // Zero the context block
    CPU_CONTEXTS[cpu_id as usize].0.fill(0);
    // Write minimum viable real-mode state into it
    let ctx = CPU_CONTEXTS[cpu_id as usize].0.as_mut_ptr();
    // instruction_pointer at offset (556-64)=492 within the block
    write_u32(ctx, 556 - 64, start_eip);
    // flags at offset (120-64)=56: FLAGS_DEFAULT = 0x2
    write_u32(ctx, 120 - 64, 0x2);
    // ... (other reset_cpu fields, adapted for AP real-mode start)
}
```

A helper macro or offset table makes this maintainable.

---

## 3. `cpu_loop_smp`: Executing Guest Instructions

### 3.1 Current state (broken)

`cpu_loop_smp()` in `cpu_smp.rs:316`:
1. Calls `handle_cpu_interrupt(cpu_id)` — checks APIC, fires interrupt
2. Calls `handle_apic_timer_smp(cpu_id, now)` — returns 100.0 (stub)
3. **Returns without executing a single guest instruction.**

`do_many_cycles_native()` is never called. The AP makes no forward progress.

### 3.2 Target design

```rust
/// Execute one cooperative SMP slice for cpu_id.
/// Called from JS in round-robin after BSP's main_loop() returns.
pub unsafe fn cpu_loop_smp(cpu_id: u8) -> bool {
    // 1. Save BSP (cpu 0) state — it's currently loaded in the fixed registers.
    //    (On the very first AP slice, BSP's main_loop() has just finished.)
    save_cpu_context(0);
    save_tsc_context(0);

    // 2. Restore this AP's state into the fixed register slots.
    restore_cpu_context(cpu_id);
    restore_tsc_context(cpu_id);

    // 3. Tell APIC MMIO which CPU is active (already done by JS, but belt+braces).
    apic_mmio::set_current_cpu_id(cpu_id);

    // 4. Check for pending APIC interrupts on this AP.
    handle_cpu_interrupt(cpu_id);

    // 5. Execute a quantum of guest instructions (same as BSP's inner loop).
    if !*in_hlt {
        do_many_cycles_native();   // ≈100 003 instructions per call
    }

    // 6. Run hardware timers for this AP and collect next-wake time.
    let now = js::microtick();
    handle_apic_timer_smp(cpu_id, now);

    // 7. Check IRQs with the AP's flags register now live.
    handle_irqs();

    // 8. Save AP state back.
    save_cpu_context(cpu_id);
    save_tsc_context(cpu_id);

    // 9. Restore BSP so it's ready when main_loop() is next called.
    restore_cpu_context(0);
    restore_tsc_context(0);
    apic_mmio::set_current_cpu_id(0);

    true
}
```

### 3.3 Call sequence from JS (no changes needed)

`src/cpu.js:1996-2006` already implements the correct pattern:

```js
if (this.smp_cpu_loop && this.smp_cpu_count && this.smp_is_enabled && this.smp_is_enabled()) {
    const cpu_count = this.smp_cpu_count();
    for (let cpu_id = 1; cpu_id < cpu_count; cpu_id++) {
        if (this.set_current_cpu_id) this.set_current_cpu_id(cpu_id);
        this.smp_cpu_loop(cpu_id);
    }
    if (this.set_current_cpu_id) this.set_current_cpu_id(0);
}
```

Since `cpu_loop_smp` now handles BSP save/restore internally, the JS
`set_current_cpu_id` call before `smp_cpu_loop` becomes redundant (harmless).
The JS side needs **no changes**.

### 3.4 Quantum sizing

`do_many_cycles_native()` runs `LOOP_COUNTER = 100_003` iterations per call
(`cpu.rs:288`). For N APs, each JS frame (1 ms, `TIME_PER_FRAME = 1.0`) must
accommodate N × ~100k cycles plus the BSP's share. With 4 CPUs this is ~400k
cycles/ms total — fine for typical emulated workloads.

If APs run too slow, increase the quantum by calling `do_many_cycles_native()`
in a mini-loop (e.g., 4 iterations) or expose a new `smp_cpu_loop_n(cpu_id,
n_cycles)` export.

### 3.5 `in_hlt` handling

If an AP is halted (`*in_hlt == true`), skip `do_many_cycles_native()` but
still run `handle_cpu_interrupt()`. An APIC interrupt will clear `in_hlt` via
`pic_call_irq → js::stop_idling → *in_hlt = false`.

---

## 4. WASM Build Requirements

### 4.1 What's missing from the sandbox

| Tool | Status | Required For |
|------|--------|-------------|
| `rustup` | **Not installed** | Managing Rust toolchain |
| `cargo` | **Not installed** | Compiling Rust → WASM |
| `wasm32-unknown-unknown` target | **Not installed** | WASM cross-compilation |
| `clang` (wasm32 target) | **Not installed** | Building `softfloat.o`, `zstddeclib.o` |
| `rust-lld` | **Not installed** (wrapper exists) | WASM linker |
| `wasm-opt` | **Not installed** | Optional post-processing |

The build also requires:
- Pre-generated Rust instruction tables in `src/rust/gen/` (the `.rs` files are
  absent — only `gen/mod.rs` exists). These are generated by running
  `gen/generate_jit.js`, `gen/generate_interpreter.js`, and
  `gen/generate_analyzer.js`, which require Node.js ≥ 14 (available via `bun`).

### 4.2 Steps to enable WASM builds in this sandbox

```bash
# 1. Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env

# 2. Add wasm32 target
rustup target add wasm32-unknown-unknown

# 3. Install clang with wasm32 support
apt-get install -y clang lld   # or use the llvm toolchain

# 4. Generate instruction tables (only needs Node/bun, which IS available)
bun gen/generate_jit.js --output-dir build/ --table jit
bun gen/generate_jit.js --output-dir build/ --table jit0f
bun gen/generate_interpreter.js --output-dir build/ --table interpreter
bun gen/generate_interpreter.js --output-dir build/ --table interpreter0f
bun gen/generate_analyzer.js --output-dir build/ --table analyzer
bun gen/generate_analyzer.js --output-dir build/ --table analyzer0f

# 5. Build C object files
make build/softfloat.o build/zstddeclib.o

# 6. Build WASM (debug first, then release)
make build/v86-debug.wasm
```

### 4.3 `std::sync::Mutex` on `wasm32-unknown-unknown`

`cpu_smp.rs`, `apic_smp.rs`, and `ioapic_smp.rs` use `std::sync::{Mutex, Arc}`.
This is **not a blocker**: `jit.rs` already uses `std::sync::Mutex` and compiles
successfully against `wasm32-unknown-unknown`. Since Rust 1.63 the standard
library compiles for this target, and `Mutex::lock()` uses a trivial single-
threaded implementation (no OS primitives). `Arc` similarly works (reference
counting, no atomics needed for single-threaded WASM).

`std::collections::HashMap` (used in `cpu_smp.rs`) is also available and works.

---

## 5. Why SMP Exports Are Missing from the Built `v86.wasm`

There is no `v86.wasm` in `build/` at all — only `build/libv86.mjs`. The SMP
exports therefore never reach `this.wm.exports` and `get_optional_import()`
returns `undefined` for all of them.

### Root cause: the JS bundle was built without Rust

The `build/libv86.mjs` was produced by `esbuild` (per `STRATUM.md` "Quick
start"):

```bash
npx esbuild src/main.js --bundle --format=esm ...
```

This bundles only the JavaScript source files. The Rust/WASM side is loaded at
runtime by `src/browser/starter.js:119` via `WebAssembly.instantiate(bytes,
env)` — it fetches `build/v86.wasm` (or `v86-debug.wasm`) as a separate file.
No WASM file was ever compiled and placed in `build/`, so every WASM export is
absent.

### Secondary cause: `set_current_cpu_id` missing `#[no_mangle]` in the right place

`set_current_cpu_id` is defined in `apic_mmio.rs:48` without `#[no_mangle]`. The
correctly attributed wrapper lives in `js_api.rs:12`. This is fine — `js_api.rs`
is included via `src/rust/lib.rs` → `mod js_api`, so it **will** be exported when
WASM is built. No fix needed here.

### Complete list of SMP exports once WASM is built

All of these are `#[no_mangle]` functions in `src/rust/lib.rs` or `src/rust/js_api.rs`:

| Export | File | Status |
|--------|------|--------|
| `smp_init` | `lib.rs:20` | Present |
| `smp_cpu_loop` | `lib.rs:26` | Present (but broken — see §3) |
| `apic_mmio_read` | `lib.rs:32` | Present |
| `apic_mmio_write` | `lib.rs:38` | Present |
| `ioapic_mmio_read` | `lib.rs:44` | Present |
| `ioapic_mmio_write` | `lib.rs:50` | Present |
| `ioapic_set_irq` | `lib.rs:56` | Present |
| `smp_is_enabled` | `lib.rs:62` | Present |
| `smp_cpu_count` | `lib.rs:68` | Present |
| `smp_start_ap` | `lib.rs:74` | Present |
| `set_current_cpu_id` | `js_api.rs:12` | Present |

---

## 6. Implementation Checklist (ordered)

1. **Install toolchain** — `rustup`, `wasm32-unknown-unknown`, `clang` (§4.2)
2. **Generate instruction tables** — `bun gen/generate_*.js` (§4.2)
3. **Build C objects** — `make build/softfloat.o build/zstddeclib.o`
4. **Smoke-build debug WASM** — `make build/v86-debug.wasm`; confirm exports
   with `wasm-objdump -x build/v86-debug.wasm | grep " smp_"` or via Node:
   `WebAssembly.instantiate(fs.readFileSync('build/v86-debug.wasm'))...exports`
5. **Add `cpu_context.rs`** — `CPU_CONTEXTS` array, `save_cpu_context`,
   `restore_cpu_context`, `initialize_ap_context`, TSC snapshot helpers (§2)
6. **Wire `cpu_context.rs` into `mod.rs`** — `pub mod cpu_context;`
7. **Rewrite `cpu_loop_smp`** in `cpu_smp.rs` per §3.2
8. **Export `save_cpu_context` / `restore_cpu_context`** from `lib.rs` if JS
   debugging is desired (optional)
9. **Call `initialize_ap_context`** from `start_ap()` / `start_application_processor()`
   after the SIPI vector is known
10. **Rebuild WASM** and verify SMP exports are present
11. **Integration test**: boot a kernel that writes to per-CPU TSC / LAPIC ID
    and verify each AP reports the correct CPU ID

---

## 7. Open Questions / Risks

1. **TLB flush cost**: flushing on every AP slice is correct but costs ~100 µs
   per switch for large guest RAM. If this is too slow, consider saving/restoring
   only the portion of `tlb_data` that is valid (`valid_tlb_entries`). For an
   initial implementation, full flush is the safe choice.

2. **JIT cache coherency**: JIT-compiled blocks embedded in `tlb_code` reference
   physical pages that are shared. After `full_clear_tlb()`, JIT blocks are
   invalidated from the TLB but the underlying compiled code in the WASM table
   remains valid and can be re-entered. This is correct; no special handling
   needed.

3. **`in_jit` static**: If `cpu_loop_smp` is called while the BSP is mid-JIT
   (impossible in WASM single-threaded execution, since JS only calls
   `cpu_loop_smp` after `main_loop()` returns), this is a non-issue.

4. **APIC Local-to-physical address mapping**: `apic_mmio.rs` assigns each CPU a
   unique Local APIC base (`0xFEE00000 + cpu_id × 0x1000`). This deviates from
   real hardware where all CPUs share `0xFEE00000` and are distinguished by
   reading the APIC ID register. Guest kernels that use the standard single-base
   approach will work correctly; kernels that enumerate multiple LAPIC bases may
   not. This is a pre-existing design issue; note it in the AP init code.

5. **TSC divergence**: Each AP gets its own `tsc_last_value` snapshot. Without
   explicit synchronisation, AP TSCs will drift. Real SMP kernels use TSC
   calibration (RDTSC on BSP, then SIPI + measure delta). A simple fix is to
   copy the BSP's `tsc_offset` to each AP at `initialize_ap_context` time.

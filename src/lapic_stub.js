/**
 * Pure-JS LAPIC MMIO stub.
 *
 * When the Rust SMP WASM modules aren't available (release build), the
 * `apic_mmio_read` / `apic_mmio_write` optional imports are undefined, so the
 * LAPIC MMIO region at 0xFEE00000 is never registered.  Guest writes to LAPIC
 * registers (LVT_TIMER, TIMER_INITIAL, TIMER_DIVIDE, etc.) go nowhere and the
 * LAPIC timer never fires — breaking any OS that relies on it for scheduling.
 *
 * This module provides `register_lapic_mmio(cpu, io)` which:
 *  1. Registers MMIO handlers at 0xFEE00000 (128 KB, one MMAP_BLOCK).
 *  2. Reads/writes go directly into the Rust `Apic` struct that already lives
 *     in WASM linear memory (accessed via `cpu.get_apic_addr()`).  The struct
 *     layout is #[repr(C)] and verified by compile-time assertions in apic.rs.
 *  3. The existing Rust `apic_timer()` (called every tick from
 *     `run_hardware_timers`) checks elapsed time, fires `deliver()` (sets IRR
 *     bits), and `handle_irqs()` → `acknowledge_irq()` → `call_interrupt_vector`
 *     completes the delivery.  We don't need to reimplement timer logic.
 *
 * Struct layout (from apic.rs, #[repr(C)], APIC_STRUCT_SIZE = 4 * 46 = 184 bytes):
 *
 *   i32 index  byte offset  field
 *   ---------  -----------  ---------------------------
 *    0          0           apic_id
 *    1          4           timer_divider
 *    2          8           timer_divider_shift
 *    3         12           timer_initial_count
 *    4         16           timer_current_count
 *    5         20           (padding for f64 alignment)
 *    6-7       24           timer_last_tick  (f64, 8 bytes)
 *    8         32           lvt_timer
 *    9         36           lvt_perf_counter
 *   10         40           lvt_int0
 *   11         44           lvt_int1
 *   12         48           lvt_error
 *   13         52           tpr
 *   14         56           icr0
 *   15         60           icr1
 *   16-23      64           irr  [u32; 8]
 *   24-31      96           isr  [u32; 8]
 *   32-39     128           tmr  [u32; 8]
 *   40        160           spurious_vector
 *   41        164           destination_format
 *   42        168           local_destination
 *   43        172           error
 *   44        176           read_error
 *   45        180           lvt_thermal_sensor
 */

import { v86 } from "./main.js";
import { dbg_log } from "./log.js";
import { MMAP_BLOCK_SIZE } from "./const.js";

// LAPIC register offsets (within the 4 KB LAPIC page)
const LAPIC_ID          = 0x20;
const LAPIC_VERSION     = 0x30;
const LAPIC_TPR         = 0x80;
const LAPIC_EOI         = 0xB0;
const LAPIC_LDR         = 0xD0;
const LAPIC_DFR         = 0xE0;
const LAPIC_SVR         = 0xF0;
const LAPIC_ISR_BASE    = 0x100;   // 0x100..0x170 (8 regs)
const LAPIC_TMR_BASE    = 0x180;   // 0x180..0x1F0 (8 regs)
const LAPIC_IRR_BASE    = 0x200;   // 0x200..0x270 (8 regs)
const LAPIC_ESR         = 0x280;
const LAPIC_ICR_LO      = 0x300;
const LAPIC_ICR_HI      = 0x310;
const LAPIC_LVT_TIMER   = 0x320;
const LAPIC_LVT_THERMAL = 0x330;
const LAPIC_LVT_PERF    = 0x340;
const LAPIC_LVT_LINT0   = 0x350;
const LAPIC_LVT_LINT1   = 0x360;
const LAPIC_LVT_ERROR   = 0x370;
const LAPIC_TIMER_ICR   = 0x380;  // initial count
const LAPIC_TIMER_CCR   = 0x390;  // current count (read-only)
const LAPIC_TIMER_DCR   = 0x3E0;  // divide config

// Struct field i32 indices
const F_APIC_ID               = 0;
const F_TIMER_DIVIDER         = 1;
const F_TIMER_DIVIDER_SHIFT   = 2;
const F_TIMER_INITIAL_COUNT   = 3;
const F_TIMER_CURRENT_COUNT   = 4;
// F64 at byte offset 24 = i32 indices 6,7
const F_TIMER_LAST_TICK_BYTE  = 24;  // byte offset for Float64 view
const F_LVT_TIMER             = 8;
const F_LVT_PERF              = 9;
const F_LVT_INT0              = 10;
const F_LVT_INT1              = 11;
const F_LVT_ERROR             = 12;
const F_TPR                   = 13;
const F_ICR0                  = 14;
const F_ICR1                  = 15;
const F_IRR_BASE              = 16;  // 8 u32s
const F_ISR_BASE              = 24;  // 8 u32s
const F_TMR_BASE              = 32;  // 8 u32s
const F_SVR                   = 40;
const F_DFR                   = 41;
const F_LDR                   = 42;
const F_ERROR                 = 43;
const F_READ_ERROR            = 44;
const F_LVT_THERMAL           = 45;

const IOAPIC_CONFIG_MASKED  = 0x10000;
const APIC_TIMER_FREQ       = 1.0 * 1000.0 * 1000.0; // 1 MHz (ticks per ms)

const APIC_TIMER_MODE_MASK      = 3 << 17;
const APIC_TIMER_MODE_ONE_SHOT  = 0;
const APIC_TIMER_MODE_PERIODIC  = 1 << 17;

/**
 * Map an LAPIC register offset to the i32 index in the struct, or a special
 * sentinel for compound/special registers.
 */
function lapic_read32(apic32, apicF64, offset)
{
    switch(offset)
    {
        case LAPIC_ID:          return apic32[F_APIC_ID];
        case LAPIC_VERSION:     return 0x50014;  // same as Rust
        case LAPIC_TPR:         return apic32[F_TPR];
        case LAPIC_EOI:         return 0;  // write-only
        case LAPIC_LDR:         return apic32[F_LDR];
        case LAPIC_DFR:         return apic32[F_DFR];
        case LAPIC_SVR:         return apic32[F_SVR];

        // ISR registers 0x100..0x170
        case 0x100: case 0x110: case 0x120: case 0x130:
        case 0x140: case 0x150: case 0x160: case 0x170:
            return apic32[F_ISR_BASE + ((offset - 0x100) >> 4)];

        // TMR registers 0x180..0x1F0
        case 0x180: case 0x190: case 0x1A0: case 0x1B0:
        case 0x1C0: case 0x1D0: case 0x1E0: case 0x1F0:
            return apic32[F_TMR_BASE + ((offset - 0x180) >> 4)];

        // IRR registers 0x200..0x270
        case 0x200: case 0x210: case 0x220: case 0x230:
        case 0x240: case 0x250: case 0x260: case 0x270:
            return apic32[F_IRR_BASE + ((offset - 0x200) >> 4)];

        case LAPIC_ESR:         return apic32[F_READ_ERROR];
        case LAPIC_ICR_LO:      return apic32[F_ICR0];
        case LAPIC_ICR_HI:      return apic32[F_ICR1];
        case LAPIC_LVT_TIMER:   return apic32[F_LVT_TIMER];
        case LAPIC_LVT_THERMAL: return apic32[F_LVT_THERMAL];
        case LAPIC_LVT_PERF:    return apic32[F_LVT_PERF];
        case LAPIC_LVT_LINT0:   return apic32[F_LVT_INT0];
        case LAPIC_LVT_LINT1:   return apic32[F_LVT_INT1];
        case LAPIC_LVT_ERROR:   return apic32[F_LVT_ERROR];
        case LAPIC_TIMER_DCR:   return apic32[F_TIMER_DIVIDER];
        case LAPIC_TIMER_ICR:   return apic32[F_TIMER_INITIAL_COUNT];

        case LAPIC_TIMER_CCR:
        {
            // Compute current count from elapsed time, same algorithm as Rust
            const now = v86.microtick();
            const last_tick = apicF64[0]; // timer_last_tick at byte offset 24
            if(last_tick > now) return apic32[F_TIMER_INITIAL_COUNT];
            const diff = now - last_tick;
            const shift = apic32[F_TIMER_DIVIDER_SHIFT];
            const diff_in_ticks = (diff * APIC_TIMER_FREQ / (1 << shift)) >>> 0;
            const initial = apic32[F_TIMER_INITIAL_COUNT] >>> 0;
            if(diff_in_ticks < initial)
            {
                return (initial - diff_in_ticks) | 0;
            }
            const mode = apic32[F_LVT_TIMER] & APIC_TIMER_MODE_MASK;
            if(mode === APIC_TIMER_MODE_PERIODIC)
            {
                return (initial - (diff_in_ticks % (initial + 1))) | 0;
            }
            return 0; // one-shot expired
        }

        default:
            dbg_log("LAPIC stub: unhandled read offset 0x" + offset.toString(16));
            return 0;
    }
}

/**
 * Helper: find highest set bit in the 256-bit ISR register (8 x u32).
 * Returns the bit index (0-255) or -1 if none set.
 */
function register_get_highest_bit(apic32, base_index)
{
    for(let i = 7; i >= 0; i--)
    {
        const word = apic32[base_index + i] >>> 0;
        if(word !== 0)
        {
            return (i << 5) | (31 - Math.clz32(word));
        }
    }
    return -1;
}

function register_get_bit(apic32, base_index, bit)
{
    return (apic32[base_index + (bit >> 5)] & (1 << (bit & 31))) !== 0;
}

function register_set_bit(apic32, base_index, bit)
{
    apic32[base_index + (bit >> 5)] |= (1 << (bit & 31));
}

function register_clear_bit(apic32, base_index, bit)
{
    apic32[base_index + (bit >> 5)] &= ~(1 << (bit & 31));
}


function lapic_write32(cpu, apic32, apicF64, offset, value)
{
    switch(offset)
    {
        case LAPIC_ID:
            apic32[F_APIC_ID] = value;
            break;

        case LAPIC_VERSION:
            // read-only, ignore
            break;

        case LAPIC_TPR:
            apic32[F_TPR] = value & 0xFF;
            break;

        case LAPIC_EOI:
        {
            // Clear highest ISR bit
            const highest = register_get_highest_bit(apic32, F_ISR_BASE);
            if(highest >= 0)
            {
                register_clear_bit(apic32, F_ISR_BASE, highest);
                // If TMR bit is set for this vector, would need EOI to IOAPIC.
                // For the stub, the IOAPIC EOI broadcast is handled by the
                // Rust ioapic module if present; for LAPIC-only timer interrupts
                // the TMR bit won't be set (edge-triggered), so this is fine.
            }
            break;
        }

        case LAPIC_LDR:
            apic32[F_LDR] = value & 0xFF000000;
            break;

        case LAPIC_DFR:
            apic32[F_DFR] = value | 0x0FFFFFFF;
            break;

        case LAPIC_SVR:
            apic32[F_SVR] = value;
            break;

        case LAPIC_ESR:
            // Writing ESR copies error → read_error, then clears error
            apic32[F_READ_ERROR] = apic32[F_ERROR];
            apic32[F_ERROR] = 0;
            break;

        case LAPIC_ICR_LO:
        {
            // ICR write — for self-IPI and broadcast.
            // We handle "self" shorthand (deliver to self) and ignore others
            // since there's only one CPU in the non-SMP build.
            const vector = (value & 0xFF);
            const delivery_mode = (value >> 8) & 7;
            const destination_shorthand = (value >> 18) & 3;

            let cleared = value & ~(1 << 12);  // clear delivery status
            apic32[F_ICR0] = cleared;

            // Deliver interrupt for self (shorthand=1) or all-incl-self (shorthand=2)
            if(destination_shorthand === 1 || destination_shorthand === 2)
            {
                if(delivery_mode === 0 && vector >= 0x10 && vector !== 0xFF)
                {
                    // Fixed delivery: set IRR bit
                    if(!register_get_bit(apic32, F_IRR_BASE, vector))
                    {
                        register_set_bit(apic32, F_IRR_BASE, vector);
                    }
                    // Trigger interrupt processing
                    cpu.handle_irqs();
                }
            }
            break;
        }

        case LAPIC_ICR_HI:
            apic32[F_ICR1] = value;
            break;

        case LAPIC_LVT_TIMER:
            apic32[F_LVT_TIMER] = value;
            break;

        case LAPIC_LVT_THERMAL:
            apic32[F_LVT_THERMAL] = value;
            break;

        case LAPIC_LVT_PERF:
            apic32[F_LVT_PERF] = value;
            break;

        case LAPIC_LVT_LINT0:
            apic32[F_LVT_INT0] = value;
            break;

        case LAPIC_LVT_LINT1:
            apic32[F_LVT_INT1] = value;
            break;

        case LAPIC_LVT_ERROR:
            apic32[F_LVT_ERROR] = value;
            break;

        case LAPIC_TIMER_DCR:
        {
            apic32[F_TIMER_DIVIDER] = value;
            const divide_shift = (value & 0b11) | ((value & 0b1000) >> 1);
            apic32[F_TIMER_DIVIDER_SHIFT] = divide_shift === 0b111 ? 0 : divide_shift + 1;
            break;
        }

        case LAPIC_TIMER_ICR:
        {
            apic32[F_TIMER_INITIAL_COUNT] = value;
            apic32[F_TIMER_CURRENT_COUNT] = value;
            // Set timer_last_tick to now (f64 at byte offset 24)
            apicF64[0] = v86.microtick();
            break;
        }

        case LAPIC_TIMER_CCR:
            // Read-only register — ignore writes
            break;

        default:
            dbg_log("LAPIC stub: unhandled write offset 0x" + offset.toString(16) +
                    " value=0x" + (value >>> 0).toString(16));
            break;
    }
}


/**
 * Register LAPIC MMIO handlers at 0xFEE00000.
 *
 * @param {Object} cpu  - The CPU instance (must have wasm_memory, get_apic_addr, handle_irqs)
 * @param {Object} io   - The IO instance with mmap_register()
 */
export function register_lapic_mmio(cpu, io)
{
    const apic_base_addr = cpu.get_apic_addr();
    const wasm_buf = cpu.wasm_memory.buffer;

    // Int32Array view over the Apic struct (46 i32 fields)
    const apic32 = new Int32Array(wasm_buf, apic_base_addr, 46);

    // Float64Array view for timer_last_tick at byte offset 24 (one f64)
    const apicF64 = new Float64Array(wasm_buf, apic_base_addr + F_TIMER_LAST_TICK_BYTE, 1);

    // Initialise key fields to sane defaults so the Rust apic_timer() sees a
    // valid state even before the guest programmes the APIC.
    // (The Rust Apic static initialiser already does this, but since we're
    //  sharing the struct let's be defensive.)
    if(apic32[F_SVR] === 0)
    {
        apic32[F_SVR] = 0xFE;   // default spurious vector
    }
    if(apic32[F_LVT_TIMER] === 0)
    {
        apic32[F_LVT_TIMER] = IOAPIC_CONFIG_MASKED;  // masked by default
    }

    io.mmap_register(
        0xFEE00000,
        MMAP_BLOCK_SIZE,   // 0x20000 = 128 KB (minimum MMIO block)

        // read8
        function lapic_read8(addr)
        {
            const offset = addr & 0xFFF;         // LAPIC page offset
            const aligned = offset & ~3;          // 32-bit aligned offset
            const val32 = lapic_read32(apic32, apicF64, aligned);
            return (val32 >>> (8 * (offset & 3))) & 0xFF;
        },

        // write8 — LAPIC registers are 32-bit; byte writes are unusual, ignore
        function lapic_write8(addr, value) {},

        // read32
        function lapic_read32_handler(addr)
        {
            const offset = addr & 0xFFF;
            return lapic_read32(apic32, apicF64, offset) | 0;
        },

        // write32
        function lapic_write32_handler(addr, value)
        {
            const offset = addr & 0xFFF;
            lapic_write32(cpu, apic32, apicF64, offset, value);
        }
    );

    dbg_log("LAPIC MMIO stub registered at 0xFEE00000 (JS fallback)");
}

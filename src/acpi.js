// http://www.uefi.org/sites/default/files/resources/ACPI_6_1.pdf

import { v86 } from "./main.js";
import { LOG_ACPI } from "../src/const.js";
import { h } from "./lib.js";
import { dbg_log, dbg_assert } from "./log.js";

// For Types Only
import { CPU } from "./cpu.js";

const PMTIMER_FREQ_SECONDS = 3579545;

/**
 * @constructor
 * @param {CPU} cpu
 */
export function ACPI(cpu)
{
    /** @type {CPU} */
    this.cpu = cpu;

    var io = cpu.io;

    var acpi = {
        pci_id: 0x07 << 3,
        pci_space: [
            0x86, 0x80, 0x13, 0x71, 0x07, 0x00, 0x80, 0x02, 0x08, 0x00, 0x80, 0x06, 0x00, 0x00, 0x80, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x09, 0x01, 0x00, 0x00,
        ],
        pci_bars: [],
        name: "acpi",
    };

    // 00:07.0 Bridge: Intel Corporation 82371AB/EB/MB PIIX4 ACPI (rev 08)
    cpu.devices.pci.register_device(acpi);

    this.timer_last_value = 0;
    this.timer_imprecision_offset = 0;

    this.status = 1;
    this.pm1_status = 0;
    this.pm1_enable = 0;
    this.last_timer = this.get_timer(v86.microtick());

    this.gpe = new Uint8Array(4);

    io.register_read(0xB000, this, undefined, function()
    {
        dbg_log("ACPI pm1_status read", LOG_ACPI);
        return this.pm1_status;
    });
    io.register_write(0xB000, this, undefined, function(value)
    {
        dbg_log("ACPI pm1_status write: " + h(value, 4), LOG_ACPI);
        this.pm1_status &= ~value;
    });

    io.register_read(0xB002, this, undefined, function()
    {
        dbg_log("ACPI pm1_enable read", LOG_ACPI);
        return this.pm1_enable;
    });
    io.register_write(0xB002, this, undefined, function(value)
    {
        dbg_log("ACPI pm1_enable write: " + h(value), LOG_ACPI);
        this.pm1_enable = value;
    });

    // ACPI status
    io.register_read(0xB004, this, function()
    {
        dbg_log("ACPI status read8", LOG_ACPI);
        return this.status & 0xFF;
    }, function()
    {
        dbg_log("ACPI status read", LOG_ACPI);
        return this.status;
    });
    io.register_write(0xB004, this, undefined, function(value)
    {
        dbg_log("ACPI status write: " + h(value), LOG_ACPI);
        this.status = value;

        // SLP_EN (bit 13) + any SLP_TYP → power off request
        // SCI_EN (bit 0) must be set for ACPI mode, SLP_EN is bit 13
        if(value & (1 << 13))
        {
            var slp_typ = (value >> 10) & 7;
            dbg_log("ACPI power off request: SLP_TYP=" + slp_typ, LOG_ACPI);
            // S5 soft-off: stop the emulator
            this.cpu.bus.send("emulator-stopped");
        }
    });

    // ACPI, pmtimer
    io.register_read(0xB008, this, undefined, undefined, function()
    {
        if(!this.dsdt_patched)
        {
            this.dsdt_patched = this.patch_dsdt_s5();
        }
        var value = this.get_timer(v86.microtick()) & 0xFFFFFF;
        return value;
    });

    // ACPI, gpe
    io.register_read(0xAFE0, this, function()
    {
        dbg_log("Read gpe#0", LOG_ACPI);
        return this.gpe[0];
    });
    io.register_read(0xAFE1, this, function()
    {
        dbg_log("Read gpe#1", LOG_ACPI);
        return this.gpe[1];
    });
    io.register_read(0xAFE2, this, function()
    {
        dbg_log("Read gpe#2", LOG_ACPI);
        return this.gpe[2];
    });
    io.register_read(0xAFE3, this, function()
    {
        dbg_log("Read gpe#3", LOG_ACPI);
        return this.gpe[3];
    });

    io.register_write(0xAFE0, this, function(value)
    {
        dbg_log("Write gpe#0: " + h(value), LOG_ACPI);
        this.gpe[0] = value;
    });
    io.register_write(0xAFE1, this, function(value)
    {
        dbg_log("Write gpe#1: " + h(value), LOG_ACPI);
        this.gpe[1] = value;
    });
    io.register_write(0xAFE2, this, function(value)
    {
        dbg_log("Write gpe#2: " + h(value), LOG_ACPI);
        this.gpe[2] = value;
    });
    io.register_write(0xAFE3, this, function(value)
    {
        dbg_log("Write gpe#3: " + h(value), LOG_ACPI);
        this.gpe[3] = value;
    });

    // SMI Command Port (0xB2) — handles ACPI enable/disable requests.
    // SeaBIOS FADT: SMI_CMD=0xB2, ACPI_ENABLE=0xF1, ACPI_DISABLE=0xF0
    io.register_write(0xB2, this, function(value)
    {
        dbg_log("ACPI SMI_CMD write: " + h(value), LOG_ACPI);
        if(value === 0xF1)
        {
            // ACPI_ENABLE: set SCI_EN (bit 0) in PM1a_CNT
            this.status |= 1;
            dbg_log("ACPI enabled (SCI_EN set)", LOG_ACPI);
        }
        else if(value === 0xF0)
        {
            // ACPI_DISABLE: clear SCI_EN
            this.status &= ~1;
            dbg_log("ACPI disabled (SCI_EN cleared)", LOG_ACPI);
        }
    });

    // Patch DSDT with _S5_ AML. Cannot use setTimeout — v86 CPU loop is
    // synchronous, so the timeout fires after the guest already parsed ACPI.
    // Instead we set a flag and check it on every PM timer read (0xB008),
    // which SeaBIOS reads during POST before launching the multiboot kernel.
    this.dsdt_patched = false;
}

ACPI.prototype.timer = function(now)
{
    var timer = this.get_timer(now);
    var highest_bit_changed = ((timer ^ this.last_timer) & (1 << 23)) !== 0;

    if((this.pm1_enable & 1) && highest_bit_changed)
    {
        dbg_log("ACPI raise irq", LOG_ACPI);
        this.pm1_status |= 1;
        this.cpu.device_raise_irq(9);
    }
    else
    {
        this.cpu.device_lower_irq(9);
    }

    this.last_timer = timer;
    return 100; // TODO
};

ACPI.prototype.get_timer = function(now)
{
    const t = Math.round(now * (PMTIMER_FREQ_SECONDS / 1000));

    // Due to the low precision of JavaScript's time functions we increment the
    // returned timer value every time it is read

    if(t === this.timer_last_value)
    {
        // don't go past 1ms

        if(this.timer_imprecision_offset < PMTIMER_FREQ_SECONDS / 1000)
        {
            this.timer_imprecision_offset++;
        }
    }
    else
    {
        dbg_assert(t > this.timer_last_value);

        const previous_timer = this.timer_last_value + this.timer_imprecision_offset;

        // don't go back in time

        if(previous_timer <= t)
        {
            this.timer_imprecision_offset = 0;
            this.timer_last_value = t;
        }
        else
        {
            dbg_log("Warning: Overshot pmtimer, waiting;" +
                    " current=" + t +
                    " last=" + this.timer_last_value +
                    " offset=" + this.timer_imprecision_offset, LOG_ACPI);
        }
    }

    return this.timer_last_value + this.timer_imprecision_offset;
};

/**
 * Scan guest RAM for the RSDP, walk RSDT → FACP → DSDT, and append a
 * minimal \_S5_ AML object so that Aqeous's initAcpi() can find it.
 *
 * SeaBIOS writes ACPI tables into guest RAM dynamically at run-time, so
 * any ROM-level patch lands at the wrong offset.  We schedule this method
 * via setTimeout after the emulator starts to give SeaBIOS time to finish
 * table construction before we walk the structures.
 *
 * Memory layout expected:
 *   RSDP  @ 0xE0000–0xFFFFF  — "RSD PTR " (8 bytes, note trailing space)
 *     +16  → 4-byte LE RsdtAddress
 *   RSDT  @ RsdtAddress
 *     +4   → 4-byte LE table length
 *     +36  → array of 4-byte table pointers (n = (length − 36) / 4)
 *   FACP  @ one of those pointers
 *     +40  → 4-byte LE DSDT physical address
 *   DSDT  @ DsdtAddress
 *     +4   → 4-byte LE table length  (updated here)
 *     +9   → 1-byte checksum         (recomputed here)
 *     +36  → AML body (we append 16 bytes here)
 *
 * The 16-byte \_S5_ AML block appended:
 *   08 5F 53 35 5F  — NameOp + "_S5_"
 *   12 0A 04        — PackageOp, PkgLength=0x0A, NumElements=4
 *   0A 05 0A 05 0A 05 0A 05 — four BytePrefix+0x05 entries (SLP_TYP=5 → S5)
 */
ACPI.prototype.patch_dsdt_s5 = function()
{
    const cpu = this.cpu;
    const mem = cpu.mem8;
    if(!mem || mem.length < 0x100000)
    {
        dbg_log("ACPI patch_dsdt_s5: mem8 not ready yet", LOG_ACPI);
        return;
    }

    // ── Demand-paging helpers ───────────────────────────────────────────────
    // SeaBIOS places ACPI tables near the top of logical_memory_size, which
    // may be far above the WASM allocation (memory_size).  When demand paging
    // is active, those GPAs are in the hot pool or SQLite — raw mem8[gpa]
    // would read out-of-bounds zeros.  Use resolveGPA to get the actual WASM
    // offset, then read/write through mem8 at that offset.
    //
    // For GPAs < memory_size, resolveGPA returns gpa unchanged — no overhead.
    const logical_limit = cpu._logical_memory_size || mem.length;

    /** Read a byte from guest physical memory, demand-paging if needed. */
    function gpa_read8(gpa)
    {
        if(gpa < mem.length) return mem[gpa];
        if(!cpu.resolveGPA) return 0xFF;
        const off = cpu.resolveGPA(gpa);
        return off >= 0 ? mem[off] : 0xFF;
    }

    /** Read a little-endian uint32 from guest physical memory. */
    function gpa_read32(gpa)
    {
        return (gpa_read8(gpa)) |
               (gpa_read8(gpa + 1) << 8) |
               (gpa_read8(gpa + 2) << 16) |
               (gpa_read8(gpa + 3) << 24);
    }

    /** Write a byte to guest physical memory, demand-paging if needed. */
    function gpa_write8(gpa, value)
    {
        if(gpa < mem.length) { mem[gpa] = value; return; }
        if(!cpu.resolveGPA) return;
        // swap_page_in with for_writing=1 to mark the frame dirty
        const page_gpa = gpa & ~0xFFF;
        let off;
        if(cpu.pool_lookup)
        {
            const frame = cpu.pool_lookup(page_gpa);
            if(frame > 0) { off = frame + (gpa & 0xFFF); }
        }
        if(off === undefined)
        {
            const frame = cpu.swap_page_in(page_gpa, 1);
            if(frame > 0) { off = frame + (gpa & 0xFFF); }
        }
        if(off !== undefined && off >= 0) mem[off] = value;
    }

    // ── 1. Locate RSDP in 0xE0000–0xFFFFF ──────────────────────────────────
    // "RSD PTR " is 8 bytes; the 8th byte is a space (0x20).
    // RSDP is always in the low BIOS region (< 1 MB) — no demand paging needed.
    const RSD_SIG = [0x52, 0x53, 0x44, 0x20, 0x50, 0x54, 0x52, 0x20]; // "RSD PTR "
    let rsdp_addr = -1;

    outer: for(let addr = 0xE0000; addr < 0x100000 - 8; addr += 16)
    {
        for(let i = 0; i < 8; i++)
        {
            if(mem[addr + i] !== RSD_SIG[i]) continue outer;
        }
        rsdp_addr = addr;
        break;
    }

    if(rsdp_addr === -1)
    {
        dbg_log("ACPI patch_dsdt_s5: RSDP not found in 0xE0000–0xFFFFF", LOG_ACPI);
        return;
    }
    dbg_log("ACPI patch_dsdt_s5: RSDP at " + h(rsdp_addr), LOG_ACPI);

    // ── 2. Read RSDT address from RSDP+16 ───────────────────────────────────
    // RSDP is in low memory, so raw mem[] is fine here.
    const rsdt_addr = gpa_read32(rsdp_addr + 16);

    if(rsdt_addr === 0 || (rsdt_addr >>> 0) >= logical_limit)
    {
        dbg_log("ACPI patch_dsdt_s5: invalid RSDT address " + h(rsdt_addr >>> 0), LOG_ACPI);
        return;
    }
    dbg_log("ACPI patch_dsdt_s5: RSDT at " + h(rsdt_addr >>> 0), LOG_ACPI);

    // Verify "RSDT" signature (RSDT may be in high memory for demand-paged images)
    if(gpa_read8(rsdt_addr)     !== 0x52 || gpa_read8(rsdt_addr + 1) !== 0x53 ||
       gpa_read8(rsdt_addr + 2) !== 0x44 || gpa_read8(rsdt_addr + 3) !== 0x54)
    {
        dbg_log("ACPI patch_dsdt_s5: RSDT signature mismatch", LOG_ACPI);
        return;
    }

    // ── 3. Walk RSDT entries looking for "FACP" ──────────────────────────────
    const rsdt_len = gpa_read32(rsdt_addr + 4);

    const entry_count = (rsdt_len - 36) >>> 2;
    let facp_addr = -1;

    for(let i = 0; i < entry_count; i++)
    {
        const ptr_off = rsdt_addr + 36 + i * 4;
        const entry = gpa_read32(ptr_off);

        if(entry === 0 || (entry >>> 0) >= logical_limit) continue;

        if(gpa_read8(entry)     === 0x46 && gpa_read8(entry + 1) === 0x41 &&
           gpa_read8(entry + 2) === 0x43 && gpa_read8(entry + 3) === 0x50) // "FACP"
        {
            facp_addr = entry;
            break;
        }
    }

    if(facp_addr === -1)
    {
        dbg_log("ACPI patch_dsdt_s5: FACP not found in RSDT", LOG_ACPI);
        return;
    }
    dbg_log("ACPI patch_dsdt_s5: FACP at " + h(facp_addr >>> 0), LOG_ACPI);

    // ── 4. Read DSDT address from FACP+40 ───────────────────────────────────
    const dsdt_addr = gpa_read32(facp_addr + 40);

    if(dsdt_addr === 0 || (dsdt_addr >>> 0) >= logical_limit)
    {
        dbg_log("ACPI patch_dsdt_s5: invalid DSDT address " + h(dsdt_addr >>> 0), LOG_ACPI);
        return;
    }
    dbg_log("ACPI patch_dsdt_s5: DSDT at " + h(dsdt_addr >>> 0), LOG_ACPI);

    // Verify "DSDT" signature
    if(gpa_read8(dsdt_addr)     !== 0x44 || gpa_read8(dsdt_addr + 1) !== 0x53 ||
       gpa_read8(dsdt_addr + 2) !== 0x44 || gpa_read8(dsdt_addr + 3) !== 0x54)
    {
        dbg_log("ACPI patch_dsdt_s5: DSDT signature mismatch", LOG_ACPI);
        return;
    }

    // ── 5. Check if \_S5_ is already present (idempotency) ──────────────────
    const dsdt_len_orig = gpa_read32(dsdt_addr + 4);

    const aml_end = dsdt_addr + dsdt_len_orig;

    // Search for _S5_ bytes (5F 53 35 5F) in AML body
    for(let a = dsdt_addr + 36; a < aml_end - 4; a++)
    {
        if(gpa_read8(a) === 0x5F && gpa_read8(a + 1) === 0x53 &&
           gpa_read8(a + 2) === 0x35 && gpa_read8(a + 3) === 0x5F)
        {
            dbg_log("ACPI patch_dsdt_s5: \\_S5_ already present, skipping patch", LOG_ACPI);
            return;
        }
    }

    // ── 6. Bounds check — ensure 16 bytes fit in guest RAM ──────────────────
    if((aml_end + 16) >>> 0 > logical_limit)
    {
        dbg_log("ACPI patch_dsdt_s5: no room to append \\S5_ AML", LOG_ACPI);
        return;
    }

    // ── 7. Append 16-byte \_S5_ AML object ──────────────────────────────────
    // 08 5F 53 35 5F  — NameOp "_S5_"
    // 12 0A 04        — PackageOp, PkgLength=0x0A (package body = 10 bytes), NumElements=4
    // 0A 05  ×4       — BytePrefix + 0x05  (SLP_TYPa/b = 5 → S5 soft-off)
    const S5_AML = [
        0x08, 0x5F, 0x53, 0x35, 0x5F,  // NameOp + "_S5_"
        0x12, 0x0A, 0x04,               // PackageOp, PkgLength, NumElements
        0x0A, 0x05, 0x0A, 0x05,         // SLP_TYPa, SLP_TYPb
        0x0A, 0x05, 0x0A, 0x05,         // Reserved entries
    ];

    for(let i = 0; i < S5_AML.length; i++)
    {
        gpa_write8(aml_end + i, S5_AML[i]);
    }

    // ── 8. Update DSDT length field (bytes 4–7, LE uint32) ──────────────────
    const new_len = dsdt_len_orig + 16;
    gpa_write8(dsdt_addr + 4, new_len & 0xFF);
    gpa_write8(dsdt_addr + 5, (new_len >>> 8) & 0xFF);
    gpa_write8(dsdt_addr + 6, (new_len >>> 16) & 0xFF);
    gpa_write8(dsdt_addr + 7, (new_len >>> 24) & 0xFF);

    // ── 9. Recompute DSDT checksum (byte 9) ─────────────────────────────────
    // The ACPI checksum covers the entire table; all bytes must sum to 0 mod 256.
    gpa_write8(dsdt_addr + 9, 0); // zero old checksum before summing
    let sum = 0;
    for(let i = 0; i < new_len; i++)
    {
        sum += gpa_read8(dsdt_addr + i);
    }
    gpa_write8(dsdt_addr + 9, (256 - (sum & 0xFF)) & 0xFF);

    dbg_log(
        "ACPI patch_dsdt_s5: appended \\_S5_ AML at " + h(aml_end >>> 0) +
        ", DSDT len " + h(dsdt_len_orig >>> 0) + " → " + h(new_len >>> 0),
        LOG_ACPI
    );
    return true;
};

ACPI.prototype.get_state = function()
{
    var state = [];
    state[0] = this.status;
    state[1] = this.pm1_status;
    state[2] = this.pm1_enable;
    state[3] = this.gpe;
    return state;
};

ACPI.prototype.set_state = function(state)
{
    this.status = state[0];
    this.pm1_status = state[1];
    this.pm1_enable = state[2];
    this.gpe = state[3];
};

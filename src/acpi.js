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
    const mem = this.cpu.mem8;
    if(!mem || mem.length < 0x100000)
    {
        dbg_log("ACPI patch_dsdt_s5: mem8 not ready yet", LOG_ACPI);
        return;
    }

    // ── 1. Locate RSDP in 0xE0000–0xFFFFF ──────────────────────────────────
    // "RSD PTR " is 8 bytes; the 8th byte is a space (0x20).
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
    const rsdt_addr =
        mem[rsdp_addr + 16] |
        (mem[rsdp_addr + 17] << 8) |
        (mem[rsdp_addr + 18] << 16) |
        (mem[rsdp_addr + 19] << 24);

    if(rsdt_addr === 0 || rsdt_addr >= mem.length)
    {
        dbg_log("ACPI patch_dsdt_s5: invalid RSDT address " + h(rsdt_addr >>> 0), LOG_ACPI);
        return;
    }
    dbg_log("ACPI patch_dsdt_s5: RSDT at " + h(rsdt_addr >>> 0), LOG_ACPI);

    // Verify "RSDT" signature
    if(mem[rsdt_addr]     !== 0x52 || mem[rsdt_addr + 1] !== 0x53 ||
       mem[rsdt_addr + 2] !== 0x44 || mem[rsdt_addr + 3] !== 0x54)
    {
        dbg_log("ACPI patch_dsdt_s5: RSDT signature mismatch", LOG_ACPI);
        return;
    }

    // ── 3. Walk RSDT entries looking for "FACP" ──────────────────────────────
    const rsdt_len =
        mem[rsdt_addr + 4] |
        (mem[rsdt_addr + 5] << 8) |
        (mem[rsdt_addr + 6] << 16) |
        (mem[rsdt_addr + 7] << 24);

    const entry_count = (rsdt_len - 36) >>> 2;
    let facp_addr = -1;

    for(let i = 0; i < entry_count; i++)
    {
        const ptr_off = rsdt_addr + 36 + i * 4;
        const entry =
            mem[ptr_off] |
            (mem[ptr_off + 1] << 8) |
            (mem[ptr_off + 2] << 16) |
            (mem[ptr_off + 3] << 24);

        if(entry === 0 || entry >= mem.length) continue;

        if(mem[entry]     === 0x46 && mem[entry + 1] === 0x41 &&
           mem[entry + 2] === 0x43 && mem[entry + 3] === 0x50) // "FACP"
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
    const dsdt_addr =
        mem[facp_addr + 40] |
        (mem[facp_addr + 41] << 8) |
        (mem[facp_addr + 42] << 16) |
        (mem[facp_addr + 43] << 24);

    if(dsdt_addr === 0 || dsdt_addr >= mem.length)
    {
        dbg_log("ACPI patch_dsdt_s5: invalid DSDT address " + h(dsdt_addr >>> 0), LOG_ACPI);
        return;
    }
    dbg_log("ACPI patch_dsdt_s5: DSDT at " + h(dsdt_addr >>> 0), LOG_ACPI);

    // Verify "DSDT" signature
    if(mem[dsdt_addr]     !== 0x44 || mem[dsdt_addr + 1] !== 0x53 ||
       mem[dsdt_addr + 2] !== 0x44 || mem[dsdt_addr + 3] !== 0x54)
    {
        dbg_log("ACPI patch_dsdt_s5: DSDT signature mismatch", LOG_ACPI);
        return;
    }

    // ── 5. Check if \_S5_ is already present (idempotency) ──────────────────
    const dsdt_len_orig =
        mem[dsdt_addr + 4] |
        (mem[dsdt_addr + 5] << 8) |
        (mem[dsdt_addr + 6] << 16) |
        (mem[dsdt_addr + 7] << 24);

    const aml_end = dsdt_addr + dsdt_len_orig;

    // Search for _S5_ bytes (5F 53 35 5F) in AML body
    for(let a = dsdt_addr + 36; a < aml_end - 4; a++)
    {
        if(mem[a] === 0x5F && mem[a + 1] === 0x53 &&
           mem[a + 2] === 0x35 && mem[a + 3] === 0x5F)
        {
            dbg_log("ACPI patch_dsdt_s5: \\_S5_ already present, skipping patch", LOG_ACPI);
            return;
        }
    }

    // ── 6. Bounds check — ensure 16 bytes fit in guest RAM ──────────────────
    if(aml_end + 16 > mem.length)
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
        mem[aml_end + i] = S5_AML[i];
    }

    // ── 8. Update DSDT length field (bytes 4–7, LE uint32) ──────────────────
    const new_len = dsdt_len_orig + 16;
    mem[dsdt_addr + 4] = new_len & 0xFF;
    mem[dsdt_addr + 5] = (new_len >>> 8) & 0xFF;
    mem[dsdt_addr + 6] = (new_len >>> 16) & 0xFF;
    mem[dsdt_addr + 7] = (new_len >>> 24) & 0xFF;

    // ── 9. Recompute DSDT checksum (byte 9) ─────────────────────────────────
    // The ACPI checksum covers the entire table; all bytes must sum to 0 mod 256.
    mem[dsdt_addr + 9] = 0; // zero old checksum before summing
    let sum = 0;
    for(let i = 0; i < new_len; i++)
    {
        sum += mem[dsdt_addr + i];
    }
    mem[dsdt_addr + 9] = (256 - (sum & 0xFF)) & 0xFF;

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

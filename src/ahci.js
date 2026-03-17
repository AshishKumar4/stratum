/**
 * AHCI (Advanced Host Controller Interface) Disk Controller Emulation for v86
 * 
 * This implements a complete AHCI controller with SMP support, building on the 
 * enhanced APIC system from Phase 2 and SMP architecture from Phase 3.
 * 
 * References:
 * - AHCI Specification Revision 1.3.1 (June 27, 2008)
 * - Serial ATA AHCI Specification, Rev. 1.3
 * - Intel® I/O Controller Hub 9 (ICH9) Family Datasheet
 */

import { LOG_DISK } from "./const.js";
import { h } from "./lib.js";
import { dbg_assert, dbg_log } from "./log.js";
import { AHCICommandProcessor } from "./ahci_protocol.js";
import { AHCISMPMemoryManager, AHCIDMAManager } from "./ahci_smp_integration.js";
import { AHCIMSIManager } from "./ahci_msi.js";
import { VirtualDiskManager } from "./ahci_virtual_disk.js";

// For Types Only
import { CPU } from "./cpu.js";
import { BusConnector } from "./bus.js";

// AHCI Memory Layout (as designed in ahci_memory_layout_design.md)
export const AHCI_MEM_ADDRESS = 0xFEA00000;    // BAR5 - HBA registers (below VGA ROM at 0xFEB00000)
export const AHCI_MEM_SIZE = 0x1000;           // 4KB

// AHCI memory regions in system RAM
const AHCI_COMMAND_LISTS_BASE = 0x03040000;    // 4KB - Command lists
const AHCI_COMMAND_TABLES_BASE = 0x03041000;   // 60KB - Command tables  
const AHCI_DATA_BUFFERS_BASE = 0x03050000;     // 3.75MB - DMA buffers
const AHCI_FIS_BUFFERS_BASE = 0x03400000;      // 4KB - FIS buffers

// AHCI Constants
const AHCI_MAX_PORTS = 32;
const AHCI_MAX_CMDS = 32;
const AHCI_CMD_SLOT_SIZE = 32;      // bytes per command slot
const AHCI_CMD_TBL_SIZE = 256;      // bytes per command table (minimum)
const AHCI_FIS_SIZE = 256;          // bytes per FIS buffer

// HBA Global Register Offsets
const HBA_CAP     = 0x00;   // Host Capabilities
const HBA_GHC     = 0x04;   // Global Host Control  
const HBA_IS      = 0x08;   // Interrupt Status
const HBA_PI      = 0x0C;   // Ports Implemented
const HBA_VS      = 0x10;   // Version
const HBA_CCC_CTL = 0x14;   // Command Completion Coalescing Control
const HBA_CCC_PORTS = 0x18; // Command Completion Coalescing Ports
const HBA_EM_LOC  = 0x1C;   // Enclosure Management Location
const HBA_EM_CTL  = 0x20;   // Enclosure Management Control
const HBA_CAP2    = 0x24;   // Host Capabilities Extended
const HBA_BOHC    = 0x28;   // BIOS/OS Handoff Control and Status

// Port Register Offsets (relative to port base)
const PORT_CLB     = 0x00;  // Command List Base Address
const PORT_CLBU    = 0x04;  // Command List Base Address Upper 32-bits
const PORT_FB      = 0x08;  // FIS Base Address
const PORT_FBU     = 0x0C;  // FIS Base Address Upper 32-bits
const PORT_IS      = 0x10;  // Interrupt Status
const PORT_IE      = 0x14;  // Interrupt Enable
const PORT_CMD     = 0x18;  // Command and Status
const PORT_TFD     = 0x20;  // Task File Data
const PORT_SIG     = 0x24;  // Signature
const PORT_SSTS    = 0x28;  // SATA Status (SCR0: SStatus)
const PORT_SCTL    = 0x2C;  // SATA Control (SCR2: SControl)
const PORT_SERR    = 0x30;  // SATA Error (SCR1: SError)
const PORT_SACT    = 0x34;  // SATA Active (SCR3: SActive)
const PORT_CI      = 0x38;  // Command Issue
const PORT_SNTF    = 0x3C;  // SATA Notification (SCR4: SNotification)

// Host Capabilities (CAP) register bits
const CAP_NP_MASK     = 0x1F;      // Number of Ports
const CAP_SXS         = (1 << 5);  // Supports External SATA
const CAP_EMS         = (1 << 6);  // Enclosure Management Supported
const CAP_CCCS        = (1 << 7);  // Command Completion Coalescing Supported
const CAP_NCS_MASK    = 0x1F00;    // Number of Command Slots
const CAP_NCS_SHIFT   = 8;
const CAP_PSC         = (1 << 13); // Partial State Capable
const CAP_SSC         = (1 << 14); // Slumber State Capable
const CAP_PMD         = (1 << 15); // PIO Multiple DRQ Block
const CAP_FBSS        = (1 << 16); // FIS-based Switching Supported
const CAP_SPM         = (1 << 17); // Supports Port Multiplier
const CAP_SAM         = (1 << 18); // Supports AHCI mode only
const CAP_SNZO        = (1 << 19); // Supports Non-Zero DMA Offsets
const CAP_ISS_MASK    = 0xF00000;  // Interface Speed Support
const CAP_ISS_SHIFT   = 20;
const CAP_SCLO        = (1 << 24); // Supports Command List Override
const CAP_SAL         = (1 << 25); // Supports Activity LED
const CAP_SALP        = (1 << 26); // Supports Aggressive Link Power Management
const CAP_SSS         = (1 << 27); // Supports Staggered Spin-up
const CAP_SMPS        = (1 << 28); // Supports Mechanical Presence Switch
const CAP_SSNTF       = (1 << 29); // Supports SNotification Register
const CAP_SNCQ        = (1 << 30); // Supports Native Command Queuing
const CAP_S64A        = (1 << 31); // Supports 64-bit Addressing

// Global Host Control (GHC) register bits
const GHC_HR          = (1 << 0);  // HBA Reset
const GHC_IE          = (1 << 1);  // Interrupt Enable
const GHC_MRSM        = (1 << 2);  // MSI Revert to Single Message
const GHC_AE          = (1 << 31); // AHCI Enable

// Port Command (CMD) register bits
const CMD_ST          = (1 << 0);  // Start
const CMD_SUD         = (1 << 1);  // Spin-Up Device
const CMD_POD         = (1 << 2);  // Power On Device
const CMD_CLO         = (1 << 3);  // Command List Override
const CMD_FRE         = (1 << 4);  // FIS Receive Enable
const CMD_CCS_MASK    = 0x1F00;    // Current Command Slot
const CMD_CCS_SHIFT   = 8;
const CMD_MPSS        = (1 << 13); // Mechanical Presence Switch State
const CMD_FR          = (1 << 14); // FIS Receive Running
const CMD_CR          = (1 << 15); // Command List Running
const CMD_CPS         = (1 << 16); // Cold Presence State
const CMD_PMA         = (1 << 17); // Port Multiplier Attached
const CMD_HPCP        = (1 << 18); // Hot Plug Capable Port
const CMD_MPSP        = (1 << 19); // Mechanical Presence Switch Present
const CMD_CPD         = (1 << 20); // Cold Presence Detection
const CMD_ESP         = (1 << 21); // External SATA Port
const CMD_FBSCP       = (1 << 22); // FIS-based Switching Capable Port
const CMD_APSTE       = (1 << 23); // Automatic Partial to Slumber Transition Enable
const CMD_ATAPI       = (1 << 24); // Device is ATAPI
const CMD_DLAE        = (1 << 25); // Drive LED on ATAPI Enable
const CMD_ALPE        = (1 << 26); // Aggressive Link Power Management Enable
const CMD_ASP         = (1 << 27); // Aggressive Slumber / Partial
const CMD_ICC_MASK    = 0xF0000000; // Interface Communication Control
const CMD_ICC_SHIFT   = 28;

// Port Task File Data (TFD) register bits
const TFD_STS_MASK    = 0xFF;      // Status
const TFD_ERR_MASK    = 0xFF00;    // Error
const TFD_ERR_SHIFT   = 8;

// Port Interrupt Status/Enable register bits
const PORT_IRQ_DHRS   = (1 << 0);  // Device to Host Register FIS
const PORT_IRQ_PSS    = (1 << 1);  // PIO Setup FIS
const PORT_IRQ_DSS    = (1 << 2);  // DMA Setup FIS  
const PORT_IRQ_SDBS   = (1 << 3);  // Set Device Bits FIS
const PORT_IRQ_UFS    = (1 << 4);  // Unknown FIS
const PORT_IRQ_DPS    = (1 << 5);  // Descriptor Processed
const PORT_IRQ_PCS    = (1 << 6);  // Port Connect Change Status
const PORT_IRQ_DMPS   = (1 << 7);  // Device Mechanical Presence Status
const PORT_IRQ_PRCS   = (1 << 22); // PhyRdy Change Status  
const PORT_IRQ_IPMS   = (1 << 23); // Incorrect Port Multiplier Status
const PORT_IRQ_OFS    = (1 << 24); // Overflow Status
const PORT_IRQ_INFS   = (1 << 26); // Interface Non-Fatal Error Status
const PORT_IRQ_IFS    = (1 << 27); // Interface Fatal Error Status
const PORT_IRQ_HBDS   = (1 << 28); // Host Bus Data Error Status
const PORT_IRQ_HBFS   = (1 << 29); // Host Bus Fatal Error Status
const PORT_IRQ_TFES   = (1 << 30); // Task File Error Status
const PORT_IRQ_CPDS   = (1 << 31); // Cold Port Detect Status

// SATA Status (SSTS) register bits
const SSTS_DET_MASK   = 0xF;       // Device Detection
const SSTS_SPD_MASK   = 0xF0;      // Current Interface Speed
const SSTS_IPM_MASK   = 0xF00;     // Interface Power Management

// SATA Signature values
const SIG_ATA         = 0x00000101; // SATA drive
const SIG_ATAPI       = 0xEB140101; // SATAPI drive
const SIG_SEMB        = 0xC33C0101; // Enclosure management bridge
const SIG_PM          = 0x96690101; // Port multiplier

// FIS Types
const FIS_TYPE_REG_H2D    = 0x27;  // Register FIS - host to device
const FIS_TYPE_REG_D2H    = 0x34;  // Register FIS - device to host
const FIS_TYPE_DMA_ACT    = 0x39;  // DMA activate FIS - device to host
const FIS_TYPE_DMA_SETUP  = 0x41;  // DMA setup FIS - bidirectional
const FIS_TYPE_DATA       = 0x46;  // Data FIS - bidirectional
const FIS_TYPE_BIST       = 0x58;  // BIST activate FIS - bidirectional
const FIS_TYPE_PIO_SETUP  = 0x5F;  // PIO setup FIS - device to host
const FIS_TYPE_DEV_BITS   = 0xA1;  // Set device bits FIS - device to host

/**
 * AHCI Controller - Main class implementing the AHCI Host Bus Adapter
 * 
 * @constructor
 * @param {CPU} cpu
 * @param {BusConnector} bus
 */
export function AHCIController(cpu, bus, disk_options) {
    /** @const @type {CPU} */
    this.cpu = cpu;
    
    /** @const @type {BusConnector} */
    this.bus = bus;

    /** @type {Object} disk image options (hda, hdb buffers) */
    this.disk_options = disk_options || {};
    
    // HBA Global Registers
    this.cap = 0;           // Host Capabilities
    this.ghc = 0;           // Global Host Control
    this.is = 0;            // Interrupt Status
    this.pi = 0;            // Ports Implemented
    this.vs = 0;            // Version
    this.ccc_ctl = 0;       // Command Completion Coalescing Control
    this.ccc_ports = 0;     // Command Completion Coalescing Ports
    this.em_loc = 0;        // Enclosure Management Location
    this.em_ctl = 0;        // Enclosure Management Control
    this.cap2 = 0;          // Host Capabilities Extended
    this.bohc = 0;          // BIOS/OS Handoff Control
    
    // Ports (up to 32, but typically 4-8)
    this.num_ports = 4;     // Start with 4 ports
    this.ports = [];
    
    for (let i = 0; i < this.num_ports; i++) {
        this.ports[i] = new AHCIPort(this, i);
        this.ports[i].cmd_processor.port = this.ports[i];
    }
    
    // Initialize HBA capabilities
    this.init_hba_capabilities();
    
    // Register as PCI device
    this.init_pci_device();
    
    // Register memory-mapped I/O
    this.init_mmio();
    
    // Initialize SMP support
    this.init_smp_support();
    
    // Initialize SMP memory manager
    this.smp_memory_manager = new AHCISMPMemoryManager(this.cpu, this.cpu.shared_memory);
    
    // Initialize DMA manager
    this.dma_manager = new AHCIDMAManager(this.smp_memory_manager, this.cpu);
    
    // Initialize MSI manager
    this.msi_manager = new AHCIMSIManager(this);
    
    // Initialize virtual disk manager
    this.disk_manager = new VirtualDiskManager();
    
    // Create default disks for each port
    this.init_default_disks();
    
    dbg_log("AHCI Controller initialized with " + this.num_ports + " ports", LOG_DISK);
}

/**
 * Initialize HBA capabilities and version information
 */
AHCIController.prototype.init_hba_capabilities = function() {
    // Host Capabilities (CAP)
    this.cap = (
        ((this.num_ports - 1) & CAP_NP_MASK) |           // Number of ports
        ((AHCI_MAX_CMDS - 1) << CAP_NCS_SHIFT) |         // Number of command slots  
        CAP_SNCQ |                                       // Native Command Queuing
        CAP_SSNTF |                                      // SNotification Register
        CAP_SALP |                                       // Aggressive Link PM
        CAP_SAL |                                        // Activity LED
        (0x3 << CAP_ISS_SHIFT) |                        // 6 Gbps interface speed
        CAP_PMD |                                        // PIO Multiple DRQ
        CAP_SSC |                                        // Slumber State Capable
        CAP_PSC                                          // Partial State Capable
    );
    
    // Host Capabilities Extended (CAP2)
    this.cap2 = 0; // Basic implementation for now
    
    // Version (VS) - AHCI 1.3.1
    this.vs = 0x00010301;
    
    // Ports Implemented (PI) - set after init_default_disks wires devices
    this.pi = 0;  // Updated in init_default_disks
    
    // Global Host Control (GHC) - AHCI enabled by default
    this.ghc = GHC_AE;
};

/**
 * Initialize PCI device configuration.
 *
 * Device: Intel ICH9 AHCI controller (82801IR/IO/IH)
 *   Vendor 0x8086, Device 0x2922, Class 0x01, Subclass 0x06, ProgIF 0x01
 *
 * BAR5 holds the AHCI ABAR (Host Bus Adapter Registers) at AHCI_MEM_ADDRESS.
 * The value stored in the pci_space bytes for BAR5 must be the raw MMIO base
 * address as a 32-bit little-endian value with bit 0 = 0 (memory, not I/O).
 *
 * Layout of pci_space (256 bytes = 64 dwords, matches v86 register_device):
 *   Bytes 0x00-0x0F  Standard PCI header
 *   Bytes 0x10-0x27  BAR0..BAR5
 *   Bytes 0x28-0x3F  CIS, subsys, ROM, caps ptr, reserved, intline/pin
 *   Bytes 0x40-0xFF  Device-specific / padding
 */
AHCIController.prototype.init_pci_device = function() {
    this.name = "ahci";

    // BDF: device 31 (0x1F), function 0  →  pci_id = 0xF8
    // (0x1F << 3 | 0 = 0xF8; v86 uses bdf directly as the device index)
    this.pci_id = 0x1F << 3;

    // BAR5 base address for the AHCI ABAR MMIO region.
    // Memory BAR: bit0 = 0, bits 3:1 = 00 (32-bit, non-prefetchable)
    const bar5_lo = (AHCI_MEM_ADDRESS & 0xFF);
    const bar5_hi1 = (AHCI_MEM_ADDRESS >> 8) & 0xFF;
    const bar5_hi2 = (AHCI_MEM_ADDRESS >> 16) & 0xFF;
    const bar5_hi3 = (AHCI_MEM_ADDRESS >> 24) & 0xFF;

    // Build 256-byte PCI config space (little-endian, as expected by v86's
    // register_device which does: new Int32Array(new Uint8Array(pci_space).buffer))
    this.pci_space = [
        // 0x00: Vendor ID = 0x8086 (Intel)
        0x86, 0x80,
        // 0x02: Device ID = 0x2922 (ICH9 AHCI)
        0x22, 0x29,
        // 0x04: Command = Bus Master + Memory Space (0x0006)
        0x06, 0x00,
        // 0x06: Status = capabilities list present (0x0010)
        0x10, 0x00,
        // 0x08: Revision ID = 0x02
        0x02,
        // 0x09: Programming Interface = 0x01 (AHCI 1.0)
        0x01,
        // 0x0A: Subclass = 0x06 (SATA)
        0x06,
        // 0x0B: Class code = 0x01 (Mass Storage)
        0x01,
        // 0x0C: Cache Line Size
        0x00,
        // 0x0D: Latency Timer
        0x00,
        // 0x0E: Header Type = 0x00 (standard, single function)
        0x00,
        // 0x0F: BIST
        0x00,

        // 0x10: BAR0 – not used (0)
        0x00, 0x00, 0x00, 0x00,
        // 0x14: BAR1 – not used (0)
        0x00, 0x00, 0x00, 0x00,
        // 0x18: BAR2 – not used (0)
        0x00, 0x00, 0x00, 0x00,
        // 0x1C: BAR3 – not used (0)
        0x00, 0x00, 0x00, 0x00,
        // 0x20: BAR4 – not used (0)
        0x00, 0x00, 0x00, 0x00,
        // 0x24: BAR5 – AHCI ABAR (memory, 32-bit, non-prefetchable)
        bar5_lo, bar5_hi1, bar5_hi2, bar5_hi3,

        // 0x28: CardBus CIS pointer
        0x00, 0x00, 0x00, 0x00,
        // 0x2C: Subsystem Vendor ID = 0x8086
        0x86, 0x80,
        // 0x2E: Subsystem ID = 0x2922
        0x22, 0x29,
        // 0x30: Expansion ROM base (disabled)
        0x00, 0x00, 0x00, 0x00,
        // 0x34: Capabilities pointer = 0x80
        0x80, 0x00, 0x00, 0x00,
        // 0x38: Reserved
        0x00, 0x00, 0x00, 0x00,
        // 0x3C: Interrupt Line = 0x0B (IRQ 11), Interrupt Pin = 0x01 (INTA#)
        0x0B, 0x01,
        // 0x3E: Min Grant, Max Latency
        0x00, 0x00,

        // 0x40 onwards – device-specific / capabilities / padding
        // 64 bytes of capability area + 128 bytes padding = 192 bytes → total = 64+192=256
        ...new Array(192).fill(0),
    ];

    // pci_bars: only BAR5 is a memory BAR for our MMIO region.
    // The size field is used by v86 for size-probing responses (write 0xFFFFFFFF → read back ~(size-1)).
    // Our ABAR is 4KB per AHCI spec, but v86's mmap granularity is 128KB.
    // We advertise 4KB to the guest (AHCI spec), but register 128KB for mmap.
    this.pci_bars = [
        undefined, // BAR0
        undefined, // BAR1
        undefined, // BAR2
        undefined, // BAR3
        undefined, // BAR4
        { size: AHCI_MEM_SIZE }, // BAR5: AHCI ABAR
    ];

    // Register with v86 PCI subsystem
    this.cpu.devices.pci.register_device(this);
    this.cpu.devices.ahci = this;
};

/**
 * Initialize memory-mapped I/O regions.
 *
 * v86's mmap system operates at MMAP_BLOCK_SIZE (128KB) granularity.
 * We register one 128KB block covering AHCI_MEM_ADDRESS.
 *
 * IMPORTANT: the mmap callbacks are called differently depending on access size:
 *   - 8-bit  accesses call read8/write8 directly
 *   - 32-bit accesses call the shim which calls read8 four times UNLESS
 *     we provide explicit read32/write32 callbacks
 *
 * Since all AHCI registers are 32-bit dwords, we must provide read32/write32
 * callbacks. The 8-bit shims decompose the dword using byte offsets.
 */
AHCIController.prototype.init_mmio = function() {
    // 128KB-aligned base that contains our 4KB AHCI register window.
    // MMAP_BLOCK_SIZE = 1 << 17 = 0x20000 (128KB)
    const MMAP_BLOCK_SIZE = 1 << 17;
    const mmap_base = AHCI_MEM_ADDRESS & ~(MMAP_BLOCK_SIZE - 1);  // 0xFE800000 or similar

    // 32-bit read: addr is the FULL guest physical address (dword-aligned).
    // v86 passes addr as a signed i32 from WASM, so addresses >= 0x80000000
    // appear negative in JS.  Use >>> 0 to treat as unsigned before subtraction.
    const abar = AHCI_MEM_ADDRESS >>> 0;
    const read32 = (addr) => {
        const offset = (addr >>> 0) - abar;
        if (offset < 0 || offset >= AHCI_MEM_SIZE) {
            return 0;
        }
        return this.read_hba_register(offset) >>> 0;
    };

    // 32-bit write: same unsigned treatment
    const write32 = (addr, value) => {
        const offset = (addr >>> 0) - abar;
        if (offset < 0 || offset >= AHCI_MEM_SIZE) return;
        this.write_hba_register(offset, value);
    };

    // 8-bit read shim (for byte accesses): extract byte from dword register
    const read8 = (addr) => {
        const dword_addr = addr & ~3;
        const byte_shift = (addr & 3) << 3;
        const dword_val = read32(dword_addr);
        return (dword_val >> byte_shift) & 0xFF;
    };

    // 8-bit write shim (for byte accesses): read-modify-write dword register
    const write8 = (addr, value) => {
        const dword_addr = addr & ~3;
        const byte_shift = (addr & 3) << 3;
        const old_val = read32(dword_addr);
        const new_val = (old_val & ~(0xFF << byte_shift)) | ((value & 0xFF) << byte_shift);
        write32(dword_addr, new_val);
    };

    // Register MMIO for the full 128KB block containing our AHCI registers.
    // The size must be a multiple of MMAP_BLOCK_SIZE.
    this.cpu.io.mmap_register(
        mmap_base,
        MMAP_BLOCK_SIZE,
        read8,
        write8,
        read32,
        write32
    );

    dbg_log("AHCI: MMIO registered at " + h(mmap_base >>> 0, 8) +
            " covering ABAR at " + h(AHCI_MEM_ADDRESS >>> 0, 8), LOG_DISK);
};

/**
 * Initialize SMP support and shared memory regions
 */
AHCIController.prototype.init_smp_support = function() {
    // Check if SMP is enabled (if SharedArrayBuffer is available)
    this.smp_enabled = typeof SharedArrayBuffer !== 'undefined' && 
                       typeof this.cpu.shared_memory !== 'undefined';
    
    if (this.smp_enabled) {
        dbg_log("AHCI: SMP support enabled with SharedArrayBuffer", LOG_DISK);
        this.init_shared_memory_regions();
    } else {
        dbg_log("AHCI: Running in single-CPU mode", LOG_DISK);
    }
    
    // Initialize per-CPU command slot allocation
    this.cpu_slot_allocation = new Array(8).fill(0);  // Support up to 8 CPUs
    this.cpu_id = this.cpu.cpu_id || 0;  // Default to CPU 0 if not SMP
};

/**
 * Initialize shared memory regions for SMP operation
 */
AHCIController.prototype.init_shared_memory_regions = function() {
    // In a real implementation, these would be allocated in the SharedArrayBuffer
    // For now, we simulate the layout for compatibility
    this.shared_command_lists = new Uint32Array(AHCI_MAX_PORTS * AHCI_MAX_CMDS * 8);
    this.shared_fis_buffers = new Uint8Array(AHCI_MAX_PORTS * AHCI_FIS_SIZE);
    this.shared_slot_status = new Int32Array(AHCI_MAX_PORTS * AHCI_MAX_CMDS);
    
    dbg_log("AHCI: Shared memory regions initialized", LOG_DISK);
};

/**
 * Initialize virtual disks for AHCI ports.
 *
 * Priority for port 0:
 *   1. opts.hda buffer (passed from V86 hda option) — pre-loaded disk image
 *   2. opts.ahci_disk_size — blank RAM disk of specified size (for AqFS2 etc.)
 *   3. Default: blank 32MB RAM disk so ssts/sig are valid and port is usable
 */
AHCIController.prototype.init_default_disks = function() {
    const opts = this.disk_options || {};
    const DEFAULT_DISK_SIZE = 32 * 1024 * 1024;  // 32MB

    // --- Port 0 ---
    if (opts.hda) {
        // Use provided disk image buffer (e.g. loaded from URL via V86 hda option)
        this.disk_manager.create_disk(0, "buffer", { buffer: opts.hda });
        dbg_log("AHCI: Port 0 using hda buffer (" + opts.hda.byteLength + " bytes)", LOG_DISK);
    } else {
        // Blank RAM disk: Aqeous will initialise its own AqFS2 filesystem on it.
        const disk_size = (opts.ahci_disk_size > 0) ? opts.ahci_disk_size : DEFAULT_DISK_SIZE;
        this.disk_manager.create_disk(0, "ram", { size: disk_size });
        dbg_log("AHCI: Port 0 using blank " + (disk_size >> 20) + "MB RAM disk", LOG_DISK);
    }

    // --- Port 1 (optional) ---
    if (this.num_ports > 1) {
        if (opts.hdb) {
            this.disk_manager.create_disk(1, "buffer", { buffer: opts.hdb });
            dbg_log("AHCI: Port 1 using hdb buffer", LOG_DISK);
        } else {
            this.disk_manager.create_disk(1, "ram", { size: DEFAULT_DISK_SIZE });
        }
    }

    // Wire disks into the port command processors
    for (let i = 0; i < this.num_ports; i++) {
        const disk = this.disk_manager.get_disk(i);
        if (disk && this.ports[i].cmd_processor) {
            this.ports[i].cmd_processor.virtual_disk = disk;
            this.ports[i].cmd_processor.disk_size = disk.size;
            this.ports[i].has_device = true;
        }
    }


    // Update PI to only advertise ports with actual devices
    this.pi = 0;
    let device_count = 0;
    for (let i = 0; i < this.num_ports; i++) {
        if (this.ports[i] && this.ports[i].has_device) {
            this.pi |= (1 << i);
            device_count++;
        }
    }
    // Update CAP.NP to match actual device count
    this.cap = (this.cap & ~0x1F) | ((device_count > 0 ? device_count - 1 : 0) & 0x1F);
    dbg_log("AHCI: PI=" + this.pi.toString(16) + " (" + device_count + " devices)", LOG_DISK);
    dbg_log("AHCI: Virtual disks initialized", LOG_DISK);
};

/**
 * Read from HBA registers
 * @param {number} offset - Register offset within AHCI MMIO space
 * @returns {number} Register value
 */
AHCIController.prototype.read_hba_register = function(offset) {
    dbg_log("AHCI HBA READ offset=" + offset.toString(16), LOG_DISK);
    // Global HBA registers
    if (offset < 0x100) {
        let val;
        switch (offset) {
            case HBA_CAP:     val = this.cap; break;
            case HBA_GHC:     val = this.ghc; break;
            case HBA_IS:      val = this.is; break;
            case HBA_PI:      val = this.pi; break;
            case HBA_VS:      val = this.vs; break;
            case HBA_CCC_CTL: val = this.ccc_ctl; break;
            case HBA_CCC_PORTS: val = this.ccc_ports; break;
            case HBA_EM_LOC:  val = this.em_loc; break;
            case HBA_EM_CTL:  val = this.em_ctl; break;
            case HBA_CAP2:    val = this.cap2; break;
            case HBA_BOHC:    val = this.bohc; break;
            default:
                dbg_log("AHCI: Unknown HBA register read at offset " + h(offset), LOG_DISK);
                return 0;
        }
        return val;
    }
    
    // Port registers (0x100 + port_num * 0x80)
    const port_num = (offset - 0x100) >> 7;  // Divide by 0x80
    const port_offset = (offset - 0x100) & 0x7F;  // Modulo 0x80
    
    if (port_num >= this.num_ports) {
        dbg_log("AHCI: Invalid port " + port_num + " register read", LOG_DISK);
        return 0;
    }
    
    return this.ports[port_num].read_register(port_offset);
};

/**
 * Write to HBA registers
 * @param {number} offset - Register offset within AHCI MMIO space  
 * @param {number} value - Value to write
 */
AHCIController.prototype.write_hba_register = function(offset, value) {
    dbg_log("AHCI HBA WRITE offset=" + offset.toString(16) + " value=" + value.toString(16), LOG_DISK);
    // Global HBA registers
    if (offset < 0x100) {
        switch (offset) {
            case HBA_CAP:
                // Read-only register
                dbg_log("AHCI: Attempt to write read-only CAP register", LOG_DISK);
                break;
                
            case HBA_GHC:
                this.write_global_host_control(value);
                break;
                
            case HBA_IS:
                // Write 1 to clear interrupt status bits
                this.is &= ~value;
                this.update_global_interrupt();
                break;
                
            case HBA_PI:
                // Read-only register
                dbg_log("AHCI: Attempt to write read-only PI register", LOG_DISK);
                break;
                
            case HBA_VS:
                // Read-only register  
                dbg_log("AHCI: Attempt to write read-only VS register", LOG_DISK);
                break;
                
            case HBA_CCC_CTL:
                this.ccc_ctl = value;
                break;
                
            case HBA_CCC_PORTS:
                this.ccc_ports = value;
                break;
                
            case HBA_EM_LOC:
                this.em_loc = value;
                break;
                
            case HBA_EM_CTL:
                this.em_ctl = value;
                break;
                
            case HBA_CAP2:
                // Read-only register
                dbg_log("AHCI: Attempt to write read-only CAP2 register", LOG_DISK);
                break;
                
            case HBA_BOHC:
                this.bohc = value;
                break;
                
            default:
                dbg_log("AHCI: Unknown HBA register write at offset " + h(offset) + " value " + h(value), LOG_DISK);
                break;
        }
        return;
    }
    
    // Port registers (0x100 + port_num * 0x80)
    const port_num = (offset - 0x100) >> 7;  // Divide by 0x80
    const port_offset = (offset - 0x100) & 0x7F;  // Modulo 0x80
    
    if (port_num >= this.num_ports) {
        dbg_log("AHCI: Invalid port " + port_num + " register write", LOG_DISK);
        return;
    }
    
    this.ports[port_num].write_register(port_offset, value);
};

/**
 * Handle Global Host Control register writes
 * @param {number} value - Value written to GHC register
 */
AHCIController.prototype.write_global_host_control = function(value) {
    const old_ghc = this.ghc;
    
    // Handle HBA Reset
    if (value & GHC_HR) {
        dbg_log("AHCI: HBA Reset requested", LOG_DISK);
        this.reset_hba();
        return;
    }
    
    // Update register value
    this.ghc = (value & ~GHC_HR) | GHC_AE;  // Always keep AHCI enabled
    
    // Handle interrupt enable/disable
    if ((this.ghc & GHC_IE) && !(old_ghc & GHC_IE)) {
        dbg_log("AHCI: Global interrupts enabled", LOG_DISK);
        this.update_global_interrupt();
    } else if (!(this.ghc & GHC_IE) && (old_ghc & GHC_IE)) {
        dbg_log("AHCI: Global interrupts disabled", LOG_DISK);
        this.clear_global_interrupt();
    }
};

/**
 * Reset the entire HBA to initial state
 */
AHCIController.prototype.reset_hba = function() {
    dbg_log("AHCI: Performing HBA reset", LOG_DISK);
    
    // Reset global registers
    this.ghc = GHC_AE;  // Keep AHCI enabled
    this.is = 0;
    this.ccc_ctl = 0;
    this.ccc_ports = 0;
    this.em_ctl = 0;
    this.bohc = 0;
    
    // Reset all ports
    for (let i = 0; i < this.num_ports; i++) {
        this.ports[i].reset();
    }
    
    // Clear global interrupt
    this.clear_global_interrupt();
};

/**
 * Update global interrupt status and deliver if needed
 */
AHCIController.prototype.update_global_interrupt = function() {
    if (!(this.ghc & GHC_IE) || this.is === 0) {
        return;  // Interrupts disabled or no pending interrupts
    }
    
    // Deliver MSI interrupt or raise PCI interrupt
    this.deliver_interrupt();
};

/**
 * Clear global interrupt
 */
AHCIController.prototype.clear_global_interrupt = function() {
    // Lower PCI interrupt line  
    if (this.cpu.devices && this.cpu.devices.pci) {
        this.cpu.devices.pci.lower_irq(this.pci_id);
    }
};

/**
 * Deliver interrupt via MSI or legacy PCI
 */
AHCIController.prototype.deliver_interrupt = function() {
    // Use MSI manager to deliver interrupts efficiently
    if (this.msi_manager) {
        // Find which port triggered the interrupt
        for (let port = 0; port < this.num_ports; port++) {
            if (this.is & (1 << port)) {
                this.msi_manager.deliver_port_interrupt(port);
                break;  // Only deliver first port interrupt for now
            }
        }
    } else {
        // Fallback to legacy PCI interrupt
        if (this.cpu.devices && this.cpu.devices.pci) {
            this.cpu.devices.pci.raise_irq(this.pci_id);
        }
    }
};

/**
 * AHCI Port implementation
 * @constructor
 * @param {AHCIController} controller - Parent AHCI controller
 * @param {number} port_num - Port number (0-31)
 */
function AHCIPort(controller, port_num) {
    this.controller = controller;
    this.port_num = port_num;
    
    // Port registers
    this.clb = 0;           // Command List Base Address
    this.clbu = 0;          // Command List Base Address Upper
    this.fb = 0;            // FIS Base Address  
    this.fbu = 0;           // FIS Base Address Upper
    this.is = 0;            // Interrupt Status
    this.ie = 0;            // Interrupt Enable
    this.cmd = 0;           // Command and Status
    this.tfd = 0;           // Task File Data
    this.sig = 0;           // Signature
    this.ssts = 0;          // SATA Status
    this.sctl = 0;          // SATA Control
    this.serr = 0;          // SATA Error
    this.sact = 0;          // SATA Active
    this.ci = 0;            // Command Issue
    this.sntf = 0;          // SATA Notification
    
    // Command tracking
    this.running_commands = new Array(AHCI_MAX_CMDS).fill(null);
    this.command_timeout_id = new Array(AHCI_MAX_CMDS).fill(null);
    
    // Command processor for SATA protocol handling
    this.cmd_processor = new AHCICommandProcessor(controller, port_num);
    
    // Initialize port
    this.reset();
    
    dbg_log("AHCI Port " + port_num + " initialized", LOG_DISK);
}

/**
 * Reset port to initial state
 */
AHCIPort.prototype.reset = function() {
    // Stop any running operations
    this.cmd &= ~(CMD_ST | CMD_FRE | CMD_CR | CMD_FR);
    
    // Clear interrupts and errors
    this.is = 0;
    this.serr = 0;
    this.ci = 0;
    this.sact = 0;
    
    // Device present from the start — no deferred activation
    this.ssts = 0;  // Inactive during BIOS POST — activated by DSDT patch
    this.sig = SIG_ATA; // ATA signature
    
    // Set task file to ready state
    this.tfd = 0x50;    // Drive ready, seek complete
    
    // Cancel any pending commands
    for (let i = 0; i < AHCI_MAX_CMDS; i++) {
        if (this.command_timeout_id[i]) {
            clearTimeout(this.command_timeout_id[i]);
            this.command_timeout_id[i] = null;
        }
        this.running_commands[i] = null;
    }
    
    dbg_log("AHCI Port " + this.port_num + " reset", LOG_DISK);
};

/**
 * Read from port register
 * @param {number} offset - Register offset within port space
 * @returns {number} Register value
 */
AHCIPort.prototype.read_register = function(offset) {
    switch (offset) {
        case PORT_CLB:   return this.clb;
        case PORT_CLBU:  return this.clbu;
        case PORT_FB:    return this.fb;
        case PORT_FBU:   return this.fbu;
        case PORT_IS:    return this.is;
        case PORT_IE:    return this.ie;
        case PORT_CMD:   return this.cmd;
        case PORT_TFD:   return this.tfd;
        case PORT_SIG:   return this.sig;
        case PORT_SSTS:
            return this.ssts;
        case PORT_SCTL:  return this.sctl;
        case PORT_SERR:  return this.serr;
        case PORT_SACT:  return this.sact;
        case PORT_CI:    return this.ci;
        case PORT_SNTF:  return this.sntf;
        default:
            dbg_log("AHCI Port " + this.port_num + ": Unknown register read at offset " + h(offset), LOG_DISK);
            return 0;
    }
};

/**
 * Write to port register  
 * @param {number} offset - Register offset within port space
 * @param {number} value - Value to write
 */
AHCIPort.prototype.write_register = function(offset, value) {
    switch (offset) {
        case PORT_CLB:
            this.clb = value & 0xFFFFFC00;  // 1KB aligned
            break;
            
        case PORT_CLBU:
            this.clbu = value;
            break;
            
        case PORT_FB:
            this.fb = value & 0xFFFFFF00;   // 256-byte aligned
            break;
            
        case PORT_FBU:
            this.fbu = value;
            break;
            
        case PORT_IS:
            // Write 1 to clear
            this.is &= ~value;
            this.update_port_interrupt();
            break;
            
        case PORT_IE:
            this.ie = value;
            this.update_port_interrupt();
            break;
            
        case PORT_CMD:
            this.write_command_register(value);
            break;
            
        case PORT_TFD:
            // Read-only register
            dbg_log("AHCI Port " + this.port_num + ": Attempt to write read-only TFD register", LOG_DISK);
            break;
            
        case PORT_SIG:
            // Read-only register
            dbg_log("AHCI Port " + this.port_num + ": Attempt to write read-only SIG register", LOG_DISK);
            break;
            
        case PORT_SSTS:
            // Read-only register  
            dbg_log("AHCI Port " + this.port_num + ": Attempt to write read-only SSTS register", LOG_DISK);
            break;
            
        case PORT_SCTL:
            this.sctl = value;
            this.handle_sata_control(value);
            break;
            
        case PORT_SERR:
            // Write 1 to clear
            this.serr &= ~value;
            break;
            
        case PORT_SACT:
            // Set SATA Active for NCQ commands
            this.sact |= value;
            break;
            
        case PORT_CI:
            // Issue new commands
            this.issue_commands(value);
            break;
            
        case PORT_SNTF:
            // Write 1 to clear
            this.sntf &= ~value;
            break;
            
        default:
            dbg_log("AHCI Port " + this.port_num + ": Unknown register write at offset " + 
                   h(offset) + " value " + h(value), LOG_DISK);
            break;
    }
};

/**
 * Handle Command and Status register writes
 * @param {number} value - New CMD register value
 */
AHCIPort.prototype.write_command_register = function(value) {
    const old_cmd = this.cmd;

    // Compute new running-status bits (CR, FR) based on the value being written.
    // AHCI spec: CR reflects whether the command engine is running (follows ST).
    //            FR reflects whether FIS receive is running (follows FRE).
    // We must clear CR/FR immediately when ST/FRE are cleared so that guest
    // stop_cmd() spin-loops (polling these bits) do not hang.

    let new_cr = old_cmd & CMD_CR;
    let new_fr = old_cmd & CMD_FR;

    // Handle Start (ST) bit transitions
    if ((value & CMD_ST) && !(old_cmd & CMD_ST)) {
        // 0->1: Start command processing - set CR if CLB is configured
        if (this.clb || this.clbu) {
            new_cr = CMD_CR;
            dbg_log("AHCI Port " + this.port_num + ": Command processing started", LOG_DISK);
        }
    } else if (!(value & CMD_ST)) {
        // ST=0: command engine must stop immediately - clear CR unconditionally
        new_cr = 0;
        if (old_cmd & CMD_ST) {
            dbg_log("AHCI Port " + this.port_num + ": Command processing stopped", LOG_DISK);
        }
    }

    // Handle FIS Receive Enable (FRE) bit transitions
    if ((value & CMD_FRE) && !(old_cmd & CMD_FRE)) {
        // 0->1: Start FIS processing - set FR if FB is configured
        if (this.fb || this.fbu) {
            new_fr = CMD_FR;
            dbg_log("AHCI Port " + this.port_num + ": FIS processing started", LOG_DISK);
        }
    } else if (!(value & CMD_FRE)) {
        // FRE=0: FIS receive must stop immediately - clear FR unconditionally
        new_fr = 0;
        if (old_cmd & CMD_FRE) {
            dbg_log("AHCI Port " + this.port_num + ": FIS processing stopped", LOG_DISK);
        }
    }


    // Handle Spin-Up Device (SUD) — when guest sets SUD and port has a device,
    // establish the SATA link. This is how real hardware works: SUD triggers
    // the OOB sequence, and the port reports DET=3 when link is established.
    if ((value & CMD_SUD) && this.has_device && (this.ssts & 0xF) === 0)
    {
        this.ssts = 0x113;  // DET=3 (established), SPD=1 (Gen1), IPM=1 (active)
        this.sig  = 0x00000101;  // ATA device signature
        this.tfd  = 0x50;  // DRDY | DSC, no BSY
    }
    // Update command register: guest-writable bits from value, running bits from our logic
    this.cmd = (value & ~(CMD_CR | CMD_FR)) | new_cr | new_fr;
};

/**
 * Handle SATA Control register writes
 * @param {number} value - SCTL register value
 */
AHCIPort.prototype.handle_sata_control = function(value) {
    const det = value & 0xF;  // Device Detection Control
    
    switch (det) {
        case 0:  // No device detection/initialization
            break;
        case 1:  // Perform device detection and initialization
            // Simulate device detection
            this.ssts = 0x113;  // Device present, 1.5 Gbps, interface active
            this.sig = SIG_ATA;
            dbg_log("AHCI Port " + this.port_num + ": SATA device detected", LOG_DISK);
            break;
        case 4:  // Disable SATA interface  
            this.ssts = 0;
            this.sig = 0xFFFFFFFF;
            dbg_log("AHCI Port " + this.port_num + ": SATA interface disabled", LOG_DISK);
            break;
    }
};

/**
 * Issue new commands from Command Issue register
 * @param {number} ci_mask - Mask of command slots to issue  
 */
AHCIPort.prototype.issue_commands = function(ci_mask) {
    if (!(this.cmd & CMD_ST)) {
        // Aqeous's port_rebase does HBA-wide resets that clear ST on already-
        // configured ports.  Auto-set ST so commands are not silently dropped.
        dbg_log("AHCI Port " + this.port_num + ": CI write with ST=0, auto-starting command engine", LOG_DISK);
        this.cmd |= CMD_ST | CMD_CR;
    }

    // Find newly issued commands (bits set in ci_mask but not yet in this.ci)
    const new_commands = ci_mask & ~this.ci;

    for (let slot = 0; slot < AHCI_MAX_CMDS; slot++) {
        if (!(new_commands & (1 << slot))) continue;

        // Set CI bit BEFORE processing so it is visible if process_command_slot
        // somehow re-enters (shouldn't happen with sync path, but defensive).
        this.ci |= (1 << slot);

        // Execute synchronously — process_command_sync clears this.ci bit before
        // returning, so the guest's busy-poll loop sees CI=0 immediately.
        this.process_command_slot(slot);
    }
};

/**
 * Process a specific command slot.
 *
 * Uses the synchronous path (process_command_sync) so that command completion
 * happens before this function returns — within the same MMIO write handler
 * call stack.  This is essential for Aqeous's busy-poll loop in SATA_Commander
 * (ahci.c:681) which spins on port->ci until the slot bit clears.
 *
 * v86 is single-threaded: a setTimeout/Promise-based completion path can never
 * fire while the x86 CPU loop is running, so async completion deadlocks.
 *
 * @param {number} slot - Command slot number (0-31)
 */
AHCIPort.prototype.process_command_slot = function(slot) {
    dbg_log("AHCI Port " + this.port_num + ": Processing command slot " + slot + " (sync)", LOG_DISK);

    // Mark command as running (informational only — cleared synchronously below)
    this.running_commands[slot] = {
        start_time: Date.now(),
        slot: slot
    };

    // Execute synchronously: reads FIS, performs I/O against RAM disk, writes
    // results to guest memory, clears CI bit, raises interrupt — all before return.
    this.cmd_processor.process_command_sync(slot);

    // running_commands[slot] is cleared inside complete_command() which is called
    // from complete_command_success/error inside process_command_sync.
};

/**
 * Complete a command and generate interrupt
 * @param {number} slot - Command slot that completed
 */
AHCIPort.prototype.complete_command = function(slot) {
    dbg_log("AHCI Port " + this.port_num + ": Command slot " + slot + " completed", LOG_DISK);
    
    // Clear command from issue register
    this.ci &= ~(1 << slot);
    
    // Clear from SATA Active if it was an NCQ command
    this.sact &= ~(1 << slot);
    

    
    // Clear timeout
    if (this.command_timeout_id[slot]) {
        clearTimeout(this.command_timeout_id[slot]);
        this.command_timeout_id[slot] = null;
    }
    
    this.running_commands[slot] = null;
    
    // Set interrupt status
    this.is |= PORT_IRQ_DHRS;  // D2H Register FIS received
    
    // Update port interrupt
    this.update_port_interrupt();
};

/**
 * Update port interrupt status and propagate to HBA
 */
AHCIPort.prototype.update_port_interrupt = function() {
    const pending_interrupts = this.is & this.ie;
    
    if (pending_interrupts) {
        // Set port interrupt in HBA interrupt status
        this.controller.is |= (1 << this.port_num);
        this.controller.update_global_interrupt();
    } else {
        // Clear port interrupt in HBA interrupt status  
        this.controller.is &= ~(1 << this.port_num);
        
        // Check if any other ports have interrupts
        if (this.controller.is === 0) {
            this.controller.clear_global_interrupt();
        }
    }
};

/**
 * Get port state for save/restore
 */
AHCIPort.prototype.get_state = function() {
    return {
        clb: this.clb,
        clbu: this.clbu,
        fb: this.fb,
        fbu: this.fbu,
        is: this.is,
        ie: this.ie,
        cmd: this.cmd,
        tfd: this.tfd,
        sig: this.sig,
        ssts: this.ssts,
        sctl: this.sctl,
        serr: this.serr,
        sact: this.sact,
        ci: this.ci,
        sntf: this.sntf,
        running_commands: this.running_commands.slice(),
        cmd_processor: this.cmd_processor ? this.cmd_processor.get_state() : null,
    };
};

/**
 * Set port state for save/restore
 */
AHCIPort.prototype.set_state = function(state) {
    this.clb = state.clb;
    this.clbu = state.clbu;
    this.fb = state.fb;
    this.fbu = state.fbu;
    this.is = state.is;
    this.ie = state.ie;
    this.cmd = state.cmd;
    this.tfd = state.tfd;
    this.sig = state.sig;
    this.ssts = state.ssts;
    this.sctl = state.sctl;
    this.serr = state.serr;
    this.sact = state.sact;
    this.ci = state.ci;
    this.sntf = state.sntf;
    this.running_commands = state.running_commands || new Array(AHCI_MAX_CMDS).fill(null);
    
    // Restore command processor state
    if (state.cmd_processor && this.cmd_processor) {
        this.cmd_processor.set_state(state.cmd_processor);
    }
    
    // Cancel any existing timeouts and recreate them if needed
    for (let i = 0; i < AHCI_MAX_CMDS; i++) {
        if (this.command_timeout_id[i]) {
            clearTimeout(this.command_timeout_id[i]);
            this.command_timeout_id[i] = null;
        }
    }
};

/**
 * Get AHCI Controller state for save/restore
AHCIController.prototype.activate_ports = function() {
    for (var i = 0; i < this.num_ports; i++) {
        if (this.ports[i] && this.ports[i].has_device && this.ports[i].ssts === 0) {
            this.ports[i].ssts = 0x113;
        }
    }
};

 */
AHCIController.prototype.get_state = function() {
    return {
        // HBA global registers
        cap: this.cap,
        ghc: this.ghc,
        is: this.is,
        pi: this.pi,
        vs: this.vs,
        ccc_ctl: this.ccc_ctl,
        ccc_ports: this.ccc_ports,
        em_loc: this.em_loc,
        em_ctl: this.em_ctl,
        cap2: this.cap2,
        bohc: this.bohc,
        
        // Ports state
        ports: this.ports.map(port => port.get_state()),
        num_ports: this.num_ports,
        
        // SMP state
        cpu_slot_allocation: this.cpu_slot_allocation,
        cpu_id: this.cpu_id,
        smp_enabled: this.smp_enabled,
        
        // SMP managers state
        smp_memory_manager: this.smp_memory_manager ? this.smp_memory_manager.get_memory_stats() : null,
        dma_manager: this.dma_manager ? this.dma_manager.get_dma_stats() : null,
        msi_manager: this.msi_manager ? this.msi_manager.get_state() : null,
        disk_manager: this.disk_manager ? this.disk_manager.get_stats() : null,
    };
};

/**
 * Set AHCI Controller state for save/restore
 */
AHCIController.prototype.set_state = function(state) {
    // Restore HBA global registers
    this.cap = state.cap;
    this.ghc = state.ghc;
    this.is = state.is;
    this.pi = state.pi;
    this.vs = state.vs;
    this.ccc_ctl = state.ccc_ctl;
    this.ccc_ports = state.ccc_ports;
    this.em_loc = state.em_loc;
    this.em_ctl = state.em_ctl;
    this.cap2 = state.cap2;
    this.bohc = state.bohc;
    
    // Restore ports
    this.num_ports = state.num_ports || 4;
    for (let i = 0; i < this.num_ports; i++) {
        if (state.ports && state.ports[i]) {
            this.ports[i].set_state(state.ports[i]);
        }
    }
    
    // Restore SMP state
    this.cpu_slot_allocation = state.cpu_slot_allocation || new Array(8).fill(0);
    this.cpu_id = state.cpu_id || 0;
    this.smp_enabled = state.smp_enabled || false;
    
    // Re-initialize SMP managers if they don't exist
    if (!this.smp_memory_manager) {
        this.smp_memory_manager = new AHCISMPMemoryManager(this.cpu, this.cpu.shared_memory);
    }
    if (!this.dma_manager) {
        this.dma_manager = new AHCIDMAManager(this.smp_memory_manager, this.cpu);
    }
    if (!this.msi_manager) {
        this.msi_manager = new AHCIMSIManager(this);
        // Restore MSI manager state
        if (state.msi_manager) {
            this.msi_manager.set_state(state.msi_manager);
        }
    }
    if (!this.disk_manager) {
        this.disk_manager = new VirtualDiskManager();
        // Re-initialize default disks
        this.init_default_disks();
    }
};
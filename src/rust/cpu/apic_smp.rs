// Enhanced APIC Implementation for SMP Support
// Supports multiple Local APICs (one per CPU) and centralized I/O APIC

use crate::cpu::{cpu::js, global_pointers::acpi_enabled};
use std::sync::{Mutex, MutexGuard, Arc};
use std::collections::HashMap;

const APIC_LOG_VERBOSE: bool = false;

// APIC Timer frequency (should match TSC_RATE in cpu.rs)
const APIC_TIMER_FREQ: f64 = 1.0 * 1000.0 * 1000.0;

// Timer modes
const APIC_TIMER_MODE_MASK: u32 = 3 << 17;
const APIC_TIMER_MODE_ONE_SHOT: u32 = 0;
const APIC_TIMER_MODE_PERIODIC: u32 = 1 << 17;
const _APIC_TIMER_MODE_TSC: u32 = 2 << 17;

// Delivery modes
const DELIVERY_MODES: [&str; 8] = [
    "Fixed (0)", "Lowest Prio (1)", "SMI (2)", "Reserved (3)",
    "NMI (4)", "INIT (5)", "Reserved (6)", "ExtINT (7)",
];

const DESTINATION_MODES: [&str; 2] = ["physical", "logical"];

// Configuration flags
const IOAPIC_CONFIG_MASKED: u32 = 0x10000;
const IOAPIC_CONFIG_TRIGGER_MODE_LEVEL: u32 = 1 << 15;
const IOAPIC_CONFIG_REMOTE_IRR: u32 = 1 << 14;

// Delivery types
const IOAPIC_DELIVERY_INIT: u8 = 5;
const IOAPIC_DELIVERY_NMI: u8 = 4;
const IOAPIC_DELIVERY_FIXED: u8 = 0;
const IOAPIC_DELIVERY_LOWEST_PRIORITY: u8 = 1;

// Memory layout
const LOCAL_APIC_BASE: u32 = 0xFEE00000;
const LOCAL_APIC_SIZE: u32 = 0x1000;
const IO_APIC_BASE: u32 = 0xFEC00000;

// Maximum supported CPUs
const MAX_CPUS: usize = 8;
const IOAPIC_IRQ_COUNT: usize = 24;

/// Per-CPU Local APIC state
#[repr(C)]
pub struct LocalApic {
    // CPU identification
    pub cpu_id: u8,
    pub apic_id: u32,
    
    // Timer state
    pub timer_divider: u32,
    pub timer_divider_shift: u32,
    pub timer_initial_count: u32,
    pub timer_current_count: u32,
    pub timer_last_tick: f64,
    
    // Local Vector Table
    pub lvt_timer: u32,
    pub lvt_perf_counter: u32,
    pub lvt_int0: u32,
    pub lvt_int1: u32,
    pub lvt_error: u32,
    pub lvt_thermal_sensor: u32,
    
    // Interrupt handling
    pub tpr: u32,                    // Task Priority Register
    pub icr0: u32,                   // Interrupt Command Register Low
    pub icr1: u32,                   // Interrupt Command Register High
    pub irr: [u32; 8],              // Interrupt Request Register
    pub isr: [u32; 8],              // In-Service Register  
    pub tmr: [u32; 8],              // Trigger Mode Register
    pub spurious_vector: u32,
    
    // Destination and format
    pub destination_format: u32,
    pub local_destination: u32,
    
    // Error handling
    pub error: u32,
    pub read_error: u32,
    
    // State flags
    pub enabled: bool,
    pub software_enabled: bool,
}

/// Centralized I/O APIC managing interrupt routing to multiple CPUs
#[repr(C)]
pub struct IoApic {
    // Register interface
    ioregsel: u32,
    ioapic_id: u32,
    
    // Redirection table (24 entries for standard PC)
    ioredtbl_config: [u32; IOAPIC_IRQ_COUNT],
    ioredtbl_destination: [u32; IOAPIC_IRQ_COUNT],
    
    // Interrupt state
    irr: u32,        // Interrupt Request Register
    irq_value: u32,  // Current IRQ line state
}

/// Main APIC manager for SMP systems
pub struct ApicManager {
    pub local_apics: Vec<Arc<Mutex<LocalApic>>>,
    pub io_apic: Arc<Mutex<IoApic>>,
    pub cpu_count: usize,
    pub cpu_id_to_apic_map: HashMap<u8, usize>,
    pub apic_id_to_cpu_map: HashMap<u32, u8>,
}

// Global APIC manager instance
static APIC_MANAGER: Mutex<Option<ApicManager>> = Mutex::new(None);

impl LocalApic {
    /// Create a new Local APIC for a specific CPU
    pub fn new(cpu_id: u8, apic_id: u32) -> Self {
        LocalApic {
            cpu_id,
            apic_id,
            
            timer_divider: 0,
            timer_divider_shift: 1,
            timer_initial_count: 0,
            timer_current_count: 0,
            timer_last_tick: 0.0,
            
            lvt_timer: IOAPIC_CONFIG_MASKED,
            lvt_thermal_sensor: IOAPIC_CONFIG_MASKED,
            lvt_perf_counter: IOAPIC_CONFIG_MASKED,
            lvt_int0: IOAPIC_CONFIG_MASKED,
            lvt_int1: IOAPIC_CONFIG_MASKED,
            lvt_error: IOAPIC_CONFIG_MASKED,
            
            tpr: 0,
            icr0: 0,
            icr1: 0,
            irr: [0; 8],
            isr: [0; 8],
            tmr: [0; 8],
            spurious_vector: 0xFE,
            
            destination_format: !0,
            local_destination: 0,
            
            error: 0,
            read_error: 0,
            
            enabled: true,
            software_enabled: false,
        }
    }
}

impl IoApic {
    /// Create a new I/O APIC
    pub fn new() -> Self {
        IoApic {
            ioregsel: 0,
            ioapic_id: 0,
            ioredtbl_config: [IOAPIC_CONFIG_MASKED; IOAPIC_IRQ_COUNT],
            ioredtbl_destination: [0; IOAPIC_IRQ_COUNT],
            irr: 0,
            irq_value: 0,
        }
    }
}

impl ApicManager {
    /// Initialize APIC manager with specified number of CPUs
    pub fn new(cpu_count: usize) -> Self {
        assert!(cpu_count <= MAX_CPUS, "Too many CPUs: {} > {}", cpu_count, MAX_CPUS);
        
        let mut local_apics = Vec::new();
        let mut cpu_id_to_apic_map = HashMap::new();
        let mut apic_id_to_cpu_map = HashMap::new();
        
        // Create Local APIC for each CPU
        for cpu_id in 0..cpu_count {
            let apic_id = cpu_id as u32;  // Simple mapping for now
            let local_apic = Arc::new(Mutex::new(LocalApic::new(cpu_id as u8, apic_id)));
            local_apics.push(local_apic);
            cpu_id_to_apic_map.insert(cpu_id as u8, cpu_id);
            apic_id_to_cpu_map.insert(apic_id, cpu_id as u8);
        }
        
        let io_apic = Arc::new(Mutex::new(IoApic::new()));
        
        ApicManager {
            local_apics,
            io_apic,
            cpu_count,
            cpu_id_to_apic_map,
            apic_id_to_cpu_map,
        }
    }
    
    /// Get Local APIC for specific CPU
    pub fn get_local_apic(&self, cpu_id: u8) -> Option<Arc<Mutex<LocalApic>>> {
        self.cpu_id_to_apic_map.get(&cpu_id)
            .and_then(|&index| self.local_apics.get(index))
            .cloned()
    }
    
    /// Get I/O APIC
    pub fn get_io_apic(&self) -> Arc<Mutex<IoApic>> {
        self.io_apic.clone()
    }
    
    /// Route interrupt from I/O APIC to appropriate Local APIC(s)
    pub fn route_interrupt(&self, irq: u8, vector: u8, delivery_mode: u8, destination: u8, destination_mode: u8) -> bool {
        match delivery_mode {
            IOAPIC_DELIVERY_FIXED => {
                if let Some(target_cpu) = self.resolve_destination(destination, destination_mode) {
                    self.deliver_to_cpu(target_cpu, vector, delivery_mode, false)
                } else {
                    false
                }
            },
            IOAPIC_DELIVERY_LOWEST_PRIORITY => {
                if let Some(target_cpu) = self.find_lowest_priority_cpu() {
                    self.deliver_to_cpu(target_cpu, vector, IOAPIC_DELIVERY_FIXED, false)
                } else {
                    false
                }
            },
            IOAPIC_DELIVERY_NMI => {
                // Broadcast NMI to all CPUs
                for cpu_id in 0..self.cpu_count as u8 {
                    self.deliver_to_cpu(cpu_id, vector, delivery_mode, false);
                }
                true
            },
            IOAPIC_DELIVERY_INIT => {
                // Handle INIT delivery
                if let Some(target_cpu) = self.resolve_destination(destination, destination_mode) {
                    self.deliver_init_to_cpu(target_cpu)
                } else {
                    false
                }
            },
            _ => {
                dbg_log!("Unimplemented delivery mode: {}", delivery_mode);
                false
            }
        }
    }
    
    /// Send Inter-Processor Interrupt (IPI)
    pub fn send_ipi(&self, source_cpu: u8, icr0: u32, icr1: u32) -> bool {
        let vector = (icr0 & 0xFF) as u8;
        let delivery_mode = ((icr0 >> 8) & 7) as u8;
        let destination_mode = ((icr0 >> 11) & 1) as u8;
        let is_level = (icr0 & IOAPIC_CONFIG_TRIGGER_MODE_LEVEL) != 0;
        let destination_shorthand = (icr0 >> 18) & 3;
        let destination = (icr1 >> 24) as u8;
        
        dbg_log!(
            "IPI from CPU {}: vector={:02x} mode={} dest_mode={} shorthand={}",
            source_cpu, vector, DELIVERY_MODES[delivery_mode as usize],
            DESTINATION_MODES[destination_mode as usize], destination_shorthand
        );
        
        let target_cpus = match destination_shorthand {
            0 => {
                // No shorthand - specific destination
                if let Some(target_cpu) = self.resolve_destination(destination, destination_mode) {
                    vec![target_cpu]
                } else {
                    vec![]
                }
            },
            1 => vec![source_cpu],  // Self
            2 => (0..self.cpu_count as u8).collect(),  // All including self
            3 => (0..self.cpu_count as u8).filter(|&cpu| cpu != source_cpu).collect(),  // All excluding self
            _ => {
                dbg_log!("Invalid destination shorthand: {}", destination_shorthand);
                return false;
            }
        };
        
        let mut success = true;
        for target_cpu in target_cpus {
            if !self.deliver_to_cpu(target_cpu, vector, delivery_mode, is_level) {
                success = false;
            }
        }
        
        success
    }
    
    /// Resolve destination address to CPU ID
    fn resolve_destination(&self, destination: u8, destination_mode: u8) -> Option<u8> {
        match destination_mode {
            0 => {
                // Physical mode - destination is APIC ID
                self.apic_id_to_cpu_map.get(&(destination as u32)).copied()
            },
            1 => {
                // Logical mode - more complex, simplified for now
                // In real APIC, this involves cluster/flat mode logic
                if destination != 0 {
                    // Find first CPU matching logical destination
                    for cpu_id in 0..self.cpu_count as u8 {
                        if let Some(apic) = self.get_local_apic(cpu_id) {
                            let apic_lock = apic.lock().unwrap();
                            let logical_dest = (apic_lock.local_destination >> 24) as u8;
                            if (logical_dest & destination) != 0 {
                                return Some(cpu_id);
                            }
                        }
                    }
                }
                None
            },
            _ => None,
        }
    }
    
    /// Find CPU with lowest Task Priority Register for load balancing
    fn find_lowest_priority_cpu(&self) -> Option<u8> {
        let mut lowest_tpr = u32::MAX;
        let mut selected_cpu = None;
        
        for cpu_id in 0..self.cpu_count as u8 {
            if let Some(apic) = self.get_local_apic(cpu_id) {
                let apic_lock = apic.lock().unwrap();
                if apic_lock.enabled && apic_lock.tpr < lowest_tpr {
                    lowest_tpr = apic_lock.tpr;
                    selected_cpu = Some(cpu_id);
                }
            }
        }
        
        selected_cpu
    }
    
    /// Deliver interrupt to specific CPU
    fn deliver_to_cpu(&self, cpu_id: u8, vector: u8, delivery_mode: u8, is_level: bool) -> bool {
        if let Some(apic) = self.get_local_apic(cpu_id) {
            let mut apic_lock = apic.lock().unwrap();
            deliver_interrupt(&mut apic_lock, vector, delivery_mode, is_level)
        } else {
            false
        }
    }
    
    /// Deliver INIT signal to CPU
    fn deliver_init_to_cpu(&self, cpu_id: u8) -> bool {
        if let Some(apic) = self.get_local_apic(cpu_id) {
            let mut apic_lock = apic.lock().unwrap();
            // INIT sequence - reset APIC state
            apic_lock.irr = [0; 8];
            apic_lock.isr = [0; 8];
            apic_lock.tmr = [0; 8];
            dbg_log!("INIT delivered to CPU {}", cpu_id);
            true
        } else {
            false
        }
    }
}

/// Initialize the APIC system for SMP
pub fn initialize_smp(cpu_count: usize) {
    let mut manager = APIC_MANAGER.lock().unwrap();
    *manager = Some(ApicManager::new(cpu_count));
    dbg_log!("APIC SMP initialized for {} CPUs", cpu_count);
}

/// Get the APIC manager mutex (for try_lock by callers)
pub fn get_apic_manager() -> &'static Mutex<Option<ApicManager>> {
    &APIC_MANAGER
}

/// Deliver interrupt to Local APIC
fn deliver_interrupt(apic: &mut LocalApic, vector: u8, mode: u8, is_level: bool) -> bool {
    if APIC_LOG_VERBOSE {
        dbg_log!("Deliver to CPU {}: vector={:02x} mode={} level={}", 
                apic.cpu_id, vector, mode, is_level);
    }
    
    if mode == IOAPIC_DELIVERY_INIT {
        // INIT sequence handled separately
        return true;
    }
    
    if mode == IOAPIC_DELIVERY_NMI {
        // NMI delivery - bypass normal interrupt logic
        // TODO: Implement NMI delivery to CPU
        return true;
    }
    
    if vector < 0x10 || vector == 0xFF {
        dbg_log!("Invalid vector: {:x}", vector);
        return false;
    }
    
    // Check if interrupt already pending
    if register_get_bit(&apic.irr, vector) {
        dbg_log!("Interrupt already pending: vector={:02x}", vector);
        return false;
    }
    
    // Set interrupt request
    register_set_bit(&mut apic.irr, vector);
    
    // Set trigger mode
    if is_level {
        register_set_bit(&mut apic.tmr, vector);
    } else {
        register_clear_bit(&mut apic.tmr, vector);
    }
    
    true
}

/// Local APIC register access functions for CPU emulation
pub fn read_local_apic(cpu_id: u8, addr: u32) -> u32 {
    if unsafe { !*acpi_enabled } {
        return 0;
    }
    
    let manager = get_apic_manager().lock().unwrap();
    if let Some(ref apic_mgr) = *manager {
        if let Some(apic) = apic_mgr.get_local_apic(cpu_id) {
            let mut apic_lock = apic.lock().unwrap();
            read_local_apic_internal(&mut apic_lock, addr)
        } else {
            0
        }
    } else {
        0
    }
}

pub fn write_local_apic(cpu_id: u8, addr: u32, value: u32) {
    if unsafe { !*acpi_enabled } {
        return;
    }
    
    let manager = get_apic_manager().lock().unwrap();
    if let Some(ref apic_mgr) = *manager {
        if let Some(apic) = apic_mgr.get_local_apic(cpu_id) {
            let mut apic_lock = apic.lock().unwrap();
            write_local_apic_internal(apic_mgr, &mut apic_lock, addr, value);
        }
    }
}

/// Internal register read implementation
fn read_local_apic_internal(apic: &mut LocalApic, addr: u32) -> u32 {
    match addr {
        0x20 => apic.apic_id,
        0x30 => 0x50014, // Version
        0x80 => apic.tpr,
        0xB0 => 0, // EOI register (write-only)
        0xD0 => apic.local_destination,
        0xE0 => apic.destination_format,
        0xF0 => apic.spurious_vector,
        
        // ISR registers
        0x100 | 0x110 | 0x120 | 0x130 | 0x140 | 0x150 | 0x160 | 0x170 => {
            let index = ((addr - 0x100) >> 4) as usize;
            apic.isr[index]
        },
        
        // TMR registers  
        0x180 | 0x190 | 0x1A0 | 0x1B0 | 0x1C0 | 0x1D0 | 0x1E0 | 0x1F0 => {
            let index = ((addr - 0x180) >> 4) as usize;
            apic.tmr[index]
        },
        
        // IRR registers
        0x200 | 0x210 | 0x220 | 0x230 | 0x240 | 0x250 | 0x260 | 0x270 => {
            let index = ((addr - 0x200) >> 4) as usize;
            apic.irr[index]
        },
        
        0x280 => apic.read_error,
        0x300 => apic.icr0,
        0x310 => apic.icr1,
        0x320 => apic.lvt_timer,
        0x330 => apic.lvt_thermal_sensor,
        0x340 => apic.lvt_perf_counter,
        0x350 => apic.lvt_int0,
        0x360 => apic.lvt_int1,
        0x370 => apic.lvt_error,
        0x3E0 => apic.timer_divider,
        0x380 => apic.timer_initial_count,
        0x390 => {
            // Timer current count - calculate based on time elapsed
            read_timer_current_count(apic)
        },
        
        _ => {
            dbg_log!("Unknown Local APIC read: {:x}", addr);
            0
        }
    }
}

/// Internal register write implementation
fn write_local_apic_internal(apic_mgr: &ApicManager, apic: &mut LocalApic, addr: u32, value: u32) {
    match addr {
        0x20 => apic.apic_id = value,
        0x80 => apic.tpr = value & 0xFF,
        0xB0 => {
            // End of Interrupt
            handle_eoi(apic);
        },
        0xD0 => apic.local_destination = value & 0xFF000000,
        0xE0 => apic.destination_format = value | 0xFFFFFF,
        0xF0 => {
            apic.spurious_vector = value;
            apic.software_enabled = (value & 0x100) != 0;
        },
        0x280 => {
            apic.read_error = apic.error;
            apic.error = 0;
        },
        0x300 => {
            // ICR Low - trigger IPI
            apic.icr0 = value & !(1 << 12); // Clear delivery status
            apic_mgr.send_ipi(apic.cpu_id, value, apic.icr1);
        },
        0x310 => apic.icr1 = value,
        0x320 => apic.lvt_timer = value,
        0x330 => apic.lvt_thermal_sensor = value,
        0x340 => apic.lvt_perf_counter = value,
        0x350 => apic.lvt_int0 = value,
        0x360 => apic.lvt_int1 = value,
        0x370 => apic.lvt_error = value,
        0x3E0 => {
            apic.timer_divider = value;
            let divide_shift = (value & 0b11) | ((value & 0b1000) >> 1);
            apic.timer_divider_shift = if divide_shift == 0b111 { 0 } else { divide_shift + 1 };
        },
        0x380 => {
            apic.timer_initial_count = value;
            apic.timer_current_count = value;
            apic.timer_last_tick = unsafe { js::microtick() };
        },
        
        _ => {
            dbg_log!("Unknown Local APIC write: {:x} <- {:08x}", addr, value);
        }
    }
}

/// Handle End of Interrupt processing
fn handle_eoi(apic: &mut LocalApic) {
    if let Some(highest_isr) = highest_isr_bit(&apic.isr) {
        if APIC_LOG_VERBOSE {
            dbg_log!("EOI for vector {:x} on CPU {}", highest_isr, apic.cpu_id);
        }
        register_clear_bit(&mut apic.isr, highest_isr);
        
        // If this was a level-triggered interrupt, send EOI to I/O APIC
        if register_get_bit(&apic.tmr, highest_isr) {
            // TODO: Send remote EOI to I/O APIC
        }
    } else {
        dbg_log!("Bad EOI: No ISR set on CPU {}", apic.cpu_id);
    }
}

/// Read timer current count with time calculation
fn read_timer_current_count(apic: &mut LocalApic) -> u32 {
    if apic.timer_initial_count == 0 {
        return 0;
    }
    
    let now = unsafe { js::microtick() };
    if apic.timer_last_tick > now {
        apic.timer_last_tick = now;
    }
    
    let diff = now - apic.timer_last_tick;
    let diff_in_ticks = diff * APIC_TIMER_FREQ / (1 << apic.timer_divider_shift) as f64;
    let diff_in_ticks = diff_in_ticks as u64;
    
    if diff_in_ticks < apic.timer_initial_count as u64 {
        apic.timer_initial_count - diff_in_ticks as u32
    } else {
        let mode = apic.lvt_timer & APIC_TIMER_MODE_MASK;
        if mode == APIC_TIMER_MODE_PERIODIC {
            apic.timer_initial_count - (diff_in_ticks % (apic.timer_initial_count as u64 + 1)) as u32
        } else {
            0 // One-shot expired
        }
    }
}

/// Acknowledge interrupt for specific CPU
pub fn acknowledge_irq(cpu_id: u8) -> Option<u8> {
    let manager = get_apic_manager().lock().unwrap();
    if let Some(ref apic_mgr) = *manager {
        if let Some(apic) = apic_mgr.get_local_apic(cpu_id) {
            let mut apic_lock = apic.lock().unwrap();
            acknowledge_irq_internal(&mut apic_lock)
        } else {
            None
        }
    } else {
        None
    }
}

fn acknowledge_irq_internal(apic: &mut LocalApic) -> Option<u8> {
    let highest_irr = match highest_irr_bit(&apic.irr) {
        None => return None,
        Some(x) => x,
    };
    
    // Check priority against current ISR
    if let Some(highest_isr) = highest_isr_bit(&apic.isr) {
        if highest_isr >= highest_irr {
            return None;
        }
    }
    
    // Check priority against TPR
    if highest_irr & 0xF0 <= apic.tpr as u8 & 0xF0 {
        return None;
    }
    
    // Move from IRR to ISR
    register_clear_bit(&mut apic.irr, highest_irr);
    register_set_bit(&mut apic.isr, highest_irr);
    
    if APIC_LOG_VERBOSE {
        dbg_log!("Acknowledged vector {:x} on CPU {}", highest_irr, apic.cpu_id);
    }
    
    Some(highest_irr)
}

/// Helper functions for register bit manipulation
fn register_get_bit(v: &[u32; 8], bit: u8) -> bool {
    v[(bit >> 5) as usize] & 1 << (bit & 31) != 0
}

fn register_set_bit(v: &mut [u32; 8], bit: u8) {
    v[(bit >> 5) as usize] |= 1 << (bit & 31);
}

fn register_clear_bit(v: &mut [u32; 8], bit: u8) {
    v[(bit >> 5) as usize] &= !(1 << (bit & 31));
}

fn highest_irr_bit(v: &[u32; 8]) -> Option<u8> {
    register_get_highest_bit(v)
}

fn highest_isr_bit(v: &[u32; 8]) -> Option<u8> {
    register_get_highest_bit(v)
}

fn register_get_highest_bit(v: &[u32; 8]) -> Option<u8> {
    let v_u64: &[u64; 4] = unsafe { std::mem::transmute(v) };
    for i in (0..4).rev() {
        let word = v_u64[i];
        if word != 0 {
            return Some(word.ilog2() as u8 | (i as u8) << 6);
        }
    }
    None
}
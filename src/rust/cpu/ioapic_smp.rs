// Enhanced I/O APIC Implementation for SMP Support
// Manages interrupt routing to multiple CPUs

use crate::cpu::{apic_smp, global_pointers::acpi_enabled};
use std::sync::{Mutex, MutexGuard};

const IOAPIC_LOG_VERBOSE: bool = false;

// Register offsets
const IOREGSEL: u32 = 0;
const IOWIN: u32 = 0x10;

// Configuration
const IOAPIC_IRQ_COUNT: usize = 24;
const IOAPIC_FIRST_IRQ_REG: u32 = 0x10;
const IOAPIC_LAST_IRQ_REG: u32 = 0x10 + 2 * IOAPIC_IRQ_COUNT as u32;
const IOAPIC_ID: u32 = 0;

// Configuration flags
pub const IOAPIC_CONFIG_TRIGGER_MODE_LEVEL: u32 = 1 << 15;
const IOAPIC_CONFIG_MASKED: u32 = 1 << 16;
const IOAPIC_CONFIG_DELIVS: u32 = 1 << 12;
const IOAPIC_CONFIG_REMOTE_IRR: u32 = 1 << 14;
const IOAPIC_CONFIG_READONLY_MASK: u32 = IOAPIC_CONFIG_REMOTE_IRR | IOAPIC_CONFIG_DELIVS | 0xFFFE0000;

// Delivery modes
const IOAPIC_DELIVERY_FIXED: u8 = 0;
const IOAPIC_DELIVERY_LOWEST_PRIORITY: u8 = 1;
const IOAPIC_DELIVERY_SMI: u8 = 2;
const IOAPIC_DELIVERY_NMI: u8 = 4;
const IOAPIC_DELIVERY_INIT: u8 = 5;
const IOAPIC_DELIVERY_EXTINT: u8 = 7;

const DELIVERY_MODES: [&str; 8] = [
    "Fixed (0)", "Lowest Prio (1)", "SMI (2)", "Reserved (3)",
    "NMI (4)", "INIT (5)", "Reserved (6)", "ExtINT (7)",
];

const DESTINATION_MODES: [&str; 2] = ["physical", "logical"];

/// Enhanced I/O APIC for SMP systems
#[repr(C)]
pub struct IoApicSmp {
    // Register interface
    ioregsel: u32,
    ioapic_id: u32,
    
    // Redirection table entries
    ioredtbl_config: [u32; IOAPIC_IRQ_COUNT],
    ioredtbl_destination: [u32; IOAPIC_IRQ_COUNT],
    
    // Interrupt state tracking
    irr: u32,        // Interrupt Request Register
    irq_value: u32,  // Current IRQ line state
    
    // SMP specific fields
    cpu_count: usize,
    round_robin_index: usize,  // For load balancing
}

// Global I/O APIC instance
static IO_APIC_SMP: Mutex<IoApicSmp> = Mutex::new(IoApicSmp {
    ioregsel: 0,
    ioapic_id: IOAPIC_ID,
    ioredtbl_config: [IOAPIC_CONFIG_MASKED; IOAPIC_IRQ_COUNT],
    ioredtbl_destination: [0; IOAPIC_IRQ_COUNT],
    irr: 0,
    irq_value: 0,
    cpu_count: 1,
    round_robin_index: 0,
});

impl IoApicSmp {
    /// Initialize I/O APIC for SMP with specified CPU count
    pub fn initialize_smp(&mut self, cpu_count: usize) {
        self.cpu_count = cpu_count;
        self.round_robin_index = 0;
        
        // Reset all redirection table entries
        for i in 0..IOAPIC_IRQ_COUNT {
            self.ioredtbl_config[i] = IOAPIC_CONFIG_MASKED;
            self.ioredtbl_destination[i] = 0;
        }
        
        self.irr = 0;
        self.irq_value = 0;
        
        dbg_log!("I/O APIC initialized for {} CPUs", cpu_count);
    }
    
    /// Check and route IRQ to appropriate CPU(s)
    fn check_irq(&mut self, irq: u8) {
        let mask = 1 << irq;
        
        if self.irr & mask == 0 {
            return;
        }
        
        let config = self.ioredtbl_config[irq as usize];
        
        if config & IOAPIC_CONFIG_MASKED == 0 {
            let delivery_mode = ((config >> 8) & 7) as u8;
            let destination_mode = ((config >> 11) & 1) as u8;
            let vector = (config & 0xFF) as u8;
            let destination = (self.ioredtbl_destination[irq as usize] >> 24) as u8;
            let is_level = config & IOAPIC_CONFIG_TRIGGER_MODE_LEVEL == IOAPIC_CONFIG_TRIGGER_MODE_LEVEL;
            
            if IOAPIC_LOG_VERBOSE {
                dbg_log!(
                    "Routing IRQ {}: vector={:02x} mode={} dest={:02x} dest_mode={} level={}",
                    irq, vector, DELIVERY_MODES[delivery_mode as usize], destination,
                    DESTINATION_MODES[destination_mode as usize], is_level
                );
            }
            
            // Clear edge-triggered interrupts immediately
            if config & IOAPIC_CONFIG_TRIGGER_MODE_LEVEL == 0 {
                self.irr &= !mask;
            } else {
                // Set Remote IRR for level-triggered interrupts
                self.ioredtbl_config[irq as usize] |= IOAPIC_CONFIG_REMOTE_IRR;
                
                if config & IOAPIC_CONFIG_REMOTE_IRR != 0 {
                    dbg_log!("No route: level interrupt and remote IRR already set for IRQ {}", irq);
                    return;
                }
            }
            
            // Route to Local APIC(s)
            let routed = self.route_to_local_apics(vector, delivery_mode, destination, destination_mode, is_level);
            
            if routed {
                // Clear delivery status
                self.ioredtbl_config[irq as usize] &= !IOAPIC_CONFIG_DELIVS;
            } else {
                dbg_log!("Failed to route IRQ {} vector {:02x}", irq, vector);
            }
        }
    }
    
    /// Route interrupt to Local APIC(s) based on delivery mode
    fn route_to_local_apics(&mut self, vector: u8, delivery_mode: u8, destination: u8, destination_mode: u8, is_level: bool) -> bool {
        match delivery_mode {
            IOAPIC_DELIVERY_FIXED => {
                self.route_fixed(vector, destination, destination_mode, is_level)
            },
            IOAPIC_DELIVERY_LOWEST_PRIORITY => {
                self.route_lowest_priority(vector, destination, destination_mode, is_level)
            },
            IOAPIC_DELIVERY_SMI => {
                self.route_smi(vector, destination, destination_mode)
            },
            IOAPIC_DELIVERY_NMI => {
                self.route_nmi(vector, destination, destination_mode)
            },
            IOAPIC_DELIVERY_INIT => {
                self.route_init(destination, destination_mode)
            },
            IOAPIC_DELIVERY_EXTINT => {
                self.route_extint(vector, destination, destination_mode)
            },
            _ => {
                dbg_log!("Unimplemented delivery mode: {}", delivery_mode);
                false
            }
        }
    }
    
    /// Route fixed delivery mode interrupt
    fn route_fixed(&self, vector: u8, destination: u8, destination_mode: u8, is_level: bool) -> bool {
        if destination_mode == 0 {
            // Physical destination mode - route to specific APIC ID
            self.route_to_physical_destination(vector, destination, IOAPIC_DELIVERY_FIXED, is_level)
        } else {
            // Logical destination mode - route to logical group
            self.route_to_logical_destination(vector, destination, IOAPIC_DELIVERY_FIXED, is_level)
        }
    }
    
    /// Route lowest priority delivery mode
    fn route_lowest_priority(&mut self, vector: u8, destination: u8, destination_mode: u8, is_level: bool) -> bool {
        if destination_mode == 0 {
            // Physical mode - find lowest priority CPU
            self.route_to_lowest_priority_physical(vector, destination, is_level)
        } else {
            // Logical mode - find lowest priority in group
            self.route_to_lowest_priority_logical(vector, destination, is_level)
        }
    }
    
    /// Route to specific physical destination
    fn route_to_physical_destination(&self, vector: u8, apic_id: u8, delivery_mode: u8, is_level: bool) -> bool {
        // Use the APIC SMP manager to route
        if let Ok(manager) = apic_smp::get_apic_manager().try_lock() {
            if let Some(ref apic_mgr) = *manager {
                return apic_mgr.route_interrupt(0, vector, delivery_mode, apic_id, 0);
            }
        }
        false
    }
    
    /// Route to logical destination group
    fn route_to_logical_destination(&self, vector: u8, logical_dest: u8, delivery_mode: u8, is_level: bool) -> bool {
        // In logical mode, find all CPUs matching the destination mask
        let mut routed = false;
        
        for cpu_id in 0..self.cpu_count as u8 {
            if let Some(dest_cpu) = self.check_logical_destination(cpu_id, logical_dest) {
                if let Ok(manager) = apic_smp::get_apic_manager().try_lock() {
                    if let Some(ref apic_mgr) = *manager {
                        if apic_mgr.route_interrupt(0, vector, delivery_mode, dest_cpu, 1) {
                            routed = true;
                        }
                    }
                }
            }
        }
        
        routed
    }
    
    /// Route to lowest priority CPU (physical mode)
    fn route_to_lowest_priority_physical(&mut self, vector: u8, destination: u8, is_level: bool) -> bool {
        // Use round-robin for now (simplified load balancing)
        let target_cpu = self.round_robin_index % self.cpu_count;
        self.round_robin_index = (self.round_robin_index + 1) % self.cpu_count;
        
        if let Ok(manager) = apic_smp::get_apic_manager().try_lock() {
            if let Some(ref apic_mgr) = *manager {
                return apic_mgr.route_interrupt(0, vector, IOAPIC_DELIVERY_FIXED, target_cpu as u8, 0);
            }
        }
        false
    }
    
    /// Route to lowest priority CPU (logical mode)
    fn route_to_lowest_priority_logical(&mut self, vector: u8, logical_dest: u8, is_level: bool) -> bool {
        // Find all CPUs in logical group and select lowest priority
        let mut candidates = Vec::new();
        
        for cpu_id in 0..self.cpu_count as u8 {
            if self.check_logical_destination(cpu_id, logical_dest).is_some() {
                candidates.push(cpu_id);
            }
        }
        
        if !candidates.is_empty() {
            // Select candidate with lowest TPR (simplified)
            let target_cpu = candidates[self.round_robin_index % candidates.len()];
            self.round_robin_index = (self.round_robin_index + 1) % candidates.len();
            
            if let Ok(manager) = apic_smp::get_apic_manager().try_lock() {
                if let Some(ref apic_mgr) = *manager {
                    return apic_mgr.route_interrupt(0, vector, IOAPIC_DELIVERY_FIXED, target_cpu, 1);
                }
            }
        }
        
        false
    }
    
    /// Check if CPU matches logical destination
    fn check_logical_destination(&self, cpu_id: u8, logical_dest: u8) -> Option<u8> {
        // Get Local APIC logical destination register for this CPU
        if let Ok(manager) = apic_smp::get_apic_manager().try_lock() {
            if let Some(ref apic_mgr) = *manager {
                if let Some(apic) = apic_mgr.get_local_apic(cpu_id) {
                    if let Ok(apic_lock) = apic.try_lock() {
                        let local_dest = (apic_lock.local_destination >> 24) as u8;
                        if (local_dest & logical_dest) != 0 {
                            return Some(cpu_id);
                        }
                    }
                }
            }
        }
        None
    }
    
    /// Route SMI (System Management Interrupt)
    fn route_smi(&self, vector: u8, destination: u8, destination_mode: u8) -> bool {
        dbg_log!("SMI delivery not implemented: vector={:02x} dest={:02x}", vector, destination);
        false
    }
    
    /// Route NMI (Non-Maskable Interrupt)
    fn route_nmi(&self, vector: u8, destination: u8, destination_mode: u8) -> bool {
        if destination_mode == 0 {
            // Physical mode - route to specific CPU
            if let Ok(manager) = apic_smp::get_apic_manager().try_lock() {
                if let Some(ref apic_mgr) = *manager {
                    return apic_mgr.route_interrupt(0, vector, IOAPIC_DELIVERY_NMI, destination, 0);
                }
            }
        } else {
            // Logical mode - route to all matching CPUs
            let mut routed = false;
            for cpu_id in 0..self.cpu_count as u8 {
                if self.check_logical_destination(cpu_id, destination).is_some() {
                    if let Ok(manager) = apic_smp::get_apic_manager().try_lock() {
                        if let Some(ref apic_mgr) = *manager {
                            if apic_mgr.route_interrupt(0, vector, IOAPIC_DELIVERY_NMI, cpu_id, 1) {
                                routed = true;
                            }
                        }
                    }
                }
            }
            return routed;
        }
        false
    }
    
    /// Route INIT sequence
    fn route_init(&self, destination: u8, destination_mode: u8) -> bool {
        if let Ok(manager) = apic_smp::get_apic_manager().try_lock() {
            if let Some(ref apic_mgr) = *manager {
                return apic_mgr.route_interrupt(0, 0, IOAPIC_DELIVERY_INIT, destination, destination_mode);
            }
        }
        false
    }
    
    /// Route ExtINT (External Interrupt)
    fn route_extint(&self, vector: u8, destination: u8, destination_mode: u8) -> bool {
        dbg_log!("ExtINT delivery not implemented: vector={:02x} dest={:02x}", vector, destination);
        false
    }
}

/// Get the I/O APIC instance
fn get_io_apic() -> MutexGuard<'static, IoApicSmp> {
    IO_APIC_SMP.lock().unwrap()
}

/// Initialize I/O APIC for SMP
pub fn initialize_smp(cpu_count: usize) {
    get_io_apic().initialize_smp(cpu_count);
}

/// Set IRQ line (called by devices)
pub fn set_irq(irq: u8) {
    if irq as usize >= IOAPIC_IRQ_COUNT {
        dbg_log!("Invalid IRQ: {}", irq);
        return;
    }
    
    let mut ioapic = get_io_apic();
    let mask = 1 << irq;
    
    if ioapic.irq_value & mask == 0 {
        if IOAPIC_LOG_VERBOSE {
            dbg_log!("I/O APIC set IRQ {}", irq);
        }
        
        ioapic.irq_value |= mask;
        
        let config = ioapic.ioredtbl_config[irq as usize];
        if config & (IOAPIC_CONFIG_TRIGGER_MODE_LEVEL | IOAPIC_CONFIG_MASKED) == IOAPIC_CONFIG_MASKED {
            // Edge triggered and masked - do nothing
            return;
        }
        
        ioapic.irr |= mask;
        ioapic.check_irq(irq);
    }
}

/// Clear IRQ line
pub fn clear_irq(irq: u8) {
    if irq as usize >= IOAPIC_IRQ_COUNT {
        dbg_log!("Invalid IRQ: {}", irq);
        return;
    }
    
    let mut ioapic = get_io_apic();
    let mask = 1 << irq;
    
    if ioapic.irq_value & mask == mask {
        ioapic.irq_value &= !mask;
        
        let config = ioapic.ioredtbl_config[irq as usize];
        if config & IOAPIC_CONFIG_TRIGGER_MODE_LEVEL != 0 {
            ioapic.irr &= !mask;
        }
    }
}

/// Handle Remote EOI from Local APIC
pub fn remote_eoi(vector: u8) {
    let mut ioapic = get_io_apic();
    
    for i in 0..IOAPIC_IRQ_COUNT as u8 {
        let config = ioapic.ioredtbl_config[i as usize];
        
        if (config & 0xFF) as u8 == vector && config & IOAPIC_CONFIG_REMOTE_IRR != 0 {
            dbg_log!("Clear remote IRR for IRQ {} vector {:02x}", i, vector);
            ioapic.ioredtbl_config[i as usize] &= !IOAPIC_CONFIG_REMOTE_IRR;
            ioapic.check_irq(i);
        }
    }
}

/// Read I/O APIC register
pub fn read32(addr: u32) -> u32 {
    if unsafe { !*acpi_enabled } {
        return 0;
    }
    
    let mut ioapic = get_io_apic();
    
    match addr {
        IOREGSEL => ioapic.ioregsel,
        IOWIN => match ioapic.ioregsel {
            0 => {
                dbg_log!("I/O APIC read ID");
                ioapic.ioapic_id << 24
            },
            1 => {
                dbg_log!("I/O APIC read version");
                0x11 | (IOAPIC_IRQ_COUNT as u32 - 1) << 16
            },
            2 => {
                dbg_log!("I/O APIC read arbitration ID");
                ioapic.ioapic_id << 24
            },
            IOAPIC_FIRST_IRQ_REG..IOAPIC_LAST_IRQ_REG => {
                let irq = ((ioapic.ioregsel - IOAPIC_FIRST_IRQ_REG) >> 1) as u8;
                let index = ioapic.ioregsel & 1;
                
                if index != 0 {
                    let value = ioapic.ioredtbl_destination[irq as usize];
                    dbg_log!("I/O APIC read destination IRQ {} -> {:08x}", irq, value);
                    value
                } else {
                    let value = ioapic.ioredtbl_config[irq as usize];
                    dbg_log!("I/O APIC read config IRQ {} -> {:08x}", irq, value);
                    value
                }
            },
            reg => {
                dbg_log!("I/O APIC read unknown register {:x}", reg);
                0
            },
        },
        _ => {
            dbg_log!("I/O APIC read invalid address: {:x}", addr);
            0
        },
    }
}

/// Write I/O APIC register
pub fn write32(addr: u32, value: u32) {
    if unsafe { !*acpi_enabled } {
        return;
    }
    
    let mut ioapic = get_io_apic();
    
    match addr {
        IOREGSEL => ioapic.ioregsel = value,
        IOWIN => match ioapic.ioregsel {
            0 => ioapic.ioapic_id = (value >> 24) & 0x0F,
            1 | 2 => {
                dbg_log!("I/O APIC invalid write to register {}", ioapic.ioregsel);
            },
            IOAPIC_FIRST_IRQ_REG..IOAPIC_LAST_IRQ_REG => {
                let irq = ((ioapic.ioregsel - IOAPIC_FIRST_IRQ_REG) >> 1) as u8;
                let index = ioapic.ioregsel & 1;
                
                if index != 0 {
                    // Destination register
                    dbg_log!(
                        "I/O APIC write destination IRQ {} = {:08x} (CPU {:02x})",
                        irq, value, value >> 24
                    );
                    ioapic.ioredtbl_destination[irq as usize] = value & 0xFF000000;
                } else {
                    // Configuration register
                    let old_value = ioapic.ioredtbl_config[irq as usize];
                    ioapic.ioredtbl_config[irq as usize] = (value & !IOAPIC_CONFIG_READONLY_MASK) 
                        | (old_value & IOAPIC_CONFIG_READONLY_MASK);
                    
                    let vector = value & 0xFF;
                    let delivery_mode = (value >> 8) & 7;
                    let destination_mode = (value >> 11) & 1;
                    let is_level = (value >> 15) & 1;
                    let masked = (value >> 16) & 1;
                    
                    dbg_log!(
                        "I/O APIC config IRQ {}: vector={:02x} mode={} dest_mode={} level={} masked={}",
                        irq, vector, DELIVERY_MODES[delivery_mode as usize],
                        DESTINATION_MODES[destination_mode as usize], is_level, masked
                    );
                    
                    ioapic.check_irq(irq);
                }
            },
            reg => {
                dbg_log!("I/O APIC write unknown register {:x} = {:08x}", reg, value);
            },
        },
        _ => {
            dbg_log!("I/O APIC write invalid address: {:x} = {:08x}", addr, value);
        },
    }
}
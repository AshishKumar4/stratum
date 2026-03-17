// Memory-Mapped I/O Interface for APIC SMP
// Handles MMIO access to Local APIC and I/O APIC from CPU emulation

use crate::cpu::{apic_smp, ioapic_smp, global_pointers::*};

// Memory layout constants
const LOCAL_APIC_BASE: u32 = 0xFEE00000;
const LOCAL_APIC_SIZE: u32 = 0x1000;
const IO_APIC_BASE: u32 = 0xFEC00000;
const IO_APIC_SIZE: u32 = 0x1000;

// APIC Base MSR 
const IA32_APIC_BASE_MSR: u32 = 0x1B;
const APIC_BASE_ENABLE: u64 = 1 << 11;
const APIC_BASE_BSP: u64 = 1 << 8;

/// CPU-specific APIC base address calculation
pub fn get_local_apic_base(cpu_id: u8) -> u32 {
    // Each CPU has its Local APIC at a unique address
    LOCAL_APIC_BASE + (cpu_id as u32 * LOCAL_APIC_SIZE)
}

/// Check if address is in Local APIC range for any CPU
pub fn is_local_apic_address(addr: u32) -> Option<u8> {
    if addr >= LOCAL_APIC_BASE && addr < LOCAL_APIC_BASE + (8 * LOCAL_APIC_SIZE) {
        let cpu_offset = addr - LOCAL_APIC_BASE;
        let cpu_id = cpu_offset / LOCAL_APIC_SIZE;
        if cpu_id < 8 {
            Some(cpu_id as u8)
        } else {
            None
        }
    } else {
        None
    }
}

/// Check if address is in I/O APIC range
pub fn is_io_apic_address(addr: u32) -> bool {
    addr >= IO_APIC_BASE && addr < IO_APIC_BASE + IO_APIC_SIZE
}

/// Current CPU ID — set by JavaScript before each time slice via set_current_cpu_id().
/// This is safe because WASM is single-threaded; only one JS task runs at a time.
static mut CURRENT_CPU_ID: u8 = 0;

/// Set the current CPU ID (called from JS before each AP slice in the round-robin tick).
pub unsafe fn set_current_cpu_id(id: u8) {
    CURRENT_CPU_ID = id;
}

/// Get current CPU ID — returns the value set by the most recent set_current_cpu_id() call.
pub fn get_current_cpu_id() -> u8 {
    // SAFETY: WASM is single-threaded; no data race is possible.
    unsafe { CURRENT_CPU_ID }
}

/// MMIO read handler for APIC addresses
pub fn mmio_read32(addr: u32) -> u32 {
    if let Some(cpu_id) = is_local_apic_address(addr) {
        // Local APIC access
        let local_addr = addr & (LOCAL_APIC_SIZE - 1);
        apic_smp::read_local_apic(cpu_id, local_addr)
    } else if is_io_apic_address(addr) {
        // I/O APIC access
        let io_addr = addr - IO_APIC_BASE;
        ioapic_smp::read32(io_addr)
    } else {
        dbg_log!("Invalid APIC MMIO read: {:08x}", addr);
        0
    }
}

/// MMIO write handler for APIC addresses
pub fn mmio_write32(addr: u32, value: u32) {
    if let Some(cpu_id) = is_local_apic_address(addr) {
        // Local APIC access
        let local_addr = addr & (LOCAL_APIC_SIZE - 1);
        apic_smp::write_local_apic(cpu_id, local_addr, value);
    } else if is_io_apic_address(addr) {
        // I/O APIC access
        let io_addr = addr - IO_APIC_BASE;
        ioapic_smp::write32(io_addr, value);
    } else {
        dbg_log!("Invalid APIC MMIO write: {:08x} = {:08x}", addr, value);
    }
}

/// MMIO read with current CPU context
pub fn mmio_read32_current_cpu(addr: u32) -> u32 {
    let cpu_id = get_current_cpu_id();
    if addr >= LOCAL_APIC_BASE && addr < LOCAL_APIC_BASE + LOCAL_APIC_SIZE {
        // Access to "local" APIC from current CPU perspective
        let local_addr = addr - LOCAL_APIC_BASE;
        apic_smp::read_local_apic(cpu_id, local_addr)
    } else {
        mmio_read32(addr)
    }
}

/// MMIO write with current CPU context
pub fn mmio_write32_current_cpu(addr: u32, value: u32) {
    let cpu_id = get_current_cpu_id();
    if addr >= LOCAL_APIC_BASE && addr < LOCAL_APIC_BASE + LOCAL_APIC_SIZE {
        // Access to "local" APIC from current CPU perspective
        let local_addr = addr - LOCAL_APIC_BASE;
        apic_smp::write_local_apic(cpu_id, local_addr, value);
    } else {
        mmio_write32(addr, value)
    }
}

/// Handle APIC Base MSR read
pub fn read_apic_base_msr(cpu_id: u8) -> u64 {
    let base_addr = get_local_apic_base(cpu_id) as u64;
    let mut msr_value = base_addr;
    
    msr_value |= APIC_BASE_ENABLE;  // APIC enabled
    
    if cpu_id == 0 {
        msr_value |= APIC_BASE_BSP; // Bootstrap Processor
    }
    
    msr_value
}

/// Handle APIC Base MSR write
pub fn write_apic_base_msr(cpu_id: u8, value: u64) -> bool {
    // Extract base address
    let new_base = value & !0xFFF;
    let expected_base = get_local_apic_base(cpu_id) as u64;
    
    if new_base != expected_base {
        dbg_log!("APIC Base MSR: Attempt to change base address from {:08x} to {:08x} on CPU {}", 
                expected_base, new_base, cpu_id);
        // For now, don't allow base address changes
        return false;
    }
    
    let enabled = (value & APIC_BASE_ENABLE) != 0;
    let is_bsp = (value & APIC_BASE_BSP) != 0;
    
    if cpu_id == 0 && !is_bsp {
        dbg_log!("Warning: Attempt to clear BSP flag on CPU 0");
        return false;
    }
    
    if cpu_id != 0 && is_bsp {
        dbg_log!("Warning: Attempt to set BSP flag on CPU {}", cpu_id);
        return false;
    }
    
    dbg_log!("APIC Base MSR CPU {}: enabled={} bsp={}", cpu_id, enabled, is_bsp);
    
    // TODO: Update APIC enabled state in Local APIC structure
    
    true
}

/// Initialize APIC MMIO system for SMP
pub fn initialize_mmio_smp(cpu_count: usize) {
    dbg_log!("Initializing APIC MMIO for {} CPUs", cpu_count);
    
    // Initialize APIC managers
    apic_smp::initialize_smp(cpu_count);
    ioapic_smp::initialize_smp(cpu_count);
    
    // Setup memory mappings for each CPU's Local APIC
    for cpu_id in 0..cpu_count {
        let base_addr = get_local_apic_base(cpu_id as u8);
        dbg_log!("CPU {} Local APIC at {:08x}", cpu_id, base_addr);
    }
    
    dbg_log!("I/O APIC at {:08x}", IO_APIC_BASE);
}

/// Get APIC timer value for specific CPU
pub fn get_apic_timer(cpu_id: u8, now: f64) -> f64 {
    // TODO: Implement per-CPU timer handling
    100.0 // Default return time for next interrupt
}

/// Handle APIC interrupt acknowledgment for specific CPU
pub fn acknowledge_apic_irq(cpu_id: u8) -> Option<u8> {
    apic_smp::acknowledge_irq(cpu_id)
}

/// Set IRQ on I/O APIC (called by devices)
pub fn set_apic_irq(irq: u8) {
    ioapic_smp::set_irq(irq);
}

/// Clear IRQ on I/O APIC
pub fn clear_apic_irq(irq: u8) {
    ioapic_smp::clear_irq(irq);
}

/// Handle remote EOI from Local APIC
pub fn handle_remote_eoi(vector: u8) {
    ioapic_smp::remote_eoi(vector);
}

/// Check if APIC system is initialized
pub fn is_apic_smp_initialized() -> bool {
    // Check if APIC manager is initialized
    if let Ok(manager) = apic_smp::get_apic_manager().try_lock() {
        manager.is_some()
    } else {
        false
    }
}

/// Get APIC status for debugging
pub fn get_apic_status() -> String {
    let mut status = String::new();
    
    if let Ok(manager) = apic_smp::get_apic_manager().try_lock() {
        if let Some(ref apic_mgr) = *manager {
            status.push_str(&format!("APIC SMP initialized with {} CPUs\n", apic_mgr.cpu_count));
            
            for cpu_id in 0..apic_mgr.cpu_count as u8 {
                if let Some(apic) = apic_mgr.get_local_apic(cpu_id) {
                    if let Ok(apic_lock) = apic.try_lock() {
                        status.push_str(&format!(
                            "CPU {}: APIC ID {:02x} enabled={} TPR={:02x}\n",
                            cpu_id, apic_lock.apic_id, apic_lock.enabled, apic_lock.tpr
                        ));
                    }
                }
            }
        } else {
            status.push_str("APIC SMP not initialized\n");
        }
    } else {
        status.push_str("APIC manager locked\n");
    }
    
    status
}

/// CPU startup sequence handling
pub fn handle_cpu_startup(cpu_id: u8) {
    dbg_log!("Starting up CPU {}", cpu_id);
    
    // Initialize CPU-specific APIC state
    if let Ok(manager) = apic_smp::get_apic_manager().try_lock() {
        if let Some(ref apic_mgr) = *manager {
            if let Some(apic) = apic_mgr.get_local_apic(cpu_id) {
                let mut apic_lock = apic.lock().unwrap();
                apic_lock.enabled = true;
                apic_lock.software_enabled = true;
                dbg_log!("CPU {} APIC enabled", cpu_id);
            }
        }
    }
}

/// Send INIT/SIPI sequence for CPU startup
pub fn send_init_sipi(target_cpu: u8, vector: u8) -> bool {
    if let Ok(manager) = apic_smp::get_apic_manager().try_lock() {
        if let Some(ref apic_mgr) = *manager {
            // Send INIT
            let init_icr0 = (5 << 8) | (1 << 14); // INIT, assert
            let init_icr1 = (target_cpu as u32) << 24;
            
            if apic_mgr.send_ipi(0, init_icr0, init_icr1) {
                // Wait for INIT to be processed (simplified)
                
                // Send SIPI
                let sipi_icr0 = (6 << 8) | vector as u32; // SIPI
                let sipi_icr1 = (target_cpu as u32) << 24;
                
                return apic_mgr.send_ipi(0, sipi_icr0, sipi_icr1);
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_local_apic_address_detection() {
        assert_eq!(is_local_apic_address(LOCAL_APIC_BASE), Some(0));
        assert_eq!(is_local_apic_address(LOCAL_APIC_BASE + LOCAL_APIC_SIZE), Some(1));
        assert_eq!(is_local_apic_address(LOCAL_APIC_BASE + 2 * LOCAL_APIC_SIZE), Some(2));
        assert_eq!(is_local_apic_address(0x12345678), None);
    }
    
    #[test]
    fn test_io_apic_address_detection() {
        assert!(is_io_apic_address(IO_APIC_BASE));
        assert!(is_io_apic_address(IO_APIC_BASE + 0x100));
        assert!(!is_io_apic_address(IO_APIC_BASE + IO_APIC_SIZE));
        assert!(!is_io_apic_address(0x12345678));
    }
    
    #[test]
    fn test_apic_base_calculation() {
        assert_eq!(get_local_apic_base(0), LOCAL_APIC_BASE);
        assert_eq!(get_local_apic_base(1), LOCAL_APIC_BASE + LOCAL_APIC_SIZE);
        assert_eq!(get_local_apic_base(2), LOCAL_APIC_BASE + 2 * LOCAL_APIC_SIZE);
    }
}
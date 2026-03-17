// SMP CPU Integration with Enhanced APIC Support
// Integrates the enhanced APIC system with CPU emulation

use crate::cpu::{apic_mmio, apic_smp, ioapic_smp, global_pointers::*};
use crate::cpu::cpu::{js, call_interrupt_vector};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;

/// Maximum number of supported CPUs
const MAX_CPUS: usize = 8;

/// CPU state for SMP system
#[derive(Clone)]
pub struct CpuContextSmp {
    pub cpu_id: u8,
    pub is_bsp: bool,
    pub is_running: bool,
    pub apic_base: u32,
    pub current_eip: u32,
    pub interrupt_pending: bool,
}

/// SMP CPU Manager
pub struct SmpManager {
    cpus: Vec<Arc<Mutex<CpuContextSmp>>>,
    cpu_count: usize,
    bsp_cpu: u8,
    initialized: bool,
}

// Global SMP manager
static SMP_MANAGER: Mutex<Option<SmpManager>> = Mutex::new(None);

impl CpuContextSmp {
    pub fn new(cpu_id: u8, is_bsp: bool) -> Self {
        CpuContextSmp {
            cpu_id,
            is_bsp,
            is_running: false,
            apic_base: apic_mmio::get_local_apic_base(cpu_id),
            current_eip: 0,
            interrupt_pending: false,
        }
    }
}

impl SmpManager {
    pub fn new(cpu_count: usize) -> Self {
        assert!(cpu_count <= MAX_CPUS, "Too many CPUs: {}", cpu_count);
        
        let mut cpus = Vec::new();
        
        for cpu_id in 0..cpu_count {
            let is_bsp = cpu_id == 0;
            let cpu_context = Arc::new(Mutex::new(CpuContextSmp::new(cpu_id as u8, is_bsp)));
            cpus.push(cpu_context);
        }
        
        SmpManager {
            cpus,
            cpu_count,
            bsp_cpu: 0,
            initialized: false,
        }
    }
    
    pub fn initialize(&mut self) {
        // Initialize APIC MMIO system
        apic_mmio::initialize_mmio_smp(self.cpu_count);
        
        // Set BSP as running
        if let Some(bsp) = self.cpus.get(0) {
            let mut bsp_lock = bsp.lock().unwrap();
            bsp_lock.is_running = true;
        }
        
        self.initialized = true;
        dbg_log!("SMP Manager initialized for {} CPUs", self.cpu_count);
    }
    
    pub fn get_cpu_context(&self, cpu_id: u8) -> Option<Arc<Mutex<CpuContextSmp>>> {
        if cpu_id < self.cpu_count as u8 {
            self.cpus.get(cpu_id as usize).cloned()
        } else {
            None
        }
    }
    
    pub fn start_application_processor(&mut self, cpu_id: u8, start_eip: u32) -> bool {
        if cpu_id == 0 || cpu_id >= self.cpu_count as u8 {
            return false;
        }
        
        if let Some(cpu_context) = self.get_cpu_context(cpu_id) {
            let mut cpu_lock = cpu_context.lock().unwrap();
            cpu_lock.is_running = true;
            cpu_lock.current_eip = start_eip;
            
            // Initialize AP's APIC
            apic_mmio::handle_cpu_startup(cpu_id);
            
            dbg_log!("Started Application Processor {} at EIP {:08x}", cpu_id, start_eip);
            true
        } else {
            false
        }
    }
    
    pub fn stop_application_processor(&mut self, cpu_id: u8) -> bool {
        if cpu_id == 0 || cpu_id >= self.cpu_count as u8 {
            return false;
        }
        
        if let Some(cpu_context) = self.get_cpu_context(cpu_id) {
            let mut cpu_lock = cpu_context.lock().unwrap();
            cpu_lock.is_running = false;
            
            dbg_log!("Stopped Application Processor {}", cpu_id);
            true
        } else {
            false
        }
    }
    
    pub fn get_running_cpu_count(&self) -> usize {
        let mut count = 0;
        for cpu in &self.cpus {
            if let Ok(cpu_lock) = cpu.try_lock() {
                if cpu_lock.is_running {
                    count += 1;
                }
            }
        }
        count
    }
    
    pub fn broadcast_ipi(&self, vector: u8, exclude_self: bool) -> bool {
        // Use CPU 0 (BSP) to send broadcast IPI
        if let Ok(manager) = apic_smp::get_apic_manager().try_lock() {
            if let Some(ref apic_mgr) = *manager {
                // ICR0 for broadcast IPI
                let shorthand = if exclude_self { 3 } else { 2 }; // All excluding/including self
                let icr0 = vector as u32 | (shorthand << 18);
                let icr1 = 0;
                
                return apic_mgr.send_ipi(0, icr0, icr1);
            }
        }
        false
    }
}

/// Initialize SMP system
pub fn initialize_smp(cpu_count: usize) {
    let mut manager = SMP_MANAGER.lock().unwrap();
    let mut smp_mgr = SmpManager::new(cpu_count);
    smp_mgr.initialize();
    *manager = Some(smp_mgr);
    
    dbg_log!("SMP system initialized with {} CPUs", cpu_count);
}

/// Get SMP manager mutex (callers use try_lock() or lock())
pub fn get_smp_manager() -> &'static Mutex<Option<SmpManager>> {
    &SMP_MANAGER
}

/// Get current CPU ID — delegates to apic_mmio which tracks it via set_current_cpu_id().
pub fn get_current_cpu_id() -> u8 {
    apic_mmio::get_current_cpu_id()
}

/// Handle CPU interrupt on specific CPU
pub fn handle_cpu_interrupt(cpu_id: u8) -> bool {
    // Check for APIC interrupts first
    if let Some(vector) = apic_mmio::acknowledge_apic_irq(cpu_id) {
        dbg_log!("APIC interrupt on CPU {}: vector {:02x}", cpu_id, vector);
        
        // Call interrupt vector on this CPU
        unsafe {
            call_interrupt_vector(vector as i32, false, None);
        }
        return true;
    }
    
    false
}

/// Set IRQ for interrupt routing
pub fn set_irq_smp(irq: u8) {
    apic_mmio::set_apic_irq(irq);
}

/// Clear IRQ 
pub fn clear_irq_smp(irq: u8) {
    apic_mmio::clear_apic_irq(irq);
}

/// Handle APIC timer for specific CPU
pub fn handle_apic_timer_smp(cpu_id: u8, now: f64) -> f64 {
    // Return next interrupt time
    apic_mmio::get_apic_timer(cpu_id, now)
}

/// MMIO read handler for CPU emulation
pub fn mmio_read_smp(addr: u32) -> u32 {
    apic_mmio::mmio_read32_current_cpu(addr)
}

/// MMIO write handler for CPU emulation
pub fn mmio_write_smp(addr: u32, value: u32) {
    apic_mmio::mmio_write32_current_cpu(addr, value)
}

/// Handle MSR read for APIC Base
pub fn read_msr_apic_base(cpu_id: u8) -> u64 {
    apic_mmio::read_apic_base_msr(cpu_id)
}

/// Handle MSR write for APIC Base
pub fn write_msr_apic_base(cpu_id: u8, value: u64) -> bool {
    apic_mmio::write_apic_base_msr(cpu_id, value)
}

/// Check if address is APIC-related
pub fn is_apic_address(addr: u32) -> bool {
    apic_mmio::is_local_apic_address(addr).is_some() || apic_mmio::is_io_apic_address(addr)
}

/// Start Application Processor using INIT/SIPI sequence
pub fn start_ap(target_cpu: u8, start_vector: u8) -> bool {
    if target_cpu == 0 || target_cpu >= MAX_CPUS as u8 {
        dbg_log!("Invalid target CPU for AP startup: {}", target_cpu);
        return false;
    }
    
    dbg_log!("Starting AP {} with vector {:02x}", target_cpu, start_vector);
    
    // Send INIT/SIPI sequence
    if apic_mmio::send_init_sipi(target_cpu, start_vector) {
        // Update SMP manager
        if let Ok(mut manager) = get_smp_manager().try_lock() {
            if let Some(ref mut smp_mgr) = manager.as_mut() {
                let start_eip = (start_vector as u32) << 12; // Vector is in 4KB pages
                return smp_mgr.start_application_processor(target_cpu, start_eip);
            }
        }
    }
    
    false
}

/// Stop Application Processor
pub fn stop_ap(target_cpu: u8) -> bool {
    if target_cpu == 0 || target_cpu >= MAX_CPUS as u8 {
        return false;
    }
    
    if let Ok(mut manager) = get_smp_manager().try_lock() {
        if let Some(ref mut smp_mgr) = manager.as_mut() {
            return smp_mgr.stop_application_processor(target_cpu);
        }
    }
    
    false
}

/// Get SMP status information
pub fn get_smp_status() -> String {
    let mut status = String::new();
    
    if let Ok(manager) = get_smp_manager().try_lock() {
        if let Some(ref smp_mgr) = *manager {
            status.push_str(&format!("SMP: {} CPUs configured, {} running\n", 
                                   smp_mgr.cpu_count, smp_mgr.get_running_cpu_count()));
            
            for cpu_id in 0..smp_mgr.cpu_count as u8 {
                if let Some(cpu_context) = smp_mgr.get_cpu_context(cpu_id) {
                    if let Ok(cpu_lock) = cpu_context.try_lock() {
                        status.push_str(&format!(
                            "CPU {}: {} running={} EIP={:08x} APIC={:08x}\n",
                            cpu_id, 
                            if cpu_lock.is_bsp { "BSP" } else { "AP " },
                            cpu_lock.is_running,
                            cpu_lock.current_eip,
                            cpu_lock.apic_base
                        ));
                    }
                }
            }
        } else {
            status.push_str("SMP not initialized\n");
        }
    }
    
    status.push_str(&apic_mmio::get_apic_status());
    status
}

/// Handle IPI delivery to specific CPU
pub fn deliver_ipi_to_cpu(target_cpu: u8, vector: u8) -> bool {
    if target_cpu >= MAX_CPUS as u8 {
        return false;
    }
    
    dbg_log!("Delivering IPI to CPU {}: vector {:02x}", target_cpu, vector);
    
    // In a real implementation, this would trigger the interrupt on the target CPU
    // For Web Worker implementation, this would send a message to the target worker
    
    // For now, just acknowledge the IPI was sent
    true
}

/// CPU main loop integration for SMP
pub fn cpu_loop_smp(cpu_id: u8) -> bool {
    // Check for pending APIC interrupts
    if handle_cpu_interrupt(cpu_id) {
        return true;
    }
    
    // Handle APIC timer
    let now = unsafe { js::microtick() };
    let _next_timer = handle_apic_timer_smp(cpu_id, now);
    
    false
}

/// Initialize SMP with default configuration
pub fn initialize_smp_default() {
    initialize_smp(1); // Start with single CPU (BSP only)
}

/// Check if SMP is enabled and initialized
pub fn is_smp_enabled() -> bool {
    if let Ok(manager) = get_smp_manager().try_lock() {
        manager.is_some()
    } else {
        false
    }
}

/// Get number of configured CPUs
pub fn get_cpu_count() -> usize {
    if let Ok(manager) = get_smp_manager().try_lock() {
        if let Some(ref smp_mgr) = *manager {
            smp_mgr.cpu_count
        } else {
            1
        }
    } else {
        1
    }
}

/// Enable additional CPUs dynamically
pub fn enable_smp(total_cpus: usize) -> bool {
    if total_cpus > MAX_CPUS {
        dbg_log!("Cannot enable {} CPUs, maximum is {}", total_cpus, MAX_CPUS);
        return false;
    }
    
    let current_count = get_cpu_count();
    if total_cpus <= current_count {
        dbg_log!("SMP already has {} CPUs, requested {}", current_count, total_cpus);
        return true;
    }
    
    // Re-initialize with more CPUs
    initialize_smp(total_cpus);
    
    dbg_log!("SMP enabled with {} CPUs", total_cpus);
    true
}
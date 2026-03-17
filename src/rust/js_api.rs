use crate::cpu::cpu::translate_address_system_read;
use crate::cpu::apic_mmio;

#[no_mangle]
pub unsafe fn translate_address_system_read_js(addr: i32) -> u32 {
    translate_address_system_read(addr).unwrap()
}

/// Tell the Rust SMP subsystem which CPU is currently executing.
/// JavaScript calls this before each AP slice in the cooperative round-robin.
#[no_mangle]
pub unsafe extern "C" fn set_current_cpu_id(id: u32) {
    apic_mmio::set_current_cpu_id(id as u8);
}

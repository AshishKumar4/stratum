#[macro_use]
mod dbg;

#[macro_use]
mod paging;

pub mod cpu;

pub mod js_api;
pub mod profiler;

// ---------------------------------------------------------------------------
// SMP/APIC extension exports — callable from JavaScript via WASM imports
// ---------------------------------------------------------------------------

/// Initialise the multi-CPU APIC manager.
/// Call once from cpu.js after BIOS detects ACPI/MP tables.
/// cpu_count: number of logical CPUs (1–8).
#[no_mangle]
pub fn smp_init(cpu_count: u32) {
    cpu::cpu_smp::initialize_smp(cpu_count as usize);
}

/// Run one SMP tick for the given CPU core (called from the JS main loop).
#[no_mangle]
pub fn smp_cpu_loop(cpu_id: u32) -> bool {
    cpu::cpu_smp::cpu_loop_smp(cpu_id as u8)
}

/// Read a Local APIC MMIO register (uses current-cpu context).
#[no_mangle]
pub fn apic_mmio_read(addr: u32) -> u32 {
    cpu::apic_mmio::mmio_read32_current_cpu(addr)
}

/// Write a Local APIC MMIO register (uses current-cpu context).
#[no_mangle]
pub fn apic_mmio_write(addr: u32, value: u32) {
    cpu::apic_mmio::mmio_write32_current_cpu(addr, value);
}

/// Read an I/O APIC register at addr.
#[no_mangle]
pub fn ioapic_mmio_read(addr: u32) -> u32 {
    cpu::ioapic_smp::read32(addr)
}

/// Write an I/O APIC register at addr.
#[no_mangle]
pub fn ioapic_mmio_write(addr: u32, value: u32) {
    cpu::ioapic_smp::write32(addr, value);
}

/// Raise an IRQ line on the I/O APIC (replaces the old pic-based raise).
#[no_mangle]
pub fn ioapic_set_irq(irq: u32) {
    cpu::ioapic_smp::set_irq(irq as u8);
}

/// Return true if SMP is initialised and more than one CPU is configured.
#[no_mangle]
pub fn smp_is_enabled() -> bool {
    cpu::cpu_smp::is_smp_enabled()
}

/// Return the number of CPUs in the SMP manager (0 = uninitialised).
#[no_mangle]
pub fn smp_cpu_count() -> u32 {
    cpu::cpu_smp::get_cpu_count() as u32
}

/// Send an INIT/SIPI startup sequence to an Application Processor.
#[no_mangle]
pub fn smp_start_ap(target_cpu: u32, start_vector: u32) -> bool {
    cpu::cpu_smp::start_ap(target_cpu as u8, start_vector as u8)
}

mod analysis;
mod codegen;
mod config;
mod control_flow;
mod cpu_context;
mod gen;
mod jit;
mod jit_instructions;
mod leb;
mod modrm;
mod opstats;
mod page;
mod prefix;
mod regs;
mod softfloat;
mod state_flags;
mod wasmgen;
mod zstd;

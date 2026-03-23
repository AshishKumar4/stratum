pub mod ext {
    extern "C" {
        pub fn mmap_read8(addr: u32) -> i32;
        pub fn mmap_read32(addr: u32) -> i32;

        pub fn mmap_write8(addr: u32, value: i32);
        pub fn mmap_write16(addr: u32, value: i32);
        pub fn mmap_write32(addr: u32, value: i32);
        pub fn mmap_write64(addr: u32, v0: i32, v1: i32);
        pub fn mmap_write128(addr: u32, v0: i32, v1: i32, v2: i32, v3: i32);

        /// Demand-paging hook: swap a cold guest page into a WASM hot-pool frame.
        ///
        /// Called from `do_page_walk` when the resolved GPA >= PAGED_THRESHOLD.
        /// The JS implementation (SqlPageStore.swapPageIn) reads 4 KB from DO SQLite
        /// synchronously, copies it into a Clock-algorithm frame in mem8[HOT_POOL_BASE..],
        /// and returns the WASM byte offset of that frame.
        ///
        /// `for_writing`: non-zero if this TLB entry is being built for a write access.
        /// The JS side uses this to immediately mark the frame dirty, enabling correct
        /// flush-on-eviction without requiring a separate write-fault hook.
        ///
        /// Returns: WASM byte offset of the hot frame (always in [HOT_POOL_BASE, memory_size)),
        /// or -1 on error (should never occur in practice).
        /// do_page_walk substitutes this offset for `high` before building the TLB
        /// entry — no other TLB mechanics change.
        pub fn swap_page_in(gpa: u32, for_writing: i32) -> i32;
    }
}

/// GPA threshold above which pages are demand-paged from DO SQLite.
///
/// Must equal VM_CONFIG.RESIDENT_MB × 1 MiB in do86/src/linux-vm.ts, and
/// must equal the poolBase passed to SqlPageStore.setWasmHeap().
/// GPAs in [0, PAGED_THRESHOLD) are permanently resident in mem8.
/// GPAs in [PAGED_THRESHOLD, logical_memory_size) are served from the hot pool.
///
/// This is a compile-time constant (used in do_page_walk which is
/// hot/JIT-compiled); change it here AND in VM_CONFIG together.
pub const PAGED_THRESHOLD: u32 = 16 * 1024 * 1024; // 16 MB — matches VM_CONFIG.RESIDENT_MB

use crate::cpu::apic;
use crate::cpu::cpu::{
    handle_irqs, reg128, APIC_MEM_ADDRESS, APIC_MEM_SIZE, IOAPIC_MEM_ADDRESS, IOAPIC_MEM_SIZE,
};

// AHCI memory addresses (from Phase 4 design)
pub const AHCI_MEM_ADDRESS: u32 = 0xFEA00000;
pub const AHCI_MEM_SIZE: u32 = 0x1000;
use crate::cpu::global_pointers::{memory_size, logical_memory_size};
use crate::cpu::ioapic;
use crate::cpu::vga;
use crate::jit;
use crate::page::Page;

use std::alloc;
use std::ptr;

#[allow(non_upper_case_globals)]
pub static mut mem8: *mut u8 = ptr::null_mut();

#[no_mangle]
pub fn allocate_memory(size: u32) -> u32 {
    unsafe {
        dbg_assert!(mem8.is_null());
    };
    dbg_log!("Allocate memory size={}m", size >> 20);
    let layout = alloc::Layout::from_size_align(size as usize, 0x1000).unwrap();
    let ptr = unsafe { alloc::alloc(layout) as u32 };
    unsafe {
        mem8 = ptr as *mut u8;
    };
    ptr
}

#[no_mangle]
pub unsafe fn zero_memory(addr: u32, size: u32) {
    ptr::write_bytes(mem8.offset(addr as isize), 0, size as usize);
}

#[allow(non_upper_case_globals)]
pub static mut vga_mem8: *mut u8 = ptr::null_mut();
#[allow(non_upper_case_globals)]
pub static mut vga_memory_size: u32 = 0;

#[no_mangle]
pub fn svga_allocate_memory(size: u32) -> u32 {
    unsafe {
        dbg_assert!(vga_mem8.is_null());
    };
    let layout = alloc::Layout::from_size_align(size as usize, 0x1000).unwrap();
    let ptr = unsafe { alloc::alloc(layout) };
    dbg_assert!(
        size & (1 << 12 << 6) == 0,
        "size not aligned to dirty_bitmap"
    );
    unsafe {
        vga_mem8 = ptr;
        vga_memory_size = size;
        vga::set_dirty_bitmap_size(size >> 12 >> 6);
    };
    ptr as u32
}

/// Returns true if `addr` is outside the WASM-backed physical RAM range.
///
/// This uses memory_size (the WASM allocation), NOT logical_memory_size.
/// Addresses in [memory_size, logical_memory_size) are demand-paged RAM,
/// but they're not directly accessible via mem8[] — they must go through
/// do_page_walk which maps them to hot pool frames.  Raw read32s/write32
/// calls (e.g. page table walks) for these addresses need the MMIO handler
/// to return safely (0xFF) rather than crashing with OOB on mem8[].
///
/// The demand paging decision uses its own logical_boundary check in
/// do_page_walk, independent of this function.
#[no_mangle]
pub fn in_mapped_range(addr: u32) -> bool {
    return addr >= 0xA0000 && addr < 0xC0000 || addr >= unsafe { *memory_size };
}

pub const VGA_LFB_ADDRESS: u32 = 0xE0000000;
pub fn in_svga_lfb(addr: u32) -> bool {
    addr >= VGA_LFB_ADDRESS && addr <= unsafe { VGA_LFB_ADDRESS + (vga_memory_size - 1) }
}

#[no_mangle]
pub fn read8(addr: u32) -> i32 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            unsafe { *vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as i32 }
        }
        else if addr >= APIC_MEM_ADDRESS && addr < APIC_MEM_ADDRESS + APIC_MEM_SIZE {
            apic::read32((addr - APIC_MEM_ADDRESS) & !3) as i32 >> 8 * (addr & 3) & 0xFF
        }
        else if addr >= IOAPIC_MEM_ADDRESS && addr < IOAPIC_MEM_ADDRESS + IOAPIC_MEM_SIZE {
            ioapic::read32((addr - IOAPIC_MEM_ADDRESS) & !3) as i32 >> 8 * (addr & 3) & 0xFF
        }
        else if addr >= AHCI_MEM_ADDRESS && addr < AHCI_MEM_ADDRESS + AHCI_MEM_SIZE {
            unsafe { ext::mmap_read8(addr) }
        }
        else {
            unsafe { ext::mmap_read8(addr) }
        }
    }
    else {
        read8_no_mmap_check(addr)
    }
}
pub fn read8_no_mmap_check(addr: u32) -> i32 { unsafe { *mem8.offset(addr as isize) as i32 } }

#[no_mangle]
pub fn read16(addr: u32) -> i32 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            unsafe {
                ptr::read_unaligned(vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *const u16)
                    as i32
            }
        }
        else {
            read8(addr) | read8(addr + 1) << 8
        }
    }
    else {
        read16_no_mmap_check(addr)
    }
}
pub fn read16_no_mmap_check(addr: u32) -> i32 {
    unsafe { ptr::read_unaligned(mem8.offset(addr as isize) as *const u16) as i32 }
}

#[no_mangle]
pub fn read32s(addr: u32) -> i32 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            unsafe {
                ptr::read_unaligned(vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *const i32)
            } // XXX
        }
        else if addr >= APIC_MEM_ADDRESS && addr < APIC_MEM_ADDRESS + APIC_MEM_SIZE {
            apic::read32(addr - APIC_MEM_ADDRESS) as i32
        }
        else if addr >= IOAPIC_MEM_ADDRESS && addr < IOAPIC_MEM_ADDRESS + IOAPIC_MEM_SIZE {
            ioapic::read32(addr - IOAPIC_MEM_ADDRESS) as i32
        }
        else if addr >= AHCI_MEM_ADDRESS && addr < AHCI_MEM_ADDRESS + AHCI_MEM_SIZE {
            unsafe { ext::mmap_read32(addr) }
        }
        else {
            unsafe { ext::mmap_read32(addr) }
        }
    }
    else {
        read32_no_mmap_check(addr)
    }
}
pub fn read32_no_mmap_check(addr: u32) -> i32 {
    unsafe { ptr::read_unaligned(mem8.offset(addr as isize) as *const i32) }
}

pub unsafe fn read64s(addr: u32) -> i64 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            ptr::read_unaligned(vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *const i64)
        }
        else {
            read32s(addr) as i64 | (read32s(addr + 4) as i64) << 32
        }
    }
    else {
        ptr::read_unaligned(mem8.offset(addr as isize) as *const i64)
    }
}

pub unsafe fn read128(addr: u32) -> reg128 {
    if in_mapped_range(addr) {
        if in_svga_lfb(addr) {
            ptr::read_unaligned(vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *const reg128)
        }
        else {
            reg128 {
                i32: [
                    read32s(addr + 0),
                    read32s(addr + 4),
                    read32s(addr + 8),
                    read32s(addr + 12),
                ],
            }
        }
    }
    else {
        ptr::read_unaligned(mem8.offset(addr as isize) as *const reg128)
    }
}

#[no_mangle]
pub unsafe fn write8(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write8(addr, value & 0xFF);
    }
    else {
        jit::jit_dirty_page(Page::page_of(addr));
        write8_no_mmap_or_dirty_check(addr, value);
    };
}

pub unsafe fn write8_no_mmap_or_dirty_check(addr: u32, value: i32) {
    *mem8.offset(addr as isize) = value as u8
}

#[no_mangle]
pub unsafe fn write16(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write16(addr, value & 0xFFFF);
    }
    else {
        jit::jit_dirty_cache_small(addr, addr + 2);
        write16_no_mmap_or_dirty_check(addr, value);
    };
}
pub unsafe fn write16_no_mmap_or_dirty_check(addr: u32, value: i32) {
    ptr::write_unaligned(mem8.offset(addr as isize) as *mut u16, value as u16)
}

#[no_mangle]
pub unsafe fn write32(addr: u32, value: i32) {
    if in_mapped_range(addr) {
        mmap_write32(addr, value);
    }
    else {
        jit::jit_dirty_cache_small(addr, addr + 4);
        write32_no_mmap_or_dirty_check(addr, value);
    }
}

pub unsafe fn write32_no_mmap_or_dirty_check(addr: u32, value: i32) {
    ptr::write_unaligned(mem8.offset(addr as isize) as *mut i32, value)
}

pub unsafe fn write64_no_mmap_or_dirty_check(addr: u32, value: u64) {
    ptr::write_unaligned(mem8.offset(addr as isize) as *mut u64, value)
}

pub unsafe fn write128_no_mmap_or_dirty_check(addr: u32, value: reg128) {
    ptr::write_unaligned(mem8.offset(addr as isize) as *mut reg128, value)
}

pub unsafe fn memset_no_mmap_or_dirty_check(addr: u32, value: u8, count: u32) {
    ptr::write_bytes(mem8.offset(addr as isize), value, count as usize);
}

pub unsafe fn memcpy_no_mmap_or_dirty_check(src_addr: u32, dst_addr: u32, count: u32) {
    dbg_assert!(src_addr < *memory_size);
    dbg_assert!(dst_addr < *memory_size);
    ptr::copy(
        mem8.offset(src_addr as isize),
        mem8.offset(dst_addr as isize),
        count as usize,
    )
}

pub unsafe fn memcpy_into_svga_lfb(src_addr: u32, dst_addr: u32, count: u32) {
    dbg_assert!(src_addr < *memory_size);
    dbg_assert!(in_svga_lfb(dst_addr));
    dbg_assert!(Page::page_of(dst_addr) == Page::page_of(dst_addr + count - 1));
    vga::mark_dirty(dst_addr);
    ptr::copy_nonoverlapping(
        mem8.offset(src_addr as isize),
        vga_mem8.offset((dst_addr - VGA_LFB_ADDRESS) as isize),
        count as usize,
    )
}

pub unsafe fn mmap_write8(addr: u32, value: i32) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr);
        *vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) = value as u8
    }
    else {
        ext::mmap_write8(addr, value)
    }
}
pub unsafe fn mmap_write16(addr: u32, value: i32) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr);
        ptr::write_unaligned(
            vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *mut u16,
            value as u16,
        )
    }
    else {
        ext::mmap_write16(addr, value)
    }
}
pub unsafe fn mmap_write32(addr: u32, value: i32) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr);
        ptr::write_unaligned(
            vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *mut i32,
            value,
        )
    }
    else if addr >= APIC_MEM_ADDRESS && addr < APIC_MEM_ADDRESS + APIC_MEM_SIZE {
        apic::write32(addr - APIC_MEM_ADDRESS, value as u32);
        handle_irqs();
    }
    else if addr >= IOAPIC_MEM_ADDRESS && addr < IOAPIC_MEM_ADDRESS + IOAPIC_MEM_SIZE {
        ioapic::write32(addr - IOAPIC_MEM_ADDRESS, value as u32);
        handle_irqs();
    }
    else if addr >= AHCI_MEM_ADDRESS && addr < AHCI_MEM_ADDRESS + AHCI_MEM_SIZE {
        ext::mmap_write32(addr, value);
        handle_irqs();
    }
    else {
        ext::mmap_write32(addr, value)
    }
}
pub unsafe fn mmap_write64(addr: u32, value: u64) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr);
        ptr::write_unaligned(
            vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *mut u64,
            value,
        )
    }
    else {
        ext::mmap_write64(addr, value as i32, (value >> 32) as i32)
    }
}
pub unsafe fn mmap_write128(addr: u32, v0: u64, v1: u64) {
    if in_svga_lfb(addr) {
        vga::mark_dirty(addr);
        ptr::write_unaligned(
            vga_mem8.offset((addr - VGA_LFB_ADDRESS) as isize) as *mut u64,
            v0,
        );
        ptr::write_unaligned(
            vga_mem8.offset((addr - VGA_LFB_ADDRESS + 8) as isize) as *mut u64,
            v1,
        )
    }
    else {
        ext::mmap_write128(
            addr,
            v0 as i32,
            (v0 >> 32) as i32,
            v1 as i32,
            (v1 >> 32) as i32,
        )
    }
}

#[no_mangle]
pub unsafe fn is_memory_zeroed(addr: u32, length: u32) -> bool {
    dbg_assert!(addr % 8 == 0);
    dbg_assert!(length % 8 == 0);
    for i in (addr..addr + length).step_by(8) {
        if *(mem8.offset(i as isize) as *const i64) != 0 {
            return false;
        }
    }
    return true;
}

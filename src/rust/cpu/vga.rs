#![allow(non_upper_case_globals)]
#![allow(static_mut_refs)]

// Safety of allow(static_mut_refs) in this file:
// These following two globals are not passed anywhere, only built-in function are called on them
static mut dirty_bitmap: Vec<u64> = Vec::new();
static mut dest_buffer: Vec<u32> = Vec::new();
// 256-entry palette for 8bpp mode. JS writes palette entries here via svga_palette_get_ptr,
// then calls svga_fill_pixel_buffer_8bpp to do SIMD-accelerated indexed→RGBX conversion.
static mut palette_buffer: [u32; 256] = [0u32; 256];

use crate::cpu::global_pointers;
use crate::cpu::memory;

use std::ptr;

#[cfg(target_feature = "simd128")]
use core::arch::wasm32::*;

#[no_mangle]
pub unsafe fn svga_allocate_dest_buffer(size: u32) -> u32 {
    dest_buffer.resize(size as usize, 0);
    dest_buffer.as_mut_ptr() as u32
}

pub unsafe fn set_dirty_bitmap_size(size: u32) { dirty_bitmap.resize(size as usize, 0); }

pub unsafe fn mark_dirty(addr: u32) {
    let page = (addr - memory::VGA_LFB_ADDRESS) >> 12;
    dbg_assert!(((page >> 6) as usize) < dirty_bitmap.len());
    *dirty_bitmap.get_unchecked_mut((page >> 6) as usize) |= 1 << (page & 63)
}

#[no_mangle]
pub unsafe fn svga_mark_dirty() {
    for v in dirty_bitmap.iter_mut() {
        *v = u64::MAX
    }
}

fn iter_dirty_pages(f: &dyn Fn(isize)) {
    let mut min_off = u32::MAX;
    let mut max_off = u32::MIN;

    for (i, &word) in unsafe { dirty_bitmap.iter().enumerate() } {
        if word == 0 {
            continue;
        }
        for j in 0..64 {
            if word & 1 << j == 0 {
                continue;
            }
            let off = ((i << 6 | j) << 12) as isize;
            dbg_assert!(off < unsafe { memory::vga_memory_size as isize });
            if min_off == u32::MAX {
                min_off = off as u32;
            }
            max_off = off as u32;
            f(off);
        }
    }

    unsafe {
        *global_pointers::svga_dirty_bitmap_min_offset = min_off;
        *global_pointers::svga_dirty_bitmap_max_offset = max_off + 0xFFF;
    }
}

/// Convert a single BGRX u32 to RGBX with alpha=0xFF (scalar fallback)
#[inline(always)]
unsafe fn bgrx_to_rgbx(dword: u32) -> u32 {
    dword << 16 | dword >> 16 & 0xFF | dword & 0xFF00 | 0xFF00_0000
}

/// SIMD-accelerated BGRX→RGBX conversion for the 32bpp path.
/// Processes 4 pixels (16 bytes) at a time using i8x16_swizzle.
#[cfg(target_feature = "simd128")]
#[inline(always)]
unsafe fn bgrx_to_rgbx_simd_4px(src: *const u32, dest: *mut u32) {
    // BGRX input:  [B0,G0,R0,X0, B1,G1,R1,X1, B2,G2,R2,X2, B3,G3,R3,X3]
    // RGBX output: [R0,G0,B0,FF, R1,G1,B1,FF, R2,G2,B2,FF, R3,G3,B3,FF]
    // Swizzle: byte[0]=src[2], byte[1]=src[1], byte[2]=src[0], byte[3]=don't care (will be ORed)
    let swizzle_mask = i8x16(
        2, 1, 0, 0, // pixel 0: R,G,B, placeholder
        6, 5, 4, 0, // pixel 1
        10, 9, 8, 0, // pixel 2
        14, 13, 12, 0, // pixel 3
    );
    let alpha_mask = u32x4(0xFF000000, 0xFF000000, 0xFF000000, 0xFF000000);

    let pixels = v128_load(src as *const v128);
    let swizzled = i8x16_swizzle(pixels, swizzle_mask);
    let result = v128_or(swizzled, alpha_mask);
    v128_store(dest as *mut v128, result);
}

#[no_mangle]
pub unsafe fn svga_fill_pixel_buffer(bpp: u32, svga_dest_offset: u32) {
    let debug_bounds = false;

    match bpp {
        32 => iter_dirty_pages(&|off| {
            dbg_assert!(off >= 0);
            let src = memory::vga_mem8.offset(off) as *const u32;
            let dest_offset = off / 4 - svga_dest_offset as isize;
            let dest = dest_buffer.as_mut_ptr().offset(dest_offset) as *mut u32;
            let end = if dest_offset < 0 {
                0
            }
            else {
                isize::min(1024, dest_buffer.len() as isize - dest_offset)
            };

            dbg_assert!(src as u32 % 8 == 0);
            dbg_assert!(dest as u32 % 8 == 0);

            #[cfg(target_feature = "simd128")]
            {
                // Process 4 pixels at a time with SIMD
                let simd_end = end & !3; // round down to multiple of 4
                let mut i: isize = 0;
                while i < simd_end {
                    if debug_bounds && (i == 0 || i + 3 >= end - 1) {
                        // Scalar fallback for debug boundary pixels
                        for j in 0..4 {
                            let dword = *src.offset(i + j);
                            let dword = if debug_bounds && (i + j == 0 || i + j == end - 1) { 0xFFFFFF } else { dword };
                            *dest.offset(i + j) = bgrx_to_rgbx(dword);
                        }
                    }
                    else {
                        bgrx_to_rgbx_simd_4px(src.offset(i), dest.offset(i));
                    }
                    i += 4;
                }
                // Handle remaining pixels (0-3) with scalar
                while i < end {
                    let dword = *src.offset(i);
                    let dword = if debug_bounds && (i == 0 || i == end - 1) { 0xFFFFFF } else { dword };
                    *dest.offset(i) = bgrx_to_rgbx(dword);
                    i += 1;
                }
            }
            #[cfg(not(target_feature = "simd128"))]
            {
                for i in 0..end {
                    dbg_assert!(off + i < memory::vga_memory_size as isize);
                    let dword = *src.offset(i);
                    let dword = if debug_bounds && (i == 0 || i == end - 1) { 0xFFFFFF } else { dword };
                    dbg_assert!(dest_offset + i < dest_buffer.len() as isize);
                    *dest.offset(i) = bgrx_to_rgbx(dword);
                }
            }
        }),
        24 => iter_dirty_pages(&|off| {
            dbg_assert!(off >= 0 && off < memory::vga_memory_size as isize);
            let off = off - off % 3;
            let src = memory::vga_mem8.offset(off);
            let dest_offset = off / 3 - svga_dest_offset as isize;
            let dest = dest_buffer.as_mut_ptr().offset(dest_offset) as *mut u32;
            let end = if dest_offset < 0 {
                0
            }
            else {
                isize::min(4096 / 3 + 1, dest_buffer.len() as isize - dest_offset)
            };
            for i in 0..end {
                let dword = ptr::read_unaligned(src.offset(3 * i) as *const u32);
                let dword = if debug_bounds && (i == 0 || i == end - 1) { 0xFFFFFF } else { dword };
                dbg_assert!(dest_offset + i < dest_buffer.len() as isize);
                *dest.offset(i) = bgrx_to_rgbx(dword);
            }
        }),
        16 => iter_dirty_pages(&|off| {
            dbg_assert!(off >= 0 && off + 2048 < memory::vga_memory_size as isize);
            let src = memory::vga_mem8.offset(off) as *const u16;
            let dest_offset = off / 2 - svga_dest_offset as isize;
            let dest = dest_buffer.as_mut_ptr().offset(dest_offset) as *mut u32;
            let end = if dest_offset < 0 {
                0
            }
            else {
                isize::min(2048, dest_buffer.len() as isize - dest_offset)
            };
            for i in 0..end {
                dbg_assert!(off + i < memory::vga_memory_size as isize);
                let word = *src.offset(i);
                let word = if debug_bounds && (i == 0 || i == end - 1) { 0xFFFF } else { word };
                let r = (word & 0x1F) * 0xFF / 0x1F;
                let g = (word >> 5 & 0x3F) * 0xFF / 0x3F;
                let b = (word >> 11) * 0xFF / 0x1F;
                dbg_assert!(dest_offset + i < dest_buffer.len() as isize);
                *dest.offset(i) = (r as u32) << 16 | (g as u32) << 8 | b as u32 | 0xFF00_0000;
            }
        }),
        15 => iter_dirty_pages(&|off| {
            dbg_assert!(off >= 0 && off + 2048 < memory::vga_memory_size as isize);
            let src = memory::vga_mem8.offset(off) as *const u16;
            let dest_offset = off / 2 - svga_dest_offset as isize;
            let dest = dest_buffer.as_mut_ptr().offset(dest_offset) as *mut u32;
            let end = if dest_offset < 0 {
                0
            }
            else {
                isize::min(2048, dest_buffer.len() as isize - dest_offset)
            };
            for i in 0..end {
                dbg_assert!(off + i < memory::vga_memory_size as isize);
                let word = *src.offset(i);
                let word = if debug_bounds && (i == 0 || i == end - 1) { 0xFFFF } else { word };
                let r = (word & 0x1F) * 0xFF / 0x1F;
                let g = (word >> 5 & 0x1F) * 0xFF / 0x1F;
                let b = (word >> 10 & 0x1F) * 0xFF / 0x1F;
                dbg_assert!(dest_offset + i < dest_buffer.len() as isize);
                *dest.offset(i) = (r as u32) << 16 | (g as u32) << 8 | b as u32 | 0xFF00_0000;
            }
        }),
        _ => {
            dbg_log!("{}", bpp);
            dbg_assert!(false, "Unsupported bpp");
        },
    }

    for v in dirty_bitmap.iter_mut() {
        *v = 0
    }
}

/// Returns a pointer to the 256-entry palette buffer in WASM memory.
/// JS should write the vga256_palette entries here before calling svga_fill_pixel_buffer_8bpp.
#[no_mangle]
pub unsafe fn svga_palette_get_ptr() -> u32 { palette_buffer.as_ptr() as u32 }

/// 8bpp palette lookup: called from JavaScript to convert indexed-color SVGA framebuffer
/// to RGBX pixel buffer using the VGA 256-color palette stored in palette_buffer.
///
/// `pixel_count`: number of pixels to convert
///
/// JS must first copy vga256_palette into palette_buffer (via svga_palette_get_ptr).
/// Reads from vga_mem8, writes to dest_buffer with BGRX→RGBX conversion.
#[no_mangle]
pub unsafe fn svga_fill_pixel_buffer_8bpp(pixel_count: u32) {
    let palette_ptr = palette_buffer.as_ptr();
    let src = memory::vga_mem8 as *const u8;
    let dest = dest_buffer.as_mut_ptr();
    let count = u32::min(pixel_count, dest_buffer.len() as u32) as isize;

    #[cfg(target_feature = "simd128")]
    {
        let alpha_mask = u32x4(0xFF000000, 0xFF000000, 0xFF000000, 0xFF000000);
        let swizzle_mask = i8x16(
            2, 1, 0, 0,
            6, 5, 4, 0,
            10, 9, 8, 0,
            14, 13, 12, 0,
        );

        let simd_end = count & !3; // round down to multiple of 4
        let mut i: isize = 0;
        while i < simd_end {
            // Look up 4 palette entries
            let c0 = *palette_ptr.offset(*src.offset(i) as isize);
            let c1 = *palette_ptr.offset(*src.offset(i + 1) as isize);
            let c2 = *palette_ptr.offset(*src.offset(i + 2) as isize);
            let c3 = *palette_ptr.offset(*src.offset(i + 3) as isize);

            // Pack 4 BGRX pixels into v128 and swizzle to RGBX
            let pixels = u32x4(c0, c1, c2, c3);
            let swizzled = i8x16_swizzle(pixels, swizzle_mask);
            let result = v128_or(swizzled, alpha_mask);
            v128_store(dest.offset(i) as *mut v128, result);
            i += 4;
        }
        // Scalar tail
        while i < count {
            let color = *palette_ptr.offset(*src.offset(i) as isize);
            *dest.offset(i) = bgrx_to_rgbx(color);
            i += 1;
        }
    }
    #[cfg(not(target_feature = "simd128"))]
    {
        for i in 0..count {
            let color = *palette_ptr.offset(*src.offset(i) as isize);
            *dest.offset(i) = bgrx_to_rgbx(color);
        }
    }
}

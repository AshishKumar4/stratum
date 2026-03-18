/// page_pool.rs — WASM-side hot page frame lookup table.
///
/// # Purpose
///
/// The demand-paging system calls the JS `swap_page_in` import on every TLB
/// miss for a GPA ≥ PAGED_THRESHOLD.  Each WASM→JS FFI crossing costs ~1–5 µs.
/// KolibriOS with a 1024×768 GUI touches 10 K+ distinct pages; the v86 TLB
/// holds only ~4 K entries, so the eviction rate is high and FFI crossings
/// accumulate into tens of ms per frame — making the GUI feel sluggish.
///
/// # Solution: WASM-side frame map
///
/// `FRAME_MAP[gpa >> 12]` stores the WASM byte offset of the currently-loaded
/// frame for that GPA, or -1 if the page is not in the hot pool.  The lookup
/// is pure WASM arithmetic — no FFI.  Only a *cache miss* (page not in pool)
/// escalates to the JS `swap_page_in` import, which then calls `pool_register`
/// to update FRAME_MAP.
///
/// `FRAME_MAP` covers GPAs 0..=MAX_GPA_4K pages.
/// MAX_GPA_4K = 65536 → covers 0..256 MB of guest physical address space.
/// At 4 bytes per entry: 256 KB static cost.
///
/// # Reference bit
///
/// `REF_MAP[gpa >> 12]` stores the reference bit for the Clock eviction
/// algorithm run on the JS side.  When `pool_lookup` returns a valid offset it
/// sets the ref bit — the JS clock sweep reads and clears it during eviction.
/// This keeps the reference-tracking entirely consistent between the two sides.
///
/// # Thread safety
///
/// v86 is single-threaded (one WASM instance, no SharedArrayBuffer threads
/// on the DO isolate).  The statics are safe to access without locks.

use crate::cpu::memory::PAGED_THRESHOLD;

// ── Table sizing ─────────────────────────────────────────────────────────────

/// Maximum guest physical address covered by the pool map, in pages.
/// 65536 pages × 4 KB = 256 MB.  Enough for any guest we currently support.
const MAX_PAGES: usize = 65536; // 256 MB / 4 KB

const UNMAPPED: i32 = -1;

// ── Static tables ─────────────────────────────────────────────────────────────

/// FRAME_MAP[gpa >> 12] = WASM byte offset of the hot frame, or UNMAPPED.
#[allow(non_upper_case_globals)]
static mut FRAME_MAP: [i32; MAX_PAGES] = [UNMAPPED; MAX_PAGES];

/// REF_MAP[gpa >> 12] = reference bit (1 = recently accessed, 0 = cold).
/// Read and cleared by the JS Clock eviction sweep; set by pool_lookup.
#[allow(non_upper_case_globals)]
static mut REF_MAP: [u8; MAX_PAGES] = [0; MAX_PAGES];

// ── Public WASM exports ───────────────────────────────────────────────────────

/// Hot-path pool lookup called from `do_page_walk` before crossing to JS.
///
/// Returns the WASM byte offset of the frame holding `gpa`, or -1 if the
/// page is not currently in the pool (cold miss — caller must call JS
/// `swap_page_in` and then `pool_register`).
///
/// Sets the reference bit on hit so the JS Clock algorithm sees this page
/// as recently used.
///
/// `gpa` must be page-aligned (low 12 bits zero); the function masks them
/// away defensively.
#[no_mangle]
pub unsafe fn pool_lookup(gpa: u32) -> i32 {
    let idx = (gpa >> 12) as usize;
    if idx >= MAX_PAGES {
        return UNMAPPED;
    }
    let offset = FRAME_MAP[idx];
    if offset != UNMAPPED {
        REF_MAP[idx] = 1;
    }
    offset
}

/// Register (or update) the WASM frame offset for a guest page.
///
/// Called from JS (`SqlPageStore`) after a frame is loaded from SQLite and
/// placed in the hot pool.  Also called for identity-mapped pages (GPA within
/// the pool region) where `wasm_offset == gpa`.
///
/// `gpa`         — guest physical address (page-aligned).
/// `wasm_offset` — WASM linear memory byte offset of the 4 KB frame.
#[no_mangle]
pub unsafe fn pool_register(gpa: u32, wasm_offset: u32) {
    let idx = (gpa >> 12) as usize;
    if idx < MAX_PAGES {
        FRAME_MAP[idx] = wasm_offset as i32;
        REF_MAP[idx] = 1;
    }
}

/// Unregister a guest page from the pool (called on eviction).
///
/// After this call `pool_lookup(gpa)` returns -1 until `pool_register` is
/// called again for the same GPA.
#[no_mangle]
pub unsafe fn pool_unregister(gpa: u32) {
    let idx = (gpa >> 12) as usize;
    if idx < MAX_PAGES {
        FRAME_MAP[idx] = UNMAPPED;
        REF_MAP[idx] = 0;
    }
}

/// Read the reference bit for `gpa` (used by JS Clock sweep).
/// Returns 1 if recently accessed, 0 otherwise.
#[no_mangle]
pub unsafe fn pool_get_ref(gpa: u32) -> i32 {
    let idx = (gpa >> 12) as usize;
    if idx < MAX_PAGES { REF_MAP[idx] as i32 } else { 0 }
}

/// Clear the reference bit for `gpa` (called by JS Clock sweep on second-chance).
#[no_mangle]
pub unsafe fn pool_clear_ref(gpa: u32) {
    let idx = (gpa >> 12) as usize;
    if idx < MAX_PAGES {
        REF_MAP[idx] = 0;
    }
}

/// Reset the entire pool map (called on emulator reset / state restore).
#[no_mangle]
pub unsafe fn pool_reset() {
    for i in 0..MAX_PAGES {
        FRAME_MAP[i] = UNMAPPED;
        REF_MAP[i] = 0;
    }
}

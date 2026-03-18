# SQLite-backed demand-paged RAM for stratum/v86 in Cloudflare Durable Objects

## Problem

Cloudflare Durable Objects have a 128 MB total isolate memory limit. A running v86 VM
consumes roughly:

```
 48 MB  WASM linear memory (guest RAM, allocated by allocate_memory())
  4 MB  VGA SVGA buffer    (svga_allocate_memory())
 30 MB  WASM heap overhead (JIT code cache, TLB tables, CPU struct arrays)
 20 MB  JS heap            (emulator objects, WS sessions, delta encoder)
────────────────────────────────────────────────────────────────────────
~102 MB total — marginal headroom, guest cannot exceed 48 MB
```

Guest OSes like TinyCore Linux need 96–128 MB to run their full desktop environment.
48 MB causes OOM kills when applications allocate heap.

## Solution: SQLite-backed demand-paging via TLB miss hook

DO SQLite (`ctx.storage.sql.exec()`) is **synchronous** — no Promises, no ASYNCIFY needed.
This enables transparent demand-paging: when the guest touches a cold page, we block
synchronously, load it from SQLite into a hot WASM frame, and return.

### Memory layout

```
WASM memory_size = 48 MB  (physical allocation; stays within DO budget)
Logical RAM      = 128 MB (reported to BIOS/guest via CMOS E820 registers)

mem8[0 .. 32 MB]           ← permanently resident guest RAM (GPA 0x00000000–0x02000000)
mem8[32 MB .. 48 MB]       ← hot page frame pool (4096 × 4 KB frames)
                              GPA 0x02000000–0x08000000 is NOT directly backed here;
                              hot pool frames are WASM-offset storage only.

PAGED_THRESHOLD = 32 MB    ← GPAs ≥ this are demand-paged
Cold store       = SQLite   ← all 4 KB pages at GPA ≥ 32 MB live here when cold
```

The BIOS (SeaBIOS CMOS registers) is patched to report `logical_memory_size` (128 MB)
instead of `memory_size[0]` (48 MB). The guest allocates virtual pages that map to
physical GPAs between 32 MB and 128 MB. These GPAs are intercepted in `do_page_walk`
and redirected to hot pool frames within `mem8[32MB..48MB]`.

### Why top-of-mem8 for the hot pool

TLB entries in v86 encode `(high + mem8_ptr) ^ virt_page<<12 | flags`. The JIT fast
path uses this baked-in pointer directly with zero additional arithmetic. Placing hot
frames within `mem8` means the TLB entry construction at `do_page_walk:2135` works
unchanged — we simply substitute a frame WASM offset for the raw GPA before that line.

## Hook point: `do_page_walk` in `src/rust/cpu/cpu.rs`

`do_page_walk` resolves a guest-virtual address to a guest-physical address (`high`)
via x86 page table walking, then builds the TLB entry:

```rust
let tlb_entry = (high + memory::mem8 as u32) as i32 ^ page << 12 | info_bits as i32;
```

`high` is assigned in four places (all converge before line 2118):

| Path | Assignment |
|------|-----------|
| Paging disabled | `high = addr as u32 & 0xFFFFF000` |
| PAE 2MB huge page | `high = pde as u32 & 0xFFE00000 \| (addr & 0x1FF000)` |
| Non-PAE 4MB huge page | `high = pde as u32 & 0xFFC00000 \| (addr & 0x3FF000)` |
| Normal 4KB PTE | `high = pte as u32 & 0xFFFFF000` |

**Injection point**: immediately before `let is_in_mapped_range = memory::in_mapped_range(high)`
(line 2118), after all four paths have set `high`:

```rust
// Demand-paging: redirect GPAs in the swappable range to a hot frame.
if high >= memory::PAGED_THRESHOLD {
    let frame_offset = unsafe { memory::ext::swap_page_in(high) };
    if frame_offset >= 0 {
        high = frame_offset as u32;
    }
    // On -1 (shouldn't happen): fall through, access will trap or
    // hit in_mapped_range and go to mmap handler (both safe).
}
```

`swap_page_in(gpa)` is a WASM import (`extern "C"` in the `ext` block in `memory.rs`).
It calls `SqlPageStore.swapIn(gpa)` in JS, which:
1. Checks the hot map — if the GPA is already in a frame, returns that frame's WASM offset.
2. If cold: reads 4 KB from SQLite (synchronous), copies into an LRU-evicted frame.
3. Returns the WASM byte offset of the frame (within `mem8[32MB..48MB]`).

## WASM import: `swap_page_in`

Added to `src/rust/cpu/memory.rs` `ext` block:

```rust
pub fn swap_page_in(gpa: u32) -> i32;
```

Return value: WASM byte offset of the hot frame (always in `[HOT_POOL_BASE, memory_size)`),
or -1 on error (should never occur in practice).

Added constant:

```rust
/// GPA threshold above which pages are demand-paged from SQLite.
/// Equal to HOT_POOL_BASE — physical addresses below this are always resident.
pub const PAGED_THRESHOLD: u32 = 32 * 1024 * 1024; // 32 MB
```

## JS wiring

### `src/browser/starter.js`

- Pass `logical_memory_size` through `settings` from `options`.
- Add `"swap_page_in"` to `wasm_shared_funcs`: `function(gpa) { return cpu.swap_page_in(gpa); }`

### `src/cpu.js`

- `CPU.prototype.swap_page_in`: delegates to `this._swap_page_in_hook(gpa)` if set, else -1.
- `CPU.prototype.init`: read `settings.logical_memory_size`; use it (instead of `memory_size[0]`)
  for CMOS `memory_above_1m`, `memory_above_16m` and `FW_CFG_RAM_SIZE` — the guest sees
  logical RAM, WASM only backs physical RAM.

## DO wiring (`do86/src/linux-vm.ts`)

After `emulator-loaded` fires:

```ts
const HOT_POOL_BASE = 32 * 1024 * 1024; // 32 MB WASM offset
const store = new SqlPageStore(this.ctx.storage.sql as any);
store.init();

const cpu = (this.emulator as any).v86.cpu;
const wasmHeap = new Uint8Array(cpu.wasm_memory.buffer);
store.setWasmHeap(wasmHeap, HOT_POOL_BASE);
store.setCpu(cpu); // for full_clear_tlb() on eviction

cpu._swap_page_in_hook = (gpa: number): number => store.swapIn(gpa);
```

And in `v86Config`:

```ts
memory_size: 48 * 1024 * 1024,       // WASM allocation
logical_memory_size: 128 * 1024 * 1024, // reported to guest BIOS
```

## `SqlPageStore` changes (`do86/src/sql-page-store.ts`)

- `setCpu(cpu)`: stores CPU reference.
- `evictLRU()`: after flushing dirty pages and freeing frames, calls `this.cpu.full_clear_tlb()`.
  This invalidates all TLB entries that may point to the evicted frames. Full flush is
  acceptable: eviction happens every ~4096 page-ins, and flush cost (microseconds) is
  negligible vs SQLite I/O latency.

## TLB flush correctness

When a frame is evicted from the hot pool and reassigned to a new GPA, any TLB entry
caching the old GPA→frame mapping must be invalidated. `full_clear_tlb()` invalidates
all TLB entries (including global ones), forcing `do_page_walk` for all subsequent
accesses. This is conservative but correct.

The JIT also caches compiled code per physical page (`jit_page_has_code`). The `has_code`
flag in the TLB entry is recalculated on each `do_page_walk` call, so after TLB flush,
new TLB entries correctly reflect the current JIT state for each frame's new GPA.

## Build steps

1. `cd /workspace/stratum && cargo rustc --release --target wasm32-unknown-unknown -- \
   -C linker=tools/rust-lld-wrapper -C link-args="--import-table --global-base=4096" \
   -C link-args="build/softfloat.o" -C link-args="build/zstddeclib.o" \
   -C target-feature=+bulk-memory -C target-feature=+multivalue -C target-feature=+simd128`
2. `cp build/wasm32-unknown-unknown/release/v86.wasm build/v86.wasm`
3. Rebuild `libv86.mjs` via esbuild (from `src/main.js`).
4. Copy both to `do86/src/`.
5. `cd /workspace/do86 && bun run build`

## Memory budget after implementation

```
 48 MB  WASM linear memory (32 MB always-resident + 16 MB hot pool)
  4 MB  VGA SVGA buffer
 30 MB  WASM heap
 20 MB  JS heap + SqlPageStore hot map (~50 KB for 4096 entries)
────────────────────────────────────────────────────────────────────
~102 MB total DO isolate usage

Cold storage: up to 96 MB in DO SQLite (compressed BLOBs, ~1 GB limit)
Guest sees:   128 MB RAM
```

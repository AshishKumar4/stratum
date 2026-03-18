# Stratum — v86 fork with AHCI, APIC/SMP, and ACPI extensions

Stratum is a fork of [copy/v86](https://github.com/copy/v86) that adds hardware
emulation features needed to boot [Aqeous OS](https://github.com/AshishKumar4/Aqeous)
and similar bare-metal kernels in the browser and on Cloudflare Workers.

## What this fork adds

### AHCI controller (JS)
Full AHCI HBA emulation registered as a PCI device (Intel ICH9, 8086:2922).
Supports IDENTIFY DEVICE, DMA READ/WRITE via command tables and PRDTs, and
a pluggable virtual disk backend (RAM, Durable Objects, or raw buffer).

- `src/ahci.js` — PCI device, MMIO registers, port state machine
- `src/ahci_protocol.js` — FIS parsing, DMA transfers, PRDT handling
- `src/ahci_virtual_disk.js` — RAM disk with built-in EXT2 formatter
- `src/ahci_msi.js` — MSI/MSI-X interrupt support
- `src/ahci_smp_integration.js` — SMP-aware interrupt routing

### Local APIC / I/O APIC (JS + Rust)
LAPIC and I/O APIC MMIO stubs so guest kernels can write to the standard
0xFEE00000 and 0xFEC00000 regions without crashing the emulator.

- `src/lapic_stub.js` — Pure-JS LAPIC fallback
- `src/rust/cpu/apic_mmio.rs` — Rust APIC MMIO extensions
- `src/rust/cpu/apic_smp.rs` — SMP APIC logic
- `src/rust/cpu/cpu_smp.rs` — Per-CPU state for SMP

### ACPI improvements (JS)
- S5 soft-off (shutdown) support via SLP_EN
- SMI command port (0xB2) for ACPI enable/disable
- Runtime DSDT patching to inject \_S5\_ AML object

### Modified upstream files
- `src/cpu.js` — AHCI/LAPIC device init, SMP WASM imports
- `src/acpi.js` — S5, SMI, DSDT patching
- `src/browser/starter.js` — `ahci_disk_size` option passthrough
- `src/rust/lib.rs`, `src/rust/js_api.rs`, `src/rust/cpu/mod.rs`,
  `src/rust/cpu/memory.rs` — SMP module wiring

## Repository layout

```
src/                  v86 source with our patches applied directly
stratum/
  worker/             Cloudflare Worker (Durable Objects session manager)
  demo/               Browser demo page
  tests/              Headless boot tests (Node.js)
  images/             OS kernel images (gitignored — see images/README.md)
```

## Building

### Prerequisites

```bash
bun install          # install JS dependencies (esbuild)
```

### 1. JS bundles (esbuild — no Closure Compiler needed)

The upstream Makefile uses Google Closure Compiler, which is heavy and hard to
install. We use esbuild instead:

```bash
bun run build:js     # IIFE bundle  → build/libv86.js   (global V86Starter)
bun run build:esm    # ESM bundle   → build/libv86.mjs  (export { V86 })
bun run build        # both of the above
```

Entry point is `src/browser/starter.js`. The following are marked as external
(not bundled): `perf_hooks`, `crypto`, `node:crypto`, `node:fs/promises`,
`./capstone-x86.min.js`, `./libwabt.cjs`.

### 2. WASM build (requires Rust + clang)

```bash
rustup target add wasm32-unknown-unknown
make build/v86.wasm           # release build
make build/v86-debug.wasm     # debug build (for tests)
```

The WASM build also needs `clang` (for softfloat.o and zstddeclib.o C objects)
and the Rust `wasm32-unknown-unknown` target.

> **Note:** Rust SMP extensions exist in `src/rust/cpu/` (`apic_mmio.rs`,
> `apic_smp.rs`, `cpu_smp.rs`, `ioapic_smp.rs`) but these are scaffolding —
> the SMP WASM exports compile but aren't exercised at runtime yet. The
> pure-JS LAPIC stub (`src/lapic_stub.js`) handles APIC MMIO in the meantime.
> See `SMP_PLAN.md` for the full roadmap.

### 3. Run the demo

```bash
bun run demo         # starts Bun server on port 8080
```

The demo needs `stratum/images/aqeous.bin` (gitignored — see
`stratum/images/README.md` for how to obtain it). The server serves the JS
bundle, WASM, BIOS binaries, and kernel images.

### 4. Run headless tests

```bash
# Requires stratum/images/aqeous.bin
node stratum/tests/test_headless.mjs
```

### 5. Cloudflare Worker

```bash
cd stratum/worker
bun install
bun run dev
```

## Upstream

Based on v86 by Fabian Hemmer — https://github.com/copy/v86

v86 is licensed under BSD-2-Clause. See LICENSE.

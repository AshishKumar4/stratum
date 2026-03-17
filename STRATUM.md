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

## Quick start

### Build JS bundle (development — fast)

```bash
bun install   # or npm install
npx esbuild src/main.js --bundle --format=esm --platform=node \
  --outfile=build/libv86.mjs \
  --define:DEBUG=false \
  --external:fs --external:path --external:url --external:"node:*" \
  --sourcemap --target=es2020
```

### Build WASM (requires Rust + clang)

```bash
rustup target add wasm32-unknown-unknown
make build/v86.wasm
```

### Run headless test

```bash
# Place aqeous.bin in stratum/images/ first (see stratum/images/README.md)
node stratum/tests/test_headless.mjs
```

### Cloudflare Worker

```bash
cd stratum/worker
bun install
bun run dev
```

## Upstream

Based on v86 by Fabian Hemmer — https://github.com/copy/v86

v86 is licensed under BSD-2-Clause. See LICENSE.

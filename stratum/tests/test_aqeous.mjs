#!/usr/bin/env node
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const v86root = path.resolve(__dirname, "../v86-aqeous-extension");
const { V86 } = await import(v86root + "/src/main.js");

process.on("unhandledRejection", exn => { console.error("UNHANDLED:", exn); process.exit(1); });

const MEMORY_SIZE = 1024 * 1024 * 1024;

console.log("[TEST] Starting Aqeous headless boot (" + (MEMORY_SIZE / 1024 / 1024) + "MB RAM)");

const emulator = new V86({
    wasm_path: path.join(__dirname, "build/v86-extensions.wasm"),
    bios:     { url: path.join(v86root, "bios/seabios.bin") },
    vga_bios: { url: path.join(v86root, "bios/vgabios.bin") },
    multiboot: { url: path.join(__dirname, "images/aqeous.bin") },
    memory_size: MEMORY_SIZE,
    vga_memory_size: 8 * 1024 * 1024,
    autostart: true,
    log_level: 0x400082,
    disable_jit: 0,
    acpi: true,
    ahci_disk_size: 32 * 1024 * 1024,
});

let serialBuf = "";
emulator.add_listener("serial0-output-byte", function(byte) {
    const ch = String.fromCharCode(byte);
    serialBuf += ch;
    if (ch === "\n") {
        process.stdout.write("[SERIAL] " + serialBuf);
        serialBuf = "";
    }
});

let lastScreen = "";
const startTime = Date.now();

const poll = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    let screen = "";
    try {
        const rows = emulator.screen_adapter && emulator.screen_adapter.get_text_screen && emulator.screen_adapter.get_text_screen();
        if (Array.isArray(rows)) screen = rows.join("\n").trim();
    } catch(e) {}

    if (screen && screen !== lastScreen) {
        const lines = screen.split("\n").filter(l => l.trim());
        console.log("\n[VGA @ " + elapsed + "s] ----------------------------------------");
        for (const line of lines) {
            console.log("  " + line);
        }
        lastScreen = screen;
    }

    if (Date.now() - startTime > 120000) {
        console.log("\n[TEST] Timeout after 120s");
        process.exit(1);
    }
}, 2000);

emulator.add_listener("emulator-started", () => {
    console.log("[EVENT] emulator-started @ " + ((Date.now() - startTime)/1000).toFixed(1) + "s");
});

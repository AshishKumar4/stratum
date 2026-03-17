#!/usr/bin/env node
import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const v86root = path.resolve(__dirname, "../v86-aqeous-extension");
const { V86 } = await import(v86root + "/src/main.js");

process.on("unhandledRejection", exn => { console.error(exn); process.exit(1); });

const emulator = new V86({
    wasm_path: path.join(__dirname, "build/v86-extensions.wasm"),
    bios:     { url: path.join(v86root, "bios/seabios.bin") },
    vga_bios: { url: path.join(v86root, "bios/vgabios.bin") },
    fda:      { url: path.join(__dirname, "images/kolibri.img"), size: 1474560 },
    memory_size: 64 * 1024 * 1024,
    vga_memory_size: 8 * 1024 * 1024,
    autostart: true,
    log_level: -1,
    disable_jit: 0,
});

let lastScreen = "";
const startTime = Date.now();
const poll = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    let screen = "";
    try {
        const rows = emulator.screen_adapter.get_text_screen();
        if (Array.isArray(rows)) screen = rows.join("\n");
        else if (typeof rows === "string") screen = rows;
    } catch(e) { screen = "(err: " + e.message + ")"; }

    if (screen !== lastScreen) {
        console.log("\n=== VGA Screen @ " + elapsed + "s ===");
        console.log(screen);
        lastScreen = screen;
    }

    if (Date.now() - startTime > 15000) {
        console.log("\n=== TIMEOUT (15s) ===");
        console.log(screen);
        clearInterval(poll);
        emulator.stop();
        process.exit(0);
    }
}, 1000);

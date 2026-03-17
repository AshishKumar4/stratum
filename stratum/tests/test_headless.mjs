import path from "node:path";
import url from "node:url";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const { V86 } = await import(repoRoot + "/src/main.js");

process.on("unhandledRejection", e => { console.error("UNHANDLED:", e); process.exit(1); });

const TIMEOUT_S = 120;

const emulator = new V86({
    wasm_path: path.join(repoRoot, "build/v86.wasm"),
    bios:     { url: path.join(repoRoot, "bios/seabios.bin") },
    vga_bios: { url: path.join(repoRoot, "bios/vgabios.bin") },
    multiboot: { url: path.join(__dirname, "../images/aqeous.bin") },
    memory_size: 256 * 1024 * 1024,
    vga_memory_size: 8 * 1024 * 1024,
    autostart: true,
    log_level: 0,
    acpi: true,
    ahci_disk_size: 32 * 1024 * 1024,
});

const t0 = Date.now();
let serialBuf = "";
let allOutput = "";
let resolved = false;

function elapsed() {
    return ((Date.now() - t0) / 1000).toFixed(1);
}

// Listen for serial output byte-by-byte, accumulate lines, print with timestamp
emulator.add_listener("serial0-output-byte", (byte) => {
    const ch = String.fromCharCode(byte);
    serialBuf += ch;
    allOutput += ch;

    // Print complete lines as they arrive
    if (ch === "\n" || ch === "\r") {
        const line = serialBuf.replace(/[\r\n]+$/, "");
        if (line.length > 0) {
            console.log(`[${elapsed()}s] ${line}`);
        }
        serialBuf = "";

        // Check for success: shell prompt
        if (line.includes(">") || allOutput.includes("\n>")) {
            success();
        }
    }
});

function success() {
    if (resolved) return;
    resolved = true;

    // Flush any remaining partial line
    if (serialBuf.trim().length > 0) {
        console.log(`[${elapsed()}s] ${serialBuf}`);
    }

    console.log(`\n*** SUCCESS — shell prompt detected at ${elapsed()}s ***`);
    clearInterval(watchdog);
    setTimeout(() => process.exit(0), 1000);
}

// Watchdog: periodic status + timeout
const watchdog = setInterval(() => {
    if (resolved) return;
    const sec = parseFloat(elapsed());

    // If we have a partial line buffered, check it for the prompt
    if (serialBuf.includes(">")) {
        console.log(`[${elapsed()}s] ${serialBuf}`);
        success();
        return;
    }

    // Periodic status if no serial output recently
    if (sec > 10 && allOutput.length === 0) {
        console.log(`[${elapsed()}s] (no serial output yet)`);
    }

    if (sec >= TIMEOUT_S) {
        console.log(`\n*** TIMEOUT after ${TIMEOUT_S}s ***`);

        // Dump any remaining serial buffer
        if (serialBuf.length > 0) {
            console.log(`[partial] ${serialBuf}`);
        }

        // Dump CPU state for diagnosis
        try {
            const cpu = emulator.v86?.cpu;
            if (cpu) {
                const eip = cpu.instruction_pointer[0] >>> 0;
                const idle = emulator.v86.idle;
                const inHlt = cpu.in_hlt;
                const eflags = cpu.flags[0] >>> 0;
                console.log(`\nCPU: EIP=0x${eip.toString(16)}  idle=${idle}  in_hlt=${!!inHlt}  EFLAGS=0x${eflags.toString(16)}`);
            }
        } catch {}

        // Dump total serial output received
        console.log(`\n=== ALL SERIAL OUTPUT (${allOutput.length} bytes) ===`);
        console.log(allOutput || "(empty)");

        clearInterval(watchdog);
        process.exit(1);
    }
}, 3000);

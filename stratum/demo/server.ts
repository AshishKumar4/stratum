import { readFileSync } from "fs";
import { join, extname, basename } from "path";

const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = "0.0.0.0";

// Resolve paths relative to this file's directory (demo/) so the server works
// regardless of the working directory or where the repo is cloned.
const DEMO_DIR  = import.meta.dir;               // stratum/demo/
const ROOT      = join(DEMO_DIR, "..", "..");     // repo root
const BIOS_DIR  = join(ROOT, "bios");
const WASM_PATH = join(ROOT, "build", "v86-extensions.wasm");
const LIB_PATH  = join(ROOT, "build", "libv86.js");
const IMG_DIR   = join(DEMO_DIR, "..", "images");
const HTML_PATH = join(DEMO_DIR, "index.html");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".bin":  "application/octet-stream",
  ".img":  "application/octet-stream",
  ".wasm": "application/wasm",
  ".iso":  "application/octet-stream",
};

function mime(path: string): string {
  return MIME[extname(path)] ?? "application/octet-stream";
}

function fileResponse(filePath: string, contentType?: string): Response {
  try {
    const data = readFileSync(filePath);
    return new Response(data, {
      headers: {
        "Content-Type": contentType ?? mime(filePath),
        "Content-Length": String(data.length),
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e: any) {
    const status = e?.code === "ENOENT" ? 404 : 500;
    const msg    = e?.code === "ENOENT" ? `Not Found: ${filePath}` : `Error: ${e.message}`;
    return new Response(msg, { status });
  }
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,

  fetch(req) {
    const url  = new URL(req.url);
    const path = url.pathname;

    // Root — demo UI
    if (path === "/" || path === "/index.html") {
      return fileResponse(HTML_PATH, "text/html; charset=utf-8");
    }

    // v86 WASM (our SMP+AHCI build) — served at both names for compatibility
    if (path === "/v86-extensions.wasm" || path === "/v86.wasm") {
      return fileResponse(WASM_PATH, "application/wasm");
    }

    // libv86.js (local copy — no CDN needed)
    if (path === "/libv86.js") {
      return fileResponse(LIB_PATH, "application/javascript");
    }

    // BIOS binaries  /bios/seabios.bin  /bios/vgabios.bin  etc.
    if (path.startsWith("/bios/")) {
      const name = basename(path);
      if (!name || name.startsWith(".")) return new Response("Forbidden", { status: 403 });
      return fileResponse(join(BIOS_DIR, name));
    }

    // Disk / floppy images  /images/kolibri.img  /images/aqeous.bin
    if (path.startsWith("/images/")) {
      const name = basename(path);
      if (!name || name.startsWith(".")) return new Response("Forbidden", { status: 403 });
      return fileResponse(join(IMG_DIR, name));
    }

    return new Response("Not Found", { status: 404 });
  },
});

function fileSize(p: string): string {
  try { return Math.round(readFileSync(p).length / 1024) + "KB"; }
  catch { return "NOT FOUND"; }
}

console.log(`Stratum demo server on http://${HOST}:${PORT}`);
console.log(`  GET /            → demo UI`);
console.log(`  GET /libv86.js   → ${LIB_PATH}  (${fileSize(LIB_PATH)})`);
console.log(`  GET /v86.wasm    → ${WASM_PATH}  (${fileSize(WASM_PATH)})`);
console.log(`  GET /bios/*      → ${BIOS_DIR}`);
console.log(`  GET /images/*    → ${IMG_DIR}`);

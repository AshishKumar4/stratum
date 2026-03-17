/**
 * Stratum — v86/Aqeous OS Cloudflare Durable Objects Worker
 *
 * Architecture:
 *  - Worker fetch handler: routes HTTP requests, serves HTML, proxies WebSocket
 *    upgrades to the V86SessionDO Durable Object.
 *  - V86SessionDO: manages one emulator session per DO instance.
 *    Accepts WebSocket at /ws. The v86 WASM runs in the *browser*; the DO
 *    acts as the persistent relay/router for serial I/O and session state.
 *    Serial bytes flowing from the browser's v86 instance are forwarded to
 *    all other connected clients and persisted in DO storage for replay.
 *
 * Why v86 runs in the browser, not in the Worker:
 *  - v86 requires ~512 MB of linear memory for the guest RAM plus its own
 *    heap. Workers are limited to 128 MB.
 *  - v86's JIT (codegen_finalize) calls WebAssembly.Module/Instance at
 *    runtime. Workers prohibit dynamic WASM compilation.
 *  - v86's JS layer uses setTimeout/setInterval for the CPU loop, which
 *    Workers don't support in the fetch context.
 *
 * The WASM binary is served directly from the Worker bundle (uploaded as a
 * module binding) or via a redirect to R2/CDN. BIOS blobs are served from
 * the Worker's asset bundle.
 */

import { DurableObject } from "cloudflare:workers";

// ---------------------------------------------------------------------------
// Environment bindings (declare in wrangler.toml)
// ---------------------------------------------------------------------------
export interface Env {
  /** The Durable Object namespace for emulator sessions */
  V86_SESSION: DurableObjectNamespace;
  /**
   * Optional R2 bucket for large assets (v86.wasm, BIOS files, disk images).
   * If absent, the Worker falls back to WASM_URL redirect.
   */
  ASSETS?: R2Bucket;
  /**
   * Optional KV namespace for session metadata persistence across restarts.
   */
  SESSION_KV?: KVNamespace;
  /**
   * URL to redirect /v86.wasm requests to when ASSETS bucket is not bound.
   * Set in [vars] in wrangler.toml. Defaults to copy.sh CDN.
   */
  WASM_URL?: string;
}

// ---------------------------------------------------------------------------
// Main Worker fetch handler
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Health check
    if (pathname === "/health") {
      return Response.json({
        status: "ok",
        version: "0.1.0",
        features: ["SMP-APIC", "AHCI", "DurableObjects", "WebSocket"],
        timestamp: Date.now(),
      });
    }

    // Serve the emulator UI
    if (pathname === "/" || pathname === "/index.html") {
      return serveHTML(url);
    }

    // Serve pre-built v86 WASM (11 MB debug build)
    if (pathname === "/v86.wasm" || pathname === "/v86-debug.wasm") {
      return serveWasm(pathname, env);
    }

    // Serve BIOS binaries (seabios.bin, vgabios.bin, etc.)
    if (pathname.startsWith("/bios/")) {
      return serveBios(pathname, env);
    }

    // WebSocket upgrade — create/get a named session DO
    if (pathname.startsWith("/ws")) {
      const sessionId = url.searchParams.get("session") ?? "default";
      const doId = env.V86_SESSION.idFromName(sessionId);
      const stub = env.V86_SESSION.get(doId);
      return stub.fetch(request);
    }

    // Session REST API
    if (pathname.startsWith("/session/")) {
      const parts = pathname.split("/");
      const sessionId = parts[2] ?? "default";
      const action = parts[3];
      const doId = env.V86_SESSION.idFromName(sessionId);
      const stub = env.V86_SESSION.get(doId);
      // Rewrite path so DO sees /status, /clear, etc.
      const doUrl = new URL(request.url);
      doUrl.pathname = action ? `/${action}` : "/status";
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// WASM serving
// ---------------------------------------------------------------------------
async function serveWasm(pathname: string, env: Env): Promise<Response> {
  // Try R2 bucket first (for large binaries)
  if (env.ASSETS) {
    const key = pathname.slice(1); // strip leading /
    const obj = await env.ASSETS.get(key);
    if (obj) {
      return new Response(obj.body, {
        headers: {
          "Content-Type": "application/wasm",
          "Cache-Control": "public, max-age=86400",
          "Content-Length": String(obj.size),
        },
      });
    }
  }
  // Fallback: redirect to configured WASM_URL (set in wrangler.toml [vars])
  // or copy.sh CDN. In production, upload to R2 instead.
  const wasmUrl = env.WASM_URL ?? "https://copy.sh/v86/build/v86.wasm";
  return Response.redirect(wasmUrl, 302);
}

// ---------------------------------------------------------------------------
// BIOS serving
// ---------------------------------------------------------------------------
async function serveBios(pathname: string, env: Env): Promise<Response> {
  const filename = pathname.slice("/bios/".length);
  if (!filename || filename.includes("/") || filename.includes("..")) {
    return new Response("Forbidden", { status: 403 });
  }
  if (env.ASSETS) {
    const obj = await env.ASSETS.get(`bios/${filename}`);
    if (obj) {
      return new Response(obj.body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "public, max-age=86400",
          "Content-Length": String(obj.size),
        },
      });
    }
  }
  // Fallback to copy.sh for standard SeaBIOS/VGABIOS
  const KNOWN: Record<string, string> = {
    "seabios.bin": "https://copy.sh/v86/bios/seabios.bin",
    "seabios-debug.bin": "https://copy.sh/v86/bios/seabios-debug.bin",
    "vgabios.bin": "https://copy.sh/v86/bios/vgabios.bin",
    "vgabios-debug.bin": "https://copy.sh/v86/bios/vgabios-debug.bin",
  };
  if (KNOWN[filename]) {
    return Response.redirect(KNOWN[filename], 302);
  }
  return new Response("BIOS file not found", { status: 404 });
}

// ---------------------------------------------------------------------------
// HTML UI
// ---------------------------------------------------------------------------
function serveHTML(requestUrl: URL): Response {
  const wsUrl = `${requestUrl.protocol === "https:" ? "wss" : "ws"}://${requestUrl.host}/ws`;
  const html = buildHTML(wsUrl);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function buildHTML(wsUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Stratum — Aqeous OS on v86</title>
<script src="https://copy.sh/v86/build/libv86.js"></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d1117;--surface:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--green:#3fb950;--blue:#58a6ff;--orange:#f0883e}
body{background:var(--bg);color:var(--text);font-family:'SF Mono','Fira Code',monospace;font-size:13px;min-height:100vh;display:flex;flex-direction:column}
header{padding:12px 20px;border-bottom:1px solid var(--border);background:var(--surface);display:flex;align-items:center;gap:12px}
.logo{font-size:16px;font-weight:700;color:var(--blue)}
.badge{font-size:10px;padding:2px 7px;border-radius:20px;background:rgba(63,185,80,.15);color:var(--green);border:1px solid rgba(63,185,80,.3)}
main{flex:1;display:grid;grid-template-columns:1fr 340px;overflow:hidden}
.emulator{display:flex;flex-direction:column;border-right:1px solid var(--border)}
.panel-hdr{padding:8px 16px;background:var(--surface);border-bottom:1px solid var(--border);font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
#screen_container{flex:1;overflow:hidden;background:#000;display:flex;align-items:center;justify-content:center}
#screen_container canvas,#screen_container div{max-width:100%;max-height:100%}
.sidebar{display:flex;flex-direction:column;overflow:hidden}
#serial_output{flex:1;background:#0d1117;color:var(--green);padding:12px;font-family:inherit;font-size:12px;border:none;resize:none;outline:none;overflow-y:auto}
.controls{padding:10px 14px;background:var(--surface);border-top:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap}
button{background:var(--surface);color:var(--text);border:1px solid var(--border);padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px}
button:hover{border-color:var(--blue);color:var(--blue)}
#ws_status{padding:6px 14px;font-size:11px;color:var(--muted);background:var(--surface);border-bottom:1px solid var(--border)}
</style>
</head>
<body>
<header>
  <span class="logo">Stratum</span>
  <span class="badge">Aqeous OS · v86 · DO</span>
  <span style="margin-left:auto;font-size:11px;color:var(--muted)" id="emu_status">Initializing…</span>
</header>
<main>
  <div class="emulator">
    <div class="panel-hdr">Screen</div>
    <div id="screen_container"><div style="color:var(--muted);text-align:center;padding:40px">
      <div style="font-size:24px;margin-bottom:8px">⚡</div>
      <div>v86 loading…</div>
    </div></div>
  </div>
  <div class="sidebar">
    <div class="panel-hdr">Serial (COM1)</div>
    <div id="ws_status">WebSocket: connecting…</div>
    <textarea id="serial_output" readonly placeholder="Serial output will appear here once the BIOS boots…"></textarea>
    <div class="controls">
      <button id="btn_start">Start</button>
      <button id="btn_stop">Stop</button>
      <button id="btn_reset">Reset</button>
      <button id="btn_clear">Clear log</button>
    </div>
  </div>
</main>
<script>
"use strict";

const WS_URL = ${JSON.stringify(wsUrl)};
const serialOutput = document.getElementById('serial_output');
const emuStatus = document.getElementById('emu_status');
const wsStatus = document.getElementById('ws_status');

// ---------------------------------------------------------------------------
// WebSocket to DO — for serial relay and session management
// ---------------------------------------------------------------------------
let ws = null;
let wsReady = false;

function connectWS() {
  ws = new WebSocket(WS_URL + '?session=' + encodeURIComponent('aqeous-' + Date.now()));
  ws.onopen = () => {
    wsReady = true;
    wsStatus.textContent = 'WebSocket: connected to DO session';
  };
  ws.onclose = () => {
    wsReady = false;
    wsStatus.textContent = 'WebSocket: disconnected (retry in 3s)';
    setTimeout(connectWS, 3000);
  };
  ws.onerror = (e) => {
    wsStatus.textContent = 'WebSocket: error';
  };
  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'serial_history') {
        // Replay buffered serial output from DO
        serialOutput.value += msg.data;
        serialOutput.scrollTop = serialOutput.scrollHeight;
      } else if (msg.type === 'serial_byte') {
        const char = String.fromCharCode(msg.byte);
        serialOutput.value += char;
        serialOutput.scrollTop = serialOutput.scrollHeight;
        // Also forward to v86 input if needed
      }
    } catch {}
  };
}
connectWS();

// ---------------------------------------------------------------------------
// v86 emulator
// ---------------------------------------------------------------------------
let emulator = null;

function startEmulator() {
  if (typeof V86 === 'undefined') {
    emuStatus.textContent = 'Error: libv86.js not loaded';
    return;
  }
  if (emulator) emulator.destroy();

  emuStatus.textContent = 'Booting…';

  emulator = new V86({
    wasm_path: "/v86.wasm",
    memory_size: 64 * 1024 * 1024,   // 64 MB — enough for SeaBIOS self-test
    vga_memory_size: 8 * 1024 * 1024,
    screen_container: document.getElementById('screen_container'),
    bios: { url: "/bios/seabios.bin" },
    vga_bios: { url: "/bios/vgabios.bin" },
    // No disk image — boots to BIOS/SeaBIOS prompt
    // Uncomment to add a disk:
    // hda: { url: "/disk/aqeous.img", async: true },
    // cdrom: { url: "/disk/aqeous.iso", async: true },
    autostart: true,
  });

  emulator.add_listener("emulator-ready", () => {
    emuStatus.textContent = 'Running';
    // Send session-ready notification to DO
    if (wsReady) ws.send(JSON.stringify({ type: 'emulator_ready' }));
  });

  emulator.add_listener("emulator-stopped", () => {
    emuStatus.textContent = 'Stopped';
  });

  // Serial output: write to textarea + send to DO for relay/persistence
  emulator.add_listener("serial0-output-byte", (byte) => {
    const char = String.fromCharCode(byte);
    serialOutput.value += char;
    serialOutput.scrollTop = serialOutput.scrollHeight;
    // Relay serial byte to DO (all other connected clients will receive it)
    if (wsReady && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'serial_byte', byte }));
    }
  });
}

// Button handlers
document.getElementById('btn_start').onclick = () => startEmulator();
document.getElementById('btn_stop').onclick = () => { emulator?.stop(); };
document.getElementById('btn_reset').onclick = () => { emulator?.restart(); };
document.getElementById('btn_clear').onclick = () => { serialOutput.value = ''; };

// Auto-start once libv86 is available
if (typeof V86 !== 'undefined') {
  startEmulator();
} else {
  window.addEventListener('load', () => {
    if (typeof V86 !== 'undefined') {
      startEmulator();
    } else {
      emuStatus.textContent = 'Error: libv86.js failed to load from CDN';
    }
  });
}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// V86SessionDO — Durable Object
// ---------------------------------------------------------------------------

/** Maximum serial bytes to buffer per session (128 KB) */
const SERIAL_BUFFER_LIMIT = 128 * 1024;
/** Idle timeout before auto-cleanup: 30 minutes */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

interface SerialMessage {
  type: "serial_byte";
  byte: number;
}

interface EmulatorReadyMessage {
  type: "emulator_ready";
}

interface ControlMessage {
  type: "control";
  action: "reset" | "stop" | "start";
}

type InboundMessage = SerialMessage | EmulatorReadyMessage | ControlMessage;

export class V86SessionDO extends DurableObject {
  private clients: Set<WebSocket> = new Set();
  private serialBuffer: string = "";
  private sessionId: string = "unknown";
  private lastActivity: number = Date.now();
  private createdAt: number = Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Restore serial buffer from storage on DO restart
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<string>("serial_buffer");
      if (stored) this.serialBuffer = stored;
      const id = await this.ctx.storage.get<string>("session_id");
      if (id) this.sessionId = id;
      const created = await this.ctx.storage.get<number>("created_at");
      if (created) this.createdAt = created;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.lastActivity = Date.now();

    // WebSocket upgrade
    const upgrade = request.headers.get("Upgrade");
    if (upgrade?.toLowerCase() === "websocket") {
      return this.handleWebSocket(request);
    }

    // REST endpoints
    const path = url.pathname;

    if (path === "/status") {
      return Response.json({
        sessionId: this.sessionId,
        connectedClients: this.clients.size,
        serialBufferBytes: this.serialBuffer.length,
        createdAt: this.createdAt,
        lastActivity: this.lastActivity,
        uptime: Date.now() - this.createdAt,
      });
    }

    if (path === "/clear" && request.method === "POST") {
      this.serialBuffer = "";
      await this.ctx.storage.put("serial_buffer", "");
      return Response.json({ cleared: true });
    }

    if (path === "/serial" && request.method === "GET") {
      return new Response(this.serialBuffer, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionParam = url.searchParams.get("session") ?? "default";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Accept the server-side WebSocket
    this.ctx.acceptWebSocket(server);

    // Store session ID on first connection
    if (this.sessionId === "unknown") {
      this.sessionId = sessionParam;
      this.createdAt = Date.now();
      await this.ctx.storage.put("session_id", this.sessionId);
      await this.ctx.storage.put("created_at", this.createdAt);
    }

    this.clients.add(server);

    // Send buffered serial history to the new client
    if (this.serialBuffer.length > 0) {
      server.send(
        JSON.stringify({ type: "serial_history", data: this.serialBuffer })
      );
    }

    // Send current session status
    server.send(
      JSON.stringify({
        type: "session_info",
        sessionId: this.sessionId,
        connectedClients: this.clients.size,
        bufferBytes: this.serialBuffer.length,
      })
    );

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.lastActivity = Date.now();

    if (typeof message !== "string") return;

    let msg: InboundMessage;
    try {
      msg = JSON.parse(message) as InboundMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "serial_byte": {
        // A browser's v86 instance emitted a serial byte.
        // Append to buffer and broadcast to all OTHER clients.
        const char = String.fromCharCode(msg.byte);
        this.serialBuffer += char;

        // Trim buffer if it exceeds limit
        if (this.serialBuffer.length > SERIAL_BUFFER_LIMIT) {
          this.serialBuffer = this.serialBuffer.slice(
            this.serialBuffer.length - SERIAL_BUFFER_LIMIT
          );
        }

        // Persist buffer (debounced — every 100 bytes or on close)
        // We persist inline here for correctness; for high-throughput,
        // move to alarm-based batching.
        await this.ctx.storage.put("serial_buffer", this.serialBuffer);

        // Broadcast to other clients
        this.broadcast(
          JSON.stringify({ type: "serial_byte", byte: msg.byte }),
          ws
        );
        break;
      }

      case "emulator_ready": {
        // Notify all other clients that a new emulator connected
        this.broadcast(
          JSON.stringify({
            type: "peer_emulator_ready",
            timestamp: Date.now(),
          }),
          ws
        );
        break;
      }

      case "control": {
        // Relay control commands to all clients (including sender)
        this.broadcast(
          JSON.stringify({ type: "control", action: msg.action }),
          null
        );
        break;
      }
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string
  ): Promise<void> {
    this.clients.delete(ws);
    // Schedule alarm for idle cleanup
    if (this.clients.size === 0) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_TIMEOUT_MS);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    this.clients.delete(ws);
  }

  async alarm(): Promise<void> {
    const idle = Date.now() - this.lastActivity;
    if (idle >= IDLE_TIMEOUT_MS && this.clients.size === 0) {
      // Clean up storage for idle sessions
      await this.ctx.storage.deleteAll();
    }
  }

  private broadcast(message: string, exclude: WebSocket | null): void {
    for (const client of this.clients) {
      if (client === exclude) continue;
      try {
        client.send(message);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

#!/usr/bin/env bun
/**
 * Concurrent WebSocket connection pressure test for the core server.
 *
 * Tests that N simultaneous WebSocket connections all receive `session_switched`
 * within a reasonable timeout, with detailed per-client timing.
 *
 * Usage:
 *   bun core/tests/test-concurrent.ts              # 5 clients, all at once
 *   bun core/tests/test-concurrent.ts --clients 10 # 10 clients
 *   bun core/tests/test-concurrent.ts --stagger 50 # 50ms between each connection
 *   bun core/tests/test-concurrent.ts --strictmode  # simulate React StrictMode (connect, close, reconnect)
 *   bun core/tests/test-concurrent.ts --vite-proxy  # connect through Vite proxy (tests Chrome connection limit)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import path from "node:path";

// ── CLI args ──
const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}
const NUM_CLIENTS = parseInt(getArg("clients", "5"), 10);
const STAGGER_MS = parseInt(getArg("stagger", "0"), 10);
const STRICT_MODE = args.includes("--strictmode");
const VITE_PROXY = args.includes("--vite-proxy");
const TIMEOUT_MS = 30_000;
const BACKEND_PORT = 15689 + Math.floor(Math.random() * 1000);
const VITE_PORT = BACKEND_PORT + 1;

// ── Colors ──
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

console.log(`\n${BOLD}Concurrent WebSocket Connection Test${RESET}`);
console.log(`${DIM}────────────────────────────────────${RESET}`);
console.log(`  Clients:      ${NUM_CLIENTS}`);
console.log(`  Stagger:      ${STAGGER_MS}ms`);
console.log(`  StrictMode:   ${STRICT_MODE}`);
console.log(`  Vite proxy:   ${VITE_PROXY}`);
console.log(`  Backend port: ${BACKEND_PORT}`);
if (VITE_PROXY) console.log(`  Vite port:    ${VITE_PORT}`);
console.log(`  Timeout:      ${TIMEOUT_MS}ms\n`);

// ── Start server(s) ──
const ROOT = path.resolve(import.meta.dir, "../..");
const children: ChildProcess[] = [];

function cleanup() {
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch {}
  }
}
process.on("SIGINT", () => { cleanup(); process.exit(1); });
process.on("SIGTERM", () => { cleanup(); process.exit(1); });

// Collect logs for debugging
const serverLogs: string[] = [];
function collectLogs(proc: ChildProcess, prefix: string) {
  proc.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) serverLogs.push(`[${prefix}] ${line}`);
    }
  });
  proc.stderr?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) serverLogs.push(`[${prefix}] ${line}`);
    }
  });
}

// Start backend
const serverProcess = spawn("bun", ["core/server/main.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(BACKEND_PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(serverProcess);
collectLogs(serverProcess, "backend");

// Optionally start Vite for proxy testing
let viteProcess: ChildProcess | null = null;
if (VITE_PROXY) {
  viteProcess = spawn("npx", ["vite", "--port", String(VITE_PORT), "--strictPort"], {
    cwd: path.join(ROOT, "core"),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(viteProcess);
  collectLogs(viteProcess, "vite");
}

// ── Wait for server port ──
async function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ port, host: "127.0.0.1" }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Port ${port} not ready after ${timeoutMs}ms`);
}

// ── Client result tracking ──
interface ClientResult {
  id: number;
  connectStartMs: number;   // relative to test start
  connectedMs?: number;     // ws.onopen relative to test start
  sessionMs?: number;       // session_switched received, relative to test start
  sessionsMs?: number;      // sessions list received, relative to test start
  sessionId?: string;
  error?: string;
  closed?: boolean;
  messagesReceived: string[];
}

/** The port clients connect to (backend directly, or Vite proxy). */
const WS_PORT = VITE_PROXY ? VITE_PORT : BACKEND_PORT;

async function connectClient(
  id: number,
  testT0: number,
): Promise<ClientResult> {
  const result: ClientResult = {
    id,
    connectStartMs: performance.now() - testT0,
    messagesReceived: [],
  };

  return new Promise<ClientResult>((resolve) => {
    const timeout = setTimeout(() => {
      result.error = `TIMEOUT after ${TIMEOUT_MS}ms (got: ${result.messagesReceived.join(", ") || "nothing"})`;
      try { ws.close(); } catch {}
      resolve(result);
    }, TIMEOUT_MS);

    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/ws`);

    ws.onopen = () => {
      result.connectedMs = performance.now() - testT0;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        result.messagesReceived.push(msg.type);

        if (msg.type === "session_switched" && !result.sessionMs) {
          result.sessionMs = performance.now() - testT0;
          result.sessionId = msg.sessionId;
        }

        if (msg.type === "sessions" && !result.sessionsMs) {
          result.sessionsMs = performance.now() - testT0;
        }

        // Consider "done" once we have session_switched
        if (result.sessionMs) {
          clearTimeout(timeout);
          // Keep the connection open for a bit to receive sessions list
          setTimeout(() => {
            try { ws.close(); } catch {}
            resolve(result);
          }, 2000);
        }
      } catch {}
    };

    ws.onerror = (event) => {
      result.error = `WebSocket error: ${(event as any).message ?? "unknown"}`;
    };

    ws.onclose = () => {
      result.closed = true;
      if (!result.sessionMs && !result.error) {
        result.error = "Closed before receiving session_switched";
        clearTimeout(timeout);
        resolve(result);
      }
    };
  });
}

/**
 * Simulate React StrictMode: connect, immediately close, then reconnect.
 * Returns the result of the second (real) connection.
 */
async function connectClientStrictMode(
  id: number,
  testT0: number,
): Promise<ClientResult> {
  // First connection: open and close immediately (simulating StrictMode cleanup)
  const sacrificial = new WebSocket(`ws://127.0.0.1:${WS_PORT}/ws`);
  await new Promise<void>((resolve) => {
    sacrificial.onopen = () => {
      // Close after a brief moment (simulates React unmount during StrictMode)
      setTimeout(() => {
        sacrificial.close();
        resolve();
      }, 10);
    };
    sacrificial.onerror = () => resolve();
    // Safety timeout
    setTimeout(() => { try { sacrificial.close(); } catch {} resolve(); }, 1000);
  });

  // Second connection: the "real" mount
  return connectClient(id, testT0);
}

// ── Main test ──
async function runTest() {
  console.log(`${CYAN}Starting backend server...${RESET}`);
  try {
    await waitForPort(BACKEND_PORT);
  } catch (e) {
    console.error(`${RED}Backend failed to start: ${(e as Error).message}${RESET}`);
    console.error(`\nServer logs:\n${serverLogs.join("\n")}`);
    cleanup();
    process.exit(1);
  }
  console.log(`${GREEN}Backend ready on port ${BACKEND_PORT}${RESET}`);

  if (VITE_PROXY) {
    console.log(`${CYAN}Starting Vite proxy...${RESET}`);
    try {
      await waitForPort(VITE_PORT);
    } catch (e) {
      console.error(`${RED}Vite failed to start: ${(e as Error).message}${RESET}`);
      console.error(`\nServer logs:\n${serverLogs.join("\n")}`);
      cleanup();
      process.exit(1);
    }
    console.log(`${GREEN}Vite proxy ready on port ${VITE_PORT}${RESET}`);
  }

  console.log(`${CYAN}Connecting to: ws://127.0.0.1:${WS_PORT}/ws${RESET}\n`);

  const testT0 = performance.now();
  const connectFn = STRICT_MODE ? connectClientStrictMode : connectClient;

  // Launch all clients (with optional stagger)
  const promises: Promise<ClientResult>[] = [];
  for (let i = 0; i < NUM_CLIENTS; i++) {
    if (STAGGER_MS > 0 && i > 0) {
      await new Promise((r) => setTimeout(r, STAGGER_MS));
    }
    console.log(`${DIM}  Launching client#${i + 1} at +${(performance.now() - testT0).toFixed(0)}ms${RESET}`);
    promises.push(connectFn(i + 1, testT0));
  }

  console.log(`\n${CYAN}Waiting for all clients to connect...${RESET}\n`);
  const results = await Promise.all(promises);

  // ── Report ──
  console.log(`\n${BOLD}Results${RESET}`);
  console.log(`${"Client".padEnd(10)} ${"Connect".padStart(10)} ${"WS Open".padStart(10)} ${"Session".padStart(10)} ${"Sessions".padStart(10)} ${"Latency".padStart(10)} ${"Status".padStart(10)}`);
  console.log(`${DIM}${"─".repeat(72)}${RESET}`);

  let failures = 0;
  let maxSessionMs = 0;
  let totalLatency = 0;

  for (const r of results) {
    const connectStr = `+${r.connectStartMs.toFixed(0)}ms`;
    const openStr = r.connectedMs != null ? `+${r.connectedMs.toFixed(0)}ms` : "-";
    const sessionStr = r.sessionMs != null ? `+${r.sessionMs.toFixed(0)}ms` : "-";
    const sessionsStr = r.sessionsMs != null ? `+${r.sessionsMs.toFixed(0)}ms` : "-";
    const latency = r.sessionMs != null ? r.sessionMs - r.connectStartMs : NaN;
    const latencyStr = !isNaN(latency) ? `${latency.toFixed(0)}ms` : "-";
    const status = r.error ? `${RED}FAIL${RESET}` : `${GREEN}OK${RESET}`;

    if (r.error) failures++;
    if (r.sessionMs != null) {
      maxSessionMs = Math.max(maxSessionMs, r.sessionMs);
      if (!isNaN(latency)) totalLatency += latency;
    }

    console.log(
      `  #${String(r.id).padEnd(7)} ${connectStr.padStart(10)} ${openStr.padStart(10)} ${sessionStr.padStart(10)} ${sessionsStr.padStart(10)} ${latencyStr.padStart(10)} ${status.padStart(20)}`,
    );

    if (r.error) {
      console.log(`${RED}           ${r.error}${RESET}`);
    }
  }

  const successCount = NUM_CLIENTS - failures;
  const avgLatency = successCount > 0 ? totalLatency / successCount : 0;

  console.log(`\n${BOLD}Summary${RESET}`);
  console.log(`  Total clients:     ${NUM_CLIENTS}`);
  console.log(`  Via:               ${VITE_PROXY ? `Vite proxy (:${VITE_PORT})` : `Direct (:${BACKEND_PORT})`}`);
  console.log(`  Successful:        ${successCount === NUM_CLIENTS ? GREEN : RED}${successCount}/${NUM_CLIENTS}${RESET}`);
  console.log(`  Avg latency:       ${avgLatency.toFixed(0)}ms`);
  console.log(`  Max time-to-ready: ${maxSessionMs.toFixed(0)}ms`);
  console.log(`  Total test time:   ${(performance.now() - testT0).toFixed(0)}ms`);

  if (failures > 0) {
    console.log(`\n${YELLOW}Server logs (last 50):${RESET}`);
    for (const line of serverLogs.slice(-50)) {
      console.log(`  ${DIM}${line}${RESET}`);
    }
  }

  console.log();
  cleanup();
  process.exit(failures > 0 ? 1 : 0);
}

runTest().catch((err) => {
  console.error(`${RED}Test runner error: ${err.message}${RESET}`);
  cleanup();
  process.exit(1);
});

#!/usr/bin/env npx tsx
/**
 * Playwright-based pressure test measuring REAL cold-start connection time.
 *
 * Simulates what a user actually experiences:
 *   1. Server starts (spawns ACP agent process)
 *   2. Browser opens immediately (doesn't wait for server warmup)
 *   3. WebSocket connects and retries until server is ready
 *   4. Measures E2E from "browser navigates" to "session_switched received"
 *
 * Also tests warm reconnection: after cold start, opens more tabs to measure
 * the steady-state latency.
 *
 * Target: p99 cold-start < 1000ms, p99 warm < 500ms
 *
 * Usage:
 *   npx tsx core/tests/test-pressure.ts                    # default (1 cold + 5 warm)
 *   npx tsx core/tests/test-pressure.ts --warm 10          # 10 warm tabs
 *   npx tsx core/tests/test-pressure.ts --headless false   # show browser
 */

import { chromium, type BrowserContext } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

// ── CLI args ──
const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}
const NUM_WARM = parseInt(getArg("warm", "5"), 10);
const HEADLESS = getArg("headless", "true") !== "false";
const TIMEOUT_MS = 30_000;
const COLD_P99_TARGET_MS = 1000;
const WARM_P99_TARGET_MS = 500;
const BACKEND_PORT = 15689 + Math.floor(Math.random() * 1000);

// ── Colors ──
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

console.log(`\n${BOLD}Cold-Start + Warm Pressure Test${RESET}`);
console.log(`${DIM}───────────────────────────────${RESET}`);
console.log(`  Cold tabs:    1`);
console.log(`  Warm tabs:    ${NUM_WARM}`);
console.log(`  Headless:     ${HEADLESS}`);
console.log(`  Backend port: ${BACKEND_PORT}`);
console.log(`  Cold p99:     <${COLD_P99_TARGET_MS}ms`);
console.log(`  Warm p99:     <${WARM_P99_TARGET_MS}ms`);
console.log(`  Timeout:      ${TIMEOUT_MS}ms\n`);

// ── Server management ──
const ROOT = path.resolve(import.meta.dirname ?? __dirname, "../..");
const children: ChildProcess[] = [];
const serverLogs: string[] = [];

function cleanup() {
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch {}
  }
}
process.on("SIGINT", () => { cleanup(); process.exit(1); });
process.on("SIGTERM", () => { cleanup(); process.exit(1); });

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

// ── Result tracking ──
interface TabResult {
  id: string;
  phase: "cold" | "warm";
  e2eMs?: number;        // total from WS new → session_switched
  wsOpenMs?: number;     // WS connect → onopen
  sessionMs?: number;    // onopen → session_switched
  retries: number;       // how many WS connect attempts before success
  sessionId?: string;
  messagesReceived: string[];
  error?: string;
}

/**
 * Open a blank page, create a WebSocket with retry loop (like the real client),
 * and measure time to session_switched.
 */
async function measureTab(
  context: BrowserContext,
  id: string,
  phase: "cold" | "warm",
  wsUrl: string,
): Promise<TabResult> {
  const result: TabResult = {
    id,
    phase,
    retries: 0,
    messagesReceived: [],
  };

  try {
    const page = await context.newPage();
    await page.goto("about:blank");

    // Use addScriptTag to inject browser code (avoids tsx __name transform issue with page.evaluate)
    const timings = await page.evaluate(`
      new Promise((resolve) => {
        var wsUrl = ${JSON.stringify(wsUrl)};
        var timeoutMs = ${TIMEOUT_MS};
        var t0 = performance.now();
        var retries = 0;
        var wsOpenAt = null;
        var state = {
          e2eMs: null, wsOpenMs: null, sessionMs: null,
          retries: 0, sessionId: null, messages: [], error: null,
        };
        var deadline = setTimeout(function() {
          if (!state.sessionId) {
            state.error = "TIMEOUT after " + timeoutMs + "ms, retries=" + retries + ", msgs=[" + state.messages.join(",") + "]";
          }
          state.retries = retries;
          resolve(state);
        }, timeoutMs);
        var tryConnect = function() {
          var ws = new WebSocket(wsUrl);
          ws.onopen = function() { wsOpenAt = performance.now(); };
          ws.onmessage = function(ev) {
            try {
              var msg = JSON.parse(ev.data);
              state.messages.push(msg.type);
              if (msg.type === "session_switched" && !state.sessionId) {
                var now = performance.now();
                state.e2eMs = now - t0;
                state.wsOpenMs = wsOpenAt ? wsOpenAt - t0 : null;
                state.sessionMs = wsOpenAt ? now - wsOpenAt : null;
                state.sessionId = msg.sessionId;
                state.retries = retries;
                clearTimeout(deadline);
                setTimeout(function() { ws.close(); resolve(state); }, 200);
              }
            } catch(e) {}
          };
          ws.onerror = function() {};
          ws.onclose = function() {
            if (!state.sessionId) { retries++; setTimeout(tryConnect, 200); }
          };
        };
        tryConnect();
      })
    `);

    const t = timings as any;
    result.e2eMs = t.e2eMs ?? undefined;
    result.wsOpenMs = t.wsOpenMs ?? undefined;
    result.sessionMs = t.sessionMs ?? undefined;
    result.retries = t.retries ?? 0;
    result.sessionId = t.sessionId ?? undefined;
    result.messagesReceived = t.messages ?? [];
    result.error = t.error ?? undefined;
  } catch (err: any) {
    result.error = err.message;
  }

  return result;
}

function printResults(results: TabResult[], label: string, p99Target: number) {
  console.log(`\n${BOLD}${label}${RESET}`);
  console.log(
    `${"Tab".padEnd(8)} ${"E2E".padStart(8)} ${"WS Open".padStart(8)} ${"→Session".padStart(8)} ${"Retries".padStart(8)} ${"Msgs".padStart(6)} ${"Status".padStart(8)}`,
  );
  console.log(`${DIM}${"─".repeat(60)}${RESET}`);

  let failures = 0;
  const latencies: number[] = [];

  for (const r of results) {
    const e2e = r.e2eMs != null ? `${Math.round(r.e2eMs)}ms` : "-";
    const wsOpen = r.wsOpenMs != null ? `${Math.round(r.wsOpenMs)}ms` : "-";
    const sess = r.sessionMs != null ? `${Math.round(r.sessionMs)}ms` : "-";
    const status = r.error ? `${RED}FAIL${RESET}` : `${GREEN}OK${RESET}`;

    if (r.error) failures++;
    if (r.e2eMs != null) latencies.push(r.e2eMs);

    console.log(
      `  ${r.id.padEnd(6)} ${e2e.padStart(8)} ${wsOpen.padStart(8)} ${sess.padStart(8)} ${String(r.retries).padStart(8)} ${String(r.messagesReceived.length).padStart(6)} ${status.padStart(18)}`,
    );
    if (r.error) console.log(`${RED}         ${r.error}${RESET}`);
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : NaN;
  const p99 = latencies.length > 0 ? latencies[Math.ceil(latencies.length * 0.99) - 1] : NaN;
  const max = latencies.length > 0 ? latencies[latencies.length - 1] : NaN;
  const p99Pass = !isNaN(p99) && p99 < p99Target;

  console.log(`  ${"─".repeat(50)}`);
  console.log(`  p50=${Math.round(p50)}ms  p99=${p99Pass ? GREEN : RED}${Math.round(p99)}ms${RESET} (target <${p99Target}ms)  max=${Math.round(max)}ms  fail=${failures}`);

  return { failures, p99, p99Pass };
}

// ── Main test ──
async function runTest() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();

  // ── Phase 1: Cold start ──
  // Start server and IMMEDIATELY connect — no waitForPort.
  // This measures what a real user experiences.
  console.log(`${CYAN}Phase 1: Cold start — starting server + connecting immediately${RESET}`);
  const serverSpawnT0 = Date.now();
  const serverProcess = spawn("bun", ["core/server/main.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(BACKEND_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(serverProcess);
  collectLogs(serverProcess, "server");

  // Connect immediately — the browser will retry until the server is ready,
  // just like a real user opening a tab while the server is starting.
  const coldResult = await measureTab(
    context,
    "cold-1",
    "cold",
    `ws://127.0.0.1:${BACKEND_PORT}/ws`,
  );
  console.log(`${DIM}  Cold start E2E: ${coldResult.e2eMs ? Math.round(coldResult.e2eMs) + "ms" : "FAIL"} (${coldResult.retries} retries)${RESET}`);

  // ── Phase 2: Warm connections ──
  // Server is now fully warmed. Open N more tabs simultaneously.
  console.log(`\n${CYAN}Phase 2: Warm — opening ${NUM_WARM} tabs simultaneously${RESET}`);
  const warmPromises: Promise<TabResult>[] = [];
  for (let i = 0; i < NUM_WARM; i++) {
    warmPromises.push(
      measureTab(context, `warm-${i + 1}`, "warm", `ws://127.0.0.1:${BACKEND_PORT}/ws`),
    );
  }
  const warmResults = await Promise.all(warmPromises);

  // ── Report ──
  const cold = printResults([coldResult], "Cold Start Results", COLD_P99_TARGET_MS);
  const warm = printResults(warmResults, "Warm Results", WARM_P99_TARGET_MS);

  // Print server timeline
  console.log(`\n${BOLD}Server Timeline${RESET}`);
  const relevantLogs = serverLogs.filter(
    (l) => l.includes("prewarm") || l.includes("ws:") || l.includes("api:") || l.includes("boot"),
  );
  for (const line of relevantLogs.slice(0, 40)) {
    console.log(`  ${DIM}${line}${RESET}`);
  }

  console.log(`\n${BOLD}Summary${RESET}`);
  console.log(`  Server spawn → cold tab ready: ${coldResult.e2eMs ? `${Math.round(coldResult.e2eMs)}ms` : "FAIL"} (${coldResult.retries} WS retries)`);
  console.log(`  Warm p99: ${warm.p99Pass ? GREEN : RED}${Math.round(warm.p99)}ms${RESET}`);

  await browser.close();
  cleanup();

  const pass = cold.failures === 0 && cold.p99Pass && warm.failures === 0 && warm.p99Pass;
  if (pass) {
    console.log(`\n${GREEN}PASS${RESET}\n`);
    process.exit(0);
  } else {
    console.log(`\n${RED}FAIL${RESET}\n`);
    process.exit(1);
  }
}

runTest().catch((err) => {
  console.error(`${RED}Test runner error: ${err.message}${RESET}`);
  cleanup();
  process.exit(1);
});

/**
 * ACP Server Real Integration Benchmark Suite
 *
 * Spawns the actual ACP server as a subprocess, connects via ClientSideConnection
 * over stdio pipes, and measures real end-to-end latencies.
 *
 * Coverage:
 *   ACP Methods: initialize, newSession, prompt, cancel, setSessionMode,
 *                setSessionModel, forkSession, resumeSession, authenticate
 *   ExtMethods:  sessions/list, sessions/getHistory, sessions/getSubagentHistory,
 *                sessions/rename, sessions/delete, sessions/getAvailableCommands,
 *                sessions/getSubagents
 *   Notifications: agent_message_chunk, agent_thought_chunk, tool_call,
 *                  tool_call_update, plan, available_commands_update,
 *                  current_mode_update, session_info_update (tracked per-type)
 *   Pressure:    rapid session creation, concurrent prompts (3/5), session churn,
 *                notification flood, list_sessions under load, rapid mode switching
 *
 * Run: npx tsx benchmarks/bench.ts
 * Saves baseline to: benchmarks/baseline.json
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { ReadableStream, WritableStream } from "node:stream/web";
import {
  type Agent,
  type Client,
  ClientSideConnection,
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

// ── Helpers ────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const BASELINE_PATH = path.join(__dirname, "baseline.json");

let systemClaudePath = "";
try {
  systemClaudePath = execSync("which claude", { encoding: "utf-8" }).trim();
} catch {}

interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  count: number;
  opsPerSec: number;
}

interface BenchmarkResult {
  name: string;
  latency: LatencyStats;
  samples?: number[];
}

interface BaselineReport {
  timestamp: string;
  nodeVersion: string;
  results: BenchmarkResult[];
  notificationProfile?: Record<string, number>;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, idx)];
}

function computeStats(samples: number[]): LatencyStats {
  if (samples.length === 0) {
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0, count: 0, opsPerSec: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const totalTimeS = sum / 1000;
  return {
    p50: +percentile(sorted, 0.5).toFixed(3),
    p95: +percentile(sorted, 0.95).toFixed(3),
    p99: +percentile(sorted, 0.99).toFixed(3),
    min: +sorted[0].toFixed(3),
    max: +sorted[sorted.length - 1].toFixed(3),
    mean: +mean.toFixed(3),
    count: sorted.length,
    opsPerSec: totalTimeS > 0 ? Math.round(sorted.length / totalTimeS) : 0,
  };
}

function logBench(name: string, samples: number[]) {
  console.log(`  done (${samples.map((s) => s.toFixed(0) + "ms").join(", ")})\n`);
}

// ── Stream adapters ──────────────────────────────────────────────────

function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        nodeStream.write(Buffer.from(chunk), (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  });
}

function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
  });
}

// ── BenchClient ─────────────────────────────────────────────────────

class BenchClient implements Client {
  agent: Agent;

  notificationCount = 0;
  firstNotificationTime: number | null = null;
  receivedText = "";
  private promptStartTime: number | null = null;

  /** Per-type notification counters (cumulative across all prompts) */
  notificationsByType: Record<string, number> = {};

  constructor(agent: Agent) {
    this.agent = agent;
  }

  resetForPrompt() {
    this.notificationCount = 0;
    this.firstNotificationTime = null;
    this.receivedText = "";
    this.promptStartTime = performance.now();
  }

  resetAllCounters() {
    this.notificationCount = 0;
    this.firstNotificationTime = null;
    this.receivedText = "";
    this.promptStartTime = null;
    this.notificationsByType = {};
  }

  getTTFT(): number | null {
    if (this.firstNotificationTime === null || this.promptStartTime === null) return null;
    return this.firstNotificationTime - this.promptStartTime;
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.notificationCount++;
    if (this.firstNotificationTime === null) {
      this.firstNotificationTime = performance.now();
    }

    // Track by notification type
    const updateType = params.update.sessionUpdate;
    this.notificationsByType[updateType] = (this.notificationsByType[updateType] || 0) + 1;

    if (updateType === "agent_message_chunk") {
      if (params.update.content.type === "text") {
        this.receivedText += params.update.content.text;
      }
    }
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const option = params.options.find((o) => o.kind === "allow_once");
    return { outcome: { outcome: "selected", optionId: option!.optionId } };
  }

  async readTextFile(_params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return { content: "" };
  }

  async writeTextFile(_params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return {};
  }
}

// ── Server lifecycle ────────────────────────────────────────────────

function spawnServer(): ChildProcess {
  const agentProcess = spawn("node", ["dist/index.js"], {
    cwd: PROJECT_ROOT,
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      ACP_PERF: "1",
      CLAUDE_MODEL: process.env.CLAUDE_MODEL || "sonnet",
      MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS || "1024",
      ...(process.env.CLAUDE_CODE_EXECUTABLE || systemClaudePath
        ? { CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE || systemClaudePath }
        : {}),
    },
  });

  agentProcess.on("error", (err) => console.error("Agent process error:", err));

  return agentProcess;
}

function createConnection(
  agentProcess: ChildProcess,
): { connection: ClientSideConnection; client: BenchClient } {
  let client!: BenchClient;
  const stream = ndJsonStream(
    nodeToWebWritable(agentProcess.stdin!),
    nodeToWebReadable(agentProcess.stdout!),
  );
  const connection = new ClientSideConnection((agent) => {
    client = new BenchClient(agent);
    return client;
  }, stream);
  return { connection, client };
}

function killServer(agentProcess: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (agentProcess.killed || agentProcess.exitCode !== null) {
      resolve();
      return;
    }
    agentProcess.on("exit", () => resolve());
    agentProcess.kill("SIGTERM");
    setTimeout(() => {
      try { agentProcess.kill("SIGKILL"); } catch {}
      resolve();
    }, 5000);
  });
}

// ── Benchmark helpers ───────────────────────────────────────────────

async function bench(
  name: string,
  results: BenchmarkResult[],
  iterations: number,
  fn: (i: number) => Promise<void>,
): Promise<number[]> {
  console.log(`Running: ${name}`);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn(i);
    samples.push(performance.now() - t0);
  }
  results.push({ name, latency: computeStats(samples), samples });
  logBench(name, samples);
  return samples;
}

// ── Benchmark runner ────────────────────────────────────────────────

async function runBenchmarks() {
  // 1. Build check
  const distIndex = path.join(PROJECT_ROOT, "dist/index.js");
  const srcIndex = path.join(PROJECT_ROOT, "src/index.ts");
  const needsBuild =
    !fs.existsSync(distIndex) ||
    fs.statSync(srcIndex).mtimeMs > fs.statSync(distIndex).mtimeMs;

  if (needsBuild) {
    console.log("Building project (tsc)...");
    try {
      execSync("npx tsc", { cwd: PROJECT_ROOT, stdio: "inherit" });
    } catch {
      if (!fs.existsSync(distIndex)) {
        console.error("Build failed and dist/index.js not found. Cannot continue.");
        process.exit(1);
      }
      console.log("tsc had errors but dist/index.js exists — continuing.");
    }
    console.log("Build complete.\n");
  } else {
    console.log("dist/index.js is up-to-date — skipping build.\n");
  }

  const results: BenchmarkResult[] = [];

  // ════════════════════════════════════════════════════════════════════
  // SECTION 1: ACP PROTOCOL METHODS
  // ════════════════════════════════════════════════════════════════════

  console.log("╔══════════════════════════════════════════╗");
  console.log("║   SECTION 1: ACP PROTOCOL METHODS        ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // ── 1a. initialize ─────────────────────────────────────────────────

  await bench("initialize", results, 3, async () => {
    const agentProcess = spawnServer();
    const { connection } = createConnection(agentProcess);
    await connection.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    await killServer(agentProcess);
  });

  // ── Spawn persistent server for the rest ───────────────────────────

  console.log("Spawning persistent server...");
  const agentProcess = spawnServer();
  const { connection, client } = createConnection(agentProcess);

  const initResp = await connection.initialize({
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  console.log(`Connected to ${initResp.agentInfo.name} v${initResp.agentInfo.version}\n`);

  // ── 1b. newSession ─────────────────────────────────────────────────

  const allSessionIds: string[] = [];
  console.log("Running: new_session");
  {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const session = await connection.newSession({ cwd: PROJECT_ROOT, mcpServers: [] });
      samples.push(performance.now() - t0);
      allSessionIds.push(session.sessionId);
    }
    results.push({ name: "new_session", latency: computeStats(samples), samples });
    logBench("new_session", samples);
  }

  // ── 1c. setSessionMode (cycle through all modes) ───────────────────

  {
    const modeSession = await connection.newSession({ cwd: PROJECT_ROOT, mcpServers: [] });
    allSessionIds.push(modeSession.sessionId);
    const modes = ["default", "acceptEdits", "plan", "dontAsk", "delegate", "bypassPermissions"];
    const samples: number[] = [];
    console.log("Running: set_session_mode (all modes)");
    for (const modeId of modes) {
      const t0 = performance.now();
      try {
        await connection.setSessionMode({ sessionId: modeSession.sessionId, modeId });
        samples.push(performance.now() - t0);
      } catch {
        // bypassPermissions may fail on root — skip
        samples.push(performance.now() - t0);
      }
    }
    results.push({ name: "set_session_mode", latency: computeStats(samples), samples });
    logBench("set_session_mode", samples);
  }

  // ── 1d. setSessionModel ────────────────────────────────────────────

  await bench("set_session_model", results, 3, async () => {
    // Use the first session — setModel is idempotent
    await connection.unstable_setSessionModel({
      sessionId: allSessionIds[0],
      modelId: "sonnet",
    });
  });

  // ── 1e. forkSession ────────────────────────────────────────────────

  {
    // First, do a prompt so the session has some history to fork
    const sourceSession = allSessionIds[0];
    await bench("fork_session", results, 3, async () => {
      const forked = await (connection as any).unstable_forkSession({
        sessionId: sourceSession,
        cwd: PROJECT_ROOT,
        mcpServers: [],
      });
      allSessionIds.push(forked.sessionId);
    });
  }

  // ── 1f. resumeSession ──────────────────────────────────────────────

  await bench("resume_session", results, 3, async () => {
    const resp = await (connection as any).unstable_resumeSession({
      sessionId: allSessionIds[0],
      cwd: PROJECT_ROOT,
      mcpServers: [],
    });
    allSessionIds.push(resp.sessionId);
  });

  // ── 1g. prompt (simple) ────────────────────────────────────────────

  console.log("Running: prompt_simple (real Claude API)");
  {
    const samples: number[] = [];
    const ttftSamples: number[] = [];
    client.resetAllCounters();

    for (let i = 0; i < 3; i++) {
      const session = await connection.newSession({ cwd: PROJECT_ROOT, mcpServers: [] });
      allSessionIds.push(session.sessionId);
      client.resetForPrompt();

      const t0 = performance.now();
      await connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: 'Reply with exactly "ok" and nothing else.' }],
      });
      const elapsed = performance.now() - t0;
      samples.push(elapsed);

      const ttft = client.getTTFT();
      if (ttft !== null) ttftSamples.push(ttft);

      console.log(
        `  iter ${i + 1}: total=${elapsed.toFixed(0)}ms ttft=${ttft?.toFixed(0) ?? "N/A"}ms` +
          ` notifications=${client.notificationCount} text="${client.receivedText.slice(0, 30)}"`,
      );
    }

    results.push({ name: "prompt_simple", latency: computeStats(samples), samples });
    if (ttftSamples.length > 0) {
      results.push({ name: "prompt_ttft", latency: computeStats(ttftSamples), samples: ttftSamples });
    }
    console.log("");
  }

  // ── 1h. cancel ─────────────────────────────────────────────────────

  console.log("Running: cancel_during_prompt");
  {
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const session = await connection.newSession({ cwd: PROJECT_ROOT, mcpServers: [] });
      allSessionIds.push(session.sessionId);
      client.resetForPrompt();

      const promptPromise = connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "Write a very detailed essay about the entire history of computing from Babbage to modern AI." }],
      });

      // Wait for the prompt to actually start streaming
      await new Promise((r) => setTimeout(r, 500));

      const t0 = performance.now();
      await connection.cancel({ sessionId: session.sessionId });
      await promptPromise;
      samples.push(performance.now() - t0);
      console.log(`  iter ${i + 1}: cancel_latency=${samples[i].toFixed(0)}ms`);
    }
    results.push({ name: "cancel_during_prompt", latency: computeStats(samples), samples });
    console.log("");
  }

  // ── 1i. authenticate (error path — stub throws "not implemented") ──

  console.log("Running: authenticate (error path)");
  {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      try {
        await (connection as any).authenticate({ authMethodId: "claude-login" });
      } catch {
        // Expected — authenticate is not implemented
      }
      samples.push(performance.now() - t0);
    }
    results.push({ name: "authenticate_error", latency: computeStats(samples), samples });
    logBench("authenticate_error", samples);
  }

  // ════════════════════════════════════════════════════════════════════
  // SECTION 2: EXT METHODS
  // ════════════════════════════════════════════════════════════════════

  console.log("╔══════════════════════════════════════════╗");
  console.log("║   SECTION 2: EXT METHODS                 ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // ── 2a. sessions/list ──────────────────────────────────────────────

  await bench("ext:sessions/list", results, 10, async () => {
    await connection.extMethod("sessions/list", {});
  });

  // ── 2b. sessions/getHistory ────────────────────────────────────────

  // Use a session that had a prompt (allSessionIds has several)
  await bench("ext:sessions/getHistory", results, 5, async () => {
    await connection.extMethod("sessions/getHistory", {
      sessionId: allSessionIds[0],
    });
  });

  // ── 2c. sessions/getSubagentHistory ────────────────────────────────
  // This may error if the session has no subagents — that's fine, we measure the latency

  console.log("Running: ext:sessions/getSubagentHistory");
  {
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      try {
        await connection.extMethod("sessions/getSubagentHistory", {
          sessionId: allSessionIds[0],
          agentId: "nonexistent-agent",
        });
      } catch {
        // Expected — no subagent exists
      }
      samples.push(performance.now() - t0);
    }
    results.push({ name: "ext:sessions/getSubagentHistory", latency: computeStats(samples), samples });
    logBench("ext:sessions/getSubagentHistory", samples);
  }

  // ── 2d. sessions/rename ────────────────────────────────────────────

  await bench("ext:sessions/rename", results, 5, async (i) => {
    await connection.extMethod("sessions/rename", {
      sessionId: allSessionIds[0],
      title: `Bench Session Renamed ${i}`,
    });
  });

  // ── 2e. sessions/delete ────────────────────────────────────────────
  // Create throwaway sessions to delete

  console.log("Running: ext:sessions/delete");
  {
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const throwaway = await connection.newSession({ cwd: PROJECT_ROOT, mcpServers: [] });
      const t0 = performance.now();
      await connection.extMethod("sessions/delete", { sessionId: throwaway.sessionId });
      samples.push(performance.now() - t0);
    }
    results.push({ name: "ext:sessions/delete", latency: computeStats(samples), samples });
    logBench("ext:sessions/delete", samples);
  }

  // ── 2f. sessions/getAvailableCommands ─────────────────────────────
  // First call is cold (loads commands from SDK), subsequent calls hit cache.
  // May error if no live session has an active query process — measure latency regardless.

  console.log("Running: ext:sessions/getAvailableCommands");
  {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      try {
        await connection.extMethod("sessions/getAvailableCommands", {});
      } catch {
        // May fail if no live session has an active query
      }
      samples.push(performance.now() - t0);
    }
    results.push({ name: "ext:sessions/getAvailableCommands", latency: computeStats(samples), samples });
    logBench("ext:sessions/getAvailableCommands", samples);
  }

  // ── 2g. sessions/getSubagents ───────────────────────────────────

  await bench("ext:sessions/getSubagents", results, 5, async () => {
    try {
      await connection.extMethod("sessions/getSubagents", {
        sessionId: allSessionIds[0],
      });
    } catch {
      // May error if session has no subagents — that's fine, we measure latency
    }
  });

  // ════════════════════════════════════════════════════════════════════
  // SECTION 3: NOTIFICATION PROFILING
  // ════════════════════════════════════════════════════════════════════

  console.log("╔══════════════════════════════════════════╗");
  console.log("║   SECTION 3: NOTIFICATION PROFILING       ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // Run a prompt that triggers tool use to generate diverse notifications
  console.log("Running: notification_profile (prompt with tool use)");
  {
    const session = await connection.newSession({ cwd: PROJECT_ROOT, mcpServers: [] });
    allSessionIds.push(session.sessionId);
    // Reset all counters so this section only tracks notifications from the tool-use prompt
    client.resetAllCounters();
    client.resetForPrompt();

    const t0 = performance.now();
    await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: 'Read the file "package.json" and tell me the version number. Be brief.' }],
    });
    const elapsed = performance.now() - t0;

    console.log(`  prompt completed in ${elapsed.toFixed(0)}ms`);
    console.log(`  total notifications: ${client.notificationCount}`);
    console.log(`  notifications by type:`);
    for (const [type, count] of Object.entries(client.notificationsByType).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${type}: ${count}`);
    }
    console.log("");

    results.push({
      name: "prompt_with_tool_use",
      latency: computeStats([elapsed]),
      samples: [elapsed],
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // SECTION 4: PRESSURE TESTING
  // ════════════════════════════════════════════════════════════════════

  console.log("╔══════════════════════════════════════════╗");
  console.log("║   SECTION 4: PRESSURE TESTING            ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // ── 4a. Rapid session creation ─────────────────────────────────────

  console.log("Running: pressure:rapid_session_creation (10 sessions)");
  {
    const N = 10;
    const t0 = performance.now();
    const sessionPromises = [];
    for (let i = 0; i < N; i++) {
      sessionPromises.push(connection.newSession({ cwd: PROJECT_ROOT, mcpServers: [] }));
    }
    const sessions = await Promise.all(sessionPromises);
    const wallClock = performance.now() - t0;
    for (const s of sessions) allSessionIds.push(s.sessionId);

    results.push({
      name: "pressure:rapid_session_10",
      latency: computeStats([wallClock]),
      samples: [wallClock],
    });
    console.log(`  wall-clock: ${wallClock.toFixed(0)}ms for ${N} sessions (${(wallClock / N).toFixed(0)}ms/session)\n`);
  }

  // ── 4b. Concurrent prompts (3) ─────────────────────────────────────

  console.log("Running: pressure:concurrent_prompts_3");
  {
    const N = 3;
    const sessions: string[] = [];
    for (let i = 0; i < N; i++) {
      const s = await connection.newSession({ cwd: PROJECT_ROOT, mcpServers: [] });
      sessions.push(s.sessionId);
      allSessionIds.push(s.sessionId);
    }
    client.resetForPrompt();

    const t0 = performance.now();
    await Promise.all(
      sessions.map((sid) =>
        connection.prompt({
          sessionId: sid,
          prompt: [{ type: "text", text: 'Reply with exactly "ok" and nothing else.' }],
        }),
      ),
    );
    const wallClock = performance.now() - t0;

    results.push({
      name: "pressure:concurrent_prompts_3",
      latency: computeStats([wallClock]),
      samples: [wallClock],
    });
    console.log(`  wall-clock: ${wallClock.toFixed(0)}ms  notifications: ${client.notificationCount}\n`);
  }

  // ── 4c. Concurrent prompts (5) ─────────────────────────────────────

  console.log("Running: pressure:concurrent_prompts_5");
  {
    const N = 5;
    const sessions: string[] = [];
    for (let i = 0; i < N; i++) {
      const s = await connection.newSession({ cwd: PROJECT_ROOT, mcpServers: [] });
      sessions.push(s.sessionId);
      allSessionIds.push(s.sessionId);
    }
    client.resetForPrompt();

    const t0 = performance.now();
    await Promise.all(
      sessions.map((sid) =>
        connection.prompt({
          sessionId: sid,
          prompt: [{ type: "text", text: 'Reply with exactly "ok" and nothing else.' }],
        }),
      ),
    );
    const wallClock = performance.now() - t0;

    results.push({
      name: "pressure:concurrent_prompts_5",
      latency: computeStats([wallClock]),
      samples: [wallClock],
    });
    console.log(`  wall-clock: ${wallClock.toFixed(0)}ms  notifications: ${client.notificationCount}\n`);
  }

  // ── 4d. Session churn (create → prompt → done, repeated) ──────────

  console.log("Running: pressure:session_churn (3 cycles of create+prompt)");
  {
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const session = await connection.newSession({ cwd: PROJECT_ROOT, mcpServers: [] });
      allSessionIds.push(session.sessionId);
      await connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: 'Reply with "ok".' }],
      });
      samples.push(performance.now() - t0);
      console.log(`  cycle ${i + 1}: ${samples[i].toFixed(0)}ms`);
    }
    results.push({ name: "pressure:session_churn", latency: computeStats(samples), samples });
    console.log("");
  }

  // ── 4e. Notification flood (prompt generating many streaming tokens)

  console.log("Running: pressure:notification_flood (longer response)");
  {
    const session = await connection.newSession({ cwd: PROJECT_ROOT, mcpServers: [] });
    allSessionIds.push(session.sessionId);
    client.resetAllCounters();
    client.resetForPrompt();

    const t0 = performance.now();
    await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Count from 1 to 50 separated by commas." }],
    });
    const elapsed = performance.now() - t0;

    const notifPerSec = client.notificationCount / (elapsed / 1000);
    results.push({
      name: "pressure:notification_flood",
      latency: computeStats([elapsed]),
      samples: [elapsed],
    });
    console.log(
      `  ${elapsed.toFixed(0)}ms, ${client.notificationCount} notifications, ${notifPerSec.toFixed(0)} notif/sec\n`,
    );
  }

  // ── 4f. list_sessions under load (many sessions exist) ─────────────

  console.log(`Running: pressure:list_sessions_under_load (${allSessionIds.length} sessions exist)`);
  {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const resp = await connection.extMethod("sessions/list", {}) as any;
      samples.push(performance.now() - t0);
    }
    results.push({ name: "pressure:list_sessions_loaded", latency: computeStats(samples), samples });
    logBench("pressure:list_sessions_loaded", samples);
  }

  // ── 4g. Rapid mode switching ───────────────────────────────────────

  console.log("Running: pressure:rapid_mode_switch (20 switches)");
  {
    const modeSession = await connection.newSession({ cwd: PROJECT_ROOT, mcpServers: [] });
    allSessionIds.push(modeSession.sessionId);
    const modes = ["default", "acceptEdits", "plan", "dontAsk", "delegate"];
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const modeId = modes[i % modes.length];
      const t0 = performance.now();
      await connection.setSessionMode({ sessionId: modeSession.sessionId, modeId });
      samples.push(performance.now() - t0);
    }
    results.push({ name: "pressure:rapid_mode_switch_20", latency: computeStats(samples), samples });
    logBench("pressure:rapid_mode_switch_20", samples);
  }

  // ── 4h. Rapid cancel (start + cancel immediately, no delay) ────────

  console.log("Running: pressure:rapid_cancel (3 iterations, no delay)");
  {
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const session = await connection.newSession({ cwd: PROJECT_ROOT, mcpServers: [] });
      allSessionIds.push(session.sessionId);

      const t0 = performance.now();
      const promptPromise = connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "Write a 1000 word essay." }],
      });
      // Cancel immediately — no delay
      await connection.cancel({ sessionId: session.sessionId });
      await promptPromise;
      samples.push(performance.now() - t0);
      console.log(`  iter ${i + 1}: ${samples[i].toFixed(0)}ms`);
    }
    results.push({ name: "pressure:rapid_cancel", latency: computeStats(samples), samples });
    console.log("");
  }

  // ════════════════════════════════════════════════════════════════════
  // CLEANUP & REPORT
  // ════════════════════════════════════════════════════════════════════

  console.log("Shutting down server...");
  await killServer(agentProcess);
  console.log("Server stopped.\n");

  // Collect notification profile from all prompts
  const notificationProfile = { ...client.notificationsByType };

  const report: BaselineReport = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    results,
    notificationProfile,
  };

  // Print results table
  console.log("=".repeat(105));
  console.log("ACP SERVER INTEGRATION BENCHMARK RESULTS");
  console.log("=".repeat(105));
  console.log(
    "Benchmark".padEnd(40),
    "p50(ms)".padStart(10),
    "p95(ms)".padStart(10),
    "p99(ms)".padStart(10),
    "max(ms)".padStart(10),
    "mean(ms)".padStart(10),
    "iters".padStart(8),
  );
  console.log("-".repeat(105));

  for (const r of results) {
    console.log(
      r.name.padEnd(40),
      r.latency.p50.toFixed(1).padStart(10),
      r.latency.p95.toFixed(1).padStart(10),
      r.latency.p99.toFixed(1).padStart(10),
      r.latency.max.toFixed(1).padStart(10),
      r.latency.mean.toFixed(1).padStart(10),
      String(r.latency.count).padStart(8),
    );
  }
  console.log("=".repeat(105));

  // Notification profile
  console.log("\nNotification Profile (cumulative):");
  for (const [type, count] of Object.entries(notificationProfile).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(30)} ${count}`);
  }

  // Compare with previous baseline
  let oldBaseline: BaselineReport | null = null;
  if (fs.existsSync(BASELINE_PATH)) {
    try {
      oldBaseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"));
    } catch {}
  }

  if (oldBaseline) {
    console.log("\n" + "=".repeat(105));
    console.log("COMPARISON WITH PREVIOUS BASELINE");
    console.log("=".repeat(105));
    console.log(
      "Benchmark".padEnd(40),
      "p50 before".padStart(12),
      "p50 after".padStart(12),
      "delta%".padStart(10),
      "p95 before".padStart(12),
      "p95 after".padStart(12),
    );
    console.log("-".repeat(105));

    for (const curr of results) {
      const base = oldBaseline.results.find((b) => b.name === curr.name);
      if (!base) {
        console.log(curr.name.padEnd(40), "NEW".padStart(12));
        continue;
      }
      const deltaP50 =
        base.latency.p50 > 0
          ? (((curr.latency.p50 - base.latency.p50) / base.latency.p50) * 100).toFixed(1)
          : "N/A";
      const marker =
        curr.latency.p50 < base.latency.p50 ? " ↓" : curr.latency.p50 > base.latency.p50 ? " ↑" : "";
      console.log(
        curr.name.padEnd(40),
        base.latency.p50.toFixed(1).padStart(12),
        curr.latency.p50.toFixed(1).padStart(12),
        (deltaP50 + "%" + marker).padStart(10),
        base.latency.p95.toFixed(1).padStart(12),
        curr.latency.p95.toFixed(1).padStart(12),
      );
    }
    console.log("=".repeat(105));
  }

  // Save baseline
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(report, null, 2));
  console.log(`\nBaseline saved to: ${BASELINE_PATH}`);

  return report;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  await runBenchmarks();
  process.exit(0);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});

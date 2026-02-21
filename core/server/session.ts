import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { log, bootMs } from "./log.js";
import { nodeToWebWritable, nodeToWebReadable, instrumentedStream } from "./acp-shared.js";
import { createInstFilteredReadable, pushAllPendingTasks, getInstStore } from "./inst-interceptor.js";

// ── AgentInst instrumentation for executor version detection ──

const INST_UUID = "00000000-exec-ver0-0000-000000000001";
const INST_NAME = "executor-version-detect";

export function instLog(text: string): void {
  const store = getInstStore();
  const ts = Date.now() / 1000;
  // Ensure the task exists with a "task" entry on first log
  let task = store.tasks.get(INST_UUID);
  if (!task) {
    store.ingest({
      entries: [{ task_uuid: INST_UUID, task_name: INST_NAME, ts, type: "task" }],
      passed: true,
      checkpoints: [],
    });
    task = store.tasks.get(INST_UUID);
  }
  // Append a log entry to the latest run
  if (task && task.runs.length > 0) {
    task.runs[task.runs.length - 1].entries.push({
      task_uuid: INST_UUID,
      task_name: INST_NAME,
      ts,
      type: "log",
      text,
    });
  }
}

function instCheck(label: string, data: Record<string, unknown>): void {
  const store = getInstStore();
  const ts = Date.now() / 1000;
  const task = store.tasks.get(INST_UUID);
  if (task && task.runs.length > 0) {
    const run = task.runs[task.runs.length - 1];
    const passed = !!data.version;
    run.entries.push({
      task_uuid: INST_UUID,
      task_name: INST_NAME,
      ts,
      type: "checkpoint",
      label,
      data,
    });
    run.checkpoints.push({ label, passed, assertions: [{ field: "version", op: "exists", passed, actual: data.version, msg: "executor version should be detected" }] });
    run.passed = passed;
    run.status = "done";
  }
}

// Resolve system-installed claude binary at module load time
let systemClaudePath = "";
try { systemClaudePath = execSync("which claude", { encoding: "utf-8" }).trim(); } catch {}

/** Run `<claude-binary> --version` and extract the semver string. */
export function detectClaudeCodeVersion(): string {
  const exe = process.env.CLAUDE_CODE_EXECUTABLE || systemClaudePath || "claude";
  instLog(`detectClaudeCodeVersion: exe="${exe}" (CLAUDE_CODE_EXECUTABLE=${process.env.CLAUDE_CODE_EXECUTABLE || "(unset)"}, systemClaudePath="${systemClaudePath}")`);
  try {
    const output = execSync(`"${exe}" --version 2>&1`, { encoding: "utf-8", timeout: 5000 }).trim();
    // Output format: "2.1.50 (Claude Code)" or just "2.1.50"
    const match = output.match(/([\d]+\.[\d]+\.[\d]+)/);
    if (match) {
      instLog(`detectClaudeCodeVersion: output="${output}" → version="${match[1]}"`);
      return match[1];
    }
    instLog(`detectClaudeCodeVersion: output="${output}" → NO MATCH`);
    log.info({ exe, output }, "api: claude --version output did not match semver pattern");
  } catch (err: any) {
    instLog(`detectClaudeCodeVersion: FAILED exe="${exe}" err="${err.message}"`);
    log.warn({ exe, err: err.message }, "api: failed to detect Claude Code version");
  }
  return "";
}
import {
  ClientSideConnection,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { WebClient } from "./client.js";
import type { AcpConnection, BroadcastFn } from "./types.js";

/**
 * One-time connection setup: spawns agent process, creates ClientSideConnection, initializes.
 */
export async function createAcpConnection(
  broadcast: BroadcastFn,
): Promise<AcpConnection> {
  const projectRoot = path.resolve(import.meta.dir, "../..");

  log.info({ boot: bootMs() }, "api: spawning agent process");
  const spawnT0 = performance.now();
  const agentProcess = spawn("node", ["dist/index.js"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      ACP_PERF: "1",
      CLAUDE_MODEL: process.env.CLAUDE_MODEL || "opus",
      MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS || "31999",
      // Use system-installed claude binary if available (for latest model/version)
      ...(process.env.CLAUDE_CODE_EXECUTABLE || systemClaudePath
        ? { CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE || systemClaudePath }
        : {}),
    },
  });
  log.info({ pid: agentProcess.pid, durationMs: Math.round(performance.now() - spawnT0), boot: bootMs() }, "api: agent process spawned");

  agentProcess.on("error", (err) => log.error({ err: err.message }, "api: agent process error"));
  agentProcess.on("exit", (code, signal) => {
    log.info({ code, signal }, "api: agent process exited");
    pushAllPendingTasks();
  });

  // Intercept agent stdout: filter :::INST: convention lines for AgentInst,
  // pass remaining NDJSON through to the ACP protocol parser.
  const filteredStdout = createInstFilteredReadable(agentProcess.stdout!);

  const rawStream = ndJsonStream(
    nodeToWebWritable(agentProcess.stdin!),
    nodeToWebReadable(filteredStdout),
  );

  const stream = instrumentedStream(
    rawStream,
    (msg) => broadcast({ type: "protocol", dir: "send", ts: Date.now(), msg }),
    (msg) => broadcast({ type: "protocol", dir: "recv", ts: Date.now(), msg }),
  );

  let webClient: WebClient | null = null;
  const connection = new ClientSideConnection((agent) => {
    webClient = new WebClient(agent, broadcast);
    return webClient;
  }, stream);

  const initT0 = performance.now();
  log.info({ boot: bootMs() }, "api: initialize started");
  const initResp = await connection.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
  });
  log.info({ durationMs: Math.round(performance.now() - initT0), agent: initResp.agentInfo.name, version: initResp.agentInfo.version, boot: bootMs() }, "api: initialize completed");

  broadcast({
    type: "system",
    text: `Connected to ${initResp.agentInfo.name} v${initResp.agentInfo.version}`,
  });

  const executorVersion = detectClaudeCodeVersion();
  instLog(`createAcpConnection: executorVersion="${executorVersion || "(empty)"}" agentName="${initResp.agentInfo.name}" agentVersion="${initResp.agentInfo.version}"`);
  log.info({ executorVersion: executorVersion || "(not detected)", totalMs: Math.round(performance.now() - spawnT0), boot: bootMs() }, "api: createAcpConnection complete");
  return {
    connection,
    agentProcess,
    webClient: webClient!,
    agentName: initResp.agentInfo.name,
    agentVersion: initResp.agentInfo.version,
    executorVersion: executorVersion || undefined,
  };
}

/**
 * Create a new session on an existing connection.
 */
export async function createNewSession(
  connection: ClientSideConnection,
  broadcast: BroadcastFn,
  cwdOverride?: string,
  agentInfo?: { name?: string; version?: string; executorVersion?: string },
): Promise<{ sessionId: string }> {
  const t0 = performance.now();
  const cwd = cwdOverride || process.env.ACP_CWD;
  if (!cwd) {
    throw new Error("createNewSession: cwd is required — no project path provided and ACP_CWD not set");
  }
  log.info({ cwd, boot: bootMs() }, "api: newSession started");
  const session = await connection.newSession({
    cwd,
    mcpServers: [],
  });
  log.info({ durationMs: Math.round(performance.now() - t0), session: session.sessionId.slice(0, 8), models: session.models?.availableModels?.length ?? 0, modes: session.modes?.availableModes?.length ?? 0, boot: bootMs() }, "api: newSession completed");

  const currentModelId = (session.models as any)?.currentModelId;
  const currentModelName = session.models?.availableModels.find((m) => m.modelId === currentModelId)?.name;

  instLog(`createNewSession: sessionId="${session.sessionId.slice(0, 8)}" agentInfo.executorVersion="${agentInfo?.executorVersion || "(unset)"}" agentInfo.name="${agentInfo?.name || "(unset)"}"`);

  const sessionInfoMsg = {
    type: "session_info",
    sessionId: session.sessionId,
    models: session.models?.availableModels.map((m) => m.modelId) ?? [],
    currentModel: currentModelName || currentModelId || null,
    modes: session.modes?.availableModes.map((m) => ({ id: m.id, name: m.name })) ?? [],
    ...(agentInfo?.name && { agentName: agentInfo.name }),
    ...(agentInfo?.version && { agentVersion: agentInfo.version }),
    ...(agentInfo?.executorVersion && { executorVersion: agentInfo.executorVersion }),
  };
  instLog(`createNewSession: broadcasting session_info keys=${Object.keys(sessionInfoMsg).join(",")} hasExecutorVersion=${"executorVersion" in sessionInfoMsg}`);
  broadcast(sessionInfoMsg);

  instCheck("createNewSession", { version: agentInfo?.executorVersion || "", sessionId: session.sessionId.slice(0, 8) });

  return { sessionId: session.sessionId };
}

/**
 * Resume an existing session by ID.
 */
export async function resumeSession(
  connection: ClientSideConnection,
  sessionId: string,
  cwdOverride?: string,
): Promise<{ sessionId: string }> {
  const t0 = performance.now();
  const cwd = cwdOverride || process.env.ACP_CWD || undefined;
  log.info({ session: sessionId.slice(0, 8), cwd: cwd ?? "(session default)" }, "api: resumeSession started");
  const response = await connection.unstable_resumeSession({
    sessionId,
    ...(cwd ? { cwd } : {}),
    mcpServers: [],
  });
  log.info({ session: sessionId.slice(0, 8), durationMs: Math.round(performance.now() - t0) }, "api: resumeSession completed");
  return { sessionId: response.sessionId };
}

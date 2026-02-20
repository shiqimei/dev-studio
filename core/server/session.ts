import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { log, bootMs } from "./log.js";
import { nodeToWebWritable, nodeToWebReadable, instrumentedStream } from "./acp-shared.js";
import { createInstFilteredReadable, pushAllPendingTasks } from "./inst-interceptor.js";

// Resolve system-installed claude binary at module load time
let systemClaudePath = "";
try { systemClaudePath = execSync("which claude", { encoding: "utf-8" }).trim(); } catch {}
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

  log.info({ totalMs: Math.round(performance.now() - spawnT0), boot: bootMs() }, "api: createAcpConnection complete");
  return { connection, agentProcess, webClient: webClient! };
}

/**
 * Create a new session on an existing connection.
 */
export async function createNewSession(
  connection: ClientSideConnection,
  broadcast: BroadcastFn,
  cwdOverride?: string,
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

  broadcast({
    type: "session_info",
    sessionId: session.sessionId,
    models: session.models?.availableModels.map((m) => m.modelId) ?? [],
    currentModel: currentModelName || currentModelId || null,
    modes: session.modes?.availableModes.map((m) => ({ id: m.id, name: m.name })) ?? [],
  });

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

/**
 * Codex ACP connection setup.
 * Mirrors session.ts but spawns the Codex ACP Rust binary.
 */
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { log, bootMs } from "./log.js";
import { nodeToWebWritable, nodeToWebReadable, instrumentedStream } from "./acp-shared.js";
import {
  ClientSideConnection,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { WebClient } from "./client.js";
import type { AcpConnection, BroadcastFn } from "./types.js";

// Resolve codex-acp binary path at module load time.
// Prefer env override, then system-installed, then vendored build.
let codexBinaryPath = "";
if (process.env.CODEX_ACP_EXECUTABLE) {
  codexBinaryPath = process.env.CODEX_ACP_EXECUTABLE;
} else {
  try {
    codexBinaryPath = execSync("which codex-acp", { encoding: "utf-8" }).trim();
  } catch {
    // Fall back to vendored build
    const vendored = path.resolve(import.meta.dir, "../../vendor/codex-acp/target/release/codex-acp");
    try {
      const stat = Bun.file(vendored);
      // We can't synchronously check existence with Bun.file, so just set the path
      // and let the spawn fail gracefully if it doesn't exist.
      codexBinaryPath = vendored;
    } catch {
      // No vendored binary available
    }
  }
}

/**
 * Check whether a Codex ACP binary is available on this system.
 */
export function isCodexAvailable(): boolean {
  if (!codexBinaryPath) return false;
  try {
    const { existsSync } = require("node:fs");
    return existsSync(codexBinaryPath);
  } catch {
    return false;
  }
}

/**
 * One-time connection setup: spawns Codex ACP process, creates ClientSideConnection, initializes.
 */
export async function createCodexConnection(
  broadcast: BroadcastFn,
  cwdOverride?: string,
): Promise<AcpConnection> {
  if (!codexBinaryPath) {
    throw new Error("Codex ACP binary not found. Set CODEX_ACP_EXECUTABLE or build vendor/codex-acp.");
  }

  log.info({ binary: codexBinaryPath, boot: bootMs() }, "codex: spawning agent process");
  const spawnT0 = performance.now();
  const cwd = cwdOverride || process.env.ACP_CWD || process.cwd();
  const agentProcess = spawn(codexBinaryPath, [], {
    cwd,
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
    },
  });
  log.info(
    { pid: agentProcess.pid, durationMs: Math.round(performance.now() - spawnT0), boot: bootMs() },
    "codex: agent process spawned",
  );

  agentProcess.on("error", (err) => log.error({ err: err.message }, "codex: agent process error"));
  agentProcess.on("exit", (code, signal) => log.info({ code, signal }, "codex: agent process exited"));

  const rawStream = ndJsonStream(
    nodeToWebWritable(agentProcess.stdin!),
    nodeToWebReadable(agentProcess.stdout!),
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
  log.info({ boot: bootMs() }, "codex: initialize started");
  const initResp = await connection.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
  });
  log.info(
    { durationMs: Math.round(performance.now() - initT0), agent: initResp.agentInfo.name, version: initResp.agentInfo.version, boot: bootMs() },
    "codex: initialize completed",
  );

  broadcast({
    type: "system",
    text: `Connected to ${initResp.agentInfo.name} v${initResp.agentInfo.version}`,
  });

  log.info({ totalMs: Math.round(performance.now() - spawnT0), boot: bootMs() }, "codex: createCodexConnection complete");
  return {
    connection,
    agentProcess,
    webClient: webClient!,
    agentName: initResp.agentInfo.name,
    agentVersion: initResp.agentInfo.version,
  };
}

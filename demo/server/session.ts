import { spawn } from "node:child_process";
import path from "node:path";
import {
  type AnyMessage,
  ClientSideConnection,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { nodeToWebWritable, nodeToWebReadable } from "../../src/utils.js";
import { WebClient } from "./client.js";
import type { AcpConnection, BroadcastFn } from "./types.js";

/**
 * Wraps an ndJsonStream with taps on both directions.
 * `onSend` fires for client→agent messages.
 * `onRecv` fires for agent→client messages.
 */
function instrumentedStream(
  base: {
    readable: ReadableStream<AnyMessage>;
    writable: WritableStream<AnyMessage>;
  },
  onSend: (msg: AnyMessage) => void,
  onRecv: (msg: AnyMessage) => void,
) {
  // Tap readable (agent → client)
  const recvTransform = new TransformStream<AnyMessage, AnyMessage>({
    transform(msg, controller) {
      onRecv(msg);
      controller.enqueue(msg);
    },
  });
  const readable = base.readable.pipeThrough(recvTransform);

  // Tap writable (client → agent)
  const sendTransform = new TransformStream<AnyMessage, AnyMessage>({
    transform(msg, controller) {
      onSend(msg);
      controller.enqueue(msg);
    },
  });
  sendTransform.readable.pipeTo(base.writable);
  const writable = sendTransform.writable;

  return { readable, writable };
}

/**
 * One-time connection setup: spawns agent process, creates ClientSideConnection, initializes.
 */
export async function createAcpConnection(
  broadcast: BroadcastFn,
): Promise<AcpConnection> {
  const projectRoot = path.resolve(import.meta.dir, "../..");

  const agentProcess = spawn("node", ["dist/index.js"], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      CLAUDE_MODEL: process.env.CLAUDE_MODEL || "opus",
      MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS || "31999",
    },
  });

  agentProcess.on("error", (err) => console.error("Agent error:", err));

  const rawStream = ndJsonStream(
    nodeToWebWritable(agentProcess.stdin!),
    nodeToWebReadable(agentProcess.stdout!),
  );

  const stream = instrumentedStream(
    rawStream,
    (msg) => broadcast({ type: "protocol", dir: "send", ts: Date.now(), msg }),
    (msg) => broadcast({ type: "protocol", dir: "recv", ts: Date.now(), msg }),
  );

  const connection = new ClientSideConnection((agent) => {
    return new WebClient(agent, broadcast);
  }, stream);

  const initResp = await connection.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
  });

  broadcast({
    type: "system",
    text: `Connected to ${initResp.agentInfo.name} v${initResp.agentInfo.version}`,
  });

  return { connection, agentProcess };
}

/**
 * Create a new session on an existing connection.
 */
export async function createNewSession(
  connection: ClientSideConnection,
  broadcast: BroadcastFn,
): Promise<{ sessionId: string }> {
  const cwd = process.env.ACP_CWD || process.cwd();
  const session = await connection.newSession({
    cwd,
    mcpServers: [],
  });

  broadcast({
    type: "session_info",
    sessionId: session.sessionId,
    models: session.models?.availableModels.map((m) => m.modelId) ?? [],
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
): Promise<{ sessionId: string }> {
  const cwd = process.env.ACP_CWD || process.cwd();
  const response = await connection.unstable_resumeSession({
    sessionId,
    cwd,
    mcpServers: [],
  });
  return { sessionId: response.sessionId };
}

/**
 * List all active sessions.
 */
export async function listSessions(
  connection: ClientSideConnection,
): Promise<{ sessions: Array<{ sessionId: string; title?: string | null; updatedAt?: string | null; cwd: string }> }> {
  const cwd = process.env.ACP_CWD || process.cwd();
  const response = await connection.unstable_listSessions({ cwd });
  return { sessions: response.sessions };
}

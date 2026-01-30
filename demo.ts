/**
 * Self-contained Bun demo of Claude Code ACP with a web UI.
 *
 * Spawns the local claude-code-acp agent, connects over ACP protocol,
 * and serves a chat interface at http://localhost:3000 with a debug
 * panel showing raw protocol messages.
 *
 * Usage:
 *   bun run demo.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  type Agent,
  type Client,
  type AnyMessage,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  ClientSideConnection,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

// ── Stream helpers ───────────────────────────────────────────────────

function nodeToWebWritable(s: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        s.write(Buffer.from(chunk), (err) => (err ? reject(err) : resolve()));
      });
    },
  });
}

function nodeToWebReadable(s: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      s.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      s.on("end", () => controller.close());
      s.on("error", (err) => controller.error(err));
    },
  });
}

/**
 * Wraps an ndJsonStream with taps on both directions.
 * `onSend` fires for client→agent messages.
 * `onRecv` fires for agent→client messages.
 */
function instrumentedStream(
  base: { readable: ReadableStream<AnyMessage>; writable: WritableStream<AnyMessage> },
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

// ── ACP session wrapper ──────────────────────────────────────────────

interface AcpSession {
  connection: ClientSideConnection;
  sessionId: string;
  agentProcess: ChildProcess;
}

async function createAcpSession(
  broadcast: (msg: object) => void,
): Promise<AcpSession> {
  const agentProcess = spawn("node", ["dist/index.js"], {
    cwd: import.meta.dir,
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, CLAUDE_MODEL: "claude-opus-4-5-20250514" },
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

  const cwd = process.env.ACP_CWD || process.cwd();
  const session = await connection.newSession({
    cwd,
    mcpServers: [],
  });

  broadcast({
    type: "session_info",
    sessionId: session.sessionId,
    models: session.models.availableModels.map((m) => m.modelId),
    modes: session.modes.availableModes.map((m) => ({ id: m.id, name: m.name })),
  });

  return { connection, sessionId: session.sessionId, agentProcess };
}

// ── ACP Client that forwards to WebSocket ────────────────────────────

class WebClient implements Client {
  agent: Agent;
  broadcast: (msg: object) => void;

  constructor(agent: Agent, broadcast: (msg: object) => void) {
    this.agent = agent;
    this.broadcast = broadcast;
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const { update } = params;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          this.broadcast({ type: "text", text: update.content.text });
        }
        break;

      case "agent_thought_chunk":
        if (update.content.type === "text") {
          this.broadcast({ type: "thought", text: update.content.text });
        }
        break;

      case "tool_call":
        this.broadcast({
          type: "tool_call",
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: "pending",
          content: update.content,
          _meta: update._meta,
        });
        break;

      case "tool_call_update":
        this.broadcast({
          type: "tool_call_update",
          toolCallId: update.toolCallId,
          status: update.status,
          content: update.content,
          _meta: update._meta,
          title: update.title,
        });
        break;

      case "plan":
        this.broadcast({ type: "plan", entries: update.entries });
        break;

      case "available_commands_update":
        this.broadcast({
          type: "commands",
          commands: update.availableCommands.map((c) => c.name),
        });
        break;

      case "current_mode_update":
        this.broadcast({ type: "mode", modeId: update.currentModeId });
        break;

      default:
        break;
    }
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    this.broadcast({
      type: "permission",
      title: params.toolCall.title,
      decision: "auto-allow",
    });
    const option = params.options.find((o) => o.kind === "allow_once");
    return { outcome: { outcome: "selected", optionId: option!.optionId } };
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    try {
      return { content: await Bun.file(params.path).text() };
    } catch {
      return { content: "" };
    }
  }

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    await Bun.write(params.path, params.content);
    return {};
  }
}

// ── HTML ─────────────────────────────────────────────────────────────

const HTML = /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Claude Code ACP Demo</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #e6edf3;
    --text-dim: #7d8590;
    --accent: #f97316;
    --accent-dim: #f9731622;
    --tool-bg: #1c2128;
    --thought-bg: #1a1520;
    --user-bg: #1e2a3a;
    --green: #3fb950;
    --yellow: #d29922;
    --red: #f85149;
    --blue: #58a6ff;
    --purple: #bc8cff;
  }

  body {
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    font-size: 13px;
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  /* ── Header ─────────────────────────────────── */

  header {
    padding: 10px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }

  header h1 { font-size: 14px; font-weight: 600; color: var(--accent); }

  #status { font-size: 11px; color: var(--text-dim); margin-left: auto; }
  #status.connected { color: var(--green); }
  #status.connected::before { content: "\\25CF "; }
  #status.error { color: var(--red); }

  /* ── Main split layout ──────────────────────── */

  #main {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  /* ── Left: Chat panel ───────────────────────── */

  #chat-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .msg { line-height: 1.5; white-space: pre-wrap; word-break: break-word; }

  .msg.user {
    background: var(--user-bg);
    border-radius: 6px;
    padding: 8px 12px;
    margin: 8px 0 4px;
    border-left: 3px solid var(--accent);
  }

  .msg.user::before {
    content: "You";
    display: block;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--accent);
    margin-bottom: 2px;
  }

  .msg.assistant { color: var(--text); }

  .msg.thought {
    color: var(--text-dim);
    font-style: italic;
    background: var(--thought-bg);
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 12px;
    border-left: 2px solid #8b5cf6;
  }

  .msg.system {
    color: var(--text-dim);
    font-size: 11px;
    text-align: center;
    padding: 4px 0;
  }

  .tool-call {
    background: var(--tool-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    margin: 4px 0;
    font-size: 12px;
  }

  .tool-call .tool-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .tool-call .tool-kind {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 600;
  }

  .tool-call .tool-title { color: var(--text); font-weight: 500; }

  .tool-call .tool-status { font-size: 10px; margin-left: auto; }
  .tool-call .tool-status.pending { color: var(--yellow); }
  .tool-call .tool-status.completed { color: var(--green); }
  .tool-call .tool-status.failed { color: var(--red); }

  .tool-call .tool-content {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--border);
    color: var(--text-dim);
    font-size: 11px;
    max-height: 200px;
    overflow-y: auto;
  }

  .plan {
    background: var(--tool-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    margin: 4px 0;
  }

  .plan-title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    margin-bottom: 6px;
    font-weight: 600;
  }

  .plan-entry { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 12px; }
  .plan-entry .marker {
    width: 14px; height: 14px; border-radius: 3px;
    display: flex; align-items: center; justify-content: center;
    font-size: 9px; flex-shrink: 0;
  }
  .plan-entry .marker.pending { border: 1px solid var(--border); color: var(--text-dim); }
  .plan-entry .marker.in_progress { background: var(--yellow); color: var(--bg); }
  .plan-entry .marker.completed { background: var(--green); color: var(--bg); }

  .permission {
    font-size: 11px;
    color: var(--text-dim);
    padding: 2px 0 2px 16px;
    border-left: 2px solid var(--green);
  }

  #input-area {
    border-top: 1px solid var(--border);
    padding: 12px 20px;
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  #input {
    flex: 1;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 14px;
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    outline: none;
    resize: none;
    min-height: 40px;
    max-height: 120px;
  }

  #input:focus { border-color: var(--accent); }
  #input::placeholder { color: var(--text-dim); }
  #input:disabled { opacity: 0.5; }

  #send {
    background: var(--accent);
    color: var(--bg);
    border: none;
    border-radius: 6px;
    padding: 10px 20px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    align-self: flex-end;
  }

  #send:hover { filter: brightness(1.1); }
  #send:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ── Right: Debug panel ─────────────────────── */

  #debug-panel {
    width: 480px;
    flex-shrink: 0;
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }

  #debug-header {
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  #debug-header .title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
  }

  #debug-header .count {
    font-size: 10px;
    color: var(--text-dim);
    background: var(--surface);
    padding: 1px 7px;
    border-radius: 9px;
  }

  #debug-filter {
    margin-left: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 3px 8px;
    color: var(--text);
    font-family: inherit;
    font-size: 10px;
    outline: none;
    width: 140px;
  }
  #debug-filter:focus { border-color: var(--accent); }
  #debug-filter::placeholder { color: var(--text-dim); }

  #debug-controls {
    display: flex;
    gap: 4px;
  }

  #debug-controls button {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-family: inherit;
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
  }

  #debug-controls button:hover { color: var(--text); border-color: var(--text-dim); }
  #debug-controls button.active { color: var(--accent); border-color: var(--accent); }

  #btn-copy {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-family: inherit;
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
  }
  #btn-copy:hover { color: var(--text); border-color: var(--text-dim); }
  #btn-copy.copied { color: var(--green); border-color: var(--green); }

  #debug-messages {
    flex: 1;
    overflow-y: auto;
    padding: 6px 0;
  }

  /* ── Protocol entry ─────────────────────────── */

  .proto-entry {
    border-bottom: 1px solid #1e242c;
    font-size: 11px;
  }

  .proto-entry.filtered { display: none; }

  .proto-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 14px;
    cursor: pointer;
    user-select: none;
  }

  .proto-summary:hover { background: #161b22; }

  .proto-arrow {
    font-size: 9px;
    width: 14px;
    text-align: center;
    flex-shrink: 0;
    transition: transform 0.15s;
  }

  .proto-entry.open .proto-arrow { transform: rotate(90deg); }

  .proto-dir {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 1px 6px;
    border-radius: 3px;
    flex-shrink: 0;
    text-align: center;
    white-space: nowrap;
  }

  .proto-dir.send { background: #1e3a5f; color: var(--blue); }
  .proto-dir.recv { background: #1a3a1a; color: var(--green); }

  .proto-method {
    color: var(--text);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  .proto-id {
    color: var(--text-dim);
    font-size: 9px;
    flex-shrink: 0;
  }

  .proto-time {
    color: var(--text-dim);
    font-size: 9px;
    flex-shrink: 0;
    width: 55px;
    text-align: right;
  }

  .proto-body {
    display: none;
    padding: 0 14px 8px 40px;
    max-height: 400px;
    overflow: auto;
  }

  .proto-entry.open .proto-body { display: block; }

  .proto-body pre {
    font-size: 10px;
    line-height: 1.4;
    color: var(--text-dim);
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* JSON syntax colors */
  .json-key { color: var(--blue); }
  .json-str { color: var(--green); }
  .json-num { color: var(--purple); }
  .json-bool { color: var(--accent); }
  .json-null { color: var(--red); }

  /* ── Task bar + panel ─────────────────────────── */

  #task-bar {
    padding: 6px 20px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
    flex-shrink: 0;
    font-size: 12px;
  }

  #task-bar:hover { background: #1c2128; }

  #task-icon {
    font-size: 14px;
    color: var(--yellow);
  }

  #task-icon.all-done { color: var(--green); }

  #task-text {
    color: var(--text-dim);
    flex: 1;
  }

  #task-arrow {
    font-size: 10px;
    color: var(--text-dim);
    transition: transform 0.15s;
  }

  #task-bar.open #task-arrow { transform: rotate(180deg); }

  #task-panel {
    max-height: 240px;
    overflow-y: auto;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    flex-shrink: 0;
  }

  .task-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 20px;
    font-size: 12px;
    border-bottom: 1px solid #1e242c;
  }

  .task-item:last-child { border-bottom: none; }

  .task-badge {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 1px 6px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .task-badge.agent { background: #2d1f54; color: var(--purple); }
  .task-badge.bash { background: #1e3a5f; color: var(--blue); }
  .task-badge.other { background: #3a2a10; color: var(--accent); }

  .task-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }

  .task-elapsed {
    font-size: 10px;
    color: var(--text-dim);
    flex-shrink: 0;
    width: 48px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .task-status {
    font-size: 10px;
    font-weight: 600;
    flex-shrink: 0;
    width: 64px;
    text-align: center;
  }

  .task-status.running { color: var(--yellow); }
  .task-status.completed { color: var(--green); }
  .task-status.failed { color: var(--red); }

  .task-kill {
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--red);
    font-family: inherit;
    font-size: 10px;
    padding: 2px 8px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .task-kill:hover { background: #3d1f1f; border-color: var(--red); }
  .task-kill:disabled { opacity: 0.3; cursor: not-allowed; background: none; border-color: transparent; }

  .task-item.has-peek { border-bottom: none; padding-bottom: 2px; }

  .task-peek {
    padding: 0 20px 6px 54px;
    font-size: 11px;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-bottom: 1px solid #1e242c;
  }

  .task-peek:last-child { border-bottom: none; }

  .peek-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--yellow);
    margin-right: 6px;
    vertical-align: middle;
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  /* ── Resize handle ──────────────────────────── */

  #resize-handle {
    width: 4px;
    flex-shrink: 0;
    cursor: col-resize;
    background: transparent;
    transition: background 0.15s;
  }

  #resize-handle:hover,
  #resize-handle.active { background: var(--accent); }
</style>
</head>
<body>
  <header>
    <h1>Claude Code ACP</h1>
    <span id="status">connecting...</span>
  </header>

  <div id="task-bar" style="display:none">
    <span id="task-icon">&#9881;</span>
    <span id="task-text">0 active tasks</span>
    <span id="task-arrow">&#9660;</span>
  </div>
  <div id="task-panel" style="display:none">
    <div id="task-list"></div>
  </div>

  <div id="main">
    <div id="chat-panel">
      <div id="messages"></div>
      <div id="input-area">
        <textarea id="input" rows="1" placeholder="Send a message..." disabled></textarea>
        <button id="send" disabled>Send</button>
      </div>
    </div>

    <div id="resize-handle"></div>

    <div id="debug-panel">
      <div id="debug-header">
        <span class="title">Protocol</span>
        <span class="count" id="debug-count">0</span>
        <div id="debug-controls">
          <button id="btn-all" class="active">All</button>
          <button id="btn-send">Sent</button>
          <button id="btn-recv">Recv</button>
        </div>
        <button id="btn-copy">Copy All</button>
        <input id="debug-filter" type="text" placeholder="Filter method..." />
      </div>
      <div id="debug-messages"></div>
    </div>
  </div>

<script>
const $msgs = document.getElementById("messages");
const $input = document.getElementById("input");
const $send = document.getElementById("send");
const $status = document.getElementById("status");
const $debug = document.getElementById("debug-messages");
const $debugCount = document.getElementById("debug-count");
const $debugFilter = document.getElementById("debug-filter");
const $btnAll = document.getElementById("btn-all");
const $btnSend = document.getElementById("btn-send");
const $btnRecv = document.getElementById("btn-recv");
const $resizeHandle = document.getElementById("resize-handle");
const $debugPanel = document.getElementById("debug-panel");

let ws;
let busy = false;
let assistantEl = null;
let thoughtEl = null;
const toolEls = {};
let protoCount = 0;
let dirFilter = "all"; // "all" | "send" | "recv"
let textFilter = "";
let startTime = Date.now();
let autoScrollDebug = true;
const protoLog = [];  // raw protocol messages for copy
const $btnCopy = document.getElementById("btn-copy");

// ── Task manager state ───────────
const $taskBar = document.getElementById("task-bar");
const $taskIcon = document.getElementById("task-icon");
const $taskText = document.getElementById("task-text");
const $taskPanel = document.getElementById("task-panel");
const $taskList = document.getElementById("task-list");

const taskStore = {};      // keyed by toolCallId
const peekStatus = {};     // parentToolCallId → peek text (latest sub-agent activity)
let turnToolCallIds = [];  // tool calls in the current turn
let taskPanelOpen = false;
let userClosedPanel = false;

$taskBar.addEventListener("click", () => {
  taskPanelOpen = !taskPanelOpen;
  if (!taskPanelOpen) userClosedPanel = true;
  $taskBar.classList.toggle("open", taskPanelOpen);
  $taskPanel.style.display = taskPanelOpen ? "block" : "none";
});

function classifyTool(meta) {
  const name = meta?.claudeCode?.toolName || "";
  if (name === "Task") return "agent";
  if (name === "Bash") return "bash";
  if (name) return "other";
  return "other";
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  return m + "m " + (s % 60) + "s";
}

function renderTasks() {
  const bgTasks = Object.values(taskStore).filter(t => t.isBackground);
  const activeCount = bgTasks.filter(t => t.status === "running").length;
  const allDone = bgTasks.length > 0 && activeCount === 0;
  console.log("[task-mgr] renderTasks: bgTasks=" + bgTasks.length, "active=" + activeCount, bgTasks.map(t => t.toolCallId + ":" + t.status));

  if (bgTasks.length === 0) {
    $taskBar.style.display = "none";
    $taskPanel.style.display = "none";
    userClosedPanel = false; // Reset so next bg tasks auto-expand
    return;
  }

  $taskBar.style.display = "flex";

  // Auto-expand panel when background tasks appear
  if (activeCount > 0 && !taskPanelOpen && !userClosedPanel) {
    taskPanelOpen = true;
    $taskBar.classList.add("open");
    $taskPanel.style.display = "block";
  }
  $taskIcon.className = allDone ? "all-done" : "";
  $taskText.textContent = allDone
    ? bgTasks.length + " background task" + (bgTasks.length === 1 ? "" : "s") + " — all done"
    : activeCount + " active background task" + (activeCount === 1 ? "" : "s");

  // Rebuild task list
  $taskList.innerHTML = "";
  for (const task of bgTasks) {
    const now = Date.now();
    const elapsed = (task.endTime || now) - task.startTime;
    const badgeClass = task.toolKind || "other";
    const badgeLabel = badgeClass === "agent" ? "AGENT" : badgeClass === "bash" ? "BASH" : "TOOL";
    const statusClass = task.status === "running" ? "running"
      : task.status === "completed" ? "completed" : "failed";
    const statusLabel = task.status === "running" ? "running"
      : task.status === "completed" ? "done" : "failed";
    const isDone = task.status !== "running";

    const row = document.createElement("div");
    row.className = "task-item";
    row.innerHTML =
      '<span class="task-badge ' + badgeClass + '">' + badgeLabel + '</span>' +
      '<span class="task-title">' + escapeHtml(task.title) + '</span>' +
      '<span class="task-elapsed">' + formatElapsed(elapsed) + '</span>' +
      '<span class="task-status ' + statusClass + '">' + statusLabel + '</span>' +
      '<button class="task-kill"' + (isDone ? ' disabled' : '') + '>Kill</button>';

    if (!isDone) {
      row.querySelector(".task-kill").onclick = () => killTask(task);
    }
    $taskList.appendChild(row);

    // Peek status line showing current sub-agent activity
    const peek = peekStatus[task.toolCallId];
    if (peek && !isDone) {
      row.classList.add("has-peek");
      const peekEl = document.createElement("div");
      peekEl.className = "task-peek";
      peekEl.innerHTML = '<span class="peek-dot"></span>' + escapeHtml(peek);
      $taskList.appendChild(peekEl);
    }
  }
}

function killTask(task) {
  if (!ws || task.status !== "running") return;
  const desc = task.toolKind === "bash"
    ? "Kill the background bash process: " + task.title
    : task.toolKind === "agent"
    ? "Kill the background agent task: " + task.title
    : "Kill the background task: " + task.title;
  addMsg("user", desc);
  assistantEl = null;
  thoughtEl = null;
  setReady(false);
  ws.send(JSON.stringify({ type: "prompt", text: desc }));
}

// Update elapsed times every second
setInterval(() => {
  const hasRunning = Object.values(taskStore).some(t => t.isBackground && t.status === "running");
  if (hasRunning) renderTasks();
}, 1000);

// ── Resize ──────────────────────

let resizing = false;
$resizeHandle.addEventListener("mousedown", (e) => {
  resizing = true;
  $resizeHandle.classList.add("active");
  e.preventDefault();
});
window.addEventListener("mousemove", (e) => {
  if (!resizing) return;
  const newWidth = window.innerWidth - e.clientX;
  $debugPanel.style.width = Math.max(200, Math.min(newWidth, window.innerWidth - 300)) + "px";
});
window.addEventListener("mouseup", () => {
  resizing = false;
  $resizeHandle.classList.remove("active");
});

// ── Debug panel scroll tracking ─

$debug.addEventListener("scroll", () => {
  const gap = $debug.scrollHeight - $debug.scrollTop - $debug.clientHeight;
  autoScrollDebug = gap < 40;
});

// ── Filter controls ─────────────

function setDirFilter(f) {
  dirFilter = f;
  [$btnAll, $btnSend, $btnRecv].forEach(b => b.classList.remove("active"));
  if (f === "all") $btnAll.classList.add("active");
  else if (f === "send") $btnSend.classList.add("active");
  else $btnRecv.classList.add("active");
  applyFilters();
}

$btnAll.onclick = () => setDirFilter("all");
$btnSend.onclick = () => setDirFilter("send");
$btnRecv.onclick = () => setDirFilter("recv");

$debugFilter.addEventListener("input", () => {
  textFilter = $debugFilter.value.toLowerCase();
  applyFilters();
});

function applyFilters() {
  for (const el of $debug.children) {
    const dir = el.dataset.dir;
    const method = (el.dataset.method || "").toLowerCase();
    const dirOk = dirFilter === "all" || dirFilter === dir;
    const textOk = !textFilter || method.includes(textFilter);
    el.classList.toggle("filtered", !(dirOk && textOk));
  }
}

// ── JSON syntax highlighting ────

function syntaxHighlight(json) {
  return json.replace(
    /("(\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    function (match) {
      let cls = "json-num";
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? "json-key" : "json-str";
      } else if (/true|false/.test(match)) {
        cls = "json-bool";
      } else if (/null/.test(match)) {
        cls = "json-null";
      }
      return '<span class="' + cls + '">' + match + '</span>';
    }
  );
}

// ── Protocol entry ──────────────

// ── Copy button ──────────────────

$btnCopy.onclick = () => {
  const text = protoLog.map(e => JSON.stringify(e)).join("\\n");
  navigator.clipboard.writeText(text).then(() => {
    $btnCopy.textContent = "Copied!";
    $btnCopy.classList.add("copied");
    setTimeout(() => {
      $btnCopy.textContent = "Copy All";
      $btnCopy.classList.remove("copied");
    }, 1500);
  });
};

function addProtoEntry(dir, ts, msg) {
  protoLog.push({ dir, ts, msg });
  protoCount++;
  $debugCount.textContent = protoCount;

  const method = msg.method || (msg.result !== undefined ? "result" : msg.error ? "error" : "?");
  const id = msg.id !== undefined ? "#" + msg.id : "";
  const elapsed = ((ts - startTime) / 1000).toFixed(2) + "s";

  const json = JSON.stringify(msg, null, 2);
  const highlighted = syntaxHighlight(escapeHtml(json));

  const el = document.createElement("div");
  el.className = "proto-entry";
  el.dataset.dir = dir;
  el.dataset.method = method;

  el.innerHTML =
    '<div class="proto-summary">' +
      '<span class="proto-arrow">\\u25B6</span>' +
      '<span class="proto-dir ' + dir + '">' + (dir === "send" ? "SND \\u2192" : "RCV \\u2190") + '</span>' +
      '<span class="proto-method">' + escapeHtml(method) + '</span>' +
      '<span class="proto-id">' + id + '</span>' +
      '<span class="proto-time">' + elapsed + '</span>' +
    '</div>' +
    '<div class="proto-body"><pre>' + highlighted + '</pre></div>';

  el.querySelector(".proto-summary").onclick = () => {
    el.classList.toggle("open");
  };

  // Apply current filters
  const dirOk = dirFilter === "all" || dirFilter === dir;
  const textOk = !textFilter || method.toLowerCase().includes(textFilter);
  if (!(dirOk && textOk)) el.classList.add("filtered");

  $debug.appendChild(el);
  if (autoScrollDebug) $debug.scrollTop = $debug.scrollHeight;
}

// ── Chat helpers ────────────────

function scrollBottom() {
  $msgs.scrollTop = $msgs.scrollHeight;
}

function setReady(ready) {
  busy = !ready;
  $input.disabled = !ready;
  $send.disabled = !ready;
  if (ready) $input.focus();
}

function addMsg(cls, text) {
  const el = document.createElement("div");
  el.className = "msg " + cls;
  el.textContent = text;
  $msgs.appendChild(el);
  scrollBottom();
  return el;
}

function addHtml(html) {
  const el = document.createElement("div");
  el.innerHTML = html;
  $msgs.appendChild(el.firstElementChild || el);
  scrollBottom();
  return $msgs.lastElementChild;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── WebSocket ───────────────────

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(proto + "//" + location.host + "/ws");

  ws.onopen = () => {
    $status.textContent = "connected";
    $status.className = "connected";
    startTime = Date.now();
    setReady(true);
  };

  ws.onclose = () => {
    $status.textContent = "disconnected";
    $status.className = "error";
    setReady(false);
    setTimeout(connect, 2000);
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    handleMsg(msg);
  };
}

function handleMsg(msg) {
  switch (msg.type) {
    // ── Protocol debug messages ───
    case "protocol":
      addProtoEntry(msg.dir, msg.ts, msg.msg);
      break;

    // ── Chat messages ─────────────
    case "text":
      if (!assistantEl) {
        assistantEl = addMsg("assistant", "");
      }
      assistantEl.textContent += msg.text;
      scrollBottom();
      break;

    case "thought":
      if (!thoughtEl) {
        thoughtEl = addMsg("thought", "");
      }
      thoughtEl.textContent += msg.text;
      scrollBottom();
      break;

    case "tool_call": {
      thoughtEl = null;
      const content = (msg.content || [])
        .filter(c => c.content?.text)
        .map(c => c.content.text)
        .join("\\n");
      const contentHtml = content
        ? '<div class="tool-content">' + escapeHtml(content) + '</div>'
        : '';
      const el = addHtml(
        '<div class="tool-call" id="tool-' + msg.toolCallId + '">' +
          '<div class="tool-header">' +
            '<span class="tool-kind">' + escapeHtml(msg.kind || "tool") + '</span>' +
            '<span class="tool-title">' + escapeHtml(msg.title || msg.toolCallId) + '</span>' +
            '<span class="tool-status pending">running</span>' +
          '</div>' +
          contentHtml +
        '</div>'
      );
      toolEls[msg.toolCallId] = el;
      // Track for background task detection
      const isBg = msg._meta?.claudeCode?.isBackground === true;
      console.log("[task-mgr] tool_call", msg.toolCallId, "tool=" + (msg._meta?.claudeCode?.toolName || "?"), "isBackground=" + isBg, "_meta=", msg._meta);
      taskStore[msg.toolCallId] = {
        toolCallId: msg.toolCallId,
        title: msg.title || msg.toolCallId,
        kind: msg.kind || "tool",
        toolKind: classifyTool(msg._meta),
        toolName: msg._meta?.claudeCode?.toolName || "",
        status: "running",
        isBackground: isBg,
        startTime: Date.now(),
        endTime: null,
      };
      turnToolCallIds.push(msg.toolCallId);
      if (isBg) renderTasks();
      // Track peek for parent background task
      const parentId = msg._meta?.claudeCode?.parentToolUseId;
      if (parentId && taskStore[parentId]?.isBackground) {
        peekStatus[parentId] = msg.title || msg._meta?.claudeCode?.toolName || "Working...";
        renderTasks();
      }
      break;
    }

    case "tool_call_update": {
      const el = toolEls[msg.toolCallId];
      if (el) {
        const statusEl = el.querySelector(".tool-status");
        if (statusEl) {
          statusEl.textContent = msg.status;
          statusEl.className = "tool-status " + msg.status;
        }
        if (msg.content && msg.content.length) {
          let contentEl = el.querySelector(".tool-content");
          if (!contentEl) {
            contentEl = document.createElement("div");
            contentEl.className = "tool-content";
            el.appendChild(contentEl);
          }
          const text = msg.content
            .filter(c => c.content?.text)
            .map(c => c.content.text)
            .join("\\n");
          if (text) contentEl.textContent = text;
        }
      }
      // Update task store
      const task = taskStore[msg.toolCallId];
      if (task) {
        if (msg.status === "completed" || msg.status === "failed") {
          // For background tasks, the initial "completed" just means "launched".
          // Wait for backgroundComplete flag for actual completion.
          const isBgComplete = msg._meta?.claudeCode?.backgroundComplete;
          if (!task.isBackground || msg.status === "failed" || isBgComplete) {
            task.status = msg.status === "failed" ? "failed" : "completed";
            task.endTime = Date.now();
          }
        }
        if (msg.title) task.title = msg.title;
        // Clear peek when this background task completes
        if (task.isBackground && task.status !== "running") {
          delete peekStatus[msg.toolCallId];
        }
        if (task.isBackground) renderTasks();
      }
      // Track peek for parent background task (sub-agent tool activity)
      const updateParentId = msg._meta?.claudeCode?.parentToolUseId;
      if (updateParentId && taskStore[updateParentId]?.isBackground && taskStore[updateParentId].status === "running") {
        if (msg.status === "completed") {
          peekStatus[updateParentId] = "Processing results...";
        }
        renderTasks();
      }
      break;
    }

    case "plan": {
      thoughtEl = null;
      const entries = msg.entries.map(e => {
        const icon = e.status === "completed" ? "\\u2713"
          : e.status === "in_progress" ? "\\u25B6" : " ";
        return '<div class="plan-entry">' +
          '<span class="marker ' + e.status + '">' + icon + '</span>' +
          '<span>' + escapeHtml(e.content) + '</span></div>';
      }).join("");
      addHtml('<div class="plan"><div class="plan-title">Plan</div>' + entries + '</div>');
      break;
    }

    case "permission":
      addHtml('<div class="permission">Allowed: ' + escapeHtml(msg.title) + '</div>');
      break;

    case "system":
      addMsg("system", msg.text);
      break;

    case "session_info":
      addMsg("system", "Session " + msg.sessionId.slice(0, 8) + "... | Models: " + msg.models.join(", ") + " | Modes: " + msg.modes.map(m => m.id).join(", "));
      break;

    case "turn_end":
      assistantEl = null;
      thoughtEl = null;
      // Mark any still-running tool calls from this turn as background tasks
      console.log("[task-mgr] turn_end, turnToolCallIds=", turnToolCallIds.slice(), "taskStore=", JSON.parse(JSON.stringify(taskStore)));
      for (const id of turnToolCallIds) {
        const task = taskStore[id];
        if (task && task.status === "running") {
          task.isBackground = true;
          console.log("[task-mgr] marking as background:", id, task.title);
        }
      }
      turnToolCallIds = [];
      renderTasks();
      setReady(true);
      break;

    case "error":
      addMsg("system", "Error: " + msg.text);
      setReady(true);
      break;
  }
}

function send() {
  const text = $input.value.trim();
  if (!text || busy) return;
  addMsg("user", text);
  assistantEl = null;
  thoughtEl = null;
  setReady(false);
  ws.send(JSON.stringify({ type: "prompt", text }));
  $input.value = "";
  $input.style.height = "auto";
}

$send.onclick = send;
$input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$input.addEventListener("input", () => {
  $input.style.height = "auto";
  $input.style.height = Math.min($input.scrollHeight, 120) + "px";
});

connect();
</script>
</body>
</html>`;

// ── Server ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000", 10);
const clients = new Set<{ send: (data: string) => void }>();

function broadcast(msg: object) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    try {
      ws.send(data);
    } catch {}
  }
}

let acpSession: AcpSession | null = null;

const server = Bun.serve({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    return new Response(HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },

  websocket: {
    async open(ws) {
      clients.add(ws);

      if (!acpSession) {
        try {
          acpSession = await createAcpSession(broadcast);
        } catch (err: any) {
          ws.send(JSON.stringify({ type: "error", text: err.message }));
        }
      }
    },

    async message(ws, raw) {
      const msg = JSON.parse(
        typeof raw === "string" ? raw : new TextDecoder().decode(raw),
      );

      if (msg.type === "prompt" && acpSession) {
        try {
          const result = await acpSession.connection.prompt({
            sessionId: acpSession.sessionId,
            prompt: [{ type: "text", text: msg.text }],
          });
          broadcast({ type: "turn_end", stopReason: result.stopReason });
        } catch (err: any) {
          broadcast({ type: "error", text: err.message });
          broadcast({ type: "turn_end", stopReason: "error" });
        }
      }
    },

    close(ws) {
      clients.delete(ws);
    },
  },
});

console.log(`\n  Claude Code ACP Demo`);
console.log(`  http://localhost:${server.port}\n`);

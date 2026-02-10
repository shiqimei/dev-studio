/**
 * Recurring task process manager.
 * Spawns inline Bun subprocesses that connect to the demo WS server
 * and send prompts on a configured trigger (interval or file watcher).
 */
import { spawn, type Subprocess } from "bun";
import { log } from "./log.js";

export interface RecurringConfig {
  type: "interval" | "filewatcher";
  /** Milliseconds between triggers (for "interval" type). */
  intervalMs?: number;
  /** Glob patterns to watch (for "filewatcher" type). */
  watchPaths?: string[];
  /** The prompt text to send on each trigger. */
  prompt: string;
  active: boolean;
}

interface RunningTask {
  sessionId: string;
  config: RecurringConfig;
  process: Subprocess;
}

const runningTasks = new Map<string, RunningTask>();

/**
 * Start a recurring task for a session.
 * Spawns an inline Bun script that connects to the demo backend WS
 * and sends prompts on the configured trigger.
 */
export function startRecurringTask(
  sessionId: string,
  config: RecurringConfig,
  wsPort: number,
  cwd: string,
): { pid: number } {
  // Stop existing task for this session if any
  stopRecurringTask(sessionId);

  const scriptCode =
    config.type === "interval"
      ? buildIntervalScript(sessionId, config.prompt, config.intervalMs ?? 30000, wsPort)
      : buildFileWatcherScript(sessionId, config.prompt, config.watchPaths ?? [], wsPort, cwd);

  const proc = spawn(["bun", "-e", scriptCode], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  const task: RunningTask = { sessionId, config, process: proc };
  runningTasks.set(sessionId, task);

  proc.exited.then(() => {
    runningTasks.delete(sessionId);
    log.info({ session: sessionId.slice(0, 8) }, "recurring: process exited");
  });

  log.info(
    { session: sessionId.slice(0, 8), pid: proc.pid, type: config.type },
    "recurring: started",
  );
  return { pid: proc.pid };
}

/** Stop a recurring task subprocess. Returns true if one was running. */
export function stopRecurringTask(sessionId: string): boolean {
  const task = runningTasks.get(sessionId);
  if (!task) return false;
  task.process.kill();
  runningTasks.delete(sessionId);
  log.info({ session: sessionId.slice(0, 8) }, "recurring: stopped");
  return true;
}

/** Stop all recurring task subprocesses (for server shutdown). */
export function stopAllRecurringTasks(): void {
  for (const [sessionId] of runningTasks) {
    stopRecurringTask(sessionId);
  }
}

/** Get map of sessionId → pid for all running tasks. */
export function getRunningTaskPids(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [sessionId, task] of runningTasks) {
    if (task.process.pid != null) {
      result[sessionId] = task.process.pid;
    }
  }
  return result;
}

// ── Script builders ──

function buildIntervalScript(
  sessionId: string,
  prompt: string,
  intervalMs: number,
  wsPort: number,
): string {
  const eSid = JSON.stringify(sessionId);
  const ePrompt = JSON.stringify(prompt);
  return `
const ws = new WebSocket("ws://localhost:${wsPort}/ws");
const sessionId = ${eSid};
const prompt = ${ePrompt};
const intervalMs = ${intervalMs};

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ type: "resume_session", sessionId }));
  setTimeout(() => {
    ws.send(JSON.stringify({ type: "prompt", text: prompt }));
    setInterval(() => {
      ws.send(JSON.stringify({ type: "prompt", text: prompt }));
    }, intervalMs);
  }, 1000);
});
ws.addEventListener("error", (e) => console.error("WS error:", e));
ws.addEventListener("close", () => process.exit(0));
process.on("SIGTERM", () => { ws.close(); process.exit(0); });
process.on("SIGINT", () => { ws.close(); process.exit(0); });
`;
}

function buildFileWatcherScript(
  sessionId: string,
  prompt: string,
  watchPaths: string[],
  wsPort: number,
  cwd: string,
): string {
  const eSid = JSON.stringify(sessionId);
  const ePrompt = JSON.stringify(prompt);
  const ePaths = JSON.stringify(watchPaths);
  const eCwd = JSON.stringify(cwd);
  return `
import { watch } from "fs";

const ws = new WebSocket("ws://localhost:${wsPort}/ws");
const sessionId = ${eSid};
const prompt = ${ePrompt};
const watchPaths = ${ePaths};
const cwd = ${eCwd};
let debounceTimer = null;

function matchesAny(filename) {
  return watchPaths.some((pattern) => {
    const glob = new Bun.Glob(pattern);
    return glob.match(filename);
  });
}

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ type: "resume_session", sessionId }));
  watch(cwd, { recursive: true }, (_event, filename) => {
    if (!filename || !matchesAny(filename)) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      ws.send(JSON.stringify({ type: "prompt", text: prompt + "\\n\\nTriggered by file change: " + filename }));
    }, 500);
  });
});
ws.addEventListener("close", () => process.exit(0));
process.on("SIGTERM", () => { ws.close(); process.exit(0); });
process.on("SIGINT", () => { ws.close(); process.exit(0); });
`;
}

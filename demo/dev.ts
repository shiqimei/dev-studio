/**
 * Unified dev script for the Claude Code ACP demo.
 *
 * Starts both the Bun backend server and the Vite dev server,
 * prefixes their output with colored labels, and handles clean shutdown.
 *
 * Usage: bun demo/dev.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const BACKEND_PORT = 5689;
const VITE_PORT = 5688;

// ANSI colors
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function prefix(label: string, color: string) {
  return (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) {
        process.stdout.write(`${color}[${label}]${RESET} ${line}\n`);
      }
    }
  };
}

const children: ChildProcess[] = [];

function cleanup() {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const { createConnection } = await import("node:net");
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
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Port ${port} not ready after ${timeoutMs}ms`);
}

// Start backend
const backend = spawn("bun", ["--hot", path.join(ROOT, "demo/server/index.ts")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(BACKEND_PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(backend);
backend.stdout?.on("data", prefix("server", CYAN));
backend.stderr?.on("data", prefix("server", CYAN));

// Wait for backend to be ready before starting Vite
await waitForPort(BACKEND_PORT);

// Start Vite
const vite = spawn("npx", ["vite", "--port", String(VITE_PORT)], {
  cwd: path.join(ROOT, "demo"),
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(vite);
vite.stdout?.on("data", prefix("vite", MAGENTA));
vite.stderr?.on("data", prefix("vite", MAGENTA));

// Print startup banner
console.log(`\n${BOLD}  Claude Code ACP Demo${RESET}`);
console.log(`${DIM}  ────────────────────────${RESET}`);
console.log(`  UI:      ${BOLD}http://localhost:${VITE_PORT}${RESET}`);
console.log(`  Backend: ${DIM}http://localhost:${BACKEND_PORT}${RESET}\n`);

// Handle child exits
for (const child of children) {
  child.on("exit", (code, signal) => {
    if (signal !== "SIGTERM" && signal !== "SIGINT") {
      console.error(`\nChild process exited unexpectedly (code=${code}, signal=${signal}). Shutting down.`);
      cleanup();
      process.exit(1);
    }
  });
}

// Clean shutdown on Ctrl+C
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  cleanup();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

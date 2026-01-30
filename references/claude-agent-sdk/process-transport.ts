/**
 * Claude Agent SDK v0.2.25 — ProcessTransport
 * Decompiled from sdk.mjs (class XX, lines ~7195–7523).
 *
 * ProcessTransport spawns the Claude Code CLI binary as a child process
 * and communicates via NDJSON over stdin/stdout pipes.
 *
 * Architecture:
 *   SDK (sdk.mjs) --spawn()--> CLI (cli.js) as child_process
 *   SDK  ---stdin--->  CLI   (NDJSON: user messages, control_requests)
 *   SDK  <--stdout---  CLI   (NDJSON: assistant messages, control_responses, stream_events, etc.)
 */

import { spawn } from "child_process";
import { createInterface } from "readline";
import type { Readable, Writable } from "stream";

// ── Types ────────────────────────────────────────────────────────────────

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

export interface SpawnedProcess {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  once(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
}

export interface TransportOptions {
  abortController: AbortController;
  pathToClaudeCodeExecutable: string;
  env: Record<string, string | undefined>;
  executable: "bun" | "deno" | "node";
  executableArgs: string[];
  extraArgs: Record<string, string | null>;
  // SDK configuration → CLI flags
  maxThinkingTokens?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  fallbackModel?: string;
  agent?: string;
  betas?: string[];
  jsonSchema?: object;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  permissionPromptToolName?: string;
  continueConversation?: boolean;
  resume?: string;
  resumeSessionAt?: string;
  settingSources?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: string[] | "default";
  mcpServers?: Record<string, any>;
  strictMcpConfig?: boolean;
  canUseTool?: boolean;
  hooks?: boolean;
  includePartialMessages?: boolean;
  additionalDirectories?: string[];
  plugins?: Array<{ type: string; path: string }>;
  forkSession?: boolean;
  persistSession?: boolean;
  cwd?: string;
  sandbox?: any;
  stderr?: (data: string) => void;
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
}

// NDJSON message from CLI stdout
type StdoutMessage =
  | { type: "assistant" }
  | { type: "user" }
  | { type: "result" }
  | { type: "stream_event" }
  | { type: "system" }
  | { type: "tool_progress" }
  | { type: "tool_use_summary" }
  | { type: "auth_status" }
  | { type: "control_response"; response: { request_id: string } }
  | { type: "control_request"; request_id: string }
  | { type: "control_cancel_request"; request_id: string }
  | { type: "keep_alive" };

// ── ProcessTransport ─────────────────────────────────────────────────────

/**
 * Spawns Claude Code CLI as a child process and provides an NDJSON
 * transport over stdin (write) and stdout (read).
 *
 * CLI is launched with these fixed flags:
 *   --output-format stream-json --verbose --input-format stream-json
 *
 * Plus conditional flags mapped from SDK options (--model, --max-turns, etc.)
 */
export class ProcessTransport {
  private process: SpawnedProcess | null = null;
  private processStdin: Writable | null = null;
  private processStdout: Readable | null = null;
  private ready = false;
  private abortController: AbortController;
  private exitError: Error | null = null;
  private exitListeners: Array<{ callback: Function; handler: Function }> = [];

  constructor(private options: TransportOptions) {
    this.abortController = options.abortController;
    this.initialize();
  }

  // ── Spawn ──────────────────────────────────────────────────────────

  private getDefaultExecutable(): string {
    // Returns "bun" if running in Bun, otherwise "node"
    return typeof Bun !== "undefined" ? "bun" : "node";
  }

  private spawnLocalProcess(options: SpawnOptions): SpawnedProcess {
    const { command, args, cwd, env, signal } = options;
    const stderrMode = env.DEBUG_CLAUDE_AGENT_SDK || this.options.stderr ? "pipe" : "ignore";

    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", stderrMode],
      signal,
      env: env as any,
      windowsHide: true,
    });

    if (stderrMode === "pipe") {
      child.stderr!.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.options.stderr?.(text);
      });
    }

    return {
      stdin: child.stdin!,
      stdout: child.stdout!,
      get killed() { return child.killed; },
      get exitCode() { return child.exitCode; },
      kill: child.kill.bind(child),
      on: child.on.bind(child) as any,
      once: child.once.bind(child),
      off: child.off.bind(child),
    };
  }

  /**
   * Build CLI arguments from SDK options and spawn the process.
   *
   * The CLI is invoked as:
   *   <executable> [executableArgs] <cli.js path> --output-format stream-json --verbose --input-format stream-json [options...]
   *
   * If pathToClaudeCodeExecutable is a native binary (no .js/.mjs/.ts extension):
   *   <native-binary> --output-format stream-json --verbose --input-format stream-json [options...]
   */
  private initialize(): void {
    const {
      additionalDirectories = [],
      agent,
      betas,
      executable = this.getDefaultExecutable(),
      executableArgs = [],
      extraArgs = {},
      pathToClaudeCodeExecutable,
      env = { ...process.env },
      maxThinkingTokens,
      maxTurns,
      maxBudgetUsd,
      model,
      fallbackModel,
      jsonSchema,
      permissionMode,
      allowDangerouslySkipPermissions,
      permissionPromptToolName,
      continueConversation,
      resume,
      settingSources,
      allowedTools = [],
      disallowedTools = [],
      tools,
      mcpServers,
      strictMcpConfig,
      canUseTool,
      includePartialMessages,
      plugins,
    } = this.options;

    // ── Fixed flags (always present) ──
    const args: string[] = [
      "--output-format", "stream-json",
      "--verbose",
      "--input-format", "stream-json",
    ];

    // ── Conditional flags ──
    if (maxThinkingTokens !== undefined) args.push("--max-thinking-tokens", maxThinkingTokens.toString());
    if (maxTurns) args.push("--max-turns", maxTurns.toString());
    if (maxBudgetUsd !== undefined) args.push("--max-budget-usd", maxBudgetUsd.toString());
    if (model) args.push("--model", model);
    if (agent) args.push("--agent", agent);
    if (betas?.length) args.push("--betas", betas.join(","));
    if (jsonSchema) args.push("--json-schema", JSON.stringify(jsonSchema));
    if (canUseTool) args.push("--permission-prompt-tool", "stdio");
    else if (permissionPromptToolName) args.push("--permission-prompt-tool", permissionPromptToolName);
    if (continueConversation) args.push("--continue");
    if (resume) args.push("--resume", resume);
    if (allowedTools.length > 0) args.push("--allowedTools", allowedTools.join(","));
    if (disallowedTools.length > 0) args.push("--disallowedTools", disallowedTools.join(","));
    if (tools !== undefined) {
      if (Array.isArray(tools)) args.push("--tools", tools.length === 0 ? "" : tools.join(","));
      else args.push("--tools", "default");
    }
    if (mcpServers && Object.keys(mcpServers).length > 0)
      args.push("--mcp-config", JSON.stringify({ mcpServers }));
    if (settingSources) args.push("--setting-sources", settingSources.join(","));
    if (strictMcpConfig) args.push("--strict-mcp-config");
    if (permissionMode) args.push("--permission-mode", permissionMode);
    if (allowDangerouslySkipPermissions) args.push("--allow-dangerously-skip-permissions");
    if (fallbackModel) args.push("--fallback-model", fallbackModel);
    if (includePartialMessages) args.push("--include-partial-messages");
    for (const dir of additionalDirectories) args.push("--add-dir", dir);
    if (plugins?.length) {
      for (const p of plugins) {
        if (p.type === "local") args.push("--plugin-dir", p.path);
      }
    }

    // Extra args (from sandbox config, etc.)
    for (const [key, value] of Object.entries(extraArgs)) {
      if (value === null) args.push(`--${key}`);
      else args.push(`--${key}`, value);
    }

    // ── Environment ──
    if (!env.CLAUDE_CODE_ENTRYPOINT) env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
    delete env.NODE_OPTIONS;
    if (env.DEBUG_CLAUDE_AGENT_SDK) env.DEBUG = "1";
    else delete env.DEBUG;

    // ── Determine command + args based on whether it's a native binary or .js file ──
    const isNative = !pathToClaudeCodeExecutable.match(/\.(js|mjs|tsx?|jsx)$/);
    const command = isNative ? pathToClaudeCodeExecutable : executable;
    const fullArgs = isNative
      ? [...executableArgs, ...args]
      : [...executableArgs, pathToClaudeCodeExecutable, ...args];

    const spawnOpts: SpawnOptions = {
      command,
      args: fullArgs,
      cwd: this.options.cwd,
      env: env as any,
      signal: this.abortController.signal,
    };

    // ── Spawn ──
    if (this.options.spawnClaudeCodeProcess) {
      this.process = this.options.spawnClaudeCodeProcess(spawnOpts);
    } else {
      this.process = this.spawnLocalProcess(spawnOpts);
    }

    this.processStdin = this.process.stdin;
    this.processStdout = this.process.stdout;

    // Cleanup on exit
    process.on("exit", () => this.process?.kill("SIGTERM"));
    this.abortController.signal.addEventListener("abort", () => this.process?.kill("SIGTERM"));

    this.process.on("error", (err) => {
      this.ready = false;
      this.exitError = this.abortController.signal.aborted
        ? new Error("Claude Code process aborted by user")
        : new Error(`Failed to spawn Claude Code process: ${err.message}`);
    });

    this.process.on("exit", (code, signal) => {
      this.ready = false;
      if (this.abortController.signal.aborted) {
        this.exitError = new Error("Claude Code process aborted by user");
      } else if (code !== 0 && code !== null) {
        this.exitError = new Error(`Claude Code process exited with code ${code}`);
      } else if (signal) {
        this.exitError = new Error(`Claude Code process terminated by signal ${signal}`);
      }
    });

    this.ready = true;
  }

  // ── Write: SDK → CLI (stdin) ─────────────────────────────────────────

  /** Write a single NDJSON line to CLI stdin */
  write(data: string): void {
    if (this.abortController.signal.aborted) throw new Error("Operation aborted");
    if (!this.ready || !this.processStdin) throw new Error("ProcessTransport is not ready");
    if (this.process?.killed || this.process?.exitCode !== null) throw new Error("Process terminated");
    this.processStdin.write(data);
  }

  // ── Read: CLI → SDK (stdout) ─────────────────────────────────────────

  /**
   * Async generator that reads NDJSON lines from CLI stdout.
   * Each line is JSON.parsed into a StdoutMessage.
   * Uses Node's readline for line-based reading.
   */
  async *readMessages(): AsyncGenerator<StdoutMessage, void> {
    if (!this.processStdout) throw new Error("Output stream not available");

    const rl = createInterface({ input: this.processStdout });
    try {
      for await (const line of rl) {
        if (line.trim()) {
          yield JSON.parse(line);
        }
      }
      await this.waitForExit();
    } finally {
      rl.close();
    }
  }

  /** Signal end of input (close stdin to CLI) */
  endInput(): void {
    this.processStdin?.end();
  }

  /** Close the transport, kill the process */
  close(): void {
    this.abortController.abort();
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      setTimeout(() => {
        if (this.process && !this.process.killed) this.process.kill("SIGKILL");
      }, 5000);
    }
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  private async waitForExit(): Promise<void> {
    if (!this.process || this.process.exitCode !== null || this.process.killed) {
      if (this.exitError) throw this.exitError;
      return;
    }
    return new Promise((resolve, reject) => {
      this.process!.once("exit", (code, signal) => {
        if (this.abortController.signal.aborted) reject(new Error("Operation aborted"));
        else if (code !== 0 && code !== null) reject(new Error(`Process exited with code ${code}`));
        else if (signal) reject(new Error(`Process terminated by signal ${signal}`));
        else resolve();
      });
    });
  }
}

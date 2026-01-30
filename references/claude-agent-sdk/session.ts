/**
 * Claude Agent SDK v0.2.25 — Session & ConversationInstance
 * Decompiled from sdk.mjs (class U9, lines ~8031–8126).
 *
 * ConversationInstance (unstable_v2) provides a multi-turn session API:
 *   const session = createSession(options);
 *   await session.send("Hello");
 *   for await (const msg of session.stream()) { ... }
 *   await session.send("Follow-up");
 *   for await (const msg of session.stream()) { ... }
 *   session.close();
 *
 * Internally it creates a ProcessTransport + Query and feeds user messages
 * through an AsyncQueue (inputStream) that the Query reads from.
 */

import { join } from "path";
import { fileURLToPath } from "url";

// Uses the same types/classes from query.ts and process-transport.ts

// ── ConversationInstance (v2 multi-turn session) ──────────────────────

export class ConversationInstance {
  private closed = false;
  private inputStream: AsyncQueue<SDKUserMessage>;
  private query: Query;
  private queryIterator: AsyncIterator<SDKMessage> | null = null;
  private abortController: AbortController;
  private _sessionId: string | null = null;

  get sessionId(): string {
    if (this._sessionId === null) throw new Error("Session ID not available until after receiving messages");
    return this._sessionId;
  }

  constructor(options: SessionOptions) {
    if (options.resume) this._sessionId = options.resume;
    this.inputStream = new AsyncQueue();

    // Resolve CLI path — defaults to cli.js in same directory as sdk.mjs
    let cliPath = options.pathToClaudeCodeExecutable;
    if (!cliPath) {
      const sdkDir = join(fileURLToPath(import.meta.url), "..");
      cliPath = join(sdkDir, "cli.js");
    }

    const env = { ...(options.env ?? process.env) };
    if (!env.CLAUDE_CODE_ENTRYPOINT) env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";

    this.abortController = new AbortController();

    // Create ProcessTransport (spawns CLI process)
    const transport = new ProcessTransport({
      abortController: this.abortController,
      pathToClaudeCodeExecutable: cliPath,
      env,
      executable: options.executable ?? "node",
      executableArgs: options.executableArgs ?? [],
      extraArgs: {},
      model: options.model,
      permissionMode: options.permissionMode ?? "default",
      resume: options.resume,
      allowedTools: options.allowedTools ?? [],
      disallowedTools: options.disallowedTools ?? [],
    });

    // Create Query (message router + async generator)
    this.query = new Query(
      transport,
      false, // multi-turn: isSingleUserTurn = false
      options.canUseTool,
      options.hooks,
      this.abortController,
      new Map(), // no SDK MCP servers in v2 constructor
    );

    // Feed the inputStream into the Query
    this.query.streamInput(this.inputStream);
  }

  /**
   * Send a user message to the session.
   * Can be a string or a full SDKUserMessage object.
   */
  async send(message: string | SDKUserMessage): void {
    if (this.closed) throw new Error("Cannot send to closed session");
    const userMessage: SDKUserMessage =
      typeof message === "string"
        ? {
            type: "user",
            session_id: "",
            message: { role: "user", content: [{ type: "text", text: message }] },
            parent_tool_use_id: null,
          }
        : message;
    this.inputStream.enqueue(userMessage);
  }

  /**
   * Stream messages from the current turn.
   * Yields SDKMessages until a "result" message is received (end of turn).
   */
  async *stream(): AsyncGenerator<SDKMessage, void> {
    if (!this.queryIterator) {
      this.queryIterator = this.query[Symbol.asyncIterator]();
    }
    while (true) {
      const { value, done } = await this.queryIterator.next();
      if (done) return;
      // Capture session ID from init message
      if (value.type === "system" && value.subtype === "init") {
        this._sessionId = value.session_id;
      }
      yield value;
      // End of turn
      if (value.type === "result") return;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inputStream.done();
    this.abortController.abort();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }
}

// ── Factory functions (exported API) ─────────────────────────────────

/** Create a new multi-turn session */
export function createSession(options: SessionOptions): ConversationInstance {
  return new ConversationInstance(options);
}

/** Resume an existing session by ID */
export function resumeSession(sessionId: string, options?: SessionOptions): ConversationInstance {
  return new ConversationInstance({ ...options, resume: sessionId });
}

/** Simple one-shot prompt (v2 API) */
export async function prompt(message: string, options?: SessionOptions): Promise<SDKResultMessage> {
  await using session = createSession(options!);
  await session.send(message);
  for await (const msg of session.stream()) {
    if (msg.type === "result") return msg as SDKResultMessage;
  }
  throw new Error("Session ended without result message");
}

// Placeholder types (see sdk.d.ts for full definitions)
type SDKUserMessage = any;
type SDKMessage = any;
type SDKResultMessage = any;
type SessionOptions = any;
type AsyncQueue<T> = any;
type Query = any;
type ProcessTransport = any;

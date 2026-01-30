/**
 * Claude Agent SDK v0.2.25 — Query (AsyncGenerator message stream)
 * Decompiled from sdk.mjs (class $X, lines ~7598–8028).
 *
 * Query is the core class that:
 *   1. Reads NDJSON messages from ProcessTransport
 *   2. Routes control messages (requests/responses) bidirectionally
 *   3. Yields SDK messages (assistant, user, result, stream_event, etc.) to the consumer
 *   4. Handles hooks, MCP servers, and permission callbacks
 *
 * Implements AsyncGenerator<SDKMessage, void> — the consumer calls .next() to get messages.
 */

import { randomUUID } from "crypto";

// ── Types ────────────────────────────────────────────────────────────────

/** Message types emitted by CLI on stdout */
type StdoutMessage =
  | SDKContentMessage
  | { type: "control_response"; response: ControlResponse }
  | { type: "control_request"; request_id: string; request: ControlRequest }
  | { type: "control_cancel_request"; request_id: string }
  | { type: "keep_alive" };

/** SDK messages yielded to consumer */
type SDKContentMessage =
  | { type: "assistant"; message: any; parent_tool_use_id: string | null }
  | { type: "user"; message: any; parent_tool_use_id: string | null }
  | { type: "result"; subtype: "success" | "error_during_execution" | string }
  | { type: "stream_event"; event: any; parent_tool_use_id: string | null }
  | { type: "system"; subtype: string; [key: string]: any }
  | { type: "tool_progress"; tool_use_id: string; tool_name: string; parent_tool_use_id: string | null }
  | { type: "tool_use_summary"; summary: string; preceding_tool_use_ids: string[] }
  | { type: "auth_status" };

type SDKMessage = SDKContentMessage;

interface ControlRequest {
  subtype: "can_use_tool" | "hook_callback" | "mcp_message" | string;
  [key: string]: any;
}

interface ControlResponse {
  subtype: "success" | "error";
  request_id: string;
  response?: any;
  error?: string;
  pending_permission_requests?: any[];
}

interface Transport {
  write(data: string): void | Promise<void>;
  close(): void;
  isReady(): boolean;
  readMessages(): AsyncGenerator<StdoutMessage, void>;
  endInput(): void;
}

// ── AsyncQueue ───────────────────────────────────────────────────────────

/**
 * A simple async queue that implements AsyncIterableIterator.
 * Messages can be enqueued, and consumers pull them via next().
 * Supports done() to signal completion and error() to propagate errors.
 *
 * This is the internal buffer between readMessages() (producer) and
 * the consumer calling query.next() (via readSdkMessages).
 */
class AsyncQueue<T> {
  private queue: T[] = [];
  private readResolve?: (result: IteratorResult<T>) => void;
  private readReject?: (error: any) => void;
  private isDone = false;
  private hasError?: any;
  private started = false;

  constructor(private returned?: () => void) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    if (this.started) throw new Error("Stream can only be iterated once");
    this.started = true;
    return this as any;
  }

  next(): Promise<IteratorResult<T>> {
    // If items are buffered, return immediately
    if (this.queue.length > 0) {
      return Promise.resolve({ done: false, value: this.queue.shift()! });
    }
    // If stream is done, signal completion
    if (this.isDone) return Promise.resolve({ done: true, value: undefined as any });
    // If there was an error, reject
    if (this.hasError) return Promise.reject(this.hasError);
    // Otherwise, wait for next enqueue/done/error
    return new Promise((resolve, reject) => {
      this.readResolve = resolve;
      this.readReject = reject;
    });
  }

  /** Push a message — wakes up any waiting consumer */
  enqueue(value: T): void {
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      this.readReject = undefined;
      resolve({ done: false, value });
    } else {
      this.queue.push(value);
    }
  }

  /** Signal stream completion */
  done(): void {
    this.isDone = true;
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      this.readReject = undefined;
      resolve({ done: true, value: undefined as any });
    }
  }

  /** Signal error */
  error(err: any): void {
    this.hasError = err;
    if (this.readReject) {
      const reject = this.readReject;
      this.readResolve = undefined;
      this.readReject = undefined;
      reject(err);
    }
  }

  return(): Promise<IteratorResult<T>> {
    this.isDone = true;
    this.returned?.();
    return Promise.resolve({ done: true, value: undefined as any });
  }
}

// ── Query ────────────────────────────────────────────────────────────────

/**
 * The main Query class — implements AsyncGenerator<SDKMessage>.
 *
 * Lifecycle:
 *   1. Constructor starts readMessages() loop and sends initialize control_request
 *   2. readMessages() reads from transport, routes control messages, enqueues content to inputStream
 *   3. readSdkMessages() yields from inputStream to consumer
 *   4. Consumer calls query.next() → gets SDKMessages
 *
 * Data flow:
 *   Transport.readMessages()  →  readMessages() loop  →  inputStream (AsyncQueue)  →  readSdkMessages()  →  consumer
 *                                     ↕
 *                              control_request/response (bidirectional via transport.write())
 */
export class Query implements AsyncGenerator<SDKMessage, void> {
  private transport: Transport;
  private isSingleUserTurn: boolean;
  private canUseTool?: Function;
  private hooks?: Record<string, any>;
  private abortController: AbortController;
  private jsonSchema?: object;

  // Control request/response correlation
  private pendingControlResponses = new Map<string, (response: ControlResponse) => void>();
  private cancelControllers = new Map<string, AbortController>();

  // Hook callbacks registered by SDK consumer
  private hookCallbacks = new Map<string, Function>();
  private nextCallbackId = 0;

  // MCP server integration
  private sdkMcpTransports = new Map<string, any>();
  private sdkMcpServerInstances = new Map<string, any>();
  private pendingMcpResponses = new Map<string, { resolve: Function; reject: Function }>();

  // Internal message stream
  private inputStream = new AsyncQueue<SDKMessage>();
  private sdkMessages: AsyncGenerator<SDKMessage, void>;
  private initialization: Promise<any>;

  // Single-turn query lifecycle
  private firstResultReceived = false;
  private firstResultReceivedResolve?: () => void;
  private cleanupPerformed = false;

  constructor(
    transport: Transport,
    isSingleUserTurn: boolean,
    canUseTool: Function | undefined,
    hooks: Record<string, any> | undefined,
    abortController: AbortController,
    sdkMcpServers: Map<string, any>,
    jsonSchema?: object,
    initConfig?: { systemPrompt?: string; appendSystemPrompt?: string; agents?: any },
  ) {
    this.transport = transport;
    this.isSingleUserTurn = isSingleUserTurn;
    this.canUseTool = canUseTool;
    this.hooks = hooks;
    this.abortController = abortController;
    this.jsonSchema = jsonSchema;

    // Connect SDK MCP servers
    for (const [name, instance] of sdkMcpServers) {
      this.connectSdkMcpServer(name, instance);
    }

    // Start reading messages from transport
    this.sdkMessages = this.readSdkMessages();
    this.readMessages(); // fire-and-forget background loop
    this.initialization = this.initialize();
  }

  // ── AsyncGenerator interface ───────────────────────────────────────

  next(...args: [] | [undefined]): Promise<IteratorResult<SDKMessage, void>> {
    return this.sdkMessages.next(...args);
  }

  return(value: void): Promise<IteratorResult<SDKMessage, void>> {
    return this.sdkMessages.return(value);
  }

  throw(e: any): Promise<IteratorResult<SDKMessage, void>> {
    return this.sdkMessages.throw(e);
  }

  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    return this.sdkMessages;
  }

  // ── Message Reading Loop ───────────────────────────────────────────

  /**
   * Background loop that reads from transport and routes messages:
   *
   * - control_response  → resolves pending request promise
   * - control_request   → handles (canUseTool, hook callback, MCP message) and responds
   * - control_cancel    → aborts in-progress control request handler
   * - keep_alive        → ignored
   * - result            → for single-turn queries, triggers stdin close
   * - all other types   → enqueued to inputStream for consumer
   */
  private async readMessages(): Promise<void> {
    try {
      for await (const message of this.transport.readMessages()) {
        // Route control messages (not yielded to consumer)
        if (message.type === "control_response") {
          const handler = this.pendingControlResponses.get(message.response.request_id);
          if (handler) handler(message.response);
          continue;
        } else if (message.type === "control_request") {
          this.handleControlRequest(message as any);
          continue;
        } else if (message.type === "control_cancel_request") {
          const controller = this.cancelControllers.get(message.request_id);
          if (controller) controller.abort();
          continue;
        } else if (message.type === "keep_alive") {
          continue;
        }

        // For single-turn queries: close stdin after first result
        if (message.type === "result") {
          this.firstResultReceived = true;
          this.firstResultReceivedResolve?.();
          if (this.isSingleUserTurn) {
            this.transport.endInput();
          }
        }

        // Enqueue content message for consumer
        this.inputStream.enqueue(message as SDKMessage);
      }

      this.inputStream.done();
      this.cleanup();
    } catch (err) {
      this.inputStream.error(err);
      this.cleanup(err);
    }
  }

  /** Yields messages from inputStream to the consumer */
  private async *readSdkMessages(): AsyncGenerator<SDKMessage, void> {
    for await (const message of this.inputStream) {
      yield message;
    }
  }

  // ── Control Request/Response Protocol ──────────────────────────────

  /**
   * Send a control request to CLI and await the response.
   *
   * Protocol:
   *   SDK → CLI:  { type: "control_request", request_id: "<uuid>", request: { subtype: "...", ... } }
   *   CLI → SDK:  { type: "control_response", response: { request_id: "<uuid>", subtype: "success"|"error", ... } }
   */
  private request(requestBody: any): Promise<ControlResponse> {
    const requestId = randomUUID();
    const message = {
      type: "control_request" as const,
      request_id: requestId,
      request: requestBody,
    };

    return new Promise((resolve, reject) => {
      this.pendingControlResponses.set(requestId, (response) => {
        if (response.subtype === "success") resolve(response);
        else reject(new Error(response.error));
      });
      this.transport.write(JSON.stringify(message) + "\n");
    });
  }

  /**
   * Handle incoming control requests from CLI.
   *
   * Three types:
   * 1. can_use_tool  — permission check, calls SDK consumer's canUseTool callback
   * 2. hook_callback — hook execution, calls registered hook function
   * 3. mcp_message   — MCP server message routing
   */
  private async handleControlRequest(request: { request_id: string; request: ControlRequest }): Promise<void> {
    const controller = new AbortController();
    this.cancelControllers.set(request.request_id, controller);

    try {
      const result = await this.processControlRequest(request, controller.signal);
      await this.transport.write(JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: request.request_id, response: result },
      }) + "\n");
    } catch (err: any) {
      await this.transport.write(JSON.stringify({
        type: "control_response",
        response: { subtype: "error", request_id: request.request_id, error: err.message || String(err) },
      }) + "\n");
    } finally {
      this.cancelControllers.delete(request.request_id);
    }
  }

  private async processControlRequest(request: any, signal: AbortSignal): Promise<any> {
    if (request.request.subtype === "can_use_tool") {
      if (!this.canUseTool) throw new Error("canUseTool callback is not provided.");
      return {
        ...(await this.canUseTool(request.request.tool_name, request.request.input, {
          signal,
          suggestions: request.request.permission_suggestions,
          blockedPath: request.request.blocked_path,
          decisionReason: request.request.decision_reason,
          toolUseID: request.request.tool_use_id,
          agentID: request.request.agent_id,
        })),
        toolUseID: request.request.tool_use_id,
      };
    } else if (request.request.subtype === "hook_callback") {
      const hookFn = this.hookCallbacks.get(request.request.callback_id);
      if (!hookFn) throw new Error(`No hook callback found for ID: ${request.request.callback_id}`);
      return hookFn(request.request.input, request.request.tool_use_id, { signal });
    } else if (request.request.subtype === "mcp_message") {
      // Route MCP messages to SDK MCP server instances
      const transport = this.sdkMcpTransports.get(request.request.server_name);
      if (!transport) throw new Error(`SDK MCP server not found: ${request.request.server_name}`);
      if ("method" in request.request.message && "id" in request.request.message) {
        return { mcp_response: await this.handleMcpRequest(request.request.server_name, request.request, transport) };
      } else {
        transport.onmessage?.(request.request.message);
        return { mcp_response: { jsonrpc: "2.0", result: {}, id: 0 } };
      }
    }
    throw new Error("Unsupported control request subtype: " + request.request.subtype);
  }

  // ── Initialize ─────────────────────────────────────────────────────

  /**
   * First control_request sent after spawn — configures the CLI session.
   * Sends: hooks config, SDK MCP server names, jsonSchema, systemPrompt, agents.
   * Receives: supported commands, models, account info.
   */
  private async initialize(): Promise<any> {
    let hooksConfig: any;
    if (this.hooks) {
      hooksConfig = {};
      for (const [event, handlers] of Object.entries(this.hooks)) {
        if ((handlers as any[]).length > 0) {
          hooksConfig[event] = (handlers as any[]).map((handler: any) => {
            const callbackIds: string[] = [];
            for (const hook of handler.hooks) {
              const id = `hook_${this.nextCallbackId++}`;
              this.hookCallbacks.set(id, hook);
              callbackIds.push(id);
            }
            return { matcher: handler.matcher, hookCallbackIds: callbackIds, timeout: handler.timeout };
          });
        }
      }
    }

    const request = {
      subtype: "initialize",
      hooks: hooksConfig,
      sdkMcpServers: this.sdkMcpTransports.size > 0 ? Array.from(this.sdkMcpTransports.keys()) : undefined,
      jsonSchema: this.jsonSchema,
      // initConfig fields
    };

    return (await this.request(request)).response;
  }

  // ── Public API methods (sent as control_requests) ──────────────────

  async interrupt(): Promise<void> {
    await this.request({ subtype: "interrupt" });
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.request({ subtype: "set_permission_mode", mode });
  }

  async setModel(model?: string): Promise<void> {
    await this.request({ subtype: "set_model", model });
  }

  async setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void> {
    await this.request({ subtype: "set_max_thinking_tokens", max_thinking_tokens: maxThinkingTokens });
  }

  async supportedCommands(): Promise<any[]> {
    return (await this.initialization).commands;
  }

  async supportedModels(): Promise<any[]> {
    return (await this.initialization).models;
  }

  async mcpServerStatus(): Promise<any[]> {
    return (await this.request({ subtype: "mcp_status" })).response!.mcpServers;
  }

  async accountInfo(): Promise<any> {
    return (await this.initialization).account;
  }

  /**
   * Feed user messages into the query (for multi-turn mode).
   * Writes each message as NDJSON to CLI stdin.
   * For bidirectional queries (hooks, MCP, canUseTool), waits for first result
   * before closing stdin to keep the bidirectional channel open.
   */
  async streamInput(stream: AsyncIterable<any>): Promise<void> {
    let count = 0;
    for await (const message of stream) {
      count++;
      if (this.abortController.signal.aborted) break;
      await this.transport.write(JSON.stringify(message) + "\n");
    }

    // For bidirectional needs, wait for first result before closing stdin
    if (count > 0 && this.hasBidirectionalNeeds()) {
      await this.waitForFirstResult();
    }
    this.transport.endInput();
  }

  private hasBidirectionalNeeds(): boolean {
    return (
      this.sdkMcpTransports.size > 0 ||
      (this.hooks !== undefined && Object.keys(this.hooks).length > 0) ||
      this.canUseTool !== undefined
    );
  }

  private waitForFirstResult(): Promise<void> {
    if (this.firstResultReceived) return Promise.resolve();
    return new Promise((resolve) => {
      this.abortController.signal.addEventListener("abort", () => resolve(), { once: true });
      this.firstResultReceivedResolve = resolve;
    });
  }

  close(): void {
    this.cleanup();
  }

  private cleanup(error?: any): void {
    if (this.cleanupPerformed) return;
    this.cleanupPerformed = true;
    this.transport.close();
    this.pendingControlResponses.clear();
    this.cancelControllers.clear();
    this.hookCallbacks.clear();
    for (const t of this.sdkMcpTransports.values()) t.close?.();
    this.sdkMcpTransports.clear();
    if (error) this.inputStream.error(error);
    else this.inputStream.done();
  }

  // ── MCP helpers ────────────────────────────────────────────────────

  private connectSdkMcpServer(name: string, instance: any): void {
    const transport = new McpTransport((msg: any) => this.sendMcpMessageToCli(name, msg));
    this.sdkMcpTransports.set(name, transport);
    this.sdkMcpServerInstances.set(name, instance);
    instance.connect(transport);
  }

  private sendMcpMessageToCli(serverName: string, message: any): void {
    const request = {
      type: "control_request" as const,
      request_id: randomUUID(),
      request: { subtype: "mcp_message", server_name: serverName, message },
    };
    this.transport.write(JSON.stringify(request) + "\n");
  }

  private handleMcpRequest(serverName: string, request: any, transport: any): Promise<any> {
    const id = request.message.id;
    const key = `${serverName}:${id}`;
    return new Promise((resolve, reject) => {
      this.pendingMcpResponses.set(key, { resolve, reject });
      transport.onmessage?.(request.message);
    });
  }
}

/** Minimal MCP transport wrapper for SDK MCP servers */
class McpTransport {
  isClosed = false;
  onclose?: () => void;
  onerror?: (err: Error) => void;
  onmessage?: (msg: any) => void;

  constructor(private sendMcpMessage: (msg: any) => void) {}

  async start(): Promise<void> {}

  async send(message: any): Promise<void> {
    if (this.isClosed) throw new Error("Transport is closed");
    this.sendMcpMessage(message);
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.onclose?.();
  }
}

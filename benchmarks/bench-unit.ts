/**
 * ACP Server Performance Benchmark Suite
 *
 * Profiles every critical ACP method and notification handler.
 * Measures: p50/p95/p99 latency, throughput (ops/s), memory usage, event loop block time.
 *
 * Run: npx tsx benchmarks/bench.ts
 * Saves baseline to: benchmarks/baseline.json
 */

import { performance, PerformanceObserver } from "node:perf_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── Helpers ────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(__dirname, "baseline.json");

interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  count: number;
  opsPerSec: number;
}

interface BenchmarkResult {
  name: string;
  latency: LatencyStats;
  memoryDeltaMB: number;
}

interface BaselineReport {
  timestamp: string;
  nodeVersion: string;
  results: BenchmarkResult[];
  eventLoopMetrics: {
    maxBlockTimeMs: number;
    avgBlockTimeMs: number;
    totalBlocks: number;
  };
  heapUsedMB: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, idx)];
}

function computeStats(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const totalTimeS = sum / 1000;
  return {
    p50: +percentile(sorted, 0.5).toFixed(3),
    p95: +percentile(sorted, 0.95).toFixed(3),
    p99: +percentile(sorted, 0.99).toFixed(3),
    min: +sorted[0].toFixed(3),
    max: +sorted[sorted.length - 1].toFixed(3),
    mean: +mean.toFixed(3),
    count: sorted.length,
    opsPerSec: totalTimeS > 0 ? Math.round(sorted.length / totalTimeS) : 0,
  };
}

// ── Event loop block time tracking ─────────────────────────────────────

let eventLoopBlockTimes: number[] = [];
let elTimerRef: ReturnType<typeof setInterval> | null = null;
let lastCheck = performance.now();

function startEventLoopMonitor(intervalMs = 5) {
  eventLoopBlockTimes = [];
  lastCheck = performance.now();
  elTimerRef = setInterval(() => {
    const now = performance.now();
    const elapsed = now - lastCheck;
    // Anything significantly over the interval is a block
    const blockTime = elapsed - intervalMs;
    if (blockTime > 1) {
      eventLoopBlockTimes.push(blockTime);
    }
    lastCheck = now;
  }, intervalMs);
  // Unref so it doesn't keep the process alive
  if (elTimerRef && typeof elTimerRef.unref === "function") {
    elTimerRef.unref();
  }
}

function stopEventLoopMonitor() {
  if (elTimerRef) {
    clearInterval(elTimerRef);
    elTimerRef = null;
  }
  const sorted = [...eventLoopBlockTimes].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    maxBlockTimeMs: sorted.length > 0 ? +sorted[sorted.length - 1].toFixed(2) : 0,
    avgBlockTimeMs: sorted.length > 0 ? +(sum / sorted.length).toFixed(2) : 0,
    totalBlocks: sorted.length,
  };
}

// ── Mock factories ─────────────────────────────────────────────────────

function createMockClient() {
  let updateCount = 0;
  return {
    sessionUpdate: async (_notification: any) => {
      updateCount++;
    },
    readTextFile: async () => ({ content: "mock content" }),
    writeTextFile: async () => ({}),
    getUpdateCount: () => updateCount,
    resetUpdateCount: () => { updateCount = 0; },
  };
}

function createMockQuery() {
  let messageIndex = 0;
  const messages: any[] = [];

  return {
    addMessages: (msgs: any[]) => { messages.push(...msgs); },
    next: async () => {
      if (messageIndex >= messages.length) {
        return { value: undefined, done: true };
      }
      return { value: messages[messageIndex++], done: false };
    },
    reset: () => { messageIndex = 0; },
    interrupt: async () => {},
    close: () => {},
    setModel: async () => {},
    setPermissionMode: async () => {},
    supportedModels: async () => [
      { value: "sonnet", displayName: "Sonnet", description: "Fast" },
    ],
    supportedCommands: async () => [],
    [Symbol.asyncIterator]() { return this; },
  };
}

// ── Synthetic message generators ───────────────────────────────────────

function makeStreamEvent(contentType: "text" | "thinking" | "tool_use", index = 0): any {
  if (contentType === "text") {
    return {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: "Hello world, this is a streaming delta chunk. " },
      },
      parent_tool_use_id: null,
    };
  }
  if (contentType === "thinking") {
    return {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: "Let me think about this carefully. " },
      },
      parent_tool_use_id: null,
    };
  }
  // tool_use start
  return {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: `toolu_bench_${Date.now()}_${index}`,
        name: "Read",
        input: {},
      },
    },
    parent_tool_use_id: null,
  };
}

function makeAssistantMessage(numContentBlocks = 3): any {
  const content: any[] = [];
  for (let i = 0; i < numContentBlocks; i++) {
    content.push({
      type: "text",
      text: `This is content block ${i} with some meaningful text. `.repeat(3),
    });
  }
  return {
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-20250514",
      content,
    },
    parent_tool_use_id: null,
  };
}

function makeToolUseAssistantMessage(toolId: string, toolName = "Bash"): any {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-20250514",
      content: [
        {
          type: "tool_use",
          id: toolId,
          name: toolName,
          input: { command: "ls -la", description: "List files" },
        },
      ],
    },
    parent_tool_use_id: null,
  };
}

function makeToolResult(toolUseId: string): any {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: [
            { type: "text", text: "total 42\ndrwxr-xr-x  8 user  staff  256 Jan  1 00:00 .\ndrwxr-xr-x  5 user  staff  160 Jan  1 00:00 .." },
          ],
          is_error: false,
        },
      ],
    },
  };
}

function makeResultMessage(): any {
  return {
    type: "result",
    subtype: "success",
    result: "Done!",
    is_error: false,
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: 1,
    total_cost_usd: 0.001,
    usage: { input_tokens: 100, output_tokens: 50 },
    modelUsage: {},
    session_id: "bench-session",
    uuid: "bench-uuid",
    permission_denials: [],
  };
}

function makeSystemInit(): any {
  return {
    type: "system",
    subtype: "init",
    session_id: "bench-session",
    tools: [],
    mcp_servers: {},
  };
}

// ── Import ACP modules for benchmarking ────────────────────────────────

async function runBenchmarks() {
  console.log("Loading ACP modules...");

  // Dynamic imports to handle ESM resolution
  const { toAcpNotifications, streamEventToAcpNotifications, promptToClaude } = await import(
    "../src/acp/notifications.js"
  );
  const { toolInfoFromToolUse, toolUpdateFromToolResult } = await import(
    "../src/acp/tool-conversion.js"
  );
  const { NotificationQueue } = await import("../src/acp/notification-queue.js");
  const { SessionMessageRouter } = await import("../src/sdk/message-router.js");
  const { extractBackgroundTaskInfo } = await import("../src/acp/background-tasks.js");

  console.log("Modules loaded. Starting benchmarks...\n");

  startEventLoopMonitor();

  const results: BenchmarkResult[] = [];
  const WARMUP = 50;
  const ITERATIONS = 2000;

  // ── Benchmark: streamEventToAcpNotifications (text delta) ──────────

  {
    const name = "streamEvent.text_delta";
    const mockClient = createMockClient();
    const toolUseCache: Record<string, any> = {};
    const bgMap: Record<string, string> = {};
    const msg = makeStreamEvent("text");

    // Warmup
    for (let i = 0; i < WARMUP; i++) {
      streamEventToAcpNotifications(msg, "s1", toolUseCache, mockClient as any, console, bgMap);
    }

    const heapBefore = process.memoryUsage().heapUsed;
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      streamEventToAcpNotifications(msg, "s1", toolUseCache, mockClient as any, console, bgMap);
      samples.push(performance.now() - t0);
    }
    const heapAfter = process.memoryUsage().heapUsed;

    results.push({
      name,
      latency: computeStats(samples),
      memoryDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(3),
    });
  }

  // ── Benchmark: streamEventToAcpNotifications (thinking delta) ──────

  {
    const name = "streamEvent.thinking_delta";
    const mockClient = createMockClient();
    const toolUseCache: Record<string, any> = {};
    const bgMap: Record<string, string> = {};
    const msg = makeStreamEvent("thinking");

    for (let i = 0; i < WARMUP; i++) {
      streamEventToAcpNotifications(msg, "s1", toolUseCache, mockClient as any, console, bgMap);
    }

    const heapBefore = process.memoryUsage().heapUsed;
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      streamEventToAcpNotifications(msg, "s1", toolUseCache, mockClient as any, console, bgMap);
      samples.push(performance.now() - t0);
    }
    const heapAfter = process.memoryUsage().heapUsed;

    results.push({
      name,
      latency: computeStats(samples),
      memoryDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(3),
    });
  }

  // ── Benchmark: streamEventToAcpNotifications (tool_use start) ──────

  {
    const name = "streamEvent.tool_use_start";
    const mockClient = createMockClient();
    const toolUseCache: Record<string, any> = {};
    const bgMap: Record<string, string> = {};

    for (let i = 0; i < WARMUP; i++) {
      const msg = makeStreamEvent("tool_use", i);
      streamEventToAcpNotifications(msg, "s1", toolUseCache, mockClient as any, console, bgMap);
    }

    const heapBefore = process.memoryUsage().heapUsed;
    const samples: number[] = [];
    // Each tool_use_start creates unique IDs, reset cache periodically
    for (let i = 0; i < ITERATIONS; i++) {
      if (i % 100 === 0) {
        for (const key of Object.keys(toolUseCache)) delete toolUseCache[key];
      }
      const msg = makeStreamEvent("tool_use", i);
      const t0 = performance.now();
      streamEventToAcpNotifications(msg, "s1", toolUseCache, mockClient as any, console, bgMap);
      samples.push(performance.now() - t0);
    }
    const heapAfter = process.memoryUsage().heapUsed;

    results.push({
      name,
      latency: computeStats(samples),
      memoryDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(3),
    });
  }

  // ── Benchmark: toAcpNotifications (assistant message) ──────────────

  {
    const name = "toAcpNotifications.assistant_message";
    const mockClient = createMockClient();
    const toolUseCache: Record<string, any> = {};
    const msg = makeAssistantMessage(5);

    for (let i = 0; i < WARMUP; i++) {
      toAcpNotifications(
        msg.message.content,
        "assistant",
        "s1",
        toolUseCache,
        mockClient as any,
        console,
      );
    }

    const heapBefore = process.memoryUsage().heapUsed;
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      toAcpNotifications(
        msg.message.content,
        "assistant",
        "s1",
        toolUseCache,
        mockClient as any,
        console,
      );
      samples.push(performance.now() - t0);
    }
    const heapAfter = process.memoryUsage().heapUsed;

    results.push({
      name,
      latency: computeStats(samples),
      memoryDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(3),
    });
  }

  // ── Benchmark: toAcpNotifications (tool_result) ────────────────────

  {
    const name = "toAcpNotifications.tool_result";
    const mockClient = createMockClient();
    const toolUseCache: Record<string, any> = {};
    const bgMap: Record<string, string> = {};

    // Pre-populate cache with tool uses
    for (let i = 0; i < WARMUP; i++) {
      const id = `toolu_result_${i}`;
      toolUseCache[id] = {
        type: "tool_use",
        id,
        name: "Bash",
        input: { command: "ls", description: "list" },
      };
    }

    const samples: number[] = [];
    const heapBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < ITERATIONS; i++) {
      const id = `toolu_result_${i % WARMUP}`;
      // Re-add to cache since tool_result evicts
      toolUseCache[id] = {
        type: "tool_use",
        id,
        name: "Bash",
        input: { command: "ls", description: "list" },
      };
      const result = makeToolResult(id);
      const t0 = performance.now();
      toAcpNotifications(
        result.message.content,
        "user",
        "s1",
        toolUseCache,
        mockClient as any,
        console,
        bgMap,
      );
      samples.push(performance.now() - t0);
    }
    const heapAfter = process.memoryUsage().heapUsed;

    results.push({
      name,
      latency: computeStats(samples),
      memoryDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(3),
    });
  }

  // ── Benchmark: toolInfoFromToolUse ─────────────────────────────────

  {
    const name = "toolInfoFromToolUse";
    const toolTypes = [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la", description: "list" } },
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/test.ts" } },
      { type: "tool_use", id: "t3", name: "Write", input: { file_path: "/test.ts", content: "hello" } },
      { type: "tool_use", id: "t4", name: "Edit", input: { file_path: "/test.ts", old_string: "a", new_string: "b" } },
      { type: "tool_use", id: "t5", name: "Glob", input: { pattern: "**/*.ts" } },
      { type: "tool_use", id: "t6", name: "Grep", input: { pattern: "TODO" } },
      { type: "tool_use", id: "t7", name: "Task", input: { description: "do work", prompt: "work", subagent_type: "general" } },
      { type: "tool_use", id: "t8", name: "WebSearch", input: { query: "test" } },
    ];

    for (let i = 0; i < WARMUP; i++) {
      toolInfoFromToolUse(toolTypes[i % toolTypes.length]);
    }

    const heapBefore = process.memoryUsage().heapUsed;
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      toolInfoFromToolUse(toolTypes[i % toolTypes.length]);
      samples.push(performance.now() - t0);
    }
    const heapAfter = process.memoryUsage().heapUsed;

    results.push({
      name,
      latency: computeStats(samples),
      memoryDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(3),
    });
  }

  // ── Benchmark: toolUpdateFromToolResult ────────────────────────────

  {
    const name = "toolUpdateFromToolResult";
    const toolUse = {
      type: "tool_use",
      id: "t1",
      name: "Bash",
      input: { command: "ls -la", description: "list" },
    };
    const toolResult = {
      content: [
        { type: "text" as const, text: "total 42\ndrwxr-xr-x  8 user  staff  256 Jan  1 00:00 ." },
      ],
      tool_use_id: "t1",
      is_error: false,
      type: "tool_result" as const,
    };

    for (let i = 0; i < WARMUP; i++) {
      toolUpdateFromToolResult(toolResult, toolUse);
    }

    const heapBefore = process.memoryUsage().heapUsed;
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      toolUpdateFromToolResult(toolResult, toolUse);
      samples.push(performance.now() - t0);
    }
    const heapAfter = process.memoryUsage().heapUsed;

    results.push({
      name,
      latency: computeStats(samples),
      memoryDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(3),
    });
  }

  // ── Benchmark: promptToClaude ──────────────────────────────────────

  {
    const name = "promptToClaude";
    const prompt = {
      sessionId: "bench-session",
      prompt: [
        { type: "text" as const, text: "Hello, please help me with this task." },
        { type: "text" as const, text: "/mcp:server:command args" },
        {
          type: "resource" as const,
          resource: {
            uri: "file:///test/file.ts",
            text: "const x = 42;\nconsole.log(x);\n".repeat(20),
          },
        },
        {
          type: "image" as const,
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
          mimeType: "image/png",
        },
      ],
    };

    for (let i = 0; i < WARMUP; i++) {
      promptToClaude(prompt);
    }

    const heapBefore = process.memoryUsage().heapUsed;
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      promptToClaude(prompt);
      samples.push(performance.now() - t0);
    }
    const heapAfter = process.memoryUsage().heapUsed;

    results.push({
      name,
      latency: computeStats(samples),
      memoryDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(3),
    });
  }

  // ── Benchmark: NotificationQueue enqueue throughput ─────────────────

  {
    const name = "NotificationQueue.enqueue";
    const mockClient = createMockClient();
    const queue = new NotificationQueue(mockClient as any, console);
    const notification = {
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk" as const,
        content: { type: "text" as const, text: "Hello" },
      },
    };

    // Warmup
    for (let i = 0; i < WARMUP; i++) {
      queue.enqueue(notification);
    }
    await queue.flush();
    mockClient.resetUpdateCount();

    const heapBefore = process.memoryUsage().heapUsed;
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      queue.enqueue(notification);
      samples.push(performance.now() - t0);
      // Periodic flush to avoid unbounded growth
      if (i % 200 === 0) await queue.flush();
    }
    await queue.flush();
    const heapAfter = process.memoryUsage().heapUsed;

    results.push({
      name,
      latency: computeStats(samples),
      memoryDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(3),
    });
  }

  // ── Benchmark: NotificationQueue.send (awaited) ────────────────────

  {
    const name = "NotificationQueue.send";
    const mockClient = createMockClient();
    const queue = new NotificationQueue(mockClient as any, console);
    const notification = {
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk" as const,
        content: { type: "text" as const, text: "Hello" },
      },
    };

    for (let i = 0; i < WARMUP; i++) {
      await queue.send(notification);
    }

    const heapBefore = process.memoryUsage().heapUsed;
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      await queue.send(notification);
      samples.push(performance.now() - t0);
    }
    const heapAfter = process.memoryUsage().heapUsed;

    results.push({
      name,
      latency: computeStats(samples),
      memoryDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(3),
    });
  }

  // ── Benchmark: SessionMessageRouter.next() ─────────────────────────

  {
    const name = "SessionMessageRouter.next";
    const N = 500; // Reduced iterations since router involves async

    // Create a mock that feeds messages
    const messages: any[] = [];
    for (let i = 0; i < N + WARMUP + 10; i++) {
      messages.push(makeStreamEvent("text", i));
    }
    messages.push(makeResultMessage());

    const mockQuery = createMockQuery();
    mockQuery.addMessages(messages);

    const router = new SessionMessageRouter(
      mockQuery as any,
      async () => {},
      console,
    );

    // Warmup
    for (let i = 0; i < WARMUP; i++) {
      await router.next();
    }

    const heapBefore = process.memoryUsage().heapUsed;
    const samples: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await router.next();
      samples.push(performance.now() - t0);
    }
    const heapAfter = process.memoryUsage().heapUsed;

    results.push({
      name,
      latency: computeStats(samples),
      memoryDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(3),
    });
  }

  // ── Benchmark: SessionMessageRouter with task_notification intercept ─

  {
    const name = "SessionMessageRouter.task_notification_intercept";
    const N = 200;

    const messages: any[] = [];
    for (let i = 0; i < N; i++) {
      // Interleave regular messages with task_notifications
      messages.push(makeStreamEvent("text", i));
      messages.push({
        type: "system",
        subtype: "task_notification",
        task_id: `task_${i}`,
        status: "completed",
        output_file: `/tmp/task_${i}.txt`,
        summary: `Task ${i} completed`,
      });
    }
    // End with result
    messages.push(makeResultMessage());

    const mockQuery = createMockQuery();
    mockQuery.addMessages(messages);

    let interceptCount = 0;
    const router = new SessionMessageRouter(
      mockQuery as any,
      async () => { interceptCount++; },
      console,
    );

    const heapBefore = process.memoryUsage().heapUsed;
    const samples: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await router.next(); // Should only get the text events, task_notifications intercepted
      samples.push(performance.now() - t0);
    }
    const heapAfter = process.memoryUsage().heapUsed;

    results.push({
      name,
      latency: computeStats(samples),
      memoryDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(3),
    });
  }

  // ── Benchmark: extractBackgroundTaskInfo ────────────────────────────

  {
    const name = "extractBackgroundTaskInfo";
    const responses = [
      { task_id: "abc123", output_file: "/tmp/output.txt" },
      "task_id: xyz789\noutput_file: /tmp/result.txt",
      [{ type: "text", text: "agentId: agent_001\noutput_file: /tmp/agent.txt" }],
      JSON.stringify({ task_id: "nested_123", output_file: "/var/data.json" }),
    ];

    for (let i = 0; i < WARMUP; i++) {
      extractBackgroundTaskInfo(responses[i % responses.length]);
    }

    const heapBefore = process.memoryUsage().heapUsed;
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      extractBackgroundTaskInfo(responses[i % responses.length]);
      samples.push(performance.now() - t0);
    }
    const heapAfter = process.memoryUsage().heapUsed;

    results.push({
      name,
      latency: computeStats(samples),
      memoryDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(3),
    });
  }

  // ── Benchmark: Full message processing pipeline ────────────────────
  // Simulates a realistic prompt() turn: system init, stream events,
  // assistant message with tool use, tool result, result

  {
    const name = "full_prompt_pipeline";
    const N = 200;
    const mockClient = createMockClient();
    const toolUseCache: Record<string, any> = {};
    const bgMap: Record<string, string> = {};

    const heapBefore = process.memoryUsage().heapUsed;
    const samples: number[] = [];
    for (let iter = 0; iter < N; iter++) {
      // Clear caches
      for (const key of Object.keys(toolUseCache)) delete toolUseCache[key];
      for (const key of Object.keys(bgMap)) delete bgMap[key];
      mockClient.resetUpdateCount();

      const t0 = performance.now();

      // 1. Process 10 stream text deltas
      for (let i = 0; i < 10; i++) {
        const msg = makeStreamEvent("text", i);
        const notifications = streamEventToAcpNotifications(
          msg, "s1", toolUseCache, mockClient as any, console, bgMap,
        );
        for (const n of notifications) {
          await mockClient.sessionUpdate(n);
        }
      }

      // 2. Process a tool use start
      const toolId = `toolu_pipeline_${iter}`;
      const toolStartMsg = {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 10,
          content_block: {
            type: "tool_use",
            id: toolId,
            name: "Bash",
            input: {},
          },
        },
        parent_tool_use_id: null,
      };
      streamEventToAcpNotifications(
        toolStartMsg, "s1", toolUseCache, mockClient as any, console, bgMap,
      );

      // 3. Process assistant message (updates tool cache)
      const assistantMsg = makeToolUseAssistantMessage(toolId, "Bash");
      toAcpNotifications(
        assistantMsg.message.content,
        "assistant",
        "s1",
        toolUseCache,
        mockClient as any,
        console,
        bgMap,
      );

      // 4. Process tool result
      const resultMsg = makeToolResult(toolId);
      toAcpNotifications(
        resultMsg.message.content,
        "user",
        "s1",
        toolUseCache,
        mockClient as any,
        console,
        bgMap,
      );

      // 5. Process 5 more text deltas
      for (let i = 0; i < 5; i++) {
        const msg = makeStreamEvent("text", 11 + i);
        streamEventToAcpNotifications(
          msg, "s1", toolUseCache, mockClient as any, console, bgMap,
        );
      }

      samples.push(performance.now() - t0);
    }
    const heapAfter = process.memoryUsage().heapUsed;

    results.push({
      name,
      latency: computeStats(samples),
      memoryDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(3),
    });
  }

  // ── Benchmark: Concurrent session notification throughput ───────────
  // Simulates multiple sessions sending notifications simultaneously

  {
    const name = "concurrent_session_throughput";
    const SESSIONS = 5;
    const MESSAGES_PER_SESSION = 50;
    const N = 50;

    const mockClient = createMockClient();
    const heapBefore = process.memoryUsage().heapUsed;
    const samples: number[] = [];

    for (let iter = 0; iter < N; iter++) {
      const queues: InstanceType<typeof NotificationQueue>[] = [];
      for (let s = 0; s < SESSIONS; s++) {
        queues.push(new NotificationQueue(mockClient as any, console));
      }

      const t0 = performance.now();
      // Enqueue messages across all sessions simultaneously
      for (let m = 0; m < MESSAGES_PER_SESSION; m++) {
        for (let s = 0; s < SESSIONS; s++) {
          queues[s].enqueue({
            sessionId: `session_${s}`,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Message ${m} from session ${s}` },
            },
          });
        }
      }
      // Flush all
      await Promise.all(queues.map((q) => q.flush()));
      samples.push(performance.now() - t0);
    }
    const heapAfter = process.memoryUsage().heapUsed;

    results.push({
      name,
      latency: computeStats(samples),
      memoryDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(3),
    });
  }

  // ── Benchmark: ToolUseCache operations ─────────────────────────────

  {
    const name = "toolUseCache.set_get_delete";
    const cache: Record<string, any> = {};

    const heapBefore = process.memoryUsage().heapUsed;
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const id = `toolu_cache_${i}`;
      const t0 = performance.now();
      // Set
      cache[id] = {
        type: "tool_use",
        id,
        name: "Bash",
        input: { command: "ls", description: "list" },
      };
      // Get
      const _val = cache[id];
      // Delete (simulate eviction)
      delete cache[id];
      samples.push(performance.now() - t0);
    }
    const heapAfter = process.memoryUsage().heapUsed;

    results.push({
      name,
      latency: computeStats(samples),
      memoryDeltaMB: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(3),
    });
  }

  // ── Collect event loop metrics and finalize ────────────────────────

  const eventLoopMetrics = stopEventLoopMonitor();
  const heapUsedMB = +(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);

  const report: BaselineReport = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    results,
    eventLoopMetrics,
    heapUsedMB,
  };

  // Print results table
  console.log("\n" + "=".repeat(100));
  console.log("ACP SERVER BENCHMARK RESULTS");
  console.log("=".repeat(100));
  console.log(
    "Benchmark".padEnd(45),
    "p50(ms)".padStart(10),
    "p95(ms)".padStart(10),
    "p99(ms)".padStart(10),
    "max(ms)".padStart(10),
    "ops/s".padStart(10),
  );
  console.log("-".repeat(100));

  for (const r of results) {
    console.log(
      r.name.padEnd(45),
      r.latency.p50.toFixed(3).padStart(10),
      r.latency.p95.toFixed(3).padStart(10),
      r.latency.p99.toFixed(3).padStart(10),
      r.latency.max.toFixed(3).padStart(10),
      String(r.latency.opsPerSec).padStart(10),
    );
  }

  console.log("-".repeat(100));
  console.log("\nEvent Loop Metrics:");
  console.log(`  Max block time: ${eventLoopMetrics.maxBlockTimeMs}ms`);
  console.log(`  Avg block time: ${eventLoopMetrics.avgBlockTimeMs}ms`);
  console.log(`  Total blocks:   ${eventLoopMetrics.totalBlocks}`);
  console.log(`  Heap used:      ${heapUsedMB}MB`);

  // Check against targets
  console.log("\n" + "=".repeat(100));
  console.log("TARGET CHECKS:");
  const targetChecks = [
    {
      label: "p95 latency < 50ms (all benchmarks)",
      pass: results.every((r) => r.latency.p95 < 50),
    },
    {
      label: "No event loop blocks > 100ms",
      pass: eventLoopMetrics.maxBlockTimeMs < 100,
    },
    {
      label: "full_prompt_pipeline p95 < 20ms",
      pass: (results.find((r) => r.name === "full_prompt_pipeline")?.latency.p95 ?? 999) < 20,
    },
  ];
  for (const check of targetChecks) {
    console.log(`  ${check.pass ? "PASS" : "FAIL"} ${check.label}`);
  }
  console.log("=".repeat(100));

  // Save baseline
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(report, null, 2));
  console.log(`\nBaseline saved to: ${BASELINE_PATH}`);

  return report;
}

// ── Comparison helper ──────────────────────────────────────────────────

export function compareWithBaseline(current: BaselineReport): void {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.log("No baseline found — this run becomes the baseline.");
    return;
  }

  const baseline: BaselineReport = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"));

  console.log("\n" + "=".repeat(110));
  console.log("COMPARISON WITH BASELINE");
  console.log("=".repeat(110));
  console.log(
    "Benchmark".padEnd(45),
    "p95 before".padStart(12),
    "p95 after".padStart(12),
    "delta%".padStart(10),
    "ops/s before".padStart(14),
    "ops/s after".padStart(14),
  );
  console.log("-".repeat(110));

  for (const curr of current.results) {
    const base = baseline.results.find((b) => b.name === curr.name);
    if (!base) {
      console.log(curr.name.padEnd(45), "NEW".padStart(12));
      continue;
    }
    const deltaP95 = base.latency.p95 > 0
      ? (((curr.latency.p95 - base.latency.p95) / base.latency.p95) * 100).toFixed(1)
      : "N/A";
    const improved = curr.latency.p95 < base.latency.p95;
    const marker = improved ? " ↓" : curr.latency.p95 > base.latency.p95 ? " ↑" : "";
    console.log(
      curr.name.padEnd(45),
      base.latency.p95.toFixed(3).padStart(12),
      curr.latency.p95.toFixed(3).padStart(12),
      (deltaP95 + "%" + marker).padStart(10),
      String(base.latency.opsPerSec).padStart(14),
      String(curr.latency.opsPerSec).padStart(14),
    );
  }

  console.log("-".repeat(110));
  console.log(`\nEvent loop max block: ${baseline.eventLoopMetrics.maxBlockTimeMs}ms → ${current.eventLoopMetrics.maxBlockTimeMs}ms`);
  console.log(`Heap used: ${baseline.heapUsedMB}MB → ${current.heapUsedMB}MB`);
  console.log("=".repeat(110));
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  // Read old baseline before running (if it exists)
  let oldBaseline: BaselineReport | null = null;
  if (fs.existsSync(BASELINE_PATH)) {
    try {
      oldBaseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"));
    } catch {}
  }

  const report = await runBenchmarks();

  // Compare with old baseline if it existed
  if (oldBaseline) {
    compareReports(oldBaseline, report);
  }

  process.exit(0);
}

function compareReports(baseline: BaselineReport, current: BaselineReport): void {
  console.log("\n" + "=".repeat(110));
  console.log("COMPARISON WITH PREVIOUS BASELINE");
  console.log("=".repeat(110));
  console.log(
    "Benchmark".padEnd(45),
    "p95 before".padStart(12),
    "p95 after".padStart(12),
    "delta%".padStart(10),
    "ops/s before".padStart(14),
    "ops/s after".padStart(14),
  );
  console.log("-".repeat(110));

  for (const curr of current.results) {
    const base = baseline.results.find((b) => b.name === curr.name);
    if (!base) {
      console.log(curr.name.padEnd(45), "NEW".padStart(12));
      continue;
    }
    const deltaP95 = base.latency.p95 > 0
      ? (((curr.latency.p95 - base.latency.p95) / base.latency.p95) * 100).toFixed(1)
      : "N/A";
    const improved = curr.latency.p95 < base.latency.p95;
    const marker = improved ? " ↓" : curr.latency.p95 > base.latency.p95 ? " ↑" : "";
    console.log(
      curr.name.padEnd(45),
      base.latency.p95.toFixed(3).padStart(12),
      curr.latency.p95.toFixed(3).padStart(12),
      (deltaP95 + "%" + marker).padStart(10),
      String(base.latency.opsPerSec).padStart(14),
      String(curr.latency.opsPerSec).padStart(14),
    );
  }

  console.log("-".repeat(110));
  console.log(`\nEvent loop max block: ${baseline.eventLoopMetrics.maxBlockTimeMs}ms → ${current.eventLoopMetrics.maxBlockTimeMs}ms`);
  console.log(`Heap used: ${baseline.heapUsedMB}MB → ${current.heapUsedMB}MB`);
  console.log("=".repeat(110));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});

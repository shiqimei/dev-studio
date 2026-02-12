/**
 * Shared Worker Pool
 *
 * Generic pre-warmed worker pool for Claude SDK streaming sessions.
 * Keeps streaming SDK sessions alive so lightweight calls avoid the
 * ~4s cold start of spawning a new subprocess per query.
 *
 * Workers are recycled after MAX_USES to prevent unbounded context growth
 * (each prompt/response pair accumulates in the conversation history).
 *
 * Response consumption uses an async-iterator-first design:
 *   stream(prompt)  → AsyncGenerator<StreamChunk>  (primary primitive)
 *   query(prompt)   → Promise<string>              (convenience, built on stream)
 *
 * Used by both the Haiku pool (routing, title generation) and
 * the Opus pool (pre-warmed for kanban task work).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { log } from "./log.js";

// ── Config ──

export interface WorkerPoolConfig {
  /** Display name for logging (e.g., "haiku-pool", "opus-pool"). */
  name: string;
  /** Claude model ID (e.g., "claude-haiku-4-5-20251001", "claude-opus-4-6"). */
  model: string;
  /** System prompt for all workers in this pool. */
  systemPrompt: string;
  /** Number of workers to pre-warm at startup. */
  poolSize: number;
  /** Recycle a worker after this many calls (prevents unbounded context growth). */
  maxUses: number;
  /** Hard cap on total workers (pool + overflow). */
  maxPoolSize: number;
  /** Max thinking tokens (0 to disable thinking). Default: 0. */
  maxThinkingTokens?: number;
  /** Budget cap per worker session in USD. Default: 1.0. */
  maxBudgetUsd?: number;
}

// ── Stream chunks ──

export interface StreamChunk {
  type: "text" | "thinking";
  text: string;
}

// ── Worker ──

interface Worker {
  push(text: string): void;
  close(): void;
  /** Drain a response fully, returning the accumulated text. Used for warmup. */
  readResponse(): Promise<string>;
  /** Stream response chunks as they arrive from the SDK. */
  streamResponse(): AsyncGenerator<StreamChunk, void, undefined>;
  busy: boolean;
  warmedUp: boolean;
  uses: number;
}

function createWorker(config: WorkerPoolConfig): Worker {
  // Push-based async iterable — lets us send messages on demand to a single subprocess
  const pending: any[] = [];
  let waiter: ((result: IteratorResult<any>) => void) | null = null;
  let closed = false;

  const iterable: AsyncIterable<any> = {
    [Symbol.asyncIterator]: () => ({
      next(): Promise<IteratorResult<any>> {
        if (pending.length > 0) return Promise.resolve({ value: pending.shift()!, done: false });
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => { waiter = r; });
      },
      return(): Promise<IteratorResult<any>> {
        closed = true;
        return Promise.resolve({ value: undefined, done: true });
      },
    }),
  };

  function push(text: string) {
    const msg = {
      type: "user" as const,
      session_id: "",
      message: { role: "user" as const, content: text },
      parent_tool_use_id: null,
    };
    if (waiter) { const w = waiter; waiter = null; w({ value: msg, done: false }); }
    else pending.push(msg);
  }

  function close() {
    closed = true;
    if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }); }
  }

  // Push a warmup prompt before calling query() so the iterable yields immediately
  push('Reply with exactly "ready".');

  const conversation = query({
    prompt: iterable,
    options: {
      systemPrompt: config.systemPrompt,
      model: config.model,
      maxThinkingTokens: config.maxThinkingTokens ?? 0,
      maxTurns: 100,
      maxBudgetUsd: config.maxBudgetUsd ?? 1.0,
      tools: [],
      settingSources: [],
      mcpServers: {},
      hooks: {},
      persistSession: false,
      cwd: process.cwd(),
    },
  });

  const iter = conversation[Symbol.asyncIterator]();

  /** Drain a full response, returning accumulated text. Used for warmup only. */
  async function readResponse(): Promise<string> {
    let text = "";
    while (true) {
      const { value: msg, done } = await iter.next();
      if (done) break;
      if (msg.type === "assistant") {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") text += block.text;
          }
        }
        return text.trim();
      }
      // skip system/init/stream messages
    }
    return text;
  }

  /**
   * Stream response chunks as they arrive from the SDK.
   *
   * Yields text/thinking deltas from stream_event messages in real time.
   * Falls back to the final assistant message content if no stream events
   * were received (e.g., very short responses).
   */
  async function* streamResponse(): AsyncGenerator<StreamChunk, void, undefined> {
    let streamedText = false;
    while (true) {
      const { value: msg, done } = await iter.next();
      if (done) break;

      // Yield incremental deltas from SDK stream events
      if (msg.type === "stream_event") {
        const event = (msg as any).event;
        if (event?.type === "content_block_delta") {
          const delta = event.delta;
          if (delta?.type === "text_delta" && delta.text) {
            streamedText = true;
            yield { type: "text", text: delta.text };
          } else if (delta?.type === "thinking_delta" && delta.thinking) {
            yield { type: "thinking", text: delta.thinking };
          }
        }
        continue;
      }

      // Final assistant message — extract any text not already streamed
      if (msg.type === "assistant") {
        if (!streamedText) {
          const content = (msg as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                yield { type: "text", text: block.text };
              }
            }
          }
        }
        return;
      }
    }
  }

  return { push, close, readResponse, streamResponse, busy: false, warmedUp: false, uses: 0 };
}

// ── Metrics ──

export interface MetricEntry {
  timestamp: number;
  operation: string;
  durationMs: number;
  inputLength: number;
  outputLength: number;
  output: string;  // truncated to 200 chars
  success: boolean;
}

const METRICS_BUFFER_SIZE = 200;

// ── Pool ──

export interface WorkerPool {
  /** Warm the pool — spawns workers and absorbs cold start. Returns when ready. */
  warmup(): Promise<void>;
  /**
   * Stream response chunks from a pre-warmed worker.
   * This is the primary primitive — yields text/thinking chunks as they arrive.
   * The worker is automatically released when the generator completes or is closed.
   */
  stream(prompt: string): AsyncGenerator<StreamChunk, void, undefined>;
  /** Send a prompt and get the full response. Convenience wrapper over stream(). */
  query(prompt: string): Promise<string>;
  /** Record a metric entry in the ring buffer. */
  recordMetric(entry: MetricEntry): void;
  /** Get collected metrics for all calls. */
  getMetrics(): MetricEntry[];
  /** Gracefully shut down all workers. */
  shutdown(): void;
}

export function createWorkerPool(config: WorkerPoolConfig): WorkerPool {
  const workers: Worker[] = [];
  let warmupPromise: Promise<void> | null = null;

  // ── Metrics ring buffer ──
  const metricsBuffer: MetricEntry[] = [];

  function recordMetric(entry: MetricEntry) {
    if (metricsBuffer.length >= METRICS_BUFFER_SIZE) metricsBuffer.shift();
    metricsBuffer.push(entry);
  }

  function getMetrics(): MetricEntry[] {
    return [...metricsBuffer];
  }

  // ── Warmup ──

  function warmup(): Promise<void> {
    if (warmupPromise) return warmupPromise;
    const t0 = performance.now();
    log.info({ poolSize: config.poolSize }, `${config.name}: warming up`);

    warmupPromise = (async () => {
      const batch = Array.from({ length: config.poolSize }, () => createWorker(config));
      await Promise.all(batch.map(async (w) => {
        await w.readResponse(); // drain warmup response
        w.warmedUp = true;
      }));
      workers.push(...batch);
      log.info({ poolSize: config.poolSize, durationMs: Math.round(performance.now() - t0) }, `${config.name}: ready`);
    })();

    return warmupPromise;
  }

  // ── Worker lifecycle ──

  /** Replace a worker in-place: close the old one, spawn + warm a fresh one. */
  function recycleWorker(old: Worker) {
    const idx = workers.indexOf(old);
    if (idx !== -1) workers.splice(idx, 1);
    try { old.close(); } catch {}

    // Spin up replacement in background
    const fresh = createWorker(config);
    fresh.readResponse().then(() => {
      fresh.warmedUp = true;
      workers.push(fresh);
      log.info({ poolSize: workers.length }, `${config.name}: recycled worker`);
    }).catch((err) => {
      log.warn({ err: (err as Error).message }, `${config.name}: recycle failed`);
    });
  }

  /** Acquire an idle worker (or create an overflow one if all busy). */
  async function acquire(): Promise<Worker> {
    if (warmupPromise) await warmupPromise;

    const idle = workers.find((w) => !w.busy && w.warmedUp);
    if (idle) {
      idle.busy = true;
      return idle;
    }

    // Overflow: all busy — create a temporary worker (still avoids cold start
    // on subsequent calls since it joins the pool).
    if (workers.length >= config.maxPoolSize) {
      // Hard cap: wait for any worker to become free rather than growing unboundedly
      log.info({ poolSize: workers.length }, `${config.name}: at max capacity, waiting for free worker`);
      while (true) {
        await new Promise((r) => setTimeout(r, 50));
        const freed = workers.find((w) => !w.busy && w.warmedUp);
        if (freed) { freed.busy = true; return freed; }
      }
    }

    log.info({ poolSize: workers.length }, `${config.name}: all busy, creating overflow worker`);
    const overflow = createWorker(config);
    await overflow.readResponse(); // absorb warmup
    overflow.warmedUp = true;
    overflow.busy = true;
    workers.push(overflow);
    return overflow;
  }

  function release(worker: Worker) {
    worker.busy = false;
    // Proactively recycle if approaching context limit
    if (worker.uses >= config.maxUses) {
      log.info({ uses: worker.uses }, `${config.name}: recycling worker (max uses reached)`);
      recycleWorker(worker);
    }
  }

  // ── Stream (primary primitive) ──

  async function* streamPool(prompt: string): AsyncGenerator<StreamChunk, void, undefined> {
    let worker: Worker | null = null;
    try {
      worker = await acquire();
      worker.push(prompt);
      yield* worker.streamResponse();
      worker.uses++;
    } catch (err: any) {
      // Evict the broken worker and spawn a replacement
      if (worker) {
        recycleWorker(worker);
        worker = null; // prevent release in finally
      }
      throw err;
    } finally {
      if (worker) release(worker);
    }
  }

  // ── Query (convenience, built on stream) ──

  async function queryPool(prompt: string): Promise<string> {
    let text = "";
    for await (const chunk of streamPool(prompt)) {
      if (chunk.type === "text") text += chunk.text;
    }
    return text.trim();
  }

  // ── Shutdown ──

  function shutdown() {
    log.info({ poolSize: workers.length }, `${config.name}: shutting down`);
    for (const w of workers) {
      try { w.close(); } catch {}
    }
    workers.length = 0;
  }

  return { warmup, stream: streamPool, query: queryPool, recordMetric, getMetrics, shutdown };
}

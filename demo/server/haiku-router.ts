/**
 * Haiku Router Pool
 *
 * Keeps pre-warmed streaming SDK sessions alive so routing calls avoid the
 * ~4s cold start of spawning a new subprocess per query. Each worker holds
 * an open `query()` subprocess; push a prompt → read the response (~1s).
 *
 * Workers are recycled after MAX_USES to prevent unbounded context growth
 * (each prompt/response pair accumulates in the conversation history).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { log } from "./log.js";

// ── Config ──

const POOL_SIZE = 2;
const MAX_USES = 40; // recycle a worker after this many routing calls
const MAX_POOL_SIZE = 4; // cap total workers (pool + overflow)

const SYSTEM_PROMPT =
  "You are a message router. Given a session title, the latest conversation exchange, " +
  "and a new user message, determine if the message should continue in the same session " +
  "or start a new one. " +
  'Reply with ONLY "same" or "new".';

// ── Worker ──

interface Worker {
  push(text: string): void;
  close(): void;
  readResponse(): Promise<string>;
  busy: boolean;
  warmedUp: boolean;
  uses: number;
}

function createWorker(): Worker {
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
  push('Session title: "warmup"\nNew message: "warmup"\nReply ONLY "same" or "new".');

  const conversation = query({
    prompt: iterable,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model: "claude-haiku-4-5-20251001",
      maxThinkingTokens: 0,
      maxTurns: 100,
      maxBudgetUsd: 1.0,
      tools: [],
      settingSources: [],
      mcpServers: {},
      hooks: {},
      persistSession: false,
      cwd: process.cwd(),
    },
  });

  const iter = conversation[Symbol.asyncIterator]();

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
        return text.trim().toLowerCase();
      }
      // skip system/init/stream messages
    }
    return text;
  }

  return { push, close, readResponse, busy: false, warmedUp: false, uses: 0 };
}

// ── Pool ──

export interface HaikuRouterPool {
  /** Warm the pool — spawns workers and absorbs cold start. Returns when ready. */
  warmup(): Promise<void>;
  /** Route a message: returns true if it belongs to the current session. */
  route(messageText: string, sessionTitle: string | null, lastTurnSummary: string | null): Promise<boolean>;
  /** Gracefully shut down all workers. */
  shutdown(): void;
}

export function createHaikuRouterPool(): HaikuRouterPool {
  const workers: Worker[] = [];
  let warmupPromise: Promise<void> | null = null;

  // ── Warmup ──

  function warmup(): Promise<void> {
    if (warmupPromise) return warmupPromise;
    const t0 = performance.now();
    log.info({ poolSize: POOL_SIZE }, "haiku-pool: warming up");

    warmupPromise = (async () => {
      const batch = Array.from({ length: POOL_SIZE }, () => createWorker());
      await Promise.all(batch.map(async (w) => {
        await w.readResponse(); // drain warmup response
        w.warmedUp = true;
      }));
      workers.push(...batch);
      log.info({ poolSize: POOL_SIZE, durationMs: Math.round(performance.now() - t0) }, "haiku-pool: ready");
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
    const fresh = createWorker();
    fresh.readResponse().then(() => {
      fresh.warmedUp = true;
      workers.push(fresh);
      log.info({ poolSize: workers.length }, "haiku-pool: recycled worker");
    }).catch((err) => {
      log.warn({ err: (err as Error).message }, "haiku-pool: recycle failed");
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
    if (workers.length >= MAX_POOL_SIZE) {
      // Hard cap: wait for any worker to become free rather than growing unboundedly
      log.info({ poolSize: workers.length }, "haiku-pool: at max capacity, waiting for free worker");
      while (true) {
        await new Promise((r) => setTimeout(r, 50));
        const freed = workers.find((w) => !w.busy && w.warmedUp);
        if (freed) { freed.busy = true; return freed; }
      }
    }

    log.info({ poolSize: workers.length }, "haiku-pool: all busy, creating overflow worker");
    const overflow = createWorker();
    await overflow.readResponse(); // absorb warmup
    overflow.warmedUp = true;
    overflow.busy = true;
    workers.push(overflow);
    return overflow;
  }

  function release(worker: Worker) {
    worker.busy = false;
    // Proactively recycle if approaching context limit
    if (worker.uses >= MAX_USES) {
      log.info({ uses: worker.uses }, "haiku-pool: recycling worker (max uses reached)");
      recycleWorker(worker);
    }
  }

  // ── Route ──

  function buildPrompt(messageText: string, sessionTitle: string, lastTurnSummary: string | null): string {
    const contextBlock = lastTurnSummary ? `\n${lastTurnSummary}\n` : "";
    return (
      `Session title: "${sessionTitle}"${contextBlock}\nNew message: "${messageText.slice(0, 500)}"\n\n` +
      `Reply with ONLY "same" if the message relates to the current session topic, or "new" if it's a different topic that should start a fresh session.`
    );
  }

  async function route(
    messageText: string,
    sessionTitle: string | null,
    lastTurnSummary: string | null,
  ): Promise<boolean> {
    if (!sessionTitle) return true; // untitled → stay in current session

    let worker: Worker | null = null;
    try {
      const t0 = performance.now();
      worker = await acquire();

      const prompt = buildPrompt(messageText, sessionTitle, lastTurnSummary);
      worker.push(prompt);
      const answer = await worker.readResponse();
      worker.uses++;

      const isSame = !answer.startsWith("new");
      log.info({ durationMs: Math.round(performance.now() - t0), answer, isSame, uses: worker.uses }, "route: Haiku decision (pooled)");
      return isSame;
    } catch (err: any) {
      log.warn({ err: err.message }, "route: Haiku pooled query failed, defaulting to same session");
      // Evict the broken worker and spawn a replacement
      if (worker) {
        recycleWorker(worker);
        worker = null; // prevent release in finally
      }
      return true;
    } finally {
      if (worker) release(worker);
    }
  }

  // ── Shutdown ──

  function shutdown() {
    log.info({ poolSize: workers.length }, "haiku-pool: shutting down");
    for (const w of workers) {
      try { w.close(); } catch {}
    }
    workers.length = 0;
  }

  return { warmup, route, shutdown };
}

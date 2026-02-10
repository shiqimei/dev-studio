/**
 * Haiku Worker Pool
 *
 * General-purpose pre-warmed Haiku worker pool. Keeps streaming SDK sessions
 * alive so lightweight calls (routing, title generation, etc.) avoid the
 * ~4s cold start of spawning a new subprocess per query.
 *
 * Workers are recycled after MAX_USES to prevent unbounded context growth
 * (each prompt/response pair accumulates in the conversation history).
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import * as path from "node:path";
import { log } from "./log.js";

// ── Config ──

const POOL_SIZE = 2;
const MAX_USES = 40; // recycle a worker after this many calls
const MAX_POOL_SIZE = 4; // cap total workers (pool + overflow)

const SYSTEM_PROMPT =
  "You are a fast, efficient assistant. Follow the instructions in each message exactly. " +
  "Be concise. Output ONLY what is requested, nothing else.";

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
  push('Reply with exactly "ready".');

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
        return text.trim();
      }
      // skip system/init/stream messages
    }
    return text;
  }

  return { push, close, readResponse, busy: false, warmedUp: false, uses: 0 };
}

// ── Pool ──

export interface HaikuPool {
  /** Warm the pool — spawns workers and absorbs cold start. Returns when ready. */
  warmup(): Promise<void>;
  /** Send a prompt and get a response using a pre-warmed worker. */
  query(prompt: string): Promise<string>;
  /** Route a message: returns true if it belongs to the current session. */
  route(messageText: string, sessionTitle: string | null, lastTurnSummary: string | null): Promise<boolean>;
  /** Generate a concise session title from user message and assistant response. */
  generateTitle(cwd: string, userMessage: string, assistantText: string): Promise<string | null>;
  /** Gracefully shut down all workers. */
  shutdown(): void;
}

export function createHaikuPool(): HaikuPool {
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

  // ── Generic query ──

  async function queryPool(prompt: string): Promise<string> {
    let worker: Worker | null = null;
    try {
      worker = await acquire();
      worker.push(prompt);
      const answer = await worker.readResponse();
      worker.uses++;
      return answer;
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

  // ── Route ──

  function buildRoutePrompt(messageText: string, sessionTitle: string, lastTurnSummary: string | null): string {
    const contextBlock = lastTurnSummary ? `\n${lastTurnSummary}\n` : "";
    return (
      `You are routing a message. Determine if it should continue in the current session or start a new one.\n\n` +
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

    try {
      const t0 = performance.now();
      const prompt = buildRoutePrompt(messageText, sessionTitle, lastTurnSummary);
      const answer = await queryPool(prompt);
      const isSame = !answer.toLowerCase().startsWith("new");
      log.info({ durationMs: Math.round(performance.now() - t0), answer, isSame }, "route: Haiku decision (pooled)");
      return isSame;
    } catch (err: any) {
      log.warn({ err: err.message }, "route: Haiku pooled query failed, defaulting to same session");
      return true;
    }
  }

  // ── Title generation ──

  const MAX_TITLE_LENGTH = 32;

  function buildTitlePrompt(projectName: string, userMessage: string, assistantText: string): string {
    let prompt =
      `Generate a concise session title in ≤${MAX_TITLE_LENGTH} characters. ` +
      `Use imperative verb phrases (e.g. Fix login bug, Add dark mode, Refactor auth). ` +
      `No quotes, no trailing punctuation. Output ONLY the title, nothing else.\n\n` +
      `Project: ${projectName}\n\nUser message:\n${userMessage.slice(0, 500)}`;
    if (assistantText.length > 0) {
      prompt += `\n\nAssistant response:\n${assistantText.slice(0, 500)}`;
    }
    return prompt;
  }

  async function generateTitle(
    cwd: string,
    userMessage: string,
    assistantText: string,
  ): Promise<string | null> {
    try {
      const t0 = performance.now();
      const projectName = path.basename(cwd);
      const prompt = buildTitlePrompt(projectName, userMessage, assistantText);
      const raw = await queryPool(prompt);

      if (!raw) return null;

      // Clean up: trim whitespace, remove surrounding quotes, truncate
      let title = raw.trim();
      if (
        (title.startsWith('"') && title.endsWith('"')) ||
        (title.startsWith("'") && title.endsWith("'"))
      ) {
        title = title.slice(1, -1);
      }
      if (title.endsWith(".")) title = title.slice(0, -1);
      title = title.slice(0, MAX_TITLE_LENGTH).trim();

      log.info({ durationMs: Math.round(performance.now() - t0), title }, "haiku-pool: generated title");
      return title || null;
    } catch (err: any) {
      log.warn({ err: err.message }, "haiku-pool: generateTitle failed");
      return null;
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

  return { warmup, query: queryPool, route, generateTitle, shutdown };
}

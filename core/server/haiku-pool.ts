/**
 * Haiku Worker Pool
 *
 * Pre-warmed Haiku worker pool for lightweight tasks (routing, title generation).
 * Built on the shared WorkerPool abstraction from worker-pool.ts.
 */

import * as path from "node:path";
import { createWorkerPool, type WorkerPool, type MetricEntry } from "./worker-pool.js";
import { log } from "./log.js";

// ── Config ──

const HAIKU_CONFIG = {
  name: "haiku-pool",
  model: "claude-haiku-4-5-20251001",
  systemPrompt:
    "You are a fast, efficient assistant. Follow the instructions in each message exactly. " +
    "Be concise. Output ONLY what is requested, nothing else.",
  poolSize: 2,
  maxUses: 40,
  maxPoolSize: 4,
  maxBudgetUsd: 1.0,
} as const;

// ── Types ──

export type HaikuMetricEntry = MetricEntry;

export interface HaikuPool {
  /** Warm the pool — spawns workers and absorbs cold start. Returns when ready. */
  warmup(): Promise<void>;
  /** Send a prompt and get a response using a pre-warmed worker. */
  query(prompt: string): Promise<string>;
  /** Generate a concise session title from user message and assistant response. */
  generateTitle(cwd: string, userMessage: string, assistantText: string): Promise<string | null>;
  /** Get collected metrics for all Haiku calls. */
  getMetrics(): HaikuMetricEntry[];
  /** Gracefully shut down all workers. */
  shutdown(): void;
}

// ── Pool ──

export function createHaikuPool(): HaikuPool {
  const pool: WorkerPool = createWorkerPool(HAIKU_CONFIG);
  const { warmup, query: queryPool, recordMetric, getMetrics, shutdown } = pool;

  // ── Title generation ──

  function buildTitlePrompt(projectName: string, userMessage: string, assistantText: string): string {
    let prompt =
      `Generate a concise session title (3-8 words). ` +
      `Use imperative verb phrases (e.g. Fix login bug, Add dark mode, Refactor auth). ` +
      `Keep it short and self-contained — avoid dangling prepositions or articles at the end. ` +
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
      title = title.trim();

      const durationMs = Math.round(performance.now() - t0);
      log.info({ durationMs, title }, "haiku-pool: generated title");
      recordMetric({
        timestamp: Date.now(),
        operation: "title",
        durationMs,
        inputLength: prompt.length,
        outputLength: raw.length,
        output: (title || raw).slice(0, 200),
        success: true,
      });
      return title || null;
    } catch (err: any) {
      log.warn({ err: err.message }, "haiku-pool: generateTitle failed");
      recordMetric({
        timestamp: Date.now(),
        operation: "title",
        durationMs: 0,
        inputLength: userMessage.length,
        outputLength: 0,
        output: err.message?.slice(0, 200) ?? "error",
        success: false,
      });
      return null;
    }
  }

  return { warmup, query: queryPool, generateTitle, getMetrics, shutdown };
}

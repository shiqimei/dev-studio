/**
 * Benchmark: routeWithHaiku latency via streaming Agent SDK
 *
 * Uses the AsyncIterable<SDKUserMessage> streaming input mode to keep a
 * single subprocess alive across all routing queries. This way subprocess
 * spawn + SDK init only happens once (warmup), and subsequent calls measure
 * pure API roundtrip latency.
 *
 * Usage:
 *   bun scripts/bench-haiku-route.ts
 *   bun scripts/bench-haiku-route.ts --runs 10
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

// ── Config ──

const DEFAULT_RUNS = 5;
const runs = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) || DEFAULT_RUNS : DEFAULT_RUNS;
})();

const MODEL = "claude-haiku-4-5-20251001";

// Test cases
const testCases: Array<{ label: string; message: string; title: string; summary: string | null }> = [
  {
    label: "same topic (bug fix)",
    message: "Can you also add a unit test for that fix?",
    title: "Fix login bug",
    summary:
      'Last user message: "There\'s a bug in the login handler"\nLast assistant response: "I found the issue in auth.ts line 42, fixing the null check now"',
  },
  {
    label: "new topic (unrelated)",
    message: "Help me set up a Docker container for the database",
    title: "Fix login bug",
    summary:
      'Last user message: "There\'s a bug in the login handler"\nLast assistant response: "Fixed! The login now works correctly"',
  },
  {
    label: "ambiguous",
    message: "What about the tests?",
    title: "Refactor API endpoints",
    summary:
      'Last user message: "Refactor the user endpoints to use the new router"\nLast assistant response: "Done, I\'ve updated all 5 endpoints"',
  },
  {
    label: "no summary context",
    message: "Add dark mode toggle",
    title: "Update settings page",
    summary: null,
  },
];

// ── Prompt / system ──

const SYSTEM_PROMPT =
  "You are a message router. Given a session title, the latest conversation exchange, " +
  "and a new user message, determine if the message should continue in the same session " +
  "or start a new one. " +
  'Reply with ONLY "same" or "new".';

function buildPrompt(messageText: string, sessionTitle: string, lastTurnSummary: string | null): string {
  const contextBlock = lastTurnSummary ? `\n${lastTurnSummary}\n` : "";
  return (
    `Session title: "${sessionTitle}"${contextBlock}\nNew message: "${messageText.slice(0, 500)}"\n\n` +
    `Reply with ONLY "same" if the message relates to the current session topic, or "new" if it's a different topic that should start a fresh session.`
  );
}

// ── Push-based async iterable for streaming input ──

function createMessageStream() {
  const pending: Array<any> = [];
  let waiter: ((result: IteratorResult<any>) => void) | null = null;
  let closed = false;

  const iterable: AsyncIterable<any> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<any>> {
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift()!, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            waiter = resolve;
          });
        },
        return(): Promise<IteratorResult<any>> {
          closed = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  function push(text: string) {
    const msg = {
      type: "user" as const,
      session_id: "",
      message: { role: "user" as const, content: text },
      parent_tool_use_id: null,
    };
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ value: msg, done: false });
    } else {
      pending.push(msg);
    }
  }

  function close() {
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ value: undefined, done: true });
    }
  }

  return { iterable, push, close };
}

// ── Main ──

async function main() {
  console.log(`\n  Haiku Route Benchmark (Streaming Agent SDK)`);
  console.log(`  Runs per case: ${runs}\n`);
  console.log("-".repeat(80));

  // ── Setup: create streaming connection (single subprocess) ──

  const stream = createMessageStream();

  // Push the first user message before calling query() so the iterable has
  // something to yield immediately when the SDK reads from it.
  const warmupPrompt = buildPrompt(testCases[0].message, testCases[0].title, testCases[0].summary);
  stream.push(warmupPrompt);

  const warmupT0 = performance.now();

  const conversation = query({
    prompt: stream.iterable,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model: MODEL,
      maxThinkingTokens: 0,
      maxTurns: 100, // high limit — we control the lifecycle via close()
      maxBudgetUsd: 1.0, // enough budget for all runs
      tools: [],
      settingSources: [],
      mcpServers: {},
      hooks: {},
      persistSession: false,
      cwd: process.cwd(),
    },
  });

  // Get the output iterator (manual .next() so we don't close it with break)
  const iter = conversation[Symbol.asyncIterator]();

  // ── Warmup: drain until we get the first assistant response ──

  let warmupAnswer = "";
  while (true) {
    const { value: msg, done } = await iter.next();
    if (done) break;
    if (msg.type === "assistant") {
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") warmupAnswer += block.text;
        }
      }
      break;
    }
    // skip system/init messages
  }
  warmupAnswer = warmupAnswer.trim().toLowerCase();
  const warmupMs = performance.now() - warmupT0;

  console.log(`\n  Warmup (subprocess spawn + first query): ${warmupMs.toFixed(0)}ms → ${warmupAnswer}\n`);
  console.log("-".repeat(80));

  // ── Measured runs ──

  const allResults: Array<{ label: string; durations: number[]; answers: string[] }> = [];

  for (const tc of testCases) {
    const durations: number[] = [];
    const answers: string[] = [];

    console.log(`\n  Case: "${tc.label}"`);
    console.log(`    title:   "${tc.title}"`);
    console.log(`    message: "${tc.message}"`);
    console.log(`    summary: ${tc.summary ? "yes" : "none"}\n`);

    for (let i = 0; i < runs; i++) {
      if (!tc.title) {
        // no title → skip (always SAME, 0ms)
        durations.push(0);
        answers.push("(no title)");
        console.log(`    run ${i + 1}/${runs}:     0ms  →  SAME  (raw: "(no title)")`);
        continue;
      }

      const prompt = buildPrompt(tc.message, tc.title, tc.summary);
      const t0 = performance.now();

      // Push user message → SDK forwards to model
      stream.push(prompt);

      // Read response
      let answer = "";
      while (true) {
        const { value: msg, done } = await iter.next();
        if (done) break;
        if (msg.type === "assistant") {
          const content = (msg as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") answer += block.text;
            }
          }
          break;
        }
      }

      const durationMs = performance.now() - t0;
      answer = answer.trim().toLowerCase();
      const isSame = !answer.startsWith("new");
      durations.push(durationMs);
      answers.push(answer);
      const tag = isSame ? "SAME" : "NEW ";
      console.log(`    run ${i + 1}/${runs}: ${durationMs.toFixed(0).padStart(5)}ms  →  ${tag}  (raw: "${answer}")`);
    }

    allResults.push({ label: tc.label, durations, answers });
  }

  // ── Cleanup ──
  stream.close();

  // ── Summary ──
  console.log("\n" + "-".repeat(80));
  console.log("\n  Summary (post-warmup, streaming)\n");
  console.log(
    "  " +
      "Case".padEnd(28) +
      "Min".padStart(8) +
      "Median".padStart(8) +
      "Mean".padStart(8) +
      "Max".padStart(8) +
      "  Answer",
  );
  console.log("  " + "-".repeat(74));

  let grandTotal = 0;
  let grandCount = 0;

  for (const r of allResults) {
    // exclude 0ms "no title" entries from stats
    const real = r.durations.filter((d) => d > 0);
    if (real.length === 0) {
      console.log("  " + r.label.padEnd(28) + "    (skipped — no title)");
      continue;
    }
    const sorted = [...real].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const median = sorted[Math.floor(sorted.length / 2)];
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const majorityAnswer = r.answers.sort(
      (a, b) => r.answers.filter((x) => x === b).length - r.answers.filter((x) => x === a).length,
    )[0];

    grandTotal += sorted.reduce((a, b) => a + b, 0);
    grandCount += sorted.length;

    console.log(
      "  " +
        r.label.padEnd(28) +
        `${min.toFixed(0)}ms`.padStart(8) +
        `${median.toFixed(0)}ms`.padStart(8) +
        `${mean.toFixed(0)}ms`.padStart(8) +
        `${max.toFixed(0)}ms`.padStart(8) +
        `  ${majorityAnswer}`,
    );
  }

  if (grandCount > 0) {
    const grandMean = grandTotal / grandCount;
    console.log("  " + "-".repeat(74));
    console.log(`  ${"Overall mean".padEnd(28)}${"".padStart(16)}${`${grandMean.toFixed(0)}ms`.padStart(8)}`);
    console.log(`  ${"Warmup (cold start)".padEnd(28)}${"".padStart(16)}${`${warmupMs.toFixed(0)}ms`.padStart(8)}`);
    console.log(`  ${"Speedup vs cold start".padEnd(28)}${"".padStart(16)}${`${(warmupMs / grandMean).toFixed(1)}x`.padStart(8)}`);
  }
  console.log();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

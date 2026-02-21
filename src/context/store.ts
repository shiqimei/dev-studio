/**
 * Context store — persistent memory for the context protocol.
 *
 * Stores structured assertions (learnings, observations, preferences, outcomes)
 * in append-only JSONL files under ~/.devstudio/projects/{cwd-slug}/memory.jsonl.
 *
 * Two automatic loops use this store:
 *   - Injection (before action): load relevant context into system prompt / hooks
 *   - Extraction (after action): distill tool results into new context entries
 *
 * The agent never decides to read or write here — hooks do it automatically.
 * MCP tools provide an optional explicit API for deliberate operations.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getDevStudioProjectDir, getMemoryPath } from "../disk/paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextKind = "preference" | "observation" | "outcome" | "constraint";
export type ContextStatus = "active" | "superseded" | "archived";

export interface ContextSource {
  sessionId: string;
  toolName?: string;
  evidence?: string;
  agentId?: string;
}

export interface ContextEntry {
  id: string;
  assertion: string;
  kind: ContextKind;
  confidence: number;
  source: ContextSource;
  tags: string[];
  timestamp: string;
  status: ContextStatus;
  supersededBy?: string;
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

/** Read all context entries from the memory JSONL file. Returns [] if file doesn't exist. */
export async function readMemory(cwd: string): Promise<ContextEntry[]> {
  const memPath = getMemoryPath(cwd);
  let raw: string;
  try {
    raw = await fs.promises.readFile(memPath, "utf8");
  } catch {
    return [];
  }
  const entries: ContextEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ContextEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/** Synchronous read for use in hot paths where async isn't possible. */
export function readMemorySync(cwd: string): ContextEntry[] {
  const memPath = getMemoryPath(cwd);
  let raw: string;
  try {
    raw = fs.readFileSync(memPath, "utf8");
  } catch {
    return [];
  }
  const entries: ContextEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ContextEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/** Append a single context entry to the memory file. Creates dir if needed. */
export async function appendMemory(cwd: string, entry: ContextEntry): Promise<void> {
  const memPath = getMemoryPath(cwd);
  await fs.promises.mkdir(path.dirname(memPath), { recursive: true });
  await fs.promises.appendFile(memPath, JSON.stringify(entry) + "\n", "utf8");
}

/** Create a new context entry with defaults filled in. */
export function createEntry(
  fields: Pick<ContextEntry, "assertion" | "kind" | "tags" | "source"> &
    Partial<Pick<ContextEntry, "confidence" | "status">>,
): ContextEntry {
  return {
    id: randomUUID(),
    assertion: fields.assertion,
    kind: fields.kind,
    confidence: fields.confidence ?? 0.6,
    source: fields.source,
    tags: fields.tags,
    timestamp: new Date().toISOString(),
    status: fields.status ?? "active",
  };
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/** Mark an entry as superseded. Rewrites the file in place. */
export async function invalidate(
  cwd: string,
  entryId: string,
  supersededBy?: string,
): Promise<boolean> {
  const entries = await readMemory(cwd);
  let found = false;
  for (const entry of entries) {
    if (entry.id === entryId && entry.status === "active") {
      entry.status = "superseded";
      if (supersededBy) entry.supersededBy = supersededBy;
      found = true;
    }
  }
  if (found) {
    const memPath = getMemoryPath(cwd);
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.promises.writeFile(memPath, content, "utf8");
  }
  return found;
}

// ---------------------------------------------------------------------------
// Query & Scoring
// ---------------------------------------------------------------------------

/** Scoring weights for relevance ranking. */
const WEIGHTS = {
  tagOverlap: 0.4,
  recency: 0.3,
  confidence: 0.2,
  kindPriority: 0.1,
};

/** Kind priority — preferences and constraints rank higher than transient observations. */
const KIND_PRIORITY: Record<ContextKind, number> = {
  constraint: 1.0,
  preference: 0.8,
  outcome: 0.6,
  observation: 0.4,
};

/** Decay constants per kind — how fast confidence decays over time (per day). */
const DECAY_LAMBDA: Record<ContextKind, number> = {
  constraint: 0.005, // Very slow: architectural decisions
  preference: 0.01, // Slow: user preferences
  outcome: 0.05, // Medium: past outcomes
  observation: 0.1, // Fast: transient observations
};

/** Compute effective confidence after time-based decay. */
export function effectiveConfidence(entry: ContextEntry): number {
  const daysSinceCreation =
    (Date.now() - new Date(entry.timestamp).getTime()) / (1000 * 60 * 60 * 24);
  const lambda = DECAY_LAMBDA[entry.kind] ?? 0.05;
  return entry.confidence * Math.exp(-lambda * daysSinceCreation);
}

/** Score an entry's relevance to a set of query tags. */
function scoreEntry(entry: ContextEntry, queryTags: string[]): number {
  // Tag overlap: Jaccard-like — fraction of query tags matched
  let tagScore = 0;
  if (queryTags.length > 0) {
    const entryTagSet = new Set(entry.tags.map((t) => t.toLowerCase()));
    let matches = 0;
    for (const qt of queryTags) {
      if (entryTagSet.has(qt.toLowerCase())) matches++;
    }
    tagScore = matches / queryTags.length;
  } else {
    // No tags specified — all entries get equal tag score
    tagScore = 0.5;
  }

  // Recency: exponential decay over 30 days
  const daysSinceCreation =
    (Date.now() - new Date(entry.timestamp).getTime()) / (1000 * 60 * 60 * 24);
  const recencyScore = Math.exp(-daysSinceCreation / 30);

  // Confidence with decay
  const confScore = effectiveConfidence(entry);

  // Kind priority
  const kindScore = KIND_PRIORITY[entry.kind] ?? 0.5;

  return (
    WEIGHTS.tagOverlap * tagScore +
    WEIGHTS.recency * recencyScore +
    WEIGHTS.confidence * confScore +
    WEIGHTS.kindPriority * kindScore
  );
}

/**
 * Query relevant context entries, ranked by relevance.
 * Only returns active entries with effective confidence > 0.1.
 */
export function queryRelevant(
  entries: ContextEntry[],
  tags: string[],
  limit: number = 10,
): ContextEntry[] {
  const active = entries.filter((e) => e.status === "active" && effectiveConfidence(e) > 0.1);

  const scored = active.map((entry) => ({
    entry,
    score: scoreEntry(entry, tags),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((s) => s.entry);
}

// ---------------------------------------------------------------------------
// Tag Inference
// ---------------------------------------------------------------------------

/** Infer context tags from a tool call. */
export function inferTags(toolName: string, toolInput: unknown): string[] {
  const tags: string[] = [];
  const input = toolInput as Record<string, unknown> | undefined;

  // Tool name as base tag
  tags.push(toolName.toLowerCase());

  if (!input) return tags;

  // File path based tags
  const filePath =
    (input.file_path as string) ?? (input.path as string) ?? (input.file as string);
  if (filePath) {
    const basename = path.basename(filePath);
    const dirname = path.dirname(filePath);

    // Known config files
    if (basename === "package.json" || basename === "package-lock.json") {
      tags.push("dependencies", "package.json");
    } else if (basename === "tsconfig.json") {
      tags.push("typescript", "config");
    } else if (basename.endsWith(".test.ts") || basename.endsWith(".spec.ts")) {
      tags.push("tests");
    } else if (basename.endsWith(".md")) {
      tags.push("documentation");
    }

    // Directory-based tags
    const parts = dirname.split(path.sep).filter(Boolean);
    for (const part of parts) {
      if (["auth", "api", "db", "database", "config", "test", "tests", "src"].includes(part)) {
        tags.push(part);
      }
    }

    // File extension
    const ext = path.extname(filePath).slice(1);
    if (ext) tags.push(ext);
  }

  // Bash command tags
  const command = (input.command as string) ?? "";
  if (command) {
    if (/npm\s+(install|update|upgrade|ci)\b/.test(command)) tags.push("dependencies");
    if (/pip\s+install\b/.test(command)) tags.push("dependencies", "python");
    if (/git\s+/.test(command)) tags.push("git");
    if (/docker\b/.test(command)) tags.push("docker");
    if (/tsc\b|typescript/.test(command)) tags.push("typescript", "build");
    if (/vitest|jest|mocha/.test(command)) tags.push("tests");
    if (/eslint|prettier/.test(command)) tags.push("lint");
  }

  return [...new Set(tags)]; // Dedupe
}

// ---------------------------------------------------------------------------
// Formatting for system prompt injection
// ---------------------------------------------------------------------------

/**
 * Max characters for memory injection into system prompt.
 * Each entry is ~80-150 chars. 1500 chars ≈ 10-15 entries ≈ ~400 tokens.
 * This is a hard cap — entries beyond this budget are dropped.
 */
const MEMORY_INJECTION_BUDGET_CHARS = 1500;

/**
 * Minimum effective confidence for system prompt injection.
 * Observations and low-confidence entries are excluded to save context budget.
 */
const MEMORY_INJECTION_MIN_CONFIDENCE = 0.3;

/** Kinds worth injecting into system prompt (skip transient observations). */
const INJECTABLE_KINDS = new Set<ContextKind>(["constraint", "preference", "outcome"]);

/** Format context entries for injection into system prompt, respecting a character budget. */
export function formatMemoriesForPrompt(entries: ContextEntry[]): string {
  if (entries.length === 0) return "";

  // Filter to high-value, high-confidence entries
  const eligible = entries.filter(
    (e) => INJECTABLE_KINDS.has(e.kind) && effectiveConfidence(e) >= MEMORY_INJECTION_MIN_CONFIDENCE,
  );

  if (eligible.length === 0) return "";

  const header = [
    "",
    "<context-memory>",
    "The following are learnings from previous sessions in this project.",
    "Use them to inform your actions. Do not mention these to the user unless relevant.",
    "",
  ].join("\n");
  const footer = "\n</context-memory>";
  const headerFooterLen = header.length + footer.length;

  // Greedily add entries until budget exhausted
  const lines: string[] = [];
  let usedChars = headerFooterLen;
  for (const e of eligible) {
    const line = `- [${e.kind}] ${e.assertion}`;
    if (usedChars + line.length + 1 > MEMORY_INJECTION_BUDGET_CHARS) break;
    lines.push(line);
    usedChars += line.length + 1; // +1 for newline
  }

  if (lines.length === 0) return "";

  return header + lines.join("\n") + footer;
}

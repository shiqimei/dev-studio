/**
 * Read and convert Codex session JSONL files from ~/.codex/sessions/.
 *
 * Codex stores sessions as:
 *   ~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{ts}-{uuid}.jsonl
 *
 * Each JSONL line is: { timestamp, type, payload }
 *   - type "session_meta"  → session metadata (id, cwd, model_provider, etc.)
 *   - type "response_item" → canonical conversation items (messages, tool calls, results)
 *   - type "event_msg"     → streaming events (duplicated in response_item, skipped)
 *   - type "turn_context"  → per-turn config snapshot (skipped)
 *
 * This adapter converts Codex entries to the Claude JSONL format expected by
 * the frontend's jsonlToEntries(), so sessions render uniformly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CODEX_HOME,
  getCodexSessionsDir,
  extractSessionIdFromFilename,
  extractTimestampFromFilename,
} from "./codex-paths.js";
import type { JsonlEntry, SessionIndexEntry } from "./types.js";

// ── Session discovery ────────────────────────────────────────────────

/** Map of sessionId → absolute file path, built by scanning the date tree. */
const _pathCache = new Map<string, string>();
let _pathCacheBuiltAt = 0;
const PATH_CACHE_TTL_MS = 10_000;

/**
 * Scan ~/.codex/sessions/ and build a sessionId → filePath map.
 * Results are cached for 10s to avoid repeated directory traversals.
 */
function buildPathCache(codexHome = CODEX_HOME): Map<string, string> {
  if (_pathCache.size > 0 && Date.now() - _pathCacheBuiltAt < PATH_CACHE_TTL_MS) {
    return _pathCache;
  }
  _pathCache.clear();
  const sessionsDir = getCodexSessionsDir(codexHome);
  try {
    // Walk {YYYY}/{MM}/{DD}/ three levels deep
    for (const year of fs.readdirSync(sessionsDir)) {
      const yearDir = path.join(sessionsDir, year);
      if (!fs.statSync(yearDir).isDirectory()) continue;
      for (const month of fs.readdirSync(yearDir)) {
        const monthDir = path.join(yearDir, month);
        if (!fs.statSync(monthDir).isDirectory()) continue;
        for (const day of fs.readdirSync(monthDir)) {
          const dayDir = path.join(monthDir, day);
          if (!fs.statSync(dayDir).isDirectory()) continue;
          for (const file of fs.readdirSync(dayDir)) {
            const sessionId = extractSessionIdFromFilename(file);
            if (sessionId) {
              _pathCache.set(sessionId, path.join(dayDir, file));
            }
          }
        }
      }
    }
  } catch {
    // ~/.codex/sessions/ may not exist
  }
  _pathCacheBuiltAt = Date.now();
  return _pathCache;
}

/** Invalidate the path cache (e.g. after creating a new session). */
export function invalidateCodexPathCache(): void {
  _pathCache.clear();
  _pathCacheBuiltAt = 0;
}

/** Resolve a Codex session ID to its JSONL file path. */
export function resolveCodexSessionPath(
  sessionId: string,
  codexHome = CODEX_HOME,
): string | null {
  const cache = buildPathCache(codexHome);
  return cache.get(sessionId) ?? null;
}

// ── Session listing ──────────────────────────────────────────────────

/**
 * Parse the first line (session_meta) of a Codex JSONL to extract metadata.
 * Returns null if the file is missing or doesn't start with session_meta.
 */
function parseSessionMeta(filePath: string): {
  id: string;
  cwd?: string;
  timestamp?: string;
  firstUserMessage?: string;
} | null {
  try {
    // Read just enough to get the first two content-bearing entries
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    if (bytesRead === 0) return null;

    const chunk = buf.toString("utf-8", 0, bytesRead);
    const lines = chunk.split("\n").filter(Boolean);

    let meta: { id: string; cwd?: string; timestamp?: string; firstUserMessage?: string } | null =
      null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "session_meta") {
          meta = {
            id: entry.payload?.id ?? "",
            cwd: entry.payload?.cwd,
            timestamp: entry.payload?.timestamp ?? entry.timestamp,
          };
        }
        // Look for the first real user message (event_msg/user_message is the actual prompt)
        if (entry.type === "event_msg" && entry.payload?.type === "user_message") {
          if (meta) {
            meta.firstUserMessage = entry.payload.message;
          }
          break; // Got what we need
        }
      } catch {
        // Skip malformed lines
      }
    }
    return meta;
  } catch {
    return null;
  }
}

/**
 * List all Codex sessions, returning entries compatible with SessionIndexEntry.
 * Scans the date-based directory tree and reads session_meta from each file.
 */
export function listCodexSessions(codexHome = CODEX_HOME): SessionIndexEntry[] {
  const cache = buildPathCache(codexHome);
  const entries: SessionIndexEntry[] = [];

  for (const [sessionId, filePath] of cache) {
    const filename = path.basename(filePath);
    const created = extractTimestampFromFilename(filename);

    // Try to get metadata from the file header (fast: only reads first 8KB)
    const meta = parseSessionMeta(filePath);

    // Get modified time from filesystem
    let modified: string | undefined;
    try {
      const stat = fs.statSync(filePath);
      modified = stat.mtime.toISOString();
    } catch {
      // ignore
    }

    entries.push({
      sessionId,
      firstPrompt: meta?.firstUserMessage
        ? truncateTitle(meta.firstUserMessage)
        : undefined,
      created: meta?.timestamp ?? created ?? undefined,
      modified,
      projectPath: meta?.cwd,
    });
  }

  // Sort by modified time descending (most recent first)
  entries.sort((a, b) => {
    const ta = a.modified ?? a.created ?? "";
    const tb = b.modified ?? b.created ?? "";
    return tb.localeCompare(ta);
  });

  return entries;
}

function truncateTitle(text: string, max = 120): string {
  const normalized = text.replace(/[\r\n]+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max - 3) + "...";
}

// ── Session history reading ──────────────────────────────────────────

/**
 * Read a Codex session's JSONL and convert to Claude-format JsonlEntry[].
 *
 * Converts Codex entry types to the format expected by the frontend's
 * jsonlToEntries() function:
 *   - response_item/message → user/assistant entries
 *   - response_item/function_call → assistant entry with tool_use block
 *   - response_item/function_call_output → user entry with tool_result block
 *   - response_item/custom_tool_call → assistant entry with tool_use block
 *   - response_item/custom_tool_call_output → user entry with tool_result block
 *   - response_item/reasoning → assistant entry with thinking block
 *   - event_msg/agent_message → assistant entry (if no prior response_item/message)
 *   - event_msg/user_message → skipped (response_item/message is canonical)
 *   - session_meta, turn_context, token_count → skipped
 */
export async function readCodexSessionHistory(
  sessionId: string,
  codexHome = CODEX_HOME,
): Promise<JsonlEntry[]> {
  const filePath = resolveCodexSessionPath(sessionId, codexHome);
  if (!filePath) return [];

  try {
    const t0 = performance.now();
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const t1 = performance.now();
    const entries: JsonlEntry[] = [];

    // Track which response_item/message entries we've seen to avoid
    // duplicating with event_msg entries
    let hasResponseItemAssistantMsg = false;
    // Track developer role messages to mark as meta
    let lineStart = 0;
    let lineCount = 0;

    while (lineStart < raw.length) {
      const lineEnd = raw.indexOf("\n", lineStart);
      const end = lineEnd === -1 ? raw.length : lineEnd;
      if (end > lineStart) {
        lineCount++;
        try {
          const codexEntry = JSON.parse(raw.substring(lineStart, end));
          const converted = convertCodexEntry(codexEntry);
          if (converted) {
            entries.push(...converted);
            // Track if we have canonical assistant messages
            if (
              codexEntry.type === "response_item" &&
              codexEntry.payload?.type === "message" &&
              codexEntry.payload?.role === "assistant"
            ) {
              hasResponseItemAssistantMsg = true;
            }
          }
        } catch {
          // Skip malformed lines
        }
      }
      lineStart = end + 1;
    }
    const t2 = performance.now();
    console.error(
      `[codex-sessions] ${path.basename(filePath)} fileRead=${(t1 - t0).toFixed(0)}ms parse=${(t2 - t1).toFixed(0)}ms lines=${lineCount} entries=${entries.length}`,
    );

    return entries;
  } catch {
    return [];
  }
}

/**
 * Convert a single Codex JSONL entry to one or more Claude-format JsonlEntry[].
 * Returns null for entries that should be skipped.
 */
function convertCodexEntry(codexEntry: any): JsonlEntry[] | null {
  const { type, payload } = codexEntry;
  if (!payload) return null;

  switch (type) {
    case "response_item":
      return convertResponseItem(payload);
    case "event_msg":
      return convertEventMsg(payload);
    case "session_meta":
    case "turn_context":
      return null;
    default:
      return null;
  }
}

function convertResponseItem(payload: any): JsonlEntry[] | null {
  switch (payload.type) {
    case "message":
      return convertMessage(payload);
    case "function_call":
      return convertFunctionCall(payload);
    case "function_call_output":
      return convertFunctionCallOutput(payload);
    case "custom_tool_call":
      return convertCustomToolCall(payload);
    case "custom_tool_call_output":
      return convertCustomToolCallOutput(payload);
    case "reasoning":
      return convertReasoning(payload);
    default:
      return null;
  }
}

function convertMessage(payload: any): JsonlEntry[] | null {
  const { role, content } = payload;
  if (!content || !Array.isArray(content)) return null;

  if (role === "developer") {
    // System instructions — skip (not useful in chat history)
    return null;
  }

  const claudeRole = role === "assistant" ? "assistant" : "user";
  const claudeType = role === "assistant" ? "assistant" : "user";

  // Convert content blocks
  const blocks = convertContentBlocks(content);
  if (blocks.length === 0) return null;

  // Mark system context messages as meta so they don't show in chat
  const isMeta =
    role === "user" &&
    blocks.length === 1 &&
    blocks[0].type === "text" &&
    (blocks[0].text.startsWith("<environment_context>") ||
      blocks[0].text.startsWith("<permissions") ||
      blocks[0].text.startsWith("# AGENTS.md") ||
      blocks[0].text.startsWith("# Global Instructions"));

  return [
    {
      type: claudeType,
      message: { role: claudeRole, content: blocks },
      ...(isMeta ? { isMeta: true } : {}),
    } as JsonlEntry,
  ];
}

function convertFunctionCall(payload: any): JsonlEntry[] | null {
  const { name, arguments: args, call_id } = payload;

  let input: unknown;
  try {
    input = JSON.parse(args);
  } catch {
    input = { raw: args };
  }

  return [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: call_id, name, input }],
      },
    } as JsonlEntry,
  ];
}

function convertFunctionCallOutput(payload: any): JsonlEntry[] | null {
  const { call_id, output } = payload;

  return [
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: call_id, content: output }],
      },
    } as JsonlEntry,
  ];
}

function convertCustomToolCall(payload: any): JsonlEntry[] | null {
  const { name, input, call_id } = payload;

  return [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: call_id, name, input: { raw: input } }],
      },
    } as JsonlEntry,
  ];
}

function convertCustomToolCallOutput(payload: any): JsonlEntry[] | null {
  const { call_id, output } = payload;

  return [
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: call_id, content: output }],
      },
    } as JsonlEntry,
  ];
}

function convertReasoning(payload: any): JsonlEntry[] | null {
  // Reasoning entries have summary text (unencrypted) and/or encrypted_content
  const summaryText = payload.summary
    ?.filter((s: any) => s?.type === "summary_text")
    .map((s: any) => s.text)
    .join("\n");

  if (!summaryText) return null;

  return [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: summaryText }],
      },
    } as JsonlEntry,
  ];
}

function convertEventMsg(payload: any): JsonlEntry[] | null {
  switch (payload.type) {
    case "agent_message":
      // Skip — response_item/message with role=assistant is the canonical source
      return null;
    case "agent_reasoning":
      // Skip — response_item/reasoning is the canonical source
      return null;
    case "user_message":
      // Skip — response_item/message with role=user is the canonical source
      return null;
    case "token_count":
      return null;
    default:
      return null;
  }
}

/**
 * Convert Codex content block types to Claude content block types.
 *   input_text  → text
 *   output_text → text
 *   input_image → image (base64 data URI)
 */
function convertContentBlocks(content: any[]): any[] {
  const blocks: any[] = [];

  for (const c of content) {
    if (!c || typeof c !== "object") continue;

    switch (c.type) {
      case "input_text":
        if (c.text) blocks.push({ type: "text", text: c.text });
        break;
      case "output_text":
        if (c.text) blocks.push({ type: "text", text: c.text });
        break;
      case "input_image": {
        // Codex stores images as data URIs: "data:image/png;base64,..."
        const url = c.image_url ?? "";
        const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (match) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          });
        }
        break;
      }
      default:
        // Pass through unknown types as-is
        if (c.text) blocks.push({ type: "text", text: c.text });
        break;
    }
  }

  return blocks;
}

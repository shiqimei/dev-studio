/**
 * Parse JSONL conversation files from disk.
 * No SDK dependencies — pure filesystem access.
 */
import * as fs from "node:fs";
import { getSessionJsonlPath } from "./paths.js";
import type { HistoryMessage, JsonlEntry } from "./types.js";

/**
 * Reads a session's JSONL conversation file and extracts user/assistant messages.
 * Returns an empty array if the file is missing or malformed.
 */
export function readSessionHistory(projectDir: string, sessionId: string): HistoryMessage[] {
  const jsonlPath = getSessionJsonlPath(projectDir, sessionId);
  try {
    const raw = fs.readFileSync(jsonlPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const messages: HistoryMessage[] = [];

    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.type === "user" && entry.message?.content) {
        const content = entry.message.content;
        let text: string;
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
        } else {
          continue;
        }
        if (text && !entry.isMeta) {
          messages.push({ role: "user", text });
        }
      } else if (entry.type === "assistant" && entry.message?.content) {
        const content = entry.message.content;
        if (!Array.isArray(content)) continue;
        const textParts = content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
        if (textParts && textParts !== "(no content)") {
          messages.push({ role: "assistant", text: textParts });
        }
      }
    }

    return messages;
  } catch {
    return [];
  }
}

/** Entry types to include when reading full session history. */
const CONTENT_ENTRY_TYPES = new Set(["user", "assistant", "system", "result"]);

/**
 * Reads a session's JSONL conversation file and returns the raw parsed entries.
 * Includes user, assistant, system, and result entries with all content blocks preserved.
 * Filters out control messages, stream_events, keep_alive, etc.
 */
export function readSessionHistoryFull(projectDir: string, sessionId: string): JsonlEntry[] {
  const jsonlPath = getSessionJsonlPath(projectDir, sessionId);
  try {
    const raw = fs.readFileSync(jsonlPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const entries: JsonlEntry[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JsonlEntry;
        if (CONTENT_ENTRY_TYPES.has(entry.type)) {
          entries.push(entry);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  } catch {
    return [];
  }
}

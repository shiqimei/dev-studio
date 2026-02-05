/**
 * Parse JSONL conversation files from disk.
 * No SDK dependencies — pure filesystem access.
 */
import * as fs from "node:fs";
import { getSessionJsonlPath } from "./paths.js";
import type { HistoryMessage } from "./types.js";

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

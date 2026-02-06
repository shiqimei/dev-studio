/**
 * Scan subagent directories for a given session.
 * No SDK dependencies — pure filesystem access.
 */
import * as fs from "node:fs";
import { getSubagentsDir } from "./paths.js";
import type { SubagentMeta, SubagentType } from "./types.js";

/** Internal agent filename patterns to filter out. */
const INTERNAL_PATTERNS = ["compact", "prompt_suggestion"];

/**
 * Extract the task prompt from a JSONL entry's message content.
 * Returns the first 120 characters of the text content.
 */
function extractTaskPrompt(entry: any): string {
  const content = entry?.message?.content;
  if (!content) return "";
  if (typeof content === "string") return content.slice(0, 120);
  if (Array.isArray(content)) {
    const textBlock = content.find((c: any) => c.type === "text");
    return (textBlock?.text ?? "").slice(0, 120);
  }
  return "";
}

/** Tools that indicate a code/general-purpose agent. */
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/**
 * Infer the subagent type from the set of tools it used.
 * - Has Edit/Write → "code" (general-purpose)
 * - Only Bash → "bash"
 * - Only read tools (Glob, Grep, Read, etc.) → "explore"
 * - Fallback → "agent"
 */
function inferAgentType(filePath: string): SubagentType {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const tools = new Set<string>();
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "assistant") continue;
        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type === "tool_use" && block.name) {
            tools.add(block.name);
          }
        }
      } catch { /* skip */ }
    }

    if (tools.size === 0) return "agent";
    for (const t of tools) {
      if (WRITE_TOOLS.has(t)) return "code";
    }
    if (tools.size === 1 && tools.has("Bash")) return "bash";
    return "explore";
  } catch {
    return "agent";
  }
}

/**
 * Reads subagent metadata for a given session.
 * Scans {projectDir}/{sessionId}/subagents/ for agent-*.jsonl files,
 * reads the first line of each to extract metadata.
 * Filters out internal agents (compact, prompt_suggestion).
 * Returns results sorted by timestamp ascending.
 */
export function readSubagents(projectDir: string, sessionId: string): SubagentMeta[] {
  const dir = getSubagentsDir(projectDir, sessionId);
  try {
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir).filter(
      (f) => f.startsWith("agent-") && f.endsWith(".jsonl"),
    );

    const results: SubagentMeta[] = [];

    for (const filename of files) {
      // Filter out internal agents
      if (INTERNAL_PATTERNS.some((p) => filename.includes(p))) continue;

      const filePath = `${dir}/${filename}`;

      try {
        const fd = fs.openSync(filePath, "r");
        const buf = Buffer.alloc(8192);
        const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
        fs.closeSync(fd);

        const chunk = buf.toString("utf-8", 0, bytesRead);
        const firstLine = chunk.split("\n")[0];
        if (!firstLine) continue;

        const entry = JSON.parse(firstLine);
        const agentId = entry.agentId ?? filename.replace(/^agent-/, "").replace(/\.jsonl$/, "");
        const timestamp = entry.timestamp ?? "";
        const taskPrompt = extractTaskPrompt(entry);
        const agentType = inferAgentType(filePath);

        results.push({
          agentId,
          parentSessionId: sessionId,
          filename,
          timestamp,
          taskPrompt,
          agentType,
        });
      } catch {
        // Skip malformed files
      }
    }

    return results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch {
    return [];
  }
}

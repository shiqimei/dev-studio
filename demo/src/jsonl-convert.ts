/**
 * Convert raw JSONL entries into ChatEntry[] for the UI.
 * This is the only conversion needed — the output format mirrors the JSONL structure.
 */
import type {
  ChatEntry,
  MessageEntry,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ImageBlock,
} from "./types";

let nextId = 0;
function uid(): string {
  return "h" + nextId++;
}

/**
 * Generate a human-readable title for a tool_use block from its name and input.
 */
export function toolTitle(name: string, input: unknown): string {
  const inp = input as Record<string, unknown> | null;
  if (!inp) return "";

  // Return just the argument — the tool name is shown in the badge
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return shortPath(inp.file_path as string);
    case "Bash":
      return truncate(String(inp.command ?? ""), 60);
    case "Glob":
      return truncate(String(inp.pattern ?? ""), 60);
    case "Grep":
      return truncate(String(inp.pattern ?? ""), 60);
    case "Task":
      return truncate(String(inp.description ?? ""), 60);
    case "WebSearch":
      return truncate(String(inp.query ?? ""), 60);
    case "WebFetch":
      return truncate(String(inp.url ?? ""), 60);
    case "TaskCreate":
      return truncate(String(inp.subject ?? ""), 80);
    case "TaskUpdate": {
      const parts: string[] = [];
      if (inp.taskId) parts.push(`#${inp.taskId}`);
      if (inp.status) parts.push(String(inp.status));
      if (inp.subject) parts.push(truncate(String(inp.subject), 50));
      return parts.join(" — ") || "";
    }
    case "TaskGet":
      return inp.taskId ? `#${inp.taskId}` : "";
    case "TaskList":
      return "";
    case "TodoWrite":
      return truncate(String(inp.todos ? `${(inp.todos as unknown[]).length} items` : ""), 60);
    default:
      return "";
  }
}

function shortPath(p: unknown): string {
  if (typeof p !== "string") return "";
  const parts = p.split("/");
  return parts.length > 2 ? ".../" + parts.slice(-2).join("/") : p;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/**
 * Convert a JSONL content array to ContentBlock[].
 */
function convertContentBlocks(content: unknown): ContentBlock[] {
  // User messages can have string content
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];

  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const block = c as Record<string, unknown>;

    switch (block.type) {
      case "text": {
        const text = String(block.text ?? "").trim();
        if (text && text !== "(no content)") {
          blocks.push({ type: "text", text: String(block.text) });
        }
        break;
      }
      case "thinking": {
        const thinking = String(block.thinking ?? "").trim();
        if (thinking) {
          blocks.push({ type: "thinking", thinking: String(block.thinking) });
        }
        break;
      }
      case "tool_use":
        blocks.push({
          type: "tool_use",
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          input: block.input,
          title: toolTitle(String(block.name ?? ""), block.input),
          status: "completed", // In history, tool calls have already completed
        });
        break;
      case "tool_result":
        blocks.push({
          type: "tool_result",
          tool_use_id: String(block.tool_use_id ?? ""),
          content: block.content,
          is_error: Boolean(block.is_error),
        });
        break;
      case "image": {
        // JSONL uses nested source: { type: "base64", media_type, data }
        const src = block.source as Record<string, unknown> | undefined;
        const data = String(src?.data ?? block.data ?? "");
        const mimeType = String(
          src?.media_type ?? block.mimeType ?? block.media_type ?? "image/png",
        );
        if (data) {
          blocks.push({ type: "image", data, mimeType });
        }
        break;
      }
    }
  }

  return blocks;
}

/**
 * Convert raw JSONL entries to ChatEntry[] for the UI.
 *
 * Key behaviors:
 * - Consecutive assistant JSONL entries are merged into a single turn (MessageEntry)
 *   because the SDK writes one entry per content block during streaming.
 * - User entries whose content is entirely tool_result blocks are treated as tool results
 *   and merged into the preceding assistant turn's matching tool_use blocks.
 * - A non-meta user entry or system entry breaks the current assistant turn.
 */
export function jsonlToEntries(rawEntries: unknown[]): ChatEntry[] {
  const entries: ChatEntry[] = [];

  /** Get or create the current assistant turn (last entry if it's an assistant message). */
  function currentAssistantTurn(): MessageEntry | null {
    const last = entries[entries.length - 1];
    if (last && last.type === "message" && last.role === "assistant") return last;
    return null;
  }

  for (const raw of rawEntries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;

    switch (entry.type) {
      case "user": {
        const message = entry.message as { role: string; content: unknown } | undefined;
        if (!message?.content) break;
        const content = convertContentBlocks(message.content);
        if (content.length === 0) break;

        // Detect tool result entries: content is entirely tool_result blocks.
        // The SDK doesn't always set isMeta, so we detect by content shape.
        const isToolResult = content.every((b) => b.type === "tool_result");
        if (isToolResult) {
          mergeToolResults(entries, content);
        } else {
          entries.push({
            type: "message",
            id: uid(),
            role: "user",
            content,
          });
        }
        break;
      }

      case "assistant": {
        const message = entry.message as { role: string; content: unknown } | undefined;
        if (!message?.content) break;
        const content = convertContentBlocks(message.content);
        if (content.length === 0) break;

        // Merge into the current assistant turn if one exists
        const turn = currentAssistantTurn();
        if (turn) {
          turn.content.push(...content);
        } else {
          entries.push({
            type: "message",
            id: uid(),
            role: "assistant",
            content,
          });
        }
        break;
      }

      case "system": {
        const subtype = String(entry.subtype ?? "");
        // Skip system entries that aren't useful for the chat view
        if (subtype === "compact_boundary" || subtype === "files_persisted") break;

        let text: string;
        if (subtype === "init") {
          text = `Session initialized (${String(entry.session_id ?? "").slice(0, 8)}...)`;
        } else if (subtype === "turn_duration") {
          const ms = Number((entry as any).durationMs ?? 0);
          text = ms > 0 ? `Duration: ${formatDuration(ms)}` : "";
        } else if (subtype === "api_error") {
          const attempt = (entry as any).retryAttempt ?? "?";
          text = `API error (retry ${attempt})`;
        } else if (subtype === "stop_hook_summary") {
          // Skip stop hook summaries — they're internal
          text = "";
        } else if (subtype === "status") {
          text = String((entry as any).status ?? "");
        } else {
          text = `[${subtype}]`;
        }

        if (text) {
          entries.push({ type: "system", id: uid(), text });
        }
        break;
      }

      case "result": {
        if ((entry as any).is_error) {
          const errors = (entry as any).errors;
          const text = Array.isArray(errors) ? errors.join("; ") : String(entry.result ?? "Error");
          entries.push({ type: "system", id: uid(), text: `Error: ${text}` });
        }
        // Non-error results are end-of-turn markers, no need to display
        break;
      }
    }
  }

  return entries;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

/**
 * Merge tool_result content blocks into the preceding assistant turn's matching tool_use blocks.
 */
function mergeToolResults(entries: ChatEntry[], resultBlocks: ContentBlock[]): void {
  // Find the most recent assistant turn
  let lastAssistant: MessageEntry | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "message" && e.role === "assistant") {
      lastAssistant = e;
      break;
    }
  }
  if (!lastAssistant) return;

  for (const block of resultBlocks) {
    if (block.type !== "tool_result") continue;
    const toolUse = lastAssistant.content.find(
      (b): b is ToolUseBlock => b.type === "tool_use" && b.id === block.tool_use_id,
    );
    if (toolUse) {
      toolUse.status = block.is_error ? "failed" : "completed";
      // Extract text from tool result content for display
      toolUse.result = extractResultText(block.content);
    }
  }
}

function extractResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text" || typeof c === "string")
      .map((c: any) => (typeof c === "string" ? c : c.text ?? ""))
      .join("\n");
  }
  return "";
}

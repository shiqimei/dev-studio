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
 * Map raw tool names to pretty display names for the badge.
 */
export function prettyToolName(name: string): string {
  if (name.startsWith("mcp__claude-in-chrome__")) return "Browser";
  // Strip mcp__acp__ prefix (case-insensitive) → just the tool name
  if (/^mcp__acp__/i.test(name)) {
    return name.replace(/^mcp__acp__/i, "");
  }
  if (name.startsWith("mcp__")) {
    // mcp__server__tool → Server:Tool
    const parts = name.slice(5).split("__");
    return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(":");
  }
  // Strip ACP: prefix (case-insensitive, e.g. "ACP:READ" → "Read")
  if (/^acp:/i.test(name)) {
    const base = name.slice(4);
    return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
  }
  return name;
}

/**
 * Generate a human-readable title for a tool_use block from its name and input.
 */
export function toolTitle(name: string, input: unknown): string {
  const inp = input as Record<string, unknown> | null;
  if (!inp) return "";

  // Normalize ACP-prefixed names (case-insensitive):
  // "mcp__acp__Read" → "Read", "ACP:READ" → "Read"
  let normalized = name;
  if (/^mcp__acp__/i.test(name)) {
    normalized = name.replace(/^mcp__acp__/i, "");
  } else if (/^acp:/i.test(name)) {
    normalized = name.slice(4).charAt(0).toUpperCase() + name.slice(5).toLowerCase();
  }

  // Return just the argument — the tool name is shown in the badge
  switch (normalized) {
    case "Read":
    case "Write":
    case "Edit":
      return shortPath(inp.file_path as string);
    case "Bash":
      return String(inp.command ?? "");
    case "Glob":
      return String(inp.pattern ?? "");
    case "Grep":
      return String(inp.pattern ?? "");
    case "Task":
      return String(inp.description ?? "");
    case "WebSearch":
      return String(inp.query ?? "");
    case "WebFetch":
      return String(inp.url ?? "");
    case "TaskCreate":
      return String(inp.subject ?? "");
    case "TaskUpdate": {
      const parts: string[] = [];
      if (inp.taskId) parts.push(`#${inp.taskId}`);
      if (inp.status) parts.push(String(inp.status));
      if (inp.subject) parts.push(String(inp.subject));
      return parts.join(" — ") || "";
    }
    case "TaskGet":
      return inp.taskId ? `#${inp.taskId}` : "";
    case "TaskList":
      return "";
    case "TodoWrite":
      return inp.todos ? `${(inp.todos as unknown[]).length} items` : "";
    default:
      // MCP browser tools
      if (name.startsWith("mcp__claude-in-chrome__")) {
        return browserToolTitle(name, inp);
      }
      return "";
  }
}

function browserToolTitle(name: string, inp: Record<string, unknown>): string {
  const tool = name.replace("mcp__claude-in-chrome__", "");
  switch (tool) {
    case "computer": {
      const action = String(inp.action ?? "");
      if (action === "screenshot") return "screenshot";
      if (action === "left_click" || action === "right_click" || action === "double_click") {
        const coord = inp.coordinate as number[] | undefined;
        return coord ? `${action} (${coord[0]}, ${coord[1]})` : action;
      }
      if (action === "type") return `type "${String(inp.text ?? "")}"`;
      if (action === "scroll") return `scroll ${inp.scroll_direction ?? ""}`;
      if (action === "key") return `key ${String(inp.text ?? "")}`;
      if (action === "wait") return `wait ${inp.duration ?? ""}s`;
      if (action === "zoom") return "zoom";
      return action;
    }
    case "navigate":
      return String(inp.url ?? "");
    case "read_page":
      return inp.filter ? String(inp.filter) : "read page";
    case "find":
      return String(inp.query ?? "");
    case "javascript_tool":
      return String(inp.text ?? "");
    case "form_input":
      return `set ${inp.ref ?? ""} = ${String(inp.value ?? "")}`;
    case "tabs_context_mcp":
    case "tabs_create_mcp":
      return "";
    case "get_page_text":
      return "extract text";
    default:
      return tool.replace(/_/g, " ");
  }
}

function shortPath(p: unknown): string {
  if (typeof p !== "string") return "";
  const parts = p.split("/");
  return parts.length > 2 ? ".../" + parts.slice(-2).join("/") : p;
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
      case "tool_use": {
        const rawName = String(block.name ?? "");
        blocks.push({
          type: "tool_use",
          id: String(block.id ?? ""),
          name: prettyToolName(rawName),
          input: block.input,
          title: toolTitle(rawName, block.input),
          status: "completed",
        });
        break;
      }
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

  // Accumulate turn_duration stats across multiple SDK calls within a single user turn.
  // Only emit a single turn_completed at the boundary (next user message or end of entries).
  let pendingTurnMs = 0;
  let pendingTurnOutputTokens: number | undefined;
  let pendingTurnThinkingMs: number | undefined;
  let pendingTurnCostUsd: number | undefined;

  function flushPendingTurn() {
    if (pendingTurnMs > 0) {
      entries.push({
        type: "turn_completed",
        id: uid(),
        durationMs: pendingTurnMs,
        ...(pendingTurnOutputTokens != null && { outputTokens: pendingTurnOutputTokens }),
        ...(pendingTurnThinkingMs != null && { thinkingDurationMs: pendingTurnThinkingMs }),
        ...(pendingTurnCostUsd != null && { costUsd: pendingTurnCostUsd }),
      });
      pendingTurnMs = 0;
      pendingTurnOutputTokens = undefined;
      pendingTurnThinkingMs = undefined;
      pendingTurnCostUsd = undefined;
    }
  }

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
          // New user turn boundary — flush any accumulated turn stats from the previous turn
          flushPendingTurn();
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

        // Extract plan entries from TodoWrite tool_use blocks for the sidecar
        const rawContent = message.content as Array<Record<string, unknown>>;
        if (Array.isArray(rawContent)) {
          for (const block of rawContent) {
            if (block?.type === "tool_use" && block.name === "TodoWrite") {
              const input = block.input as Record<string, unknown> | undefined;
              if (Array.isArray(input?.todos)) {
                entries.push({
                  type: "plan",
                  id: uid(),
                  entries: (input.todos as Array<{ content: string; status: string }>).map((t) => ({
                    content: String(t.content ?? ""),
                    status: (t.status as "pending" | "in_progress" | "completed") ?? "pending",
                  })),
                });
              }
            }
          }
        }
        break;
      }

      case "system": {
        const subtype = String(entry.subtype ?? "");
        // Skip system entries that aren't useful for the chat view
        if (subtype === "compact_boundary" || subtype === "files_persisted" || subtype === "init" || subtype === "stop_hook_summary") break;

        let text: string;
        if (subtype === "turn_duration") {
          const ms = Number((entry as any).durationMs ?? 0);
          if (ms > 0) {
            const e = entry as any;
            pendingTurnMs += ms;
            if (e.outputTokens != null) {
              pendingTurnOutputTokens = (pendingTurnOutputTokens ?? 0) + Number(e.outputTokens);
            }
            if (e.thinkingDurationMs != null) {
              pendingTurnThinkingMs = (pendingTurnThinkingMs ?? 0) + Number(e.thinkingDurationMs);
            }
            if (e.costUsd != null) {
              pendingTurnCostUsd = (pendingTurnCostUsd ?? 0) + Number(e.costUsd);
            }
          }
          break;
        } else if (subtype === "api_error") {
          const attempt = (entry as any).retryAttempt ?? "?";
          text = `API error (retry ${attempt})`;
        } else if (subtype === "stop_hook_summary") {
          // Skip stop hook summaries — they're internal
          text = "";
        } else if (subtype === "status") {
          text = String((entry as any).status ?? "");
        } else if (subtype === "local_command") {
          text = formatLocalCommand(String((entry as any).content ?? ""));
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

  // Flush any remaining accumulated turn stats (last turn in the session)
  flushPendingTurn();

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

/** Extract display text from local_command content XML. */
function formatLocalCommand(content: string): string {
  // Command invocation: <command-name>/foo</command-name> <command-args>bar</command-args>
  const nameMatch = content.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (nameMatch) {
    const name = nameMatch[1].trim();
    const argsMatch = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const args = argsMatch ? argsMatch[1].trim() : "";
    return args ? `${name} ${args}` : name;
  }
  // Stdout response: <local-command-stdout>...</local-command-stdout>
  const stdoutMatch = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (stdoutMatch) {
    const out = stdoutMatch[1].trim();
    return out || "";
  }
  // Caveat: <local-command-caveat>...</local-command-caveat>
  const caveatMatch = content.match(/<local-command-caveat>([\s\S]*?)<\/local-command-caveat>/);
  if (caveatMatch) return caveatMatch[1].trim();
  // Fallback: strip all tags
  return content.replace(/<[^>]+>/g, "").trim();
}

/**
 * Merge tool_result content blocks into the preceding assistant turn's matching tool_use blocks.
 */
function mergeToolResults(entries: ChatEntry[], resultBlocks: ContentBlock[]): void {
  for (const block of resultBlocks) {
    if (block.type !== "tool_result") continue;
    // Search backwards through ALL assistant turns to find the matching tool_use.
    // Background tasks (e.g. Task tool) can have their results arrive many turns
    // later, so the tool_use may not be in the most recent assistant turn.
    let toolUse: ToolUseBlock | undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type !== "message" || e.role !== "assistant") continue;
      toolUse = e.content.find(
        (b): b is ToolUseBlock => b.type === "tool_use" && b.id === block.tool_use_id,
      );
      if (toolUse) break;
    }
    if (toolUse) {
      toolUse.status = block.is_error ? "failed" : "completed";
      // Extract text from tool result content for display
      toolUse.result = extractResultText(block.content);
      // Link Task tool calls to their sub-agent session
      if (toolUse.name === "Task" && toolUse.result) {
        toolUse.agentId = extractAgentId(toolUse.result);
      }
    }
  }
}

function extractResultText(content: unknown): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((c: any) => c?.type === "text" || typeof c === "string")
      .map((c: any) => (typeof c === "string" ? c : c.text ?? ""))
      .join("\n");
  } else {
    return "";
  }
  return text;
}

/**
 * Generate a short overview from a tool's result content.
 * Used as a fallback title when the input-derived title is empty.
 */
export function toolOverview(kind: string, content: string): string {
  if (!content) return "";

  switch (kind) {
    case "SendMessage": {
      try {
        const msg = JSON.parse(content);
        const from = msg.from || msg.sender || "";
        const to = msg.recipient || msg.to || "";
        const text = msg.content || msg.message || "";
        if (from && to && text) {
          const preview = text.length > 50 ? text.slice(0, 50) + "..." : text;
          return `${from} → @${to}: ${preview}`;
        }
      } catch {
        // Not JSON — ignore
      }
      return "";
    }

    case "TaskList": {
      const matches = [...content.matchAll(/#\d+\s+\[(\w+)\]/g)];
      if (matches.length === 0) return "";
      const total = matches.length;
      const completed = matches.filter((m) => m[1] === "completed").length;
      if (completed > 0) return `${total} tasks, ${completed} completed`;
      return `${total} tasks`;
    }

    default:
      return "";
  }
}

/** Extract agentId from Task tool result text (e.g. "agentId: a8ce50f"). */
export function extractAgentId(text: string): string | undefined {
  const m = text.match(/agentId:\s*(\w+)/);
  return m ? m[1] : undefined;
}

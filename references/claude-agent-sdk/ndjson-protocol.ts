/**
 * Claude Agent SDK v0.2.25 — NDJSON Protocol Reference
 *
 * The SDK communicates with the Claude Code CLI via a bidirectional NDJSON
 * (newline-delimited JSON) protocol over stdin/stdout of a child process.
 *
 * ─── Architecture ────────────────────────────────────────────────────────
 *
 *   SDK (sdk.mjs / our ACP agent)
 *     │
 *     ├──spawn──► CLI (cli.js) as child_process
 *     │           Flags: -p --output-format stream-json --input-format stream-json --verbose
 *     │
 *     ├──stdin──► User messages + Control requests (NDJSON)
 *     │
 *     ◄──stdout── SDKMessages + Control responses (NDJSON)
 *
 *   Each line is a complete JSON object terminated by \n.
 *   JSON.stringify(msg) + "\n" for writing, readline + JSON.parse for reading.
 *
 * ─── Message Categories ──────────────────────────────────────────────────
 *
 *   1. CONTENT MESSAGES (yielded to consumer via AsyncGenerator)
 *      - assistant     — Full assistant message with content blocks
 *      - user          — User/tool_result message
 *      - result        — Session result (success/error), signals end of turn
 *      - stream_event  — Partial streaming chunk (BetaRawMessageStreamEvent)
 *      - system        — System messages (init, task_notification, compact_boundary, hooks, status, files_persisted)
 *      - tool_progress — Long-running tool progress (elapsed time)
 *      - tool_use_summary — Collapsed tool use summaries
 *      - auth_status   — Authentication status updates
 *
 *   2. CONTROL MESSAGES (handled internally, not yielded)
 *      - control_request   — Request/response pair (SDK↔CLI, bidirectional)
 *      - control_response  — Response to a control_request
 *      - control_cancel_request — Cancel an in-progress control_request
 *      - keep_alive        — Heartbeat (ignored)
 *
 * ─── Content Message Details ─────────────────────────────────────────────
 */

// ── stdin → CLI (SDK writes these) ──

/** User message sent to CLI */
export interface StdinUserMessage {
  type: "user";
  session_id: string;
  message: {
    role: "user";
    content: Array<{ type: "text"; text: string } | { type: "tool_result"; tool_use_id: string; content: any }>;
  };
  parent_tool_use_id: string | null;
}

/** Control request (SDK → CLI) */
export interface StdinControlRequest {
  type: "control_request";
  request_id: string;
  request: ControlRequestPayload;
}

/** Control response (SDK → CLI, responding to CLI's control_request) */
export interface StdinControlResponse {
  type: "control_response";
  response: {
    subtype: "success" | "error";
    request_id: string;
    response?: any;
    error?: string;
  };
}

// ── stdout ← CLI (SDK reads these) ──

/** Assistant message with content blocks */
export interface StdoutAssistantMessage {
  type: "assistant";
  message: {
    role: "assistant";
    model: string;
    content: Array<
      | { type: "text"; text: string }
      | { type: "thinking"; thinking: string }
      | { type: "tool_use"; id: string; name: string; input: any }
      | { type: "tool_result"; tool_use_id: string; content: any }
    >;
  };
  parent_tool_use_id: string | null; // links sub-agent messages to parent Task's toolUseId
  uuid: string;
  session_id: string;
}

/** Streaming chunk (partial message) */
export interface StdoutStreamEvent {
  type: "stream_event";
  event: any; // BetaRawMessageStreamEvent from Anthropic API
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}

/** System message (various subtypes) */
export type StdoutSystemMessage =
  | { type: "system"; subtype: "init"; session_id: string; /* commands, models, account */ }
  | { type: "system"; subtype: "task_notification"; task_id: string; status: "completed" | "failed" | "stopped"; output_file: string; summary: string }
  | { type: "system"; subtype: "compact_boundary" }
  | { type: "system"; subtype: "status"; status: string }
  | { type: "system"; subtype: "hook_started"; tool_use_id: string; hook_id: string }
  | { type: "system"; subtype: "hook_progress"; tool_use_id: string; hook_id: string; progress: string }
  | { type: "system"; subtype: "hook_response"; tool_use_id: string; hook_id: string; response: any }
  | { type: "system"; subtype: "files_persisted"; files: Array<{ filename: string; file_id: string }> };

/** Result message (end of turn) */
export type StdoutResultMessage =
  | { type: "result"; subtype: "success"; result: string; is_error: boolean; session_id: string }
  | { type: "result"; subtype: "error_during_execution"; errors: string[]; is_error: boolean }
  | { type: "result"; subtype: "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries"; errors: string[]; is_error: boolean };

/** Tool progress (long-running tools like Bash) */
export interface StdoutToolProgress {
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  session_id: string;
  uuid: string;
}

/** Tool use summary (collapsed tool descriptions) */
export interface StdoutToolUseSummary {
  type: "tool_use_summary";
  summary: string;
  preceding_tool_use_ids: string[];
  uuid: string;
  session_id: string;
}

// ── Control Request Subtypes ─────────────────────────────────────────

export type ControlRequestPayload =
  // SDK → CLI
  | { subtype: "initialize"; hooks?: any; sdkMcpServers?: string[]; jsonSchema?: any; systemPrompt?: string; appendSystemPrompt?: string; agents?: any }
  | { subtype: "interrupt" }
  | { subtype: "set_permission_mode"; mode: string }
  | { subtype: "set_model"; model?: string }
  | { subtype: "set_max_thinking_tokens"; max_thinking_tokens: number | null }
  | { subtype: "rewind_files"; user_message_id: string; dry_run?: boolean }
  | { subtype: "mcp_status" }
  | { subtype: "mcp_reconnect"; serverName: string }
  | { subtype: "mcp_toggle"; serverName: string; enabled: boolean }
  | { subtype: "mcp_set_servers"; servers: Record<string, any> }
  | { subtype: "mcp_message"; server_name: string; message: any }
  // CLI → SDK
  | { subtype: "can_use_tool"; tool_name: string; input: any; tool_use_id: string; agent_id?: string; permission_suggestions?: any; blocked_path?: string; decision_reason?: string }
  | { subtype: "hook_callback"; callback_id: string; input: any; tool_use_id: string };

/**
 * ─── Complete Protocol Flow ──────────────────────────────────────────
 *
 *  SDK                                          CLI (claude code)
 *  ───                                          ────────────────
 *
 *  1. spawn(node cli.js --output-format stream-json --input-format stream-json --verbose ...)
 *
 *  2. stdin:  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]},...}
 *
 *  3. stdin:  {"type":"control_request","request_id":"abc","request":{"subtype":"initialize","hooks":...}}
 *     stdout: {"type":"control_response","response":{"request_id":"abc","subtype":"success","response":{"commands":[...],"models":[...],...}}}
 *
 *  4. stdout: {"type":"system","subtype":"init","session_id":"sess_123",...}
 *
 *  5. stdout: {"type":"stream_event","event":{"type":"content_block_start",...},"parent_tool_use_id":null,...}
 *     stdout: {"type":"stream_event","event":{"type":"content_block_delta",...},...}
 *     ...
 *
 *  6. stdout: {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"},{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]},...}
 *
 *  7. stdout: {"type":"control_request","request_id":"def","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},...}}
 *     stdin:  {"type":"control_response","response":{"request_id":"def","subtype":"success","response":{"allowed":true}}}
 *
 *  8. stdout: {"type":"tool_progress","tool_use_id":"tu_1","tool_name":"Bash","elapsed_time_seconds":2,...}
 *
 *  9. stdout: {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1",...}]},...}
 *
 * 10. stdout: {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done!"}]},...}
 *
 * 11. stdout: {"type":"result","subtype":"success","result":"Done!","is_error":false,...}
 *
 * 12. SDK closes stdin → CLI exits
 */

# Claude Code ACP -- Feature Compatibility Table

Tracks every Claude Code SDK feature and its ACP protocol support status.
Target: 100% feature coverage.

**Status legend:**
- `[✓]` -- Fully implemented
- `[~]` -- Partially implemented / no-op acknowledged
- `[ ]` -- Not implemented
- `[-]` -- Intentionally disabled

**Validation:** Every `[✓]` row should be demonstrable through `demo.ts` (`bun --hot demo.ts`).

---

## 1. SDK Message Types (16 content types + 4 control types)

Every subtype of `SDKMessage` yielded by the Query async generator or exchanged via control protocol.

### Content Messages (yielded to consumer)

| # | Message Type | Status | ACP Mapping | Notes |
|---|-------------|--------|-------------|-------|
| 1 | `SDKAssistantMessage` (type: `assistant`) | [✓] | `agent_message_chunk`, `tool_call` | Text, images, tool_use blocks extracted |
| 2 | `SDKUserMessage` (type: `user`) | [~] | Filtered | Synthetic/replay messages filtered; `/context` output forwarded |
| 3 | `SDKPartialAssistantMessage` (type: `stream_event`) | [✓] | `agent_message_chunk`, `agent_thought_chunk` | content_block_start/delta/stop, message_start/delta/stop |
| 4 | `SDKResultSuccess` (type: `result`, subtype: `success`) | [✓] | Stop reason `end_turn` | Result metadata extracted (cost, usage, duration) |
| 5 | `SDKResultError` (type: `result`, subtype: `error_*`) | [✓] | Stop reason varies | `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries` |
| 6 | `SDKSystemMessage` (type: `system`, subtype: `init`) | [✓] | Session init metadata | tools, model, permissionMode, mcp_servers, slash_commands |
| 7 | `SDKCompactBoundaryMessage` (type: `system`, subtype: `compact_boundary`) | [~] | No-op | Logged but not forwarded |
| 8 | `SDKStatusMessage` (type: `system`, subtype: `status`) | [~] | No-op | TODO: process via status API |
| 9 | `SDKHookStartedMessage` (type: `system`, subtype: `hook_started`) | [~] | No-op | Logged but not forwarded |
| 10 | `SDKHookProgressMessage` (type: `system`, subtype: `hook_progress`) | [~] | No-op | Logged but not forwarded |
| 11 | `SDKHookResponseMessage` (type: `system`, subtype: `hook_response`) | [~] | No-op | Logged but not forwarded |
| 12 | `SDKToolProgressMessage` (type: `tool_progress`) | [~] | Passthrough | elapsed_time_seconds for long-running tools |
| 13 | `SDKAuthStatusMessage` (type: `auth_status`) | [~] | Passthrough | isAuthenticating, output, error |
| 14 | `SDKTaskNotificationMessage` (type: `system`, subtype: `task_notification`) | [✓] | `tool_call_update` | Background task completion via SessionMessageRouter |
| 15 | `SDKFilesPersistedEvent` (type: `system`, subtype: `files_persisted`) | [~] | No-op | File checkpointing events |
| 16 | `SDKToolUseSummaryMessage` (type: `tool_use_summary`) | [~] | Passthrough | Collapsed tool descriptions |

### Control Messages (internal protocol)

| # | Message Type | Status | ACP Mapping | Notes |
|---|-------------|--------|-------------|-------|
| 17 | `SDKControlRequest` (type: `control_request`) | [✓] | Internal | SDK-to-CLI and CLI-to-SDK control flow |
| 18 | `SDKControlResponse` (type: `control_response`) | [✓] | Internal | Success and error responses |
| 19 | `SDKControlCancelRequest` (type: `control_cancel_request`) | [✓] | `cancel()` | Maps to ACP cancel |
| 20 | `SDKKeepAliveMessage` (type: `keep_alive`) | [~] | Internal | Not exposed to ACP |

---

## 2. SDK Tools (19 tools)

Every tool defined in `sdk-tools.d.ts` with input schemas.

| # | Tool | Background Support | ACP Mapping | Status | Notes |
|---|------|--------------------|-------------|--------|-------|
| 1 | `Task` (Agent) | Yes (`run_in_background`) | `mcp__acp__*` proxied | [✓] | Sub-agent dispatch; background via `run_in_background` |
| 2 | `TaskOutput` | N/A | Handled internally | [✓] | Poll/wait for background task output |
| 3 | `TaskStop` | N/A | Handled internally | [✓] | Terminate background task |
| 4 | `Bash` | Yes (`run_in_background`) | `mcp__acp__Bash` | [✓] | Proxied if `clientCapabilities.terminal` |
| 5 | `Read` | No | `mcp__acp__Read` | [✓] | Proxied if `clientCapabilities.fs.readTextFile` |
| 6 | `Write` | No | `mcp__acp__Write` | [✓] | Proxied if `clientCapabilities.fs.writeTextFile` |
| 7 | `Edit` | No | `mcp__acp__Edit` | [✓] | Proxied if `clientCapabilities.fs.writeTextFile` |
| 8 | `Glob` | No | Native (Claude Code) | [✓] | Runs inside Claude Code process |
| 9 | `Grep` | No | Native (Claude Code) | [✓] | Runs inside Claude Code process |
| 10 | `NotebookEdit` | No | Native (Claude Code) | [✓] | Runs inside Claude Code process |
| 11 | `WebFetch` | No | Native (Claude Code) | [✓] | Runs inside Claude Code process |
| 12 | `WebSearch` | No | Native (Claude Code) | [✓] | Runs inside Claude Code process |
| 13 | `TodoWrite` | No | `plan` notification | [✓] | Plan mode entries with status tracking |
| 14 | `ExitPlanMode` | No | Permission flow | [✓] | `canUseTool` callback |
| 15 | `AskUserQuestion` | No | N/A | [-] | Intentionally disabled; needs ACP-native UI mapping |
| 16 | `Config` | No | Native (Claude Code) | [✓] | Config read/write inside Claude Code |
| 17 | `ListMcpResources` | No | Native (Claude Code) | [✓] | MCP resource listing |
| 18 | `ReadMcpResource` | No | Native (Claude Code) | [✓] | MCP resource reading |
| 19 | `Skill` | No | Native (Claude Code) | [✓] | Slash command / skill invocation |

---

## 3. Query API Methods (14 methods)

Every method on the `Query` interface or `SDKSession`.

| # | Method | Status | ACP Mapping | Notes |
|---|--------|--------|-------------|-------|
| 1 | `query[Symbol.asyncIterator]()` / `next()` | [✓] | `prompt()` streaming | Wrapped in `SessionMessageRouter` |
| 2 | `interrupt()` | [✓] | `cancel()` | Sets cancelled flag, calls SDK interrupt |
| 3 | `setPermissionMode(mode)` | [✓] | `setSessionMode()` | Runtime mode switching |
| 4 | `setModel(model)` | [✓] | `unstable_setSessionModel()` | Runtime model switching |
| 5 | `setMaxThinkingTokens(n)` | [ ] | Not exposed | Could map to session option |
| 6 | `supportedCommands()` | [✓] | `available_commands_update` | Slash commands list |
| 7 | `supportedModels()` | [✓] | `newSession()` response | Returns model list with display info |
| 8 | `mcpServerStatus()` | [ ] | Not exposed | MCP server health |
| 9 | `reconnectMcpServer(name)` | [ ] | Not exposed | MCP reconnection |
| 10 | `toggleMcpServer(name, enabled)` | [ ] | Not exposed | MCP enable/disable |
| 11 | `setMcpServers(servers)` | [ ] | Not exposed | Dynamic MCP config |
| 12 | `accountInfo()` | [ ] | Not exposed | Email, org, subscription info |
| 13 | `rewindFiles(messageId, opts)` | [ ] | Not exposed | File state rewinding |
| 14 | `close()` | [✓] | Session cleanup | Forceful termination |
| 15 | `streamInput(stream)` | [✓] | Multi-turn `prompt()` | Async message stream input |

### V2 Session API

| # | Method | Status | ACP Mapping | Notes |
|---|--------|--------|-------------|-------|
| 16 | `unstable_v2_createSession()` | [ ] | Not used | V2 multi-turn session API |
| 17 | `unstable_v2_prompt()` | [ ] | Not used | V2 one-shot prompt |
| 18 | `unstable_v2_resumeSession()` | [ ] | Not used | V2 session resume |
| 19 | `SDKSession.send()` | [ ] | Not used | V2 send message |
| 20 | `SDKSession.stream()` | [ ] | Not used | V2 stream messages |

---

## 4. Session Options (40+ fields)

Every field in `Options` (v1 API) and `SDKSessionOptions` (v2 API).

### Session Control

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 1 | `prompt` | [✓] | User input from ACP `prompt()` |
| 2 | `abortController` | [✓] | Used for `cancel()` |
| 3 | `continue` | [✓] | Continue conversation |
| 4 | `resume` | [✓] | Session ID to resume |
| 5 | `resumeSessionAt` | [ ] | Resume at specific message UUID |
| 6 | `forkSession` | [✓] | Fork resumed session |
| 7 | `persistSession` | [✓] | Default true |

### Model and Cost

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 8 | `model` | [✓] | Passed through to SDK |
| 9 | `fallbackModel` | [ ] | Not exposed |
| 10 | `maxTurns` | [✓] | Passed through to SDK |
| 11 | `maxBudgetUsd` | [ ] | Not exposed |
| 12 | `maxThinkingTokens` | [✓] | Via `MAX_THINKING_TOKENS` env var |

### Tools and Permissions

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 13 | `tools` | [✓] | Preset `claude_code` |
| 14 | `allowedTools` | [✓] | Based on client capabilities |
| 15 | `disallowedTools` | [✓] | Disabled tools + AskUserQuestion |
| 16 | `canUseTool` | [✓] | Permission callback for plan/edit flows |
| 17 | `permissionMode` | [✓] | default, acceptEdits, plan, dontAsk, bypassPermissions |
| 18 | `allowDangerouslySkipPermissions` | [✓] | True if non-root |
| 19 | `permissionPromptToolName` | [ ] | MCP tool for permission prompts |

### Directories and Environment

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 20 | `cwd` | [✓] | Controlled by ACP |
| 21 | `additionalDirectories` | [ ] | Not exposed |
| 22 | `env` | [✓] | Environment variables passed through |

### Execution and Runtime

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 23 | `executable` | [✓] | Node.js runtime path |
| 24 | `executableArgs` | [ ] | Not exposed |
| 25 | `pathToClaudeCodeExecutable` | [✓] | Custom CLI binary path |
| 26 | `extraArgs` | [✓] | Additional CLI flags via `_meta` |
| 27 | `spawnClaudeCodeProcess` | [ ] | Custom process spawning |

### System Prompt and Configuration

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 28 | `systemPrompt` | [✓] | Custom or preset with append |
| 29 | `settingSources` | [✓] | `["user", "project", "local"]` |
| 30 | `strictMcpConfig` | [ ] | Not exposed |

### Agents and Subagents

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 31 | `agent` | [ ] | Named agent selection |
| 32 | `agents` | [ ] | Custom agent definitions |

### Hooks

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 33 | `hooks` | [✓] | PreToolUse and PostToolUse merged with user hooks |

### MCP Servers

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 34 | `mcpServers` | [✓] | Merged with ACP internal MCP server |

### Output and Streaming

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 35 | `includePartialMessages` | [✓] | Always true (controlled by ACP) |
| 36 | `outputFormat` | [ ] | Structured output (json_schema) |

### File Checkpointing

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 37 | `enableFileCheckpointing` | [ ] | File state tracking |

### Beta Features

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 38 | `betas` | [ ] | e.g. `context-1m-2025-08-07` |

### Sandbox Configuration

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 39 | `sandbox` | [~] | Default only; full SandboxSettings not exposed |

### Plugins

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 40 | `plugins` | [ ] | Local plugin directories |

### Debugging

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 41 | `stderr` | [ ] | Stderr callback |

---

## 5. Hook Events (13 events)

Every event in the `HOOK_EVENTS` constant.

| # | Hook Event | Status | Notes |
|---|-----------|--------|-------|
| 1 | `PreToolUse` | [✓] | Merged with user hooks; permission decisions, input updates |
| 2 | `PostToolUse` | [✓] | Merged with user hooks; captures structured tool response |
| 3 | `PostToolUseFailure` | [ ] | After tool failure |
| 4 | `Notification` | [ ] | System notification dispatch |
| 5 | `UserPromptSubmit` | [ ] | Prompt submission hook |
| 6 | `SessionStart` | [ ] | Session lifecycle start |
| 7 | `SessionEnd` | [ ] | Session lifecycle end |
| 8 | `Stop` | [ ] | Stop event |
| 9 | `SubagentStart` | [ ] | Sub-agent lifecycle start |
| 10 | `SubagentStop` | [ ] | Sub-agent lifecycle stop |
| 11 | `PreCompact` | [ ] | Before context compaction |
| 12 | `PermissionRequest` | [ ] | Permission needed event |
| 13 | `Setup` | [ ] | Session initialization/maintenance |

---

## 6. Permission Modes (6 modes)

Every value of `PermissionMode`.

| # | Mode | Status | Notes |
|---|------|--------|-------|
| 1 | `default` | [✓] | Standard behavior; prompts for dangerous ops |
| 2 | `acceptEdits` | [✓] | Auto-accept file edit operations |
| 3 | `bypassPermissions` | [✓] | Skip all checks (requires non-root + `allowDangerouslySkipPermissions`) |
| 4 | `plan` | [✓] | Planning mode; no tool execution |
| 5 | `dontAsk` | [✓] | Never prompt; deny if not pre-approved |
| 6 | `delegate` | [ ] | Delegation mode for sub-agents; not exposed via ACP |

---

## 7. Control Protocol (16 subtypes)

Every subtype of `SDKControlRequestInner` and `ControlResponse`.

### SDK-to-CLI Control Requests

| # | Subtype | Status | Notes |
|---|---------|--------|-------|
| 1 | `interrupt` | [✓] | Maps to ACP `cancel()` |
| 2 | `set_permission_mode` | [✓] | Maps to ACP `setSessionMode()` |
| 3 | `set_model` | [✓] | Maps to ACP `unstable_setSessionModel()` |
| 4 | `set_max_thinking_tokens` | [ ] | Not exposed via ACP |
| 5 | `mcp_status` | [ ] | Not exposed |
| 6 | `mcp_message` | [ ] | JSON-RPC to MCP server; not exposed |
| 7 | `mcp_reconnect` | [ ] | Not exposed |
| 8 | `mcp_toggle` | [ ] | Not exposed |
| 9 | `mcp_set_servers` | [ ] | Not exposed |
| 10 | `rewind_files` | [ ] | Not exposed |
| 11 | `initialize` | [✓] | Internal; hooks, schema, system prompt setup |

### CLI-to-SDK Control Requests

| # | Subtype | Status | Notes |
|---|---------|--------|-------|
| 12 | `can_use_tool` | [✓] | Permission callback via `canUseTool` |
| 13 | `hook_callback` | [✓] | Hook dispatch for PreToolUse/PostToolUse |

### Control Responses

| # | Subtype | Status | Notes |
|---|---------|--------|-------|
| 14 | `success` | [✓] | Successful control response |
| 15 | `error` | [✓] | Error control response with pending permissions |

### Cancel

| # | Subtype | Status | Notes |
|---|---------|--------|-------|
| 16 | `control_cancel_request` | [✓] | Cancel pending control request |

---

## 8. Result Metadata

All fields on `SDKResultSuccess` and `SDKResultError`.

### SDKResultSuccess Fields

| # | Field | Status | Notes |
|---|-------|--------|-------|
| 1 | `result` (string) | [✓] | Final text output |
| 2 | `is_error` (false) | [✓] | Error flag |
| 3 | `duration_ms` | [~] | Available but not surfaced to ACP client |
| 4 | `duration_api_ms` | [~] | Available but not surfaced |
| 5 | `num_turns` | [~] | Available but not surfaced |
| 6 | `total_cost_usd` | [~] | Available but not surfaced |
| 7 | `usage.inputTokens` | [~] | Available but not surfaced |
| 8 | `usage.outputTokens` | [~] | Available but not surfaced |
| 9 | `usage.cacheReadInputTokens` | [~] | Available but not surfaced |
| 10 | `usage.cacheCreationInputTokens` | [~] | Available but not surfaced |
| 11 | `usage.webSearchRequests` | [~] | Available but not surfaced |
| 12 | `usage.costUSD` | [~] | Available but not surfaced |
| 13 | `usage.contextWindow` | [~] | Available but not surfaced |
| 14 | `usage.maxOutputTokens` | [~] | Available but not surfaced |
| 15 | `modelUsage` (per-model breakdown) | [~] | Available but not surfaced |
| 16 | `permission_denials` | [~] | Available but not surfaced |
| 17 | `structured_output` | [ ] | Not implemented (requires `outputFormat`) |
| 18 | `uuid` | [✓] | Message UUID propagated |
| 19 | `session_id` | [✓] | Session identifier propagated |

### SDKResultError Additional Fields

| # | Field | Status | Notes |
|---|-------|--------|-------|
| 20 | `subtype` (`error_during_execution` / `error_max_turns` / `error_max_budget_usd` / `error_max_structured_output_retries`) | [✓] | Mapped to stop reasons |
| 21 | `errors` (string[]) | [✓] | Error messages extracted |

---

## 9. Environment Variables (7 variables)

| # | Variable | Status | Notes |
|---|----------|--------|-------|
| 1 | `CLAUDE_CODE_ENTRYPOINT` | [✓] | Set to `"sdk-ts"` by SDK |
| 2 | `CLAUDE_AGENT_SDK_VERSION` | [✓] | Set by SDK for telemetry |
| 3 | `CLAUDE_CODE_EXECUTABLE` | [✓] | Override CLI binary location |
| 4 | `DEBUG_CLAUDE_AGENT_SDK` | [ ] | Debug logging enable |
| 5 | `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` | [ ] | File checkpointing enable |
| 6 | `CLAUDE` | [ ] | Override config directory path |
| 7 | `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` | [ ] | MCP call timeout override |

---

## 10. Background Task Features

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | `Bash` with `run_in_background: true` | [✓] | Background shell execution |
| 2 | `Task` (Agent) with `run_in_background: true` | [✓] | Background sub-agent execution |
| 3 | `task_notification` message handling | [✓] | Via `SessionMessageRouter` intercept |
| 4 | `TaskOutput` polling/waiting | [✓] | Block/timeout for background output |
| 5 | `TaskStop` termination | [✓] | Kill background task |
| 6 | Background task ID extraction from tool result | [✓] | Regex + structured extraction |
| 7 | Background task map (`task_id` -> `toolCallId`) | [✓] | Correlation for `tool_call_update` |
| 8 | `backgroundComplete` flag in `tool_call_update` metadata | [✓] | Signals async completion |
| 9 | `isBackground` flag in `tool_call` metadata | [✓] | Tags background tool calls |
| 10 | Background task `output_file` path tracking | [✓] | Stored in task map |
| 11 | Background task status states (pending/completed/failed/stopped) | [✓] | Full lifecycle |

---

## 11. Sub-Agent Features

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | `parent_tool_use_id` linkage | [✓] | Propagated in assistant messages |
| 2 | `parentToolUseId` in ACP notifications | [✓] | In `tool_call` and `tool_call_update` metadata |
| 3 | Sub-agent streaming content | [✓] | Text and thinking from child agents |
| 4 | Sub-agent tool calls | [✓] | Tool invocations within sub-agents |
| 5 | Combined background + sub-agent | [✓] | Background agents with parent linkage |
| 6 | `AgentDefinition` custom agents | [ ] | `agents` option not exposed |
| 7 | Built-in agent types (Bash, Explore, Plan, etc.) | [✓] | Used internally by Claude Code |
| 8 | `SubagentStart` / `SubagentStop` hooks | [ ] | Hook events not wired |

---

## 12. ACP Notification Types Emitted

Every notification type sent from ACP agent to client via `sessionUpdate()`.

| # | Notification Type | SDK Source | Status | Notes |
|---|------------------|-----------|--------|-------|
| 1 | `agent_message_chunk` | `stream_event` (text delta), `assistant` (text blocks) | [✓] | Text content streaming |
| 2 | `agent_thought_chunk` | `stream_event` (thinking delta) | [✓] | Extended thinking output |
| 3 | `tool_call` | `assistant` (tool_use blocks), `stream_event` (tool_use start) | [✓] | Tool invocation with metadata |
| 4 | `tool_call_update` | `user` (tool_result), `task_notification` | [✓] | Tool result, background completion |
| 5 | `plan` | `assistant` (TodoWrite tool_use) | [✓] | Plan entries with status |
| 6 | `available_commands_update` | `system:init` (slash_commands) | [✓] | Slash commands list |
| 7 | `current_mode_update` | `setSessionMode()` | [✓] | Permission mode changed |
| 8 | `user_message_chunk` | `user` (forwarded content) | [~] | Rare; only specific patterns forwarded |

---

## Summary

| Section | Total | [✓] | [~] | [ ] | [-] |
|---------|-------|-----|-----|-----|-----|
| SDK Message Types | 20 | 10 | 8 | 0 | 0 |
| SDK Tools | 19 | 17 | 0 | 0 | 1 |
| Query API Methods | 20 | 9 | 0 | 11 | 0 |
| Session Options | 41 | 23 | 1 | 17 | 0 |
| Hook Events | 13 | 2 | 0 | 11 | 0 |
| Permission Modes | 6 | 5 | 0 | 1 | 0 |
| Control Protocol | 16 | 10 | 0 | 6 | 0 |
| Result Metadata | 21 | 5 | 12 | 1 | 0 |
| Environment Variables | 7 | 3 | 0 | 4 | 0 |
| Background Task Features | 11 | 11 | 0 | 0 | 0 |
| Sub-Agent Features | 8 | 5 | 0 | 3 | 0 |
| ACP Notification Types | 8 | 7 | 1 | 0 | 0 |
| **Totals** | **190** | **107** | **22** | **54** | **1** |

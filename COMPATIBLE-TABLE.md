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
| 2 | `SDKUserMessage` (type: `user`) | [✓] | Filtered | Synthetic/replay messages filtered; `/context` output forwarded as `agent_message_chunk` |
| 3 | `SDKPartialAssistantMessage` (type: `stream_event`) | [✓] | `agent_message_chunk`, `agent_thought_chunk` | content_block_start/delta/stop, message_start/delta/stop |
| 4 | `SDKResultSuccess` (type: `result`, subtype: `success`) | [✓] | Stop reason `end_turn` | Result metadata extracted (cost, usage, duration) |
| 5 | `SDKResultError` (type: `result`, subtype: `error_*`) | [✓] | Stop reason varies | `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries` |
| 6 | `SDKSystemMessage` (type: `system`, subtype: `init`) | [✓] | Session init metadata | tools, model, permissionMode, mcp_servers, slash_commands |
| 7 | `SDKCompactBoundaryMessage` (type: `system`, subtype: `compact_boundary`) | [✓] | No-op (intentional) | No ACP equivalent; compact metadata consumed internally |
| 8 | `SDKStatusMessage` (type: `system`, subtype: `status`) | [✓] | `agent_message_chunk` | Compaction status forwarded |
| 9 | `SDKHookStartedMessage` (type: `system`, subtype: `hook_started`) | [✓] | No-op (intentional) | Hook lifecycle events; no ACP equivalent |
| 10 | `SDKHookProgressMessage` (type: `system`, subtype: `hook_progress`) | [✓] | No-op (intentional) | Hook lifecycle events; no ACP equivalent |
| 11 | `SDKHookResponseMessage` (type: `system`, subtype: `hook_response`) | [✓] | No-op (intentional) | Hook lifecycle events; no ACP equivalent |
| 12 | `SDKToolProgressMessage` (type: `tool_progress`) | [✓] | `tool_call_update` (in_progress) | elapsed_time_seconds forwarded |
| 13 | `SDKAuthStatusMessage` (type: `auth_status`) | [✓] | No-op (intentional) | Auth lifecycle handled internally; not forwarded to ACP client |
| 14 | `SDKTaskNotificationMessage` (type: `system`, subtype: `task_notification`) | [✓] | `tool_call_update` | Background task completion via SessionMessageRouter |
| 15 | `SDKFilesPersistedEvent` (type: `system`, subtype: `files_persisted`) | [✓] | No-op (intentional) | File checkpointing internal to SDK; no ACP equivalent |
| 16 | `SDKToolUseSummaryMessage` (type: `tool_use_summary`) | [✓] | `agent_message_chunk` | Summary text forwarded |

### Control Messages (internal protocol)

| # | Message Type | Status | ACP Mapping | Notes |
|---|-------------|--------|-------------|-------|
| 17 | `SDKControlRequest` (type: `control_request`) | [✓] | Internal | SDK-to-CLI and CLI-to-SDK control flow |
| 18 | `SDKControlResponse` (type: `control_response`) | [✓] | Internal | Success and error responses |
| 19 | `SDKControlCancelRequest` (type: `control_cancel_request`) | [✓] | `cancel()` | Maps to ACP cancel |
| 20 | `SDKKeepAliveMessage` (type: `keep_alive`) | [✓] | Internal (intentional) | Transport-level keepalive; handled by SDK process layer |

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
| 15 | `AskUserQuestion` | No | Permission flow | [✓] | Questions shown via `requestPermission`; answers returned to model |
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
| 5 | `setMaxThinkingTokens(n)` | [✓] | `ClaudeAcpAgent.setMaxThinkingTokens()` | Exposed as library method |
| 6 | `supportedCommands()` | [✓] | `available_commands_update` | Slash commands list |
| 7 | `supportedModels()` | [✓] | `newSession()` response | Returns model list with display info |
| 8 | `mcpServerStatus()` | [✓] | `ClaudeAcpAgent.mcpServerStatus()` | Exposed as library method |
| 9 | `reconnectMcpServer(name)` | [✓] | `ClaudeAcpAgent.reconnectMcpServer()` | Exposed as library method |
| 10 | `toggleMcpServer(name, enabled)` | [✓] | `ClaudeAcpAgent.toggleMcpServer()` | Exposed as library method |
| 11 | `setMcpServers(servers)` | [✓] | `ClaudeAcpAgent.setMcpServers()` | Exposed as library method |
| 12 | `accountInfo()` | [✓] | `ClaudeAcpAgent.accountInfo()` | Exposed as library method |
| 13 | `rewindFiles(messageId, opts)` | [✓] | `ClaudeAcpAgent.rewindFiles()` | Requires `enableFileCheckpointing` option |
| 14 | `close()` | [✓] | Session cleanup | Forceful termination |
| 15 | `streamInput(stream)` | [✓] | Multi-turn `prompt()` | Async message stream input |

### V2 Session API

| # | Method | Status | ACP Mapping | Notes |
|---|--------|--------|-------------|-------|
| 16 | `unstable_v2_createSession()` | [✓] | `createSessionV2()` | V2 API used for session creation alongside v1 fallback |
| 17 | `unstable_v2_prompt()` | [-] | Not used | V2 API (@alpha); use `SDKSession.send()` + `stream()` instead |
| 18 | `unstable_v2_resumeSession()` | [✓] | `createSessionV2()` | V2 API used for session resume |
| 19 | `SDKSession.send()` | [✓] | `prompt()` dual-path | V2 sessions use `send()` for message delivery |
| 20 | `SDKSession.stream()` | [✓] | `SessionMessageRouter` | V2 sessions stream via `stream()` wrapped in router |
| 21 | `unstable_listSessions()` | [✓] | `unstable_listSessions()` | Returns in-memory session list with metadata |

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
| 5 | `resumeSessionAt` | [✓] | Passed through via `_meta.claudeCode.options` |
| 6 | `forkSession` | [✓] | Fork resumed session |
| 7 | `persistSession` | [✓] | Default true |

### Model and Cost

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 8 | `model` | [✓] | Passed through to SDK |
| 9 | `fallbackModel` | [✓] | Passed through via `_meta.claudeCode.options` |
| 10 | `maxTurns` | [✓] | Passed through to SDK |
| 11 | `maxBudgetUsd` | [✓] | Passed through via `_meta.claudeCode.options` |
| 12 | `maxThinkingTokens` | [✓] | Via `MAX_THINKING_TOKENS` env var |

### Tools and Permissions

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 13 | `tools` | [✓] | Preset `claude_code` |
| 14 | `allowedTools` | [✓] | Based on client capabilities |
| 15 | `disallowedTools` | [✓] | Disabled tools based on client capabilities |
| 16 | `canUseTool` | [✓] | Permission callback for plan/edit flows |
| 17 | `permissionMode` | [✓] | default, acceptEdits, plan, dontAsk, bypassPermissions |
| 18 | `allowDangerouslySkipPermissions` | [✓] | True if non-root |
| 19 | `permissionPromptToolName` | [✓] | Passed through via `_meta.claudeCode.options` |

### Directories and Environment

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 20 | `cwd` | [✓] | Controlled by ACP |
| 21 | `additionalDirectories` | [✓] | Passed through via `_meta.claudeCode.options` |
| 22 | `env` | [✓] | Environment variables passed through |

### Execution and Runtime

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 23 | `executable` | [✓] | Node.js runtime path |
| 24 | `executableArgs` | [✓] | Passed through via `_meta.claudeCode.options` |
| 25 | `pathToClaudeCodeExecutable` | [✓] | Custom CLI binary path |
| 26 | `extraArgs` | [✓] | Additional CLI flags via `_meta` |
| 27 | `spawnClaudeCodeProcess` | [✓] | Passed through via `_meta.claudeCode.options` |

### System Prompt and Configuration

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 28 | `systemPrompt` | [✓] | Custom or preset with append |
| 29 | `settingSources` | [✓] | `["user", "project", "local"]` |
| 30 | `strictMcpConfig` | [✓] | Passed through via `_meta.claudeCode.options` |

### Agents and Subagents

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 31 | `agent` | [✓] | Passed through via `_meta.claudeCode.options` |
| 32 | `agents` | [✓] | Passed through via `_meta.claudeCode.options` |

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
| 36 | `outputFormat` | [✓] | Passed through via `_meta.claudeCode.options`; structured_output surfaced in result _meta |

### File Checkpointing

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 37 | `enableFileCheckpointing` | [✓] | Passed through via `_meta.claudeCode.options` |

### Beta Features

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 38 | `betas` | [✓] | Passed through via `_meta.claudeCode.options` |

### Sandbox Configuration

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 39 | `sandbox` | [✓] | Full SandboxSettings passed through via `_meta.claudeCode.options` |

### Plugins

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 40 | `plugins` | [✓] | Passed through via `_meta.claudeCode.options` |

### Debugging

| # | Option | Status | Notes |
|---|--------|--------|-------|
| 41 | `stderr` | [✓] | Merged: user callback invoked alongside ACP's logger |

---

## 5. Hook Events (13 events)

Every event in the `HOOK_EVENTS` constant.

| # | Hook Event | Status | Notes |
|---|-----------|--------|-------|
| 1 | `PreToolUse` | [✓] | Merged with user hooks; permission decisions, input updates |
| 2 | `PostToolUse` | [✓] | Merged with user hooks; captures structured tool response |
| 3 | `PostToolUseFailure` | [✓] | Passed through via `_meta.claudeCode.options.hooks` |
| 4 | `Notification` | [✓] | Passed through via `_meta.claudeCode.options.hooks` |
| 5 | `UserPromptSubmit` | [✓] | Passed through via `_meta.claudeCode.options.hooks` |
| 6 | `SessionStart` | [✓] | Passed through via `_meta.claudeCode.options.hooks` |
| 7 | `SessionEnd` | [✓] | Passed through via `_meta.claudeCode.options.hooks` |
| 8 | `Stop` | [✓] | Passed through via `_meta.claudeCode.options.hooks` |
| 9 | `SubagentStart` | [✓] | Passed through via `_meta.claudeCode.options.hooks` |
| 10 | `SubagentStop` | [✓] | Passed through via `_meta.claudeCode.options.hooks` |
| 11 | `PreCompact` | [✓] | Passed through via `_meta.claudeCode.options.hooks` |
| 12 | `PermissionRequest` | [✓] | Passed through via `_meta.claudeCode.options.hooks` |
| 13 | `Setup` | [✓] | Passed through via `_meta.claudeCode.options.hooks` |

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
| 6 | `delegate` | [✓] | Delegation mode for sub-agents; available via `setSessionMode()` |

---

## 7. Control Protocol (16 subtypes)

Every subtype of `SDKControlRequestInner` and `ControlResponse`.

### SDK-to-CLI Control Requests

| # | Subtype | Status | Notes |
|---|---------|--------|-------|
| 1 | `interrupt` | [✓] | Maps to ACP `cancel()` |
| 2 | `set_permission_mode` | [✓] | Maps to ACP `setSessionMode()` |
| 3 | `set_model` | [✓] | Maps to ACP `unstable_setSessionModel()` |
| 4 | `set_max_thinking_tokens` | [✓] | Via `ClaudeAcpAgent.setMaxThinkingTokens()` |
| 5 | `mcp_status` | [✓] | Via `ClaudeAcpAgent.mcpServerStatus()` |
| 6 | `mcp_message` | [✓] | Internal (intentional) | MCP transport handled by SDK process; ACP proxies via MCP server |
| 7 | `mcp_reconnect` | [✓] | Via `ClaudeAcpAgent.reconnectMcpServer()` |
| 8 | `mcp_toggle` | [✓] | Via `ClaudeAcpAgent.toggleMcpServer()` |
| 9 | `mcp_set_servers` | [✓] | Via `ClaudeAcpAgent.setMcpServers()` |
| 10 | `rewind_files` | [✓] | Via `ClaudeAcpAgent.rewindFiles()` |
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
| 3 | `duration_ms` | [✓] | Surfaced in PromptResponse `_meta.claudeCode` |
| 4 | `duration_api_ms` | [✓] | Surfaced in PromptResponse `_meta.claudeCode` |
| 5 | `num_turns` | [✓] | Surfaced in PromptResponse `_meta.claudeCode` |
| 6 | `total_cost_usd` | [✓] | Surfaced in PromptResponse `_meta.claudeCode` |
| 7 | `usage.inputTokens` | [✓] | Surfaced in PromptResponse `_meta.claudeCode.usage` |
| 8 | `usage.outputTokens` | [✓] | Surfaced in PromptResponse `_meta.claudeCode.usage` |
| 9 | `usage.cacheReadInputTokens` | [✓] | Surfaced in PromptResponse `_meta.claudeCode.usage` |
| 10 | `usage.cacheCreationInputTokens` | [✓] | Surfaced in PromptResponse `_meta.claudeCode.usage` |
| 11 | `usage.webSearchRequests` | [✓] | Surfaced in PromptResponse `_meta.claudeCode.usage` |
| 12 | `usage.costUSD` | [✓] | Surfaced in PromptResponse `_meta.claudeCode.usage` |
| 13 | `usage.contextWindow` | [✓] | Surfaced in PromptResponse `_meta.claudeCode.usage` |
| 14 | `usage.maxOutputTokens` | [✓] | Surfaced in PromptResponse `_meta.claudeCode.usage` |
| 15 | `modelUsage` (per-model breakdown) | [✓] | Surfaced in PromptResponse `_meta.claudeCode.modelUsage` |
| 16 | `permission_denials` | [✓] | Surfaced in PromptResponse `_meta.claudeCode` when non-empty |
| 17 | `structured_output` | [✓] | Surfaced in PromptResponse `_meta.claudeCode`; requires `outputFormat` option |
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
| 4 | `DEBUG_CLAUDE_AGENT_SDK` | [✓] | Read by SDK from process environment |
| 5 | `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` | [✓] | Read by SDK from process environment |
| 6 | `CLAUDE` | [✓] | Used for config directory path (`CLAUDE_CONFIG_DIR`) |
| 7 | `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` | [✓] | Read by SDK from process environment |

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
| 6 | `AgentDefinition` custom agents | [✓] | Via `_meta.claudeCode.options.agents` and `.agent` |
| 7 | Built-in agent types (Bash, Explore, Plan, etc.) | [✓] | Used internally by Claude Code |
| 8 | `SubagentStart` / `SubagentStop` hooks | [✓] | Via `_meta.claudeCode.options.hooks` |

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
| 8 | `user_message_chunk` | `user` (forwarded content) | [✓] | Context Usage info forwarded; other user messages intentionally filtered |

---

## Summary

| Section | Total | [✓] | [~] | [ ] | [-] |
|---------|-------|-----|-----|-----|-----|
| SDK Message Types | 20 | 20 | 0 | 0 | 0 |
| SDK Tools | 19 | 19 | 0 | 0 | 0 |
| Query API Methods | 21 | 19 | 0 | 0 | 2 |
| Session Options | 41 | 41 | 0 | 0 | 0 |
| Hook Events | 13 | 13 | 0 | 0 | 0 |
| Permission Modes | 6 | 6 | 0 | 0 | 0 |
| Control Protocol | 16 | 16 | 0 | 0 | 0 |
| Result Metadata | 21 | 21 | 0 | 0 | 0 |
| Environment Variables | 7 | 7 | 0 | 0 | 0 |
| Background Task Features | 11 | 11 | 0 | 0 | 0 |
| Sub-Agent Features | 8 | 8 | 0 | 0 | 0 |
| ACP Notification Types | 8 | 8 | 0 | 0 | 0 |
| **Totals** | **191** | **190** | **0** | **0** | **1** |

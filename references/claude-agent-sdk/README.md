# Claude Agent SDK — Reference

Decompiled reference files from `@anthropic-ai/claude-agent-sdk` v0.2.25.

## Architecture

```
SDK (sdk.mjs)                         CLI (cli.js = Claude Code binary v2.1.25)
=============                         ==========================================

query({ prompt, options })
  │
  ├── ProcessTransport
  │     spawn(node, cli.js,
  │       --output-format stream-json
  │       --input-format stream-json
  │       --verbose ...)
  │
  ├──stdin──►  NDJSON lines
  │            (user messages, control_requests)
  │
  ◄──stdout──  NDJSON lines
  │            (assistant, stream_event, result,
  │             system, tool_progress, control_response, ...)
  │
  └── Query (AsyncGenerator<SDKMessage>)
        ├── readMessages() loop — routes control vs content
        ├── inputStream (AsyncQueue) — buffers content messages
        └── readSdkMessages() — yields to consumer
```

### Core Insight: SDK is a Thin Wrapper

The SDK is a **thin process launcher + message router**. All agent logic — sub-agents, plan mode,
background tasks, tool execution, task notifications — lives inside the Claude Code CLI binary.
The SDK handles only:

1. **Process lifecycle** — spawn, write to stdin, read from stdout, kill
2. **Control message routing** — bidirectional request/response with `request_id` correlation
3. **Hook dispatch** — stores hook functions by ID, dispatches when CLI triggers them
4. **MCP bridge** — routes MCP JSON-RPC between CLI and in-process SDK MCP servers
5. **Permission flow** — dispatches `can_use_tool` control requests to SDK consumer's callback

---

## Files

| File | Description |
|------|-------------|
| `ndjson-protocol.ts` | **Start here.** Full protocol specification — message types, flow, examples |
| `process-transport.ts` | ProcessTransport — spawns CLI, maps SDK options → CLI flags, stdin/stdout NDJSON |
| `query.ts` | Query class — AsyncGenerator, control request routing, MCP/hooks integration |
| `query-function.ts` | `query()` entry point — resolves options, creates transport + query |
| `session.ts` | ConversationInstance (v2 multi-turn API) — send/stream/close |
| `sdk.d.ts` | Full TypeScript type declarations (1770 lines) |
| `sdk-tools.d.ts` | Tool input schema types (1565 lines) |
| `package.json` | Package metadata |

---

## Core Features to Support over ACP

### Feature Matrix

| Feature | Status | ACP Notification Type | Notes |
|---------|--------|----------------------|-------|
| **Text Streaming** | ✓ Done | `message_stream` | stream_event → text deltas |
| **Thinking Blocks** | ✓ Done | `thinking_stream` | stream_event → thinking deltas |
| **Tool Calls** | ✓ Done | `tool_call` | tool_use content blocks |
| **Tool Results** | ✓ Done | `tool_call_update` | tool_result content blocks |
| **Plan Mode (TodoWrite)** | ✓ Done | `plan_update` | TodoWrite → plan entries |
| **Exit Plan Mode** | ✓ Done | permission flow | canUseTool callback |
| **Background Tasks** | ✓ Done | `tool_call_update` | run_in_background + task_notification |
| **Background Bash** | ✓ Done | `tool_call_update` | Bash run_in_background |
| **Background Agents** | ✓ Done | `tool_call_update` | Task run_in_background |
| **Sub-Agent Messages** | ✓ Done | via `parentToolUseId` | parent_tool_use_id linkage |
| **Session Resume/Fork** | ✓ Done | — | resume, forkSession options |
| **Permission Modes** | ✓ Done | mode switching | default, acceptEdits, plan, dontAsk, bypassPermissions |
| **Model Switching** | ✓ Done | — | setModel() at runtime |
| **Slash Commands/Skills** | ✓ Done | — | supportedCommands() |
| **MCP Server Integration** | ✓ Done | — | SDK MCP server for ACP tools |
| **AskUserQuestion** | ✗ Disabled | — | Disallowed; needs ACP-native UI mapping |
| **Tool Progress** | ○ No-op | — | elapsed_time_seconds for long Bash |
| **Tool Use Summary** | ○ No-op | — | Collapsed tool descriptions |
| **Auth Status** | ○ No-op | — | isAuthenticating, output, error |
| **Hook Status** | ○ No-op | — | hook_started/progress/response |
| **Compact Boundary** | ○ No-op | — | Context compaction events |
| **Files Persisted** | ○ No-op | — | File checkpointing events |
| **Status Updates** | ○ No-op | — | e.g. "compacting" status |
| **File Checkpointing** | ○ Not used | — | enableFileCheckpointing + rewindFiles() |
| **Structured Output** | ○ Not used | — | outputFormat: json_schema |
| **Delegate Mode** | ○ Not exposed | — | 6th permission mode |
| **Plugins** | ○ Not used | — | Local plugin directories |
| **Betas** | ○ Not used | — | e.g. context-1m-2025-08-07 |
| **Sandbox Config** | ○ Default only | — | Full SandboxSettings |
| **Account Info** | ○ Not exposed | — | accountInfo() → email, org, subscription |
| **Dynamic MCP** | ○ Not exposed | — | setMcpServers(), reconnect, toggle |
| **Cost/Usage Stats** | ○ Not surfaced | — | SDKResultSuccess has total_cost_usd, usage, modelUsage |

---

## All 18 SDK Tools

### Agent & Task Management

| Tool | Input Type | Background | Key Fields |
|------|-----------|------------|------------|
| **Task** (Agent) | `AgentInput` | ✓ | `prompt`, `description`, `subagent_type` (string), `model` (sonnet/opus/haiku), `resume` (agent ID), `run_in_background`, `max_turns`, `mode` |
| **TaskOutput** | `TaskOutputInput` | — | `task_id`, `block` (boolean), `timeout` (ms) |
| **TaskStop** | `TaskStopInput` | — | `task_id` |
| **Bash** | `BashInput` | ✓ | `command`, `timeout` (max 600s), `description`, `run_in_background`, `dangerouslyDisableSandbox` |

### File Operations

| Tool | Input Type | Key Fields |
|------|-----------|------------|
| **Read** | `FileReadInput` | `file_path`, `offset`, `limit` |
| **Write** | `FileWriteInput` | `file_path`, `content` |
| **Edit** | `FileEditInput` | `file_path`, `old_string`, `new_string`, `replace_all` |
| **Glob** | `GlobInput` | `pattern`, `path` |
| **Grep** | `GrepInput` | `pattern`, `path`, `glob`, `output_mode`, context flags, `multiline` |
| **NotebookEdit** | `NotebookEditInput` | `notebook_path`, `new_source`, `cell_id`, `cell_type`, `edit_mode` |

### Web & Search

| Tool | Input Type | Key Fields |
|------|-----------|------------|
| **WebFetch** | `WebFetchInput` | `url`, `prompt` |
| **WebSearch** | `WebSearchInput` | `query`, `allowed_domains`, `blocked_domains` |

### Planning & User Interaction

| Tool | Input Type | Key Fields |
|------|-----------|------------|
| **TodoWrite** | `TodoWriteInput` | `todos[]` with `content`, `status` (pending/in_progress/completed), `activeForm` |
| **ExitPlanMode** | `ExitPlanModeInput` | `allowedPrompts[]` (Bash semantic permissions), `pushToRemote`, remote session fields |
| **AskUserQuestion** | `AskUserQuestionInput` | `questions` (1-4), each with `header`, `options` (2-4), `multiSelect`; `answers`, `metadata` |
| **Config** | `ConfigInput` | `setting` (key), `value` (string/bool/number) |

### MCP Integration

| Tool | Input Type | Key Fields |
|------|-----------|------------|
| **ListMcpResources** | `ListMcpResourcesInput` | `server` |
| **ReadMcpResource** | `ReadMcpResourceInput` | `server`, `uri` |
| **\<MCP tools\>** | `McpInput` | Freeform `[k: string]: unknown` |

---

## NDJSON Protocol

### Message Categories

**Content messages** (yielded to consumer via AsyncGenerator):

| Type | Subtypes | Description |
|------|----------|-------------|
| `assistant` | — | Full message with content blocks, `parent_tool_use_id`, `error?` |
| `user` | — | Tool result / user message, `parent_tool_use_id` |
| `result` | `success`, `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries` | End of turn |
| `stream_event` | — | Partial streaming chunk (BetaRawMessageStreamEvent), `parent_tool_use_id` |
| `system` | `init`, `task_notification`, `compact_boundary`, `status`, `hook_started`, `hook_progress`, `hook_response`, `files_persisted` | System events |
| `tool_progress` | — | Long-running tool elapsed time, `parent_tool_use_id` |
| `tool_use_summary` | — | Collapsed tool descriptions |
| `auth_status` | — | Authentication state |

**Control messages** (handled internally, never yielded):

| Type | Direction | Purpose |
|------|-----------|---------|
| `control_request` | SDK→CLI | initialize, interrupt, set_model, set_permission_mode, set_max_thinking_tokens, mcp_*, rewind_files |
| `control_request` | CLI→SDK | can_use_tool (permission), hook_callback |
| `control_response` | Both | Response correlated by `request_id` |
| `control_cancel_request` | SDK→CLI | Cancel in-progress control request |
| `keep_alive` | CLI→SDK | Heartbeat (ignored) |

### Init Message (system.init)

The first content message from CLI after spawn:

```typescript
{
  type: "system",
  subtype: "init",
  session_id: string,
  tools: string[],           // All available tool names
  model: string,             // Active model
  cwd: string,               // Working directory
  mcp_servers: { name, status }[],
  agents?: string[],         // Registered agent names
  permissionMode: PermissionMode,
  slash_commands: string[],  // Available / commands
  skills: string[],          // Loaded skills
  plugins: { name, path }[], // Loaded plugins
  claude_code_version: string,
  apiKeySource: string,      // user | project | org | temporary
  betas?: string[],
  output_style: string,
}
```

### Result Message (end of turn)

```typescript
// Success
{
  type: "result", subtype: "success",
  result: string,              // Final text output
  is_error: boolean,
  duration_ms: number,         // Wall clock time
  duration_api_ms: number,     // API call time only
  num_turns: number,           // Number of agent turns
  total_cost_usd: number,      // Total cost in USD
  usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens },
  modelUsage: Record<string, { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD, contextWindow, maxOutputTokens }>,
  permission_denials: SDKPermissionDenial[],
  structured_output?: unknown,  // If outputFormat was json_schema
  session_id: string,
}
```

### Complete Protocol Flow

```
  SDK                                          CLI (claude code)
  ───                                          ────────────────

  1. spawn(node cli.js --output-format stream-json --input-format stream-json --verbose ...)
     env: CLAUDE_CODE_ENTRYPOINT=sdk-ts, CLAUDE_AGENT_SDK_VERSION=0.2.25

  2. stdin:  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]},...}

  3. stdin:  {"type":"control_request","request_id":"abc","request":{"subtype":"initialize","hooks":...,"agents":...}}
     stdout: {"type":"control_response","response":{"request_id":"abc","subtype":"success","response":{commands,models,account}}}

  4. stdout: {"type":"system","subtype":"init","session_id":"sess_123","tools":[...],"model":"..."}

  5. stdout: {"type":"stream_event","event":{"type":"content_block_start",...},"parent_tool_use_id":null}
     stdout: {"type":"stream_event","event":{"type":"content_block_delta",...}}
     ...

  6. stdout: {"type":"assistant","message":{"role":"assistant","content":[{tool_use},{text}]},"parent_tool_use_id":null}

  7. stdout: {"type":"control_request","request_id":"def","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{...}}}
     stdin:  {"type":"control_response","response":{"request_id":"def","subtype":"success","response":{"allowed":true}}}

  8. stdout: {"type":"tool_progress","tool_use_id":"tu_1","tool_name":"Bash","elapsed_time_seconds":2}

  9. stdout: {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1",...}]}}

 10. stdout: {"type":"result","subtype":"success","result":"Done!","total_cost_usd":0.003,...}

 11. SDK closes stdin → CLI exits
```

---

## Key Concepts & Insights

### parent_tool_use_id — Sub-Agent Message Linking

Present on `assistant`, `user`, `stream_event`, and `tool_progress` messages.

- `null` → top-level message from the main agent
- `"toolu_xxx"` → message from a sub-agent spawned by a Task tool with that ID

The SDK does **not** generate or modify this field — it passes through as-is from the CLI.
The CLI sets it on all messages emitted by sub-agent execution contexts.

### Background Task Lifecycle

Background tasks are entirely managed by the CLI. The SDK only defines the types.

```
1. Agent calls Bash/Task with run_in_background: true
2. CLI returns immediately with tool_result containing task_id and output_file path
3. Background task runs asynchronously inside CLI
4. On completion: CLI emits {"type":"system","subtype":"task_notification","task_id":"...","status":"completed|failed|stopped","output_file":"...","summary":"..."}
5. SDK yields this as SDKTaskNotificationMessage
6. Our ACP agent matches task_id → toolCallId via backgroundTaskMap and emits tool_call_update
```

### Hook Registration & Dispatch

Hooks are registered as JavaScript functions in the SDK process. During initialization:

1. SDK assigns each hook function a callback ID (`hook_0`, `hook_1`, ...)
2. SDK stores functions in a local Map: `hookCallbacks.set("hook_0", fn)`
3. SDK sends only the IDs to CLI via initialize control_request
4. When CLI triggers a hook, it sends: `{"type":"control_request","request":{"subtype":"hook_callback","callback_id":"hook_0","input":{...}}}`
5. SDK looks up the function by ID and calls it
6. SDK sends the result back as a control_response

### Permission Flow (can_use_tool)

```
CLI → SDK:  control_request { subtype: "can_use_tool", tool_name, input, tool_use_id, agent_id,
                              permission_suggestions, blocked_path, decision_reason }
SDK → CLI:  control_response { allowed: true|false, reason?: string }
```

The `permission_suggestions` field contains suggested permission rules. The `blocked_path` and
`decision_reason` provide context for why permission was needed.

### SDK MCP Servers — In-Process Bridge

SDK-type MCP servers run **inside the SDK process** (not in the CLI):

```
CLI  ──control_request { subtype:"mcp_message", server_name, message }──►  SDK
SDK  ──routes to local McpServer instance──►  McpTransport
SDK  ◄──MCP JSON-RPC response──  McpTransport
SDK  ──control_response { mcp_response }──►  CLI
```

This allows the ACP agent to expose custom tools to Claude Code via MCP without spawning
a separate MCP server process.

### subagent_type — Not an Enum

Despite the property name, `subagent_type` is typed as `string` (not an enum). Valid values
are names of registered agents — either built-in Claude Code agent types or custom agents
defined via the `agents` option. The CLI resolves the name to an agent definition at runtime.

Known built-in values from Claude Code system prompts:
- `"Bash"` — Command execution specialist
- `"general-purpose"` — General-purpose agent
- `"Explore"` — Codebase exploration specialist
- `"Plan"` — Software architect for implementation plans
- `"statusline-setup"` — Status line configuration
- `"claude-code-guide"` — Help/documentation agent
- Custom names defined via `Options.agents`

### Plan Mode Internals

Plan mode is implemented inside the CLI, not the SDK. The SDK's involvement:

1. `permissionMode: "plan"` → CLI flag `--permission-mode plan`
2. `setPermissionMode("plan")` → control_request to switch at runtime
3. `TodoWrite` tool → Claude writes plan entries with `{ content, status, activeForm }`
4. `ExitPlanMode` tool → triggers `can_use_tool` control_request with `allowedPrompts`
5. Our ACP agent maps TodoWrite to `plan_update` notifications and ExitPlanMode to special permission flow

### Initialize Control Request — Session Configuration

The first control_request after spawn configures the session:

```typescript
{
  subtype: "initialize",
  hooks: {                           // Hook callback IDs (not live functions)
    PreToolUse: [{ matcher: "...", hookCallbackIds: ["hook_0", "hook_1"], timeout: 30 }],
    PostToolUse: [...],
    ...
  },
  sdkMcpServers: ["my-server"],     // Names of SDK MCP servers
  jsonSchema: { ... },               // Structured output schema
  systemPrompt: "...",               // System prompt override
  appendSystemPrompt: "...",         // Append to preset system prompt
  agents: {                          // Custom agent definitions
    "my-agent": { description, tools, prompt, model, maxTurns, ... }
  },
}
```

Response contains: `commands` (slash commands), `models` (available models), `account` (info).

---

## All 13 Hook Events

| Event | Trigger | Input Includes | Output Can |
|-------|---------|---------------|------------|
| `PreToolUse` | Before tool execution | `tool_name`, `tool_input` | allow/deny, modify input |
| `PostToolUse` | After tool success | `tool_name`, `tool_input`, `tool_output` | add context, update MCP output |
| `PostToolUseFailure` | After tool failure | `tool_name`, `tool_input`, `error` | add context |
| `Notification` | System notification | notification data | — |
| `UserPromptSubmit` | User submits prompt | `prompt_text` | modify prompt |
| `SessionStart` | Session begins | trigger (startup/resume/clear/compact) | — |
| `SessionEnd` | Session ends | exit reason | — |
| `Stop` | Stop event | `stop_hook_active` flag | — |
| `SubagentStart` | Sub-agent starts | `agent_id`, `agent_type` | — |
| `SubagentStop` | Sub-agent stops | `agent_transcript_path` | — |
| `PreCompact` | Before compaction | trigger (manual/auto) | — |
| `PermissionRequest` | Permission needed | tool info, suggestions | approve/block |
| `Setup` | Init/maintenance | trigger (init/maintenance) | — |

---

## 6 Permission Modes

| Mode | Description |
|------|-------------|
| `default` | Standard — prompts for dangerous operations |
| `acceptEdits` | Auto-accept file edit operations (Read, Write, Edit) |
| `bypassPermissions` | Skip all checks (requires `allowDangerouslySkipPermissions`) |
| `plan` | Planning only — no actual tool execution |
| `delegate` | Delegation mode for sub-agents |
| `dontAsk` | Never prompt — deny if not pre-approved |

---

## SDK Exports

```typescript
export {
  query,                         // Main entry point → Query (AsyncGenerator<SDKMessage>)
  tool,                          // Define a custom MCP tool: tool(name, desc, schema, handler)
  createSdkMcpServer,           // Create in-process MCP server: { type:"sdk", name, instance }
  HOOK_EVENTS,                  // ["PreToolUse", "PostToolUse", ...] (13 events)
  EXIT_REASONS,                 // ["clear", "logout", "prompt_input_exit", "other", "bypass_permissions_disabled"]
  AbortError,                   // Error thrown on abort/cancellation
  unstable_v2_createSession,    // v2: create multi-turn session
  unstable_v2_prompt,           // v2: one-shot prompt
  unstable_v2_resumeSession,    // v2: resume existing session
}
```

---

## Environment Variables

| Variable | Value | Purpose |
|----------|-------|---------|
| `CLAUDE_CODE_ENTRYPOINT` | `"sdk-ts"` | Identifies SDK as caller (vs `"sdk-py"`, `"sdk-cli"`) |
| `CLAUDE_AGENT_SDK_VERSION` | `"0.2.25"` | SDK version telemetry |
| `CLAUDE_CODE_EXECUTABLE` | path | Custom CLI binary path |
| `DEBUG_CLAUDE_AGENT_SDK` | any | Enable debug logging + stderr pipe |
| `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` | `"true"` | Enable file state tracking |
| `CLAUDE` | path | Override `~/.claude` config directory |

---

## CLI Flags Mapped from SDK Options

The SDK always launches with these fixed flags:
```
--output-format stream-json --verbose --input-format stream-json
```

Plus conditional flags:

| SDK Option | CLI Flag |
|-----------|----------|
| `model` | `--model <model>` |
| `maxTurns` | `--max-turns <n>` |
| `maxBudgetUsd` | `--max-budget-usd <n>` |
| `maxThinkingTokens` | `--max-thinking-tokens <n>` |
| `fallbackModel` | `--fallback-model <model>` |
| `agent` | `--agent <name>` |
| `betas` | `--betas <list>` |
| `jsonSchema` | `--json-schema <json>` |
| `permissionMode` | `--permission-mode <mode>` |
| `allowDangerouslySkipPermissions` | `--allow-dangerously-skip-permissions` |
| `canUseTool` | `--permission-prompt-tool stdio` |
| `permissionPromptToolName` | `--permission-prompt-tool <name>` |
| `continue` | `--continue` |
| `resume` | `--resume <id>` |
| `resumeSessionAt` | `--resume-session-at <uuid>` |
| `forkSession` | `--fork-session` |
| `persistSession=false` | `--no-session-persistence` |
| `allowedTools` | `--allowedTools <list>` |
| `disallowedTools` | `--disallowedTools <list>` |
| `tools` | `--tools <list\|"default"\|"">` |
| `mcpServers` | `--mcp-config <json>` |
| `strictMcpConfig` | `--strict-mcp-config` |
| `settingSources` | `--setting-sources <list>` |
| `includePartialMessages` | `--include-partial-messages` |
| `additionalDirectories` | `--add-dir <dir>` (repeated) |
| `plugins` | `--plugin-dir <path>` (repeated) |
| `enableFileCheckpointing` | env: `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true` |

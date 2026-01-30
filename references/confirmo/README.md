# Confirmo — Agent Monitoring Architecture

> Reverse-engineered from Confirmo v1.0.54 (Electron desktop pet by yetone).
> These files are reference-only extracts from the decompiled bundle.

## How It Works

Confirmo monitors Claude Code (and Codex, Aider, OpenCode) using **two passive mechanisms** — no hooks, no IPC, no runtime coupling with the agent process.

### 1. Process Detection (polling)

Every 3 seconds, `AgentMonitor.checkAgents()` runs `pgrep -f` to detect running processes matching patterns like `claude-code`, `claude-code-acp`, `bin/claude`. Emits `agent-start` / `agent-stop`.

### 2. JSONL File Watching (core logic)

Uses **chokidar** (backed by macOS `fsevents` native module) to watch:

```
~/.claude/projects/**/*.jsonl
```

When a file changes, reads only the **new bytes** since the last known position (incremental `fs.readSync` with byte offset), splits on newlines, parses each JSON entry, and runs a state machine.

### JSONL State Machine

| Entry | Event Emitted | Details shown |
|---|---|---|
| `type:"user"` + text | `agent-active` | "Processing user message" |
| `type:"user"` + tool_result | `agent-active` | "Processing tool results" |
| `type:"assistant"` + thinking | `agent-active` | "Thinking..." |
| `type:"assistant"` + tool_use | `agent-active` | Tool names: `Read: foo.ts \| Bash: npm test` |
| `type:"assistant"` + end_turn | `task-complete` | Text preview of response |
| `type:"assistant"` + text, null stop | fallback timer | 1.5–8s → `task-complete` |
| `type:"system"` + turn_duration | `agent-idle` | "Idle" |
| Synthetic error message | `task-error` | Error preview |

### Tool Name Formatting

Parses `tool_use` content blocks to show human-readable descriptions:
- `Read: filename.ts`, `Edit: filename.ts`, `Write: filename.ts`
- `Bash: npm test`, `Grep: pattern`, `Glob: **/*.ts`
- `Task: description`, `WebFetch: url`, `TodoWrite: updating tasks`

### Session Context

- **Title**: First user message text (stripping `<system_instruction>`, `<system-reminder>` tags)
- **Working directory**: Decoded from JSONL path — `~/.claude/projects/-Users-foo-project/` → `/Users/foo/project/`
- **Subagent detection**: Path contains `/subagents/`

### Event Flow

```
AgentMonitor.onEvent(event)
  → petWindow.webContents.send("agent-event", event)
  → preload: window.confirmo.onAgentEvent(callback)
  → renderer: drives pet animation state

task-complete → also triggers "celebrate" animation
```

### Key Design Decisions

1. **Zero runtime coupling** — purely reads files on disk, never communicates with Claude Code
2. **Fallback completion heuristic** — since Claude Code doesn't always write explicit "done" markers, uses a 1.5–8s timeout based on response length and whether the last user message was a tool_result
3. **Deduplication** — `reportedMessageIds` Set prevents duplicate events when re-reading entries
4. **Incremental reads** — tracks byte offset per file, only reads new data on each change event

## Files

- `agent-configs.ts` — Agent definitions (process patterns, log paths, file patterns)
- `agent-monitor.ts` — Core monitoring class (~1200 lines)
- `preload-api.ts` — Electron preload bridge (IPC channels exposed to renderer)
- `app-bootstrap.ts` — App initialization and event wiring

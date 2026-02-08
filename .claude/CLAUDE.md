# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@zed-industries/claude-code-acp` is a TypeScript ACP (Agent Client Protocol) adapter for Claude Code. It wraps the Claude Agent SDK, translating SDK messages into ACP notifications so that ACP-compatible clients (like Zed) can use Claude Code as an agent. Supports streaming, tool proxying via MCP, background tasks, sub-agents, and permission management.

## Commands

```bash
# Build
tsc                           # or: npm run build

# Test
npx vitest run                # all tests, single run
npx vitest run src/tests/hooks.test.ts  # single test file
npx vitest                    # watch mode (disabled by default in config)
RUN_INTEGRATION_TESTS=true npx vitest run  # include integration tests
npx vitest run --coverage     # with v8 coverage

# Lint & Format
npx eslint src --ext .ts      # lint
npx prettier --check .        # format check
npm run check                 # both lint + format check

# Demo (requires bun)
bun demo/dev.ts               # starts backend (port 5689) + Vite frontend (port 5688)
npm run demo:server           # backend only with hot reload
npm run demo:vite             # frontend only
```

CI runs: format check, lint, build, test (in that order).

## Architecture

### Layer Structure

```
src/index.ts (CLI)  →  src/acp/agent.ts (ClaudeAcpAgent)
src/lib.ts (library)        ↓
                    ┌───────┼──────────┬──────────┐
                    ↓       ↓          ↓          ↓
                  sdk/    acp/       disk/      events/
```

- **`acp/`** -- ACP protocol layer. `agent.ts` is the main orchestrator (~1400 lines). Converts SDK messages to ACP notifications, manages tool state, handles MCP server.
- **`sdk/`** -- Claude Agent SDK integration. Message routing, permission hooks, pre/post tool-use hooks.
- **`disk/`** -- Persistence. Settings management with file watchers, session history, task lists, skills, plugins.
- **`events/`** -- JSONL file watching and session event emission.

### Key Patterns

**SDK → ACP Message Flow:** `ClaudeAcpAgent.prompt()` calls the SDK's `query()`, which returns an async iterator of SDK messages. Each message type maps to an ACP notification:
- `stream_event` (content_block_start/delta) → `agent_message_chunk` / `tool_call`
- `tool_result` → `tool_call_update` (completed/failed)
- `system.task_notification` → `tool_call_update` (background task completion)
- `Result` → `end_turn` response with cost/usage

**SessionMessageRouter** (`sdk/message-router.ts`): Wraps the SDK query iterator to intercept `task_notification` messages between turns for immediate handling while buffering everything else. Compacts buffer when read cursor > 64 entries.

**ToolUseCache** (`acp/agent.ts`): Tracks `tool_use` blocks across async operations. Caches tool info at `content_block_start`, fills input from final assistant message, evicts after tool_result (or after `task_notification` for background tasks).

**MCP Server** (`acp/mcp-server.ts`): Per-session MCP server exposing Read, Write, Edit, Bash, BashOutput, KillShell tools. These proxy to ACP client capabilities. Handles `internalPath()` for CLAUDE_CONFIG_DIR access and enforces 50KB file read limits.

**NotificationQueue** (`acp/notification-queue.ts`): Non-blocking `enqueue()` for streaming updates, awaited `send()` for critical updates, `flush()` before returning from prompt.

**SettingsManager** (`disk/settings.ts`): Multi-source settings with file watchers and pre-parsed rule caching. RefCount pooling for per-session sharing.

### Entry Points

- **`src/index.ts`** -- CLI binary. Redirects stdout→stderr (ACP uses stdin/stdout), loads settings, calls `runAcp()`.
- **`src/lib.ts`** -- Library exports for programmatic use by other packages.
- **`src/acp-agent.ts`** -- Deprecated backward-compat re-export from `acp/agent.ts`.

## Key References

- **`COMPATIBLE-TABLE.md`** -- Feature tracking table. Update when implementing new SDK features.
- **`references/claude-agent-sdk/`** -- SDK type declarations (`sdk.d.ts`, `sdk-tools.d.ts`), NDJSON protocol spec, architecture overview.

## Development Workflow

When implementing a new SDK feature:
1. Add support in `src/acp/agent.ts` (and related files under `src/acp/` or `src/sdk/`)
2. Update the corresponding row in `COMPATIBLE-TABLE.md` from `[ ]` to `[x]`
3. Verify through the demo app (`bun demo/dev.ts`) that the feature works end-to-end

## Conventions

- TypeScript strict mode, ES2020 target, NodeNext modules
- Prettier: 100 char print width, 2-space indent
- ESLint: strict equality required, curly braces required, no unused vars (except `_` prefixed)
- Tests are colocated in `src/tests/`, organized by feature (not per-file)
- `any` is allowed (SDK types often require it)

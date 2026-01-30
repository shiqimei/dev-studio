# Claude Code ACP -- Project Instructions

## Project Overview

This is `claude-code-acp`, a TypeScript implementation of the Agent Client Protocol (ACP) that bridges the Claude Code SDK with ACP-compatible clients. It exposes Claude Code as an ACP agent with streaming, tool proxying, background tasks, and sub-agent support.

## Key References

- **`COMPATIBLE-TABLE.md`** (workspace root) -- Feature tracking table listing every Claude Code SDK feature and its ACP support status. Update this when implementing new features.
- **`references/claude-agent-sdk/`** -- SDK architecture, protocol spec, and type declarations:
  - `sdk.d.ts` -- Full TypeScript type declarations (SDKMessage, Query, Options, hooks, etc.)
  - `sdk-tools.d.ts` -- Tool input schema types
  - `ndjson-protocol.ts` -- NDJSON protocol specification
  - `README.md` -- Architecture overview and feature matrix
- **`references/confirmo/`** -- Confirmo monitoring architecture reference:
  - `agent-monitor.ts` -- Agent monitoring patterns
  - `agent-configs.ts` -- Agent configuration patterns
  - `preload-api.ts` -- Preload API patterns

## Development Workflow

When implementing a new SDK feature:

1. Add support in `src/acp-agent.ts` (and related files)
2. Update the corresponding row in `COMPATIBLE-TABLE.md` from `[ ]` to `[x]`
3. Verify through `demo.ts` (`bun --hot demo.ts`) that the feature works end-to-end

## Project Conventions

- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js / Bun
- **Test framework:** Vitest (`npx vitest`)
- **Protocol:** ACP (Agent Client Protocol) via `@anthropic-ai/acp`
- **SDK:** `@anthropic-ai/claude-agent-sdk` v0.2.25
- **Entry point:** `src/index.ts` (CLI), `src/lib.ts` (library)
- **Main implementation:** `src/acp-agent.ts`

## Architecture Notes

- The SDK is a thin process launcher + message router. All agent logic lives in the Claude Code CLI binary.
- ACP agent wraps SDK's `query()` function, translating SDK messages into ACP notifications.
- `SessionMessageRouter` intercepts `task_notification` messages for background task handling.
- `ToolUseCache` tracks tool state across async operations.
- MCP server provides built-in tools (Read, Write, Edit, Bash) proxied to ACP client capabilities.

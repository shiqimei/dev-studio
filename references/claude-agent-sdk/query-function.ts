/**
 * Claude Agent SDK v0.2.25 — query() function (main entry point)
 * Decompiled from sdk.mjs (function o_, lines ~18968–19090).
 *
 * The `query()` function is the primary API — it:
 *   1. Resolves the CLI path (defaults to cli.js next to sdk.mjs)
 *   2. Creates a ProcessTransport with all options mapped to CLI flags
 *   3. Creates a Query (AsyncGenerator) that routes messages
 *   4. Either writes a single prompt to stdin (string) or feeds an async stream
 *   5. Returns the Query as an AsyncGenerator<SDKMessage>
 *
 * Usage:
 *   import { query } from "@anthropic-ai/claude-agent-sdk";
 *
 *   // Single-turn (string prompt)
 *   const q = query({ prompt: "What is 2+2?", options: { model: "claude-sonnet-4-20250514" } });
 *   for await (const msg of q) { console.log(msg); }
 *
 *   // Multi-turn (async iterable of user messages)
 *   const q = query({ prompt: userMessageStream, options: { ... } });
 *   for await (const msg of q) { console.log(msg); }
 */

import { join } from "path";
import { fileURLToPath } from "url";

// ── query() entry point ──────────────────────────────────────────────

export function query({ prompt, options }: QueryParams): Query {
  const { systemPrompt, settingSources, sandbox, ...rest } = options ?? {};

  // Parse system prompt
  let resolvedSystemPrompt: string | undefined;
  let appendSystemPrompt: string | undefined;
  if (systemPrompt === undefined) {
    resolvedSystemPrompt = "";
  } else if (typeof systemPrompt === "string") {
    resolvedSystemPrompt = systemPrompt;
  } else if (systemPrompt.type === "preset") {
    appendSystemPrompt = systemPrompt.append;
  }

  // Resolve CLI path (default: cli.js adjacent to sdk.mjs)
  let cliPath = rest.pathToClaudeCodeExecutable;
  if (!cliPath) {
    const sdkDir = join(fileURLToPath(import.meta.url), "..");
    cliPath = join(sdkDir, "cli.js");
  }

  // Set SDK version env var for telemetry
  process.env.CLAUDE_AGENT_SDK_VERSION = "0.2.25";

  const {
    abortController = new AbortController(),
    additionalDirectories = [],
    agent,
    agents,
    allowedTools = [],
    betas,
    canUseTool,
    continue: continueConversation,
    cwd,
    disallowedTools = [],
    tools,
    env: userEnv,
    executable = "node",
    executableArgs = [],
    extraArgs = {},
    fallbackModel,
    enableFileCheckpointing,
    forkSession,
    hooks,
    includePartialMessages,
    persistSession,
    maxThinkingTokens,
    maxTurns,
    maxBudgetUsd,
    mcpServers,
    model,
    outputFormat,
    permissionMode = "default",
    allowDangerouslySkipPermissions = false,
    permissionPromptToolName,
    plugins,
    resume,
    resumeSessionAt,
    stderr,
    strictMcpConfig,
  } = rest;

  // Environment setup
  const env = userEnv ?? { ...process.env };
  if (!env.CLAUDE_CODE_ENTRYPOINT) env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
  if (enableFileCheckpointing) env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = "true";

  // Separate SDK MCP servers from regular MCP server configs
  const regularMcpServers: Record<string, any> = {};
  const sdkMcpInstances = new Map<string, any>();
  if (mcpServers) {
    for (const [name, config] of Object.entries(mcpServers)) {
      if (config.type === "sdk" && "instance" in config) {
        sdkMcpInstances.set(name, config.instance);
        regularMcpServers[name] = { type: "sdk", name };
      } else {
        regularMcpServers[name] = config;
      }
    }
  }

  const isSingleUserTurn = typeof prompt === "string";
  const jsonSchema = outputFormat?.type === "json_schema" ? outputFormat.schema : undefined;

  // ── Create ProcessTransport ──
  const transport = new ProcessTransport({
    abortController,
    additionalDirectories,
    agent,
    betas,
    cwd,
    executable,
    executableArgs,
    extraArgs,
    pathToClaudeCodeExecutable: cliPath,
    env,
    forkSession,
    stderr,
    maxThinkingTokens,
    maxTurns,
    maxBudgetUsd,
    model,
    fallbackModel,
    jsonSchema,
    permissionMode,
    allowDangerouslySkipPermissions,
    permissionPromptToolName,
    continueConversation,
    resume,
    resumeSessionAt,
    settingSources: settingSources ?? [],
    allowedTools,
    disallowedTools,
    tools,
    mcpServers: regularMcpServers,
    strictMcpConfig,
    canUseTool: !!canUseTool,
    hooks: !!hooks,
    includePartialMessages,
    persistSession,
    plugins,
    sandbox,
    spawnClaudeCodeProcess: rest.spawnClaudeCodeProcess,
  });

  // ── Create Query ──
  const queryInstance = new Query(
    transport,
    isSingleUserTurn,
    canUseTool,
    hooks,
    abortController,
    sdkMcpInstances,
    jsonSchema,
    {
      systemPrompt: resolvedSystemPrompt,
      appendSystemPrompt,
      agents,
    },
  );

  // ── Feed prompt ──
  if (typeof prompt === "string") {
    // Single turn: write user message to stdin immediately
    transport.write(
      JSON.stringify({
        type: "user",
        session_id: "",
        message: { role: "user", content: [{ type: "text", text: prompt }] },
        parent_tool_use_id: null,
      }) + "\n",
    );
  } else {
    // Multi-turn: pipe the async iterable of user messages
    queryInstance.streamInput(prompt);
  }

  return queryInstance;
}

// ── SDK exports ──────────────────────────────────────────────────────

// The SDK exports these symbols:
// export {
//   query,                         — Main entry point
//   tool,                          — Define a custom tool
//   createSdkMcpServer,           — Create an SDK MCP server
//   HOOK_EVENTS,                  — Available hook event names
//   EXIT_REASONS,                 — Valid exit reason constants
//   AbortError,                   — Error thrown on abort
//   unstable_v2_createSession,    — v2: create multi-turn session
//   unstable_v2_prompt,           — v2: one-shot prompt
//   unstable_v2_resumeSession,    — v2: resume existing session
// }

// Placeholder types
type QueryParams = { prompt: string | AsyncIterable<any>; options?: any };
type Query = any;
type ProcessTransport = any;

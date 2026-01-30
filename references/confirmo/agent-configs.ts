/**
 * Confirmo v1.0.54 — Agent configuration definitions.
 * Decompiled from out/main/index.js lines 8190–8247.
 *
 * Each config tells AgentMonitor:
 *  - How to detect the agent process (processPatterns → pgrep -f)
 *  - Where to find log files (logPaths + filePatterns → chokidar watch)
 *  - How to detect completion/errors in non-JSONL logs (completionPatterns, errorPatterns)
 */

import path from "path";
import os from "os";

export interface AgentConfig {
  name: string;
  displayName: string;
  /** Patterns matched via `pgrep -f` (macOS/Linux) or tasklist/wmic (Windows) */
  processPatterns: string[];
  /** Root directories to watch with chokidar */
  logPaths?: string[];
  /** Glob patterns for relevant files within logPaths */
  filePatterns?: string[];
  /** Regex patterns that indicate task completion (for non-JSONL logs) */
  completionPatterns?: RegExp[];
  /** Regex patterns that indicate errors (for non-JSONL logs) */
  errorPatterns?: RegExp[];
  /** WSL log paths (populated at runtime on Windows) */
  wslLogPaths?: string[];
}

export const AGENT_CONFIGS: AgentConfig[] = [
  {
    name: "claude-code",
    displayName: "Claude Code",
    // Match claude CLI binaries including conductor's claude and claude-code-acp
    processPatterns: [
      "claude-code",
      "claude-code-acp",
      "@anthropic-ai/claude-code",
      "bin/claude",
    ],
    logPaths: [path.join(os.homedir(), ".claude", "projects")],
    filePatterns: ["**/*.jsonl", "**/*.json", "**/conversation.log"],
    completionPatterns: [
      /Task completed successfully/i,
      /All tasks completed/i,
      /Successfully committed/i,
      /Pull request created/i,
      /PR created/i,
      /Commit [a-f0-9]{7,} pushed/i,
    ],
    errorPatterns: [
      /Error: .{10,}/i,
      /Failed to .{10,}/i,
      /fatal error/i,
    ],
  },
  {
    name: "codex",
    displayName: "Codex",
    processPatterns: ["codex", "@openai/codex"],
    logPaths: [path.join(os.homedir(), ".codex", "sessions")],
    filePatterns: ["**/*.jsonl"],
    completionPatterns: [/Commit/i, /Applied/i, /Done/i],
    errorPatterns: [/Error/i, /Failed/i],
  },
  {
    name: "aider",
    displayName: "Aider",
    processPatterns: ["aider"],
    completionPatterns: [/Commit/i, /Applied/i, /Done/i],
    errorPatterns: [/Error/i, /Failed/i],
  },
  {
    name: "opencode",
    displayName: "OpenCode",
    processPatterns: ["opencode", "@sst/opencode"],
    logPaths: [
      path.join(os.homedir(), ".local", "share", "opencode", "storage", "message"),
      path.join(os.homedir(), ".local", "share", "opencode", "storage", "part"),
    ],
    filePatterns: ["**/*.json"],
  },
];

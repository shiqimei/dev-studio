/**
 * Path computation for Claude Code config directories, projects, sessions, etc.
 * No SDK dependencies — pure filesystem path logic.
 */
import * as path from "node:path";
import * as os from "node:os";

/** Root Claude config directory (defaults to ~/.claude, overridable via CLAUDE env var). */
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE ?? path.join(os.homedir(), ".claude");

/** Returns the project directory inside ~/.claude/projects/ for a given cwd. */
export function getProjectDir(cwd?: string): string {
  const resolvedCwd = cwd ?? process.env.ACP_CWD ?? process.cwd();
  return path.join(CLAUDE_CONFIG_DIR, "projects", resolvedCwd.replace(/\//g, "-"));
}

/** Returns the path to sessions-index.json for a given project directory. */
export function getSessionsIndexPath(projectDir: string): string {
  return path.join(projectDir, "sessions-index.json");
}

/** Returns the path to a session's JSONL conversation file. */
export function getSessionJsonlPath(projectDir: string, sessionId: string): string {
  return path.join(projectDir, `${sessionId}.jsonl`);
}

/** Returns the path to the user settings file. */
export function getUserSettingsPath(): string {
  return path.join(CLAUDE_CONFIG_DIR, "settings.json");
}

/** Returns the path to project settings file for a given cwd. */
export function getProjectSettingsPath(cwd: string): string {
  return path.join(cwd, ".claude", "settings.json");
}

/** Returns the path to local project settings file for a given cwd. */
export function getLocalSettingsPath(cwd: string): string {
  return path.join(cwd, ".claude", "settings.local.json");
}

/** Returns the enterprise managed settings path for the current platform. */
export function getManagedSettingsPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/managed-settings.json";
    case "linux":
      return "/etc/claude-code/managed-settings.json";
    case "win32":
      return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
    default:
      return "/etc/claude-code/managed-settings.json";
  }
}

/** Returns the path to ~/.claude/statsig-cache.json. */
export function getStatsCachePath(): string {
  return path.join(CLAUDE_CONFIG_DIR, "statsig-cache.json");
}

/** Returns the path to ~/.claude/todos/. */
export function getTasksDir(): string {
  return path.join(CLAUDE_CONFIG_DIR, "todos");
}

/** Returns the path to ~/.claude/commands/. */
export function getCommandsDir(): string {
  return path.join(CLAUDE_CONFIG_DIR, "commands");
}

/** Returns the path to ~/.claude/plugins/installed_plugins.json. */
export function getPluginsPath(): string {
  return path.join(CLAUDE_CONFIG_DIR, "plugins", "installed_plugins.json");
}

/** Returns the path to ~/.claude/skills/. */
export function getSkillsDir(): string {
  return path.join(CLAUDE_CONFIG_DIR, "skills");
}

/** Returns the path to a session's subagents directory. */
export function getSubagentsDir(projectDir: string, sessionId: string): string {
  return path.join(projectDir, sessionId, "subagents");
}

/** Returns the path to a specific subagent's JSONL file. */
export function getSubagentJsonlPath(projectDir: string, sessionId: string, agentId: string): string {
  return path.join(projectDir, sessionId, "subagents", `agent-${agentId}.jsonl`);
}

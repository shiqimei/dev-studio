/**
 * Path computation for Claude Code config directories, projects, sessions, etc.
 * No SDK dependencies — pure filesystem path logic.
 *
 * Zero-argument path getters are eagerly cached at module load since
 * CLAUDE_CONFIG_DIR is a process-lifetime constant.
 */
import * as path from "node:path";
import * as os from "node:os";

/** Root Claude config directory (defaults to ~/.claude, overridable via CLAUDE env var). */
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE ?? path.join(os.homedir(), ".claude");

// Eagerly cached constant paths (avoids path.join on every call)
const _userSettingsPath = path.join(CLAUDE_CONFIG_DIR, "settings.json");
const _statsCachePath = path.join(CLAUDE_CONFIG_DIR, "statsig-cache.json");
const _tasksDir = path.join(CLAUDE_CONFIG_DIR, "todos");
const _commandsDir = path.join(CLAUDE_CONFIG_DIR, "commands");
const _pluginsPath = path.join(CLAUDE_CONFIG_DIR, "plugins", "installed_plugins.json");
const _skillsDir = path.join(CLAUDE_CONFIG_DIR, "skills");
const _managedSettingsPath = (() => {
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
})();

// Memoization cache for parameterized path getters
const _projectDirCache = new Map<string, string>();
const _projectSettingsCache = new Map<string, string>();
const _localSettingsCache = new Map<string, string>();
const _sessionsIndexCache = new Map<string, string>();

/** Returns the project directory inside ~/.claude/projects/ for a given cwd. */
export function getProjectDir(cwd?: string): string {
  const resolvedCwd = cwd ?? process.env.ACP_CWD ?? process.cwd();
  let cached = _projectDirCache.get(resolvedCwd);
  if (cached === undefined) {
    cached = path.join(CLAUDE_CONFIG_DIR, "projects", resolvedCwd.replace(/\//g, "-"));
    _projectDirCache.set(resolvedCwd, cached);
  }
  return cached;
}

/** Returns the path to sessions-index.json for a given project directory. */
export function getSessionsIndexPath(projectDir: string): string {
  let cached = _sessionsIndexCache.get(projectDir);
  if (cached === undefined) {
    cached = path.join(projectDir, "sessions-index.json");
    _sessionsIndexCache.set(projectDir, cached);
  }
  return cached;
}

/** Returns the path to a session's JSONL conversation file. */
export function getSessionJsonlPath(projectDir: string, sessionId: string): string {
  return path.join(projectDir, `${sessionId}.jsonl`);
}

/** Returns the path to the user settings file. */
export function getUserSettingsPath(): string {
  return _userSettingsPath;
}

/** Returns the path to project settings file for a given cwd. */
export function getProjectSettingsPath(cwd: string): string {
  let cached = _projectSettingsCache.get(cwd);
  if (cached === undefined) {
    cached = path.join(cwd, ".claude", "settings.json");
    _projectSettingsCache.set(cwd, cached);
  }
  return cached;
}

/** Returns the path to local project settings file for a given cwd. */
export function getLocalSettingsPath(cwd: string): string {
  let cached = _localSettingsCache.get(cwd);
  if (cached === undefined) {
    cached = path.join(cwd, ".claude", "settings.local.json");
    _localSettingsCache.set(cwd, cached);
  }
  return cached;
}

/** Returns the enterprise managed settings path for the current platform. */
export function getManagedSettingsPath(): string {
  return _managedSettingsPath;
}

/** Returns the path to ~/.claude/statsig-cache.json. */
export function getStatsCachePath(): string {
  return _statsCachePath;
}

/** Returns the path to ~/.claude/todos/. */
export function getTasksDir(): string {
  return _tasksDir;
}

/** Returns the path to ~/.claude/commands/. */
export function getCommandsDir(): string {
  return _commandsDir;
}

/** Returns the path to ~/.claude/plugins/installed_plugins.json. */
export function getPluginsPath(): string {
  return _pluginsPath;
}

/** Returns the path to ~/.claude/skills/. */
export function getSkillsDir(): string {
  return _skillsDir;
}

/** Returns the path to a session's subagents directory. */
export function getSubagentsDir(projectDir: string, sessionId: string): string {
  return path.join(projectDir, sessionId, "subagents");
}

/** Returns the path to a specific subagent's JSONL file. */
export function getSubagentJsonlPath(projectDir: string, sessionId: string, agentId: string): string {
  return path.join(projectDir, sessionId, "subagents", `agent-${agentId}.jsonl`);
}

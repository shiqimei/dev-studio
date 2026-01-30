/**
 * Confirmo v1.0.54 — AgentMonitor class (core monitoring logic).
 * Decompiled from out/main/index.js lines 8238–11181.
 *
 * This is the heart of Confirmo's agent observation. It:
 *  1. Polls for running agent processes every 3s via pgrep/tasklist
 *  2. Watches ~/.claude/projects/ with chokidar (fsevents on macOS)
 *  3. Incrementally reads new JSONL bytes on each file change
 *  4. Parses entries through a state machine to emit UI events
 *
 * Events emitted via onEvent callback:
 *  - agent-start / agent-stop   — process detected / gone
 *  - agent-active               — working (thinking, tool use, processing)
 *  - agent-idle                  — turn ended, waiting for user
 *  - task-complete              — turn finished with end_turn
 *  - task-error                  — error detected
 */

import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import { execAsync } from "child_process";
import { AgentConfig, AGENT_CONFIGS } from "./agent-configs";

// ── Types ────────────────────────────────────────────────────────────

export interface AgentEvent {
  type:
    | "agent-start"
    | "agent-stop"
    | "agent-active"
    | "agent-idle"
    | "task-complete"
    | "task-error";
  agent: string;
  timestamp: number;
  details?: string;
  sessionId?: string;
  sessionTitle?: string;
  workingDirectory?: string;
}

interface PendingCompletion {
  timeout: ReturnType<typeof setTimeout>;
  entryUuid: string;
  content: unknown[];
  config: AgentConfig;
}

// ── AgentMonitor ─────────────────────────────────────────────────────

export class AgentMonitor {
  static TEXT_COMPLETION_FALLBACK_MIN_MS = 1500;
  static TEXT_COMPLETION_FALLBACK_MAX_MS = 8000;

  private running = false;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private onEvent: (event: AgentEvent) => void;

  /** Whether each agent was previously detected as running */
  private previousStatus = new Map<string, boolean>();
  /** Active chokidar watchers */
  private fileWatchers: chokidar.FSWatcher[] = [];
  /** Log root paths already being watched (dedup) */
  private watchedLogRoots = new Set<string>();
  /** Byte offset of last read per file path */
  private lastLogPosition = new Map<string, number>();
  /** Incomplete trailing JSONL line per file */
  private pendingJsonlLine = new Map<string, string>();
  /** UUIDs of entries already reported (prevents duplicates) */
  private reportedMessageIds = new Set<string>();
  /** Per-session working state (true = agent actively processing) */
  private workingState = new Map<string, boolean>();
  /** Per-session title extracted from first user message */
  private sessionTitles = new Map<string, string>();
  /** Last user message type per session ("text" | "tool_result" | "other") */
  private lastUserMessageType = new Map<string, string>();
  /** Pending fallback completion timers */
  private pendingTextCompletion = new Map<string, PendingCompletion>();

  constructor(onEvent: (event: AgentEvent) => void) {
    this.onEvent = onEvent;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async start() {
    if (this.running) return;
    this.running = true;
    await this.checkAgents();
    this.checkInterval = setInterval(() => this.checkAgents(), 3000);
    setTimeout(() => this.setupLogWatchers(), 1000);
  }

  stop() {
    this.running = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    for (const watcher of this.fileWatchers) watcher.close();
    this.fileWatchers = [];
    this.watchedLogRoots.clear();
    this.workingState.clear();
    this.lastUserMessageType.clear();
    for (const pending of this.pendingTextCompletion.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingTextCompletion.clear();
  }

  getStatus() {
    return AGENT_CONFIGS.map((config) => ({
      name: config.name,
      displayName: config.displayName,
      running: this.previousStatus.get(config.name) ?? false,
    }));
  }

  // ── Process detection ────────────────────────────────────────────

  async checkAgents() {
    for (const config of AGENT_CONFIGS) {
      const isRunning = await this.isAgentRunning(config);
      const wasRunning = this.previousStatus.get(config.name) ?? false;
      if (isRunning !== wasRunning) {
        this.previousStatus.set(config.name, isRunning);
        this.onEvent({
          type: isRunning ? "agent-start" : "agent-stop",
          agent: config.displayName,
          timestamp: Date.now(),
        });
      }
    }
  }

  async isAgentRunning(config: AgentConfig): Promise<boolean> {
    try {
      for (const pattern of config.processPatterns) {
        // macOS/Linux: pgrep -f with anchored pattern
        const { stdout } = await execAsync(
          `pgrep -f "^.*/${pattern}(\\s|$)|^${pattern}(\\s|$)"`
        );
        if (stdout.trim()) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ── File system watching ─────────────────────────────────────────

  /**
   * Sets up chokidar watchers for each agent's log directories.
   * Uses fsevents on macOS for native kernel-level file notifications.
   * Falls back to polling (1s interval) which also works on WSL paths.
   */
  setupLogWatchers() {
    for (const config of AGENT_CONFIGS) {
      const allLogPaths = [...(config.logPaths || []), ...(config.wslLogPaths || [])];
      if (allLogPaths.length === 0) continue;

      for (const logPath of allLogPaths) {
        if (this.watchedLogRoots.has(logPath)) continue;

        if (!fs.existsSync(logPath)) {
          try {
            fs.mkdirSync(logPath, { recursive: true });
          } catch {
            continue;
          }
        }

        const watcher = chokidar.watch(logPath, {
          persistent: true,
          ignoreInitial: true,
          followSymlinks: true,
          depth: 10,
          usePolling: true,
          interval: 1000,
          ignorePermissionErrors: true,
          ignored: [
            "**/node_modules/**",
            "**/.git/**",
            "**/dist/**",
            "**/build/**",
          ],
        });

        const isRelevantFile = (filePath: string) => {
          if (!config.filePatterns) return true;
          const ext = path.extname(filePath);
          const fileName = path.basename(filePath);
          return config.filePatterns.some((p) => {
            if (p.endsWith(".jsonl")) return ext === ".jsonl";
            if (p.endsWith(".json")) return ext === ".json";
            if (p.includes("conversation.log")) return fileName === "conversation.log";
            return true;
          });
        };

        watcher.on("change", (filePath) => {
          if (isRelevantFile(filePath)) this.checkLogFile(filePath, config);
        });
        watcher.on("add", (filePath) => {
          if (isRelevantFile(filePath)) this.checkLogFile(filePath, config);
        });

        this.fileWatchers.push(watcher);
        this.watchedLogRoots.add(logPath);
      }
    }
  }

  // ── Incremental JSONL reading ────────────────────────────────────

  /**
   * Core file processing: reads only NEW bytes since last check,
   * parses JSONL entries, and feeds them to the state machine.
   */
  async checkLogFile(filePath: string, config: AgentConfig) {
    if (!fs.existsSync(filePath)) return;
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) return;
    } catch {
      return;
    }

    try {
      const stats = fs.statSync(filePath);
      const lastPosition = this.lastLogPosition.get(filePath) ?? 0;

      // File was truncated — reset
      if (stats.size < lastPosition) {
        this.lastLogPosition.set(filePath, 0);
        this.pendingJsonlLine.delete(filePath);
        return;
      }
      if (stats.size <= lastPosition) return;

      // Read only the new bytes (incremental read)
      const fd = fs.openSync(filePath, "r");
      const buffer = Buffer.alloc(stats.size - lastPosition);
      fs.readSync(fd, buffer, 0, buffer.length, lastPosition);
      fs.closeSync(fd);
      this.lastLogPosition.set(filePath, stats.size);

      const newContent = buffer.toString();

      if (filePath.endsWith(".jsonl")) {
        // Combine with any pending partial line from last read
        const combined = (this.pendingJsonlLine.get(filePath) || "") + newContent;
        const segments = combined.split("\n");
        let trailing = segments.pop() ?? "";

        // Check if trailing segment is actually a complete JSON line
        if (!combined.endsWith("\n")) {
          const trimmed = trailing.trim();
          const looksComplete = /[}\]]\s*$/.test(trimmed);
          if (trimmed && looksComplete) {
            try {
              JSON.parse(trimmed);
              segments.push(trailing);
              trailing = "";
            } catch {
              // Incomplete — keep as pending
            }
          }
        } else {
          trailing = "";
        }

        if (trailing) {
          this.pendingJsonlLine.set(filePath, trailing);
        } else {
          this.pendingJsonlLine.delete(filePath);
        }

        // Parse all complete lines
        const entries: { entry: any; line: string }[] = [];
        for (const line of segments.map((l) => l.trim()).filter(Boolean)) {
          try {
            entries.push({ entry: JSON.parse(line), line });
          } catch {
            // Skip malformed lines
          }
        }

        // ── JSONL state machine ──────────────────────────────────

        for (const { entry } of entries) {
          try {
            const typedEntry = entry as any;

            // ── turn_duration → agent is idle ──
            if (typedEntry.type === "system" && typedEntry.subtype === "turn_duration") {
              if (this.flushPendingTextCompletion(filePath)) continue;
              if (this.workingState.get(filePath)) {
                this.workingState.set(filePath, false);
                this.onEvent({
                  type: "agent-idle",
                  agent: config.displayName,
                  timestamp: Date.now(),
                  details: "Idle",
                  sessionId: filePath,
                  sessionTitle: this.getSessionTitle(filePath),
                  workingDirectory: this.getWorkingDirectory(filePath, config.name),
                });
              }
              continue;
            }

            // ── assistant message → detect activity/completion ──
            if (typedEntry.type === "assistant" && typedEntry.message) {
              const isSynthetic = typedEntry.message.model === "<synthetic>";

              // Synthetic error messages
              if (isSynthetic) {
                const isApiError = Boolean(entry.isApiErrorMessage || entry.error);
                if (isApiError) {
                  const uuid = typedEntry.uuid;
                  if (uuid && !this.reportedMessageIds.has(uuid)) {
                    this.reportedMessageIds.add(uuid);
                    this.cancelPendingTextCompletion(filePath);
                    this.workingState.set(filePath, false);
                    this.onEvent({
                      type: "task-error",
                      agent: config.displayName,
                      timestamp: Date.now(),
                      details: this.extractTextPreview(typedEntry.message.content || []),
                      sessionId: filePath,
                      sessionTitle: this.getSessionTitle(filePath),
                      workingDirectory: this.getWorkingDirectory(filePath, config.name),
                    });
                  }
                }
                continue;
              }

              const stopReason = typedEntry.message.stop_reason;
              const contentTypes: string[] = Array.isArray(typedEntry.message.content)
                ? typedEntry.message.content.map((item: any) => item.type)
                : [];
              const hasThinking =
                contentTypes.includes("thinking") ||
                contentTypes.includes("redacted_thinking");

              // ── end_turn → task complete ──
              if (stopReason === "end_turn" || stopReason === "stop_sequence") {
                this.cancelPendingTextCompletion(filePath);
                const uuid = typedEntry.uuid;
                if (uuid && !this.reportedMessageIds.has(uuid)) {
                  this.reportedMessageIds.add(uuid);
                  this.workingState.set(filePath, false);
                  this.onEvent({
                    type: "task-complete",
                    agent: config.displayName,
                    timestamp: Date.now(),
                    details: this.extractTextPreview(typedEntry.message.content || []),
                    sessionId: filePath,
                    sessionTitle: this.getSessionTitle(filePath),
                    workingDirectory: this.getWorkingDirectory(filePath, config.name),
                  });
                }
                continue;
              }

              // ── thinking → active ──
              if (hasThinking) {
                this.cancelPendingTextCompletion(filePath);
                this.workingState.set(filePath, true);
                this.onEvent({
                  type: "agent-active",
                  agent: config.displayName,
                  timestamp: Date.now(),
                  details: "Thinking...",
                  sessionId: filePath,
                  sessionTitle: this.getSessionTitle(filePath),
                  workingDirectory: this.getWorkingDirectory(filePath, config.name),
                });
                continue;
              }

              // ── tool_use → active with tool names ──
              if (stopReason === "tool_use" || contentTypes.includes("tool_use")) {
                this.cancelPendingTextCompletion(filePath);
                const toolNames = this.extractToolNames(typedEntry.message.content || []);
                this.workingState.set(filePath, true);
                this.onEvent({
                  type: "agent-active",
                  agent: config.displayName,
                  timestamp: Date.now(),
                  details: toolNames || "Executing tools",
                  sessionId: filePath,
                  sessionTitle: this.getSessionTitle(filePath),
                  workingDirectory: this.getWorkingDirectory(filePath, config.name),
                });
                continue;
              }

              // ── text-only with null stop_reason → schedule fallback completion ──
              const hasText = contentTypes.includes("text");
              const hasToolUse = contentTypes.includes("tool_use");
              if (stopReason === null && hasText && !hasToolUse && typedEntry.uuid) {
                if (this.workingState.get(filePath)) {
                  this.onEvent({
                    type: "agent-active",
                    agent: config.displayName,
                    timestamp: Date.now(),
                    details: "Generating response...",
                    sessionId: filePath,
                    sessionTitle: this.getSessionTitle(filePath),
                    workingDirectory: this.getWorkingDirectory(filePath, config.name),
                  });
                }
                this.scheduleFallbackTextCompletion(
                  filePath,
                  typedEntry.uuid,
                  typedEntry.message.content || [],
                  config
                );
              }
            }

            // ── user message → detect new turn / tool results ──
            if (typedEntry.type === "user" && typedEntry.message?.content) {
              if (entry.isMeta) continue;
              if (this.isLocalCommandMessage(typedEntry.message.content)) continue;

              this.cancelPendingTextCompletion(filePath);
              const content = typedEntry.message.content;
              const contentTypes: string[] = Array.isArray(content)
                ? content.map((item: any) => item.type)
                : [];

              // Extract session title from first user text message
              if (!this.sessionTitles.has(filePath)) {
                const title = this.extractSessionTitle(content, filePath);
                if (title) this.sessionTitles.set(filePath, title);
              }

              if (contentTypes.includes("tool_result")) {
                this.workingState.set(filePath, true);
                this.onEvent({
                  type: "agent-active",
                  agent: config.displayName,
                  timestamp: Date.now(),
                  details: "Processing tool results",
                  sessionId: filePath,
                  sessionTitle: this.getSessionTitle(filePath),
                  workingDirectory: this.getWorkingDirectory(filePath, config.name),
                });
              } else if (typeof content === "string" || contentTypes.includes("text")) {
                if (!this.workingState.get(filePath)) {
                  this.workingState.set(filePath, true);
                  this.onEvent({
                    type: "agent-active",
                    agent: config.displayName,
                    timestamp: Date.now(),
                    details: "Processing user message",
                    sessionId: filePath,
                    sessionTitle: this.getSessionTitle(filePath),
                    workingDirectory: this.getWorkingDirectory(filePath, config.name),
                  });
                }
              }
            }
          } catch {
            // Skip entries that fail to process
          }
        }
      } else {
        // Non-JSONL files: match against completion/error patterns
        if (config.completionPatterns) {
          for (const pattern of config.completionPatterns) {
            if (pattern.test(newContent)) {
              this.onEvent({
                type: "task-complete",
                agent: config.displayName,
                timestamp: Date.now(),
                details: `Detected in: ${path.basename(filePath)}`,
              });
              return;
            }
          }
        }
        if (config.errorPatterns) {
          for (const pattern of config.errorPatterns) {
            if (pattern.test(newContent)) {
              this.onEvent({
                type: "task-error",
                agent: config.displayName,
                timestamp: Date.now(),
                details: `Error in: ${path.basename(filePath)}`,
              });
              return;
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error reading ${filePath}:`, error);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /** Extract first 100 chars of text from content blocks */
  extractTextPreview(content: any[]): string {
    for (const item of content) {
      if (typeof item === "object" && item?.type === "text" && typeof item.text === "string") {
        const text = item.text.trim();
        return text.length > 100 ? text.substring(0, 100) + "..." : text;
      }
    }
    return "";
  }

  /**
   * Extract human-readable tool descriptions from content blocks.
   * Returns e.g. "Read: foo.ts | Bash: npm test | Task: fix the bug"
   */
  extractToolNames(content: any[]): string {
    const descriptions: string[] = [];
    for (const item of content) {
      if (item?.type !== "tool_use" || typeof item.name !== "string") continue;
      const name = item.name;
      const input = item.input;
      let param = "";
      if (input) {
        if (name === "Read" && typeof input.file_path === "string")
          param = this.getFileName(input.file_path);
        else if (name === "Edit" && typeof input.file_path === "string")
          param = this.getFileName(input.file_path);
        else if (name === "Write" && typeof input.file_path === "string")
          param = this.getFileName(input.file_path);
        else if (name === "Glob" && typeof input.pattern === "string")
          param = this.truncate(input.pattern, 30);
        else if (name === "Grep" && typeof input.pattern === "string")
          param = this.truncate(input.pattern, 30);
        else if (name === "Bash" && typeof input.command === "string")
          param = this.truncate(input.command, 40);
        else if (name === "Task" && typeof input.description === "string")
          param = this.truncate(input.description, 40);
        else if (name === "WebFetch" && typeof input.url === "string")
          param = this.truncate(input.url, 40);
        else if (name === "TodoWrite") param = "updating tasks";
      }
      descriptions.push(param ? `${name}: ${param}` : name);
    }
    return descriptions.join(" | ");
  }

  /**
   * Extract working directory from JSONL path.
   * ~/.claude/projects/-Users-foo-project/session.jsonl → /Users/foo/project
   */
  getWorkingDirectory(filePath: string, agentName: string): string | undefined {
    if (agentName === "claude-code") {
      const match = filePath.match(/\.claude[/\\]projects[/\\]([^/\\]+)[/\\]/);
      if (match) {
        const encoded = match[1];
        if (encoded === "subagents") return undefined;
        return encoded.replace(/-/g, "/");
      }
    }
    return undefined;
  }

  /** Extract session title from first user message, stripping system tags */
  extractSessionTitle(content: any, filePath: string): string | undefined {
    const isSubagent = filePath.includes("/subagents/");
    if (typeof content === "string") return this.titleFromText(content, isSubagent);
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === "text" && typeof item.text === "string") {
          const title = this.titleFromText(item.text, isSubagent);
          if (title) return title;
        }
      }
    }
    return undefined;
  }

  private titleFromText(text: string, isSubagent: boolean): string | undefined {
    let clean = text.trim();
    if (!isSubagent) {
      clean = clean
        .replace(/<system_instruction>[\s\S]*?<\/system_instruction>/g, "")
        .replace(/<system-instruction>[\s\S]*?<\/system-instruction>/g, "")
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
        .trim();
    }
    if (!clean) return undefined;
    const first = clean.split("\n")[0].trim();
    return first ? this.truncate(first, 50) : undefined;
  }

  getSessionTitle(filePath: string): string | undefined {
    return this.sessionTitles.get(filePath);
  }

  /** Check if message is a local slash command (e.g. /context) */
  isLocalCommandMessage(content: any): boolean {
    const tags = ["<command-name>", "<local-command-stdout>", "<local-command-stderr>", "<local-command-caveat>"];
    if (typeof content === "string") return tags.some((t) => content.includes(t));
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === "text" && typeof item.text === "string") {
          if (tags.some((t) => item.text.includes(t))) return true;
        }
      }
    }
    return false;
  }

  // ── Fallback completion timer ────────────────────────────────────

  /**
   * When a text-only assistant message has stop_reason: null,
   * we can't tell if Claude is done or will follow up with tool_use.
   * Schedule a fallback that fires after 1.5–8s depending on context.
   */
  scheduleFallbackTextCompletion(
    filePath: string,
    entryUuid: string,
    content: unknown[],
    config: AgentConfig
  ) {
    this.cancelPendingTextCompletion(filePath);
    const lastUserType = this.lastUserMessageType.get(filePath) ?? "other";
    const textLength = this.extractTextLength(content);
    let fallbackMs: number;
    if (lastUserType === "tool_result") fallbackMs = AgentMonitor.TEXT_COMPLETION_FALLBACK_MIN_MS;
    else if (textLength >= 800) fallbackMs = 2000;
    else if (textLength >= 200) fallbackMs = 4000;
    else fallbackMs = AgentMonitor.TEXT_COMPLETION_FALLBACK_MAX_MS;

    const timeout = setTimeout(() => this.flushPendingTextCompletion(filePath), fallbackMs);
    this.pendingTextCompletion.set(filePath, { timeout, entryUuid, content, config });
  }

  cancelPendingTextCompletion(filePath: string) {
    const pending = this.pendingTextCompletion.get(filePath);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingTextCompletion.delete(filePath);
    }
  }

  flushPendingTextCompletion(filePath: string): boolean {
    const pending = this.pendingTextCompletion.get(filePath);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pendingTextCompletion.delete(filePath);
    if (!this.reportedMessageIds.has(pending.entryUuid)) {
      this.reportedMessageIds.add(pending.entryUuid);
      this.workingState.set(filePath, false);
      this.onEvent({
        type: "task-complete",
        agent: pending.config.displayName,
        timestamp: Date.now(),
        details: this.extractTextPreview(pending.content as any[]),
        sessionId: filePath,
        sessionTitle: this.getSessionTitle(filePath),
        workingDirectory: this.getWorkingDirectory(filePath, pending.config.name),
      });
    } else {
      this.workingState.set(filePath, false);
    }
    return true;
  }

  private extractTextLength(content: unknown[]): number {
    let length = 0;
    for (const item of content as any[]) {
      if (item?.type === "text" && typeof item.text === "string") length += item.text.length;
    }
    return length;
  }

  private getFileName(filePath: string): string {
    return filePath.split("/").pop() || filePath;
  }

  private truncate(text: string, max: number): string {
    return text.length <= max ? text : text.substring(0, max) + "...";
  }
}

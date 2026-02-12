import type { MetricEntry } from "./worker-pool.js";

// ── Turn state ──

export type TurnActivity = "brewing" | "thinking" | "responding" | "reading" | "editing" | "running" | "searching" | "delegating" | "planning" | "compacting";

export interface TurnState {
  status: "in_progress" | "completed" | "error";
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  approxTokens: number;
  thinkingDurationMs: number;
  thinkingLastChunkAt?: number;
  costUsd?: number;
  outputTokens?: number;
  activity: TurnActivity;
  activityDetail?: string;
  /** Why the turn ended (e.g., "end_turn", "error", "max_tokens"). */
  stopReason?: string;
}

// ── Session metadata ──

export interface SessionMeta {
  sessionInfo?: { sessionId: string; models: string[]; modes: { id: string; name?: string }[] };
  systemMessages: string[];
  commands?: { name: string; description: string; inputHint?: string }[];
}

// ── Message queue ──

export interface QueuedMessage {
  id: string;
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  files?: Array<{ path: string; name: string }>;
  addedAt: number;
}

// ── Event sink ──

/** Minimal interface for sending data to a WebSocket client. */
export interface WsSendable {
  send(data: string): void;
}

/**
 * Replaceable callback the API server provides to the daemon.
 * The daemon calls this for every event that should reach clients.
 * The API server replaces it on every HMR reload with a closure
 * capturing the fresh `clients` Map.
 */
export type EventSink = (msg: object, sessionId?: string | null) => void;

// ── Daemon interface ──

export interface AgentsDaemon {
  // ── Event sink ──
  setEventSink(sink: EventSink): void;

  // ── Lifecycle ──
  /** Initialize the daemon (spawn ACP connection, warm pools, recover sessions). */
  init(): Promise<void>;
  /** Promise that resolves when init() completes. */
  readonly ready: Promise<void>;

  // ── Session lifecycle ──
  createSession(): Promise<{ sessionId: string }>;
  resumeSession(sessionId: string): Promise<void>;
  prompt(sessionId: string, text: string, images?: Array<{ data: string; mimeType: string }>, files?: Array<{ path: string; name: string }>): void;
  interrupt(sessionId: string): Promise<void>;

  // ── Queries ──
  getHistory(sessionId: string): Promise<{ entries: unknown[] }>;
  getSubagentHistory(parentSessionId: string, agentId: string): Promise<{ entries: unknown[] }>;
  broadcastSessions(): Promise<void>;
  getSubagents(sessionId: string): Promise<any>;
  getAvailableCommands(sessionIdHint?: string): Promise<any>;
  getTasksList(sessionId: string): Promise<any>;

  // ── Session management ──
  renameSession(sessionId: string, title: string): Promise<boolean>;
  deleteSession(sessionId: string): Promise<{ success: boolean; deletedIds: string[] }>;
  cleanupStaleSession(sessionId: string): void;

  // ── State accessors ──
  getTurnStatusSnapshot(sessionId: string): object | null;
  sendTurnState(ws: WsSendable, sessionId: string): void;
  sendSessionMeta(ws: WsSendable, sessionId: string): void;
  sendQueueState(ws: WsSendable, sessionId: string): void;
  augmentHistoryWithTurnStats(sessionId: string, entries: unknown[]): unknown[];

  // ── Routing ──
  routeWithHaiku(text: string, sessionTitle: string | null, lastTurnSummary: string | null): Promise<boolean>;
  isRouteWhitelisted(text: string): boolean;
  getLastTurnSummary(sessionId: string): Promise<string | null>;
  getSessionTitle(sessionId: string): string | null;

  // ── Queue management ──
  enqueueMessage(sessionId: string, msg: QueuedMessage): void;
  cancelQueuedMessage(sessionId: string, queueId: string): boolean;
  isProcessing(sessionId: string): boolean;
  clearSessionQueue(sessionId: string | null): void;

  // ── Metrics ──
  getHaikuMetrics(): MetricEntry[];
  getOpusMetrics(): MetricEntry[];

  // ── Mutable state ──
  readonly liveSessionIds: Set<string>;
  defaultSessionId: string | null;
  readonly autoRenameEligible: Set<string>;

  // ── Permission forwarding ──
  resolvePermission(requestId: string, optionId: string, optionName: string): void;
  cancelPermissions(sessionId: string): void;
}

import { useState, useRef, useEffect, useLayoutEffect, memo } from "react";
import { useWs } from "../context/WebSocketContext";
import { cleanTitle, shortPath, relativeTime } from "../utils";
import type { DiskSession, SubagentChild, SubagentType, TurnStatus, TurnActivity } from "../types";

const SPARKLE_CHARS = ["·", "✻", "✽", "✶", "✳", "✢"];

/** Animated sparkle for in-progress sessions (matches TurnStatusBar active style). */
function SidebarSparkleActive() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setIdx((i) => (i + 1) % SPARKLE_CHARS.length), 250);
    return () => clearInterval(id);
  }, []);
  return <span className="sidebar-status-star active">{SPARKLE_CHARS[idx]}</span>;
}

/** Static star for idle sessions (matches TurnStatusBar completed style). */
function SidebarSparkleIdle() {
  return <span className="sidebar-status-star idle">*</span>;
}

const ACTIVITY_LABELS: Record<TurnActivity, string> = {
  brewing: "Brewing",
  thinking: "Thinking",
  responding: "Responding",
  reading: "Reading",
  editing: "Editing",
  running: "Running",
  searching: "Searching",
  delegating: "Delegating",
  planning: "Planning",
  compacting: "Compacting",
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Compact completed label matching CompletedBar format: "* Brewed for Xs · Xk tokens" */
function SidebarCompletedLabel({ turnInfo, isUnread }: { turnInfo: TurnStatus; isUnread?: boolean }) {
  const duration = turnInfo.durationMs ?? 0;
  const tokens = turnInfo.outputTokens ?? turnInfo.approxTokens;
  const thinkingMs = turnInfo.thinkingDurationMs ?? 0;

  const parts: string[] = [formatDuration(duration)];
  if (tokens && tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
  if (thinkingMs >= 1000) parts.push(`thought for ${formatDuration(thinkingMs)}`);

  return <><span className={`sidebar-status-star ${isUnread ? "active-blue" : "idle"}`}>*</span> Brewed for {parts.join(" · ")}</>;
}

/** Compact in-progress label for sidebar: "Reading... (5s)" */
function SidebarInProgressLabel({ turnInfo }: { turnInfo: TurnStatus }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = now - turnInfo.startedAt;
  const activity = turnInfo.activity ?? "brewing";
  const label = ACTIVITY_LABELS[activity];

  return (
    <span className="truncate">
      {label}... {formatDuration(elapsed)}
    </span>
  );
}

export const SessionItem = memo(function SessionItem({
  session,
  isActive,
  isLive,
  turnStatus,
  turnInfo,
  hasChildren,
  isUnread,
  onClick,
  onMore,
}: {
  session: DiskSession;
  isActive: boolean;
  isLive: boolean;
  turnStatus?: "in_progress" | "completed" | "error";
  /** Full turn status (only available for the current session). */
  turnInfo?: TurnStatus | null;
  hasChildren: boolean;
  isUnread: boolean;
  onClick: () => void;
  onMore: (e: React.MouseEvent) => void;
}) {
  const isInProgress = isLive && turnStatus === "in_progress";
  const isCompleted = turnStatus === "completed";

  return (
    <button
      onClick={onClick}
      className="session-item-btn group w-full min-w-0 overflow-hidden text-left transition-colors cursor-pointer"
    >
      <div className="flex items-center gap-1.5">
        {session.teamName && (
          <span className="team-badge">Team</span>
        )}
        <div className="session-item-title truncate flex-1 min-w-0">
          {cleanTitle(session.title)}
        </div>
        <span
          onClick={onMore}
          className="session-more-btn shrink-0 w-5 h-5 flex items-center justify-center rounded text-dim opacity-0 group-hover:opacity-100 hover:bg-[var(--color-border)] hover:text-text transition-all cursor-pointer"
          title="More actions"
        >
          &#x22EE;
        </span>
      </div>
      <div className="session-item-meta">
        <span className={`truncate flex items-center gap-1 min-w-0 ${isInProgress ? "sidebar-in-progress" : isCompleted && isUnread ? "" : ""}`}>
          {isInProgress && <SidebarSparkleActive />}
          {isLive && !isInProgress && !isCompleted && <SidebarSparkleIdle />}
          {isInProgress ? (
            turnInfo ? (
              <SidebarInProgressLabel turnInfo={turnInfo} />
            ) : (
              <span className="truncate">Working...</span>
            )
          ) : isCompleted ? (
            <span className="truncate" style={isUnread ? { color: "var(--color-blue)" } : undefined}>
              {turnInfo ? <SidebarCompletedLabel turnInfo={turnInfo} isUnread={isUnread} /> : "* Brewed"}
            </span>
          ) : (
            <span className="truncate">
              {shortPath(session.projectPath) ?? session.sessionId.slice(0, 8)}
              {session.gitBranch && (
                <span className="opacity-50"> ({session.gitBranch})</span>
              )}
            </span>
          )}
        </span>
        <span className="shrink-0 ml-1 session-item-time">
          {relativeTime(session.updatedAt)}
        </span>
      </div>
    </button>
  );
}, (prev, next) => {
  // Custom comparator: ignore onClick/onMore (always new inline references)
  return prev.session === next.session
    && prev.isActive === next.isActive
    && prev.isLive === next.isLive
    && prev.turnStatus === next.turnStatus
    && prev.turnInfo === next.turnInfo
    && prev.hasChildren === next.hasChildren
    && prev.isUnread === next.isUnread;
});

const AGENT_TYPE_STYLES: Record<SubagentType, { label: string; className: string }> = {
  code:    { label: "Code",    className: "subagent-badge code" },
  explore: { label: "Explore", className: "subagent-badge explore" },
  plan:    { label: "Plan",    className: "subagent-badge plan" },
  bash:    { label: "Bash",    className: "subagent-badge bash" },
  agent:   { label: "Agent",   className: "subagent-badge agent" },
};

export const SubagentItem = memo(function SubagentItem({
  child,
  parentSessionId,
  isActive,
  onClick,
  depth = 0,
  hasChildren = false,
  isExpanded = false,
  onToggle,
  scrollRef,
  isTeammate = false,
}: {
  child: SubagentChild;
  parentSessionId: string;
  isActive: boolean;
  onClick: () => void;
  depth?: number;
  hasChildren?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
  scrollRef?: React.Ref<HTMLDivElement>;
  isTeammate?: boolean;
}) {
  const badge = isTeammate
    ? { label: "Teammate", className: "subagent-badge teammate" }
    : AGENT_TYPE_STYLES[child.agentType] ?? AGENT_TYPE_STYLES.agent;
  const paddingLeft = 28 + depth * 16; // pl-7 = 28px base, +16px per depth level
  return (
    <div ref={scrollRef} className={`relative${depth > 0 ? " subagent-nested" : ""}`}>
      <button
        onClick={onClick}
        style={{ paddingLeft: hasChildren ? paddingLeft + 18 : paddingLeft }}
        className={`subagent-item-btn w-full text-left pr-3 transition-colors cursor-pointer ${
          isActive
            ? "subagent-item-active"
            : "subagent-item-inactive"
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={badge.className}>{badge.label}</span>
          <span className="subagent-item-title truncate">{child.taskPrompt || "Sub-agent"}</span>
        </div>
        <div className="subagent-item-meta">
          <span className="truncate">{child.agentId.slice(0, 8)}</span>
          <span className="shrink-0 ml-1">{relativeTime(child.timestamp)}</span>
        </div>
      </button>
      {hasChildren && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
          style={{ left: paddingLeft - 2 }}
          className={`absolute top-1/2 -translate-y-1/2 z-10 session-chevron${isExpanded ? " expanded" : ""}`}
          title={`${child.children!.length} nested agent${child.children!.length > 1 ? "s" : ""}`}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M4.5 2.5L7.5 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}, (prev, next) => {
  return prev.child === next.child
    && prev.isActive === next.isActive
    && prev.depth === next.depth
    && prev.hasChildren === next.hasChildren
    && prev.isExpanded === next.isExpanded
    && prev.isTeammate === next.isTeammate;
});

export function SessionContextMenu({
  sessionId,
  anchorPos,
  onClose,
}: {
  sessionId: string;
  sessionTitle?: string | null;
  anchorPos: { x: number; y: number };
  onClose: () => void;
}) {
  const { deleteSession } = useWs();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("click", handleClickOutside, true);
    return () => document.removeEventListener("click", handleClickOutside, true);
  }, [onClose]);

  const [flipped, setFlipped] = useState(false);

  useLayoutEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      if (rect.bottom > window.innerHeight) {
        setFlipped(true);
      }
    }
  }, [anchorPos]);

  const style: React.CSSProperties = {
    position: "fixed",
    left: anchorPos.x,
    zIndex: 50,
    ...(flipped
      ? { bottom: window.innerHeight - anchorPos.y }
      : { top: anchorPos.y }),
  };

  return (
    <div ref={menuRef} className="session-context-menu" style={style}>
      <button
        className="session-context-item delete"
        onClick={() => {
          deleteSession(sessionId);
          onClose();
        }}
      >
        Delete
      </button>
    </div>
  );
}

/** Walk a sub-agent tree and return the path of agentIds from root to the target (exclusive). */
export function findAncestorPath(children: SubagentChild[], targetId: string): string[] | null {
  for (const child of children) {
    if (child.agentId === targetId) return [];
    // Also match by sessionId for teammate children
    if (child.sessionId === targetId) return [];
    if (child.children?.length) {
      const sub = findAncestorPath(child.children, targetId);
      if (sub !== null) return [child.agentId, ...sub];
    }
  }
  return null;
}

/** Find the parent DiskSession that contains a teammate child with the given sessionId. */
export function findTeammateParent(diskSessions: DiskSession[], teammateSessionId: string): DiskSession | null {
  for (const session of diskSessions) {
    if (!session.children?.length) continue;
    if (findAncestorPath(session.children, teammateSessionId) !== null) {
      return session;
    }
  }
  return null;
}

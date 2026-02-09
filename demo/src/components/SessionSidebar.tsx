import { useState, useRef, useEffect, useLayoutEffect, memo } from "react";
import { useWs } from "../context/WebSocketContext";
import { useTheme, THEMES } from "../context/ThemeContext";
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
function SidebarCompletedLabel({ turnInfo }: { turnInfo: TurnStatus }) {
  const duration = turnInfo.durationMs ?? 0;
  const tokens = turnInfo.outputTokens ?? turnInfo.approxTokens;
  const thinkingMs = turnInfo.thinkingDurationMs ?? 0;

  const parts: string[] = [formatDuration(duration)];
  if (tokens && tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
  if (thinkingMs >= 1000) parts.push(`thought for ${formatDuration(thinkingMs)}`);

  return <>* Brewed for {parts.join(" · ")}</>;
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
      {label}... ({formatDuration(elapsed)})
    </span>
  );
}

/** Strip XML tags from session titles and extract a readable summary. */
function cleanTitle(raw: string | null): string {
  if (!raw) return "New session";

  // Extract teammate-message content and build a readable label
  const tmRe = /<teammate-message\s+([^>]*)>([\s\S]*?)<\/teammate-message>/g;
  let cleaned = raw;
  let hadTeammate = false;

  cleaned = cleaned.replace(tmRe, (_match, attrStr, body) => {
    hadTeammate = true;
    // Try to extract the teammate_id
    const idMatch = attrStr.match(/teammate_id="([^"]*)"/);
    const from = idMatch?.[1] ?? "";

    const trimmed = body.trim();
    // If body is JSON, try to extract a meaningful field
    try {
      const json = JSON.parse(trimmed);
      if (json.subject) return `[${from}] ${json.subject}`;
      if (json.reason) return `[${from}] ${json.reason}`;
      if (json.type) return `[${from}] ${json.type.replace(/_/g, " ")}`;
    } catch { /* not JSON */ }

    // Plain text — take first line as summary
    const firstLine = trimmed.split("\n")[0].slice(0, 80);
    return from ? `[${from}] ${firstLine}` : firstLine;
  });

  // Strip any remaining XML tags
  cleaned = cleaned.replace(/<[^>]+>/g, "").trim();

  if (!cleaned) return hadTeammate ? "Teammate message" : "New session";
  return cleaned;
}

/** Shorten a project path to the last 2 segments. */
function shortPath(p: string | null): string | null {
  if (!p) return null;
  const parts = p.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return parts.slice(-2).join("/");
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const SessionItem = memo(function SessionItem({
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
              {turnInfo ? <SidebarCompletedLabel turnInfo={turnInfo} /> : "* Brewed"}
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

const SubagentItem = memo(function SubagentItem({
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

function SessionContextMenu({
  sessionId,
  sessionTitle,
  anchorPos,
  onClose,
}: {
  sessionId: string;
  sessionTitle: string | null;
  anchorPos: { x: number; y: number };
  onClose: () => void;
}) {
  const { deleteSession, renameSession } = useWs();
  const menuRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(sessionTitle ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (renaming) inputRef.current?.focus();
  }, [renaming]);

  useLayoutEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      if (rect.bottom > window.innerHeight) {
        setFlipped(true);
      }
    }
  }, [anchorPos]);

  const submitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== (sessionTitle ?? "")) {
      renameSession(sessionId, trimmed);
    }
    onClose();
  };

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
      {renaming ? (
        <div className="session-rename-input-wrapper">
          <input
            ref={inputRef}
            className="session-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRename();
              if (e.key === "Escape") onClose();
            }}
            onBlur={submitRename}
          />
        </div>
      ) : (
        <>
          <button
            className="session-context-item"
            onClick={() => setRenaming(true)}
          >
            Rename
          </button>
          <button
            className="session-context-item delete"
            onClick={() => {
              deleteSession(sessionId);
              onClose();
            }}
          >
            Delete
          </button>
        </>
      )}
    </div>
  );
}

/** Walk a sub-agent tree and return the path of agentIds from root to the target (exclusive). */
function findAncestorPath(children: SubagentChild[], targetId: string): string[] | null {
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
function findTeammateParent(diskSessions: DiskSession[], teammateSessionId: string): DiskSession | null {
  for (const session of diskSessions) {
    if (!session.children?.length) continue;
    if (findAncestorPath(session.children, teammateSessionId) !== null) {
      return session;
    }
  }
  return null;
}

export function SessionSidebar() {
  const { state, newSession, resumeSession, resumeSubagent, requestSubagents } = useWs();
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; title: string | null; x: number; y: number } | null>(null);
  // Track which sessions have had subagents loaded
  const [subagentsLoaded, setSubagentsLoaded] = useState<Set<string>>(new Set());
  const [subagentsLoading, setSubagentsLoading] = useState<Set<string>>(new Set());

  // Use pending session id for optimistic active highlighting
  const activeSessionId = state.switchingToSessionId ?? state.currentSessionId;

  // Auto-expand sidebar tree when navigating to a sub-agent or teammate session
  useEffect(() => {
    if (!activeSessionId) return;

    let parentId: string;
    let targetId: string;

    const subMatch = activeSessionId.match(/^(.+):subagent:(.+)$/);
    if (subMatch) {
      [, parentId, targetId] = subMatch;
    } else {
      // Check if activeSessionId is a teammate session nested under a parent
      const parent = findTeammateParent(state.diskSessions, activeSessionId);
      if (!parent) return;
      parentId = parent.sessionId;
      targetId = activeSessionId;
    }

    // Expand the parent session and load subagents if needed
    setExpandedSessions((prev) => {
      if (prev.has(parentId)) return prev;
      const next = new Set(prev);
      next.add(parentId);
      return next;
    });

    // Load subagents for the parent if not yet loaded
    if (!subagentsLoaded.has(parentId) && !subagentsLoading.has(parentId)) {
      setSubagentsLoading((p) => { const n = new Set(p); n.add(parentId); return n; });
      requestSubagents(parentId);
    }

    // Expand ancestor agents in the tree path to the target
    const session = state.diskSessions.find((s) => s.sessionId === parentId);
    if (!session?.children?.length) return;

    const ancestors = findAncestorPath(session.children, targetId);
    if (!ancestors?.length) return;

    setExpandedAgents((prev) => {
      const missing = ancestors.filter((id) => !prev.has(id));
      if (!missing.length) return prev;
      const next = new Set(prev);
      for (const id of missing) next.add(id);
      return next;
    });
  }, [activeSessionId, state.diskSessions, subagentsLoaded, subagentsLoading, requestSubagents]);

  // Auto-fetch subagents for the active session when a turn completes.
  // This ensures newly-spawned sub-agents appear in the sidebar without
  // requiring the user to click the sub-agent link in the chat.
  const prevTurnStatusRef = useRef<string | undefined>();
  useEffect(() => {
    if (!activeSessionId) return;
    // Only act on the base session (not sub-agent sessions)
    if (activeSessionId.includes(":subagent:")) return;

    const session = state.diskSessions.find((s) => s.sessionId === activeSessionId);
    const currentStatus = session?.turnStatus;
    const prevStatus = prevTurnStatusRef.current;
    prevTurnStatusRef.current = currentStatus;

    // When a turn completes, refresh subagents from the server
    if (prevStatus === "in_progress" && currentStatus === "completed") {
      requestSubagents(activeSessionId);
    }
  }, [activeSessionId, state.diskSessions, requestSubagents]);

  // Scroll active sub-agent into view after tree expansion
  const activeSubagentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activeSessionId) return;
    // Only scroll for sub-agent or teammate navigation
    const isSubagent = activeSessionId.includes(":subagent:");
    const isTeammate = !isSubagent && findTeammateParent(state.diskSessions, activeSessionId);
    if (!isSubagent && !isTeammate) return;

    // Delay to allow React to render the expanded tree
    const timer = setTimeout(() => {
      activeSubagentRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 50);
    return () => clearTimeout(timer);
  }, [activeSessionId, state.diskSessions]);

  const toggleExpand = (sessionId: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
        // Load subagents on first expand if not yet loaded
        if (!subagentsLoaded.has(sessionId) && !subagentsLoading.has(sessionId)) {
          setSubagentsLoading((p) => { const n = new Set(p); n.add(sessionId); return n; });
          requestSubagents(sessionId);
        }
      }
      return next;
    });
  };

  // Mark subagents as loaded when they arrive via SESSION_SUBAGENTS
  useEffect(() => {
    for (const sessionId of subagentsLoading) {
      const session = state.diskSessions.find((s) => s.sessionId === sessionId);
      // If the session now has non-teammate children, the subagents have loaded
      const hasSubagents = session?.children?.some((c: any) => !c.sessionId);
      if (hasSubagents || session) {
        setSubagentsLoaded((p) => { const n = new Set(p); n.add(sessionId); return n; });
        setSubagentsLoading((p) => { const n = new Set(p); n.delete(sessionId); return n; });
      }
    }
  }, [state.diskSessions, subagentsLoading]);

  const toggleAgentExpand = (agentId: string) => {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const renderSubagentTree = (children: SubagentChild[], parentSessionId: string, depth: number) => {
    return children.map((child) => {
      const hasKids = (child.children?.length ?? 0) > 0;
      const isAgentExpanded = expandedAgents.has(child.agentId);
      // Teammate sessions have their own sessionId — load via resumeSession
      const isTeammate = !!child.sessionId;
      const isActive = isTeammate
        ? activeSessionId === child.sessionId
        : activeSessionId === `${parentSessionId}:subagent:${child.agentId}`;
      const handleClick = isTeammate
        ? () => resumeSession(child.sessionId!)
        : () => resumeSubagent(parentSessionId, child.agentId);
      return (
        <div key={child.agentId}>
          <SubagentItem
            child={child}
            parentSessionId={parentSessionId}
            isActive={isActive}
            onClick={handleClick}
            depth={depth}
            hasChildren={hasKids}
            isExpanded={isAgentExpanded}
            onToggle={() => toggleAgentExpand(child.agentId)}
            scrollRef={isActive ? activeSubagentRef : undefined}
            isTeammate={isTeammate}
          />
          {hasKids && isAgentExpanded && renderSubagentTree(child.children!, parentSessionId, depth + 1)}
        </div>
      );
    });
  };

  // Custom overlay scrollbar
  const sidebarListRef = useRef<HTMLDivElement>(null);
  const scrollThumbRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const updateScrollThumb = (el: HTMLElement) => {
    const thumb = scrollThumbRef.current;
    if (!thumb) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight) {
      thumb.style.opacity = "0";
      return;
    }
    const ratio = clientHeight / scrollHeight;
    const thumbH = Math.max(ratio * clientHeight, 24);
    const maxScroll = scrollHeight - clientHeight;
    const thumbTop = (scrollTop / maxScroll) * (clientHeight - thumbH);
    thumb.style.height = `${thumbH}px`;
    thumb.style.top = `${thumbTop}px`;
  };

  const handleSidebarScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const thumb = scrollThumbRef.current;
    if (thumb) thumb.style.opacity = "1";
    updateScrollThumb(el);
    clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      if (thumb) thumb.style.opacity = "0";
    }, 800);
  };

  const liveSessionIds = new Set(
    state.diskSessions.filter((s) => s.isLive).map((s) => s.sessionId),
  );

  return (
    <div className="sidebar-container">
      {/* Header */}
      <div className="sidebar-header">
        <span className="sidebar-header-label">
          {(() => {
            const active = state.diskSessions.find((s) => s.sessionId === activeSessionId);
            return shortPath(active?.projectPath ?? null) ?? "Sessions";
          })()}
        </span>
        <button
          onClick={newSession}
          className="sidebar-new-btn"
          title="New session"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 2.5V11.5M2.5 7H11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Session list */}
      <div className="sidebar-list-wrap">
      <div
        className="sidebar-list"
        ref={sidebarListRef}
        onScroll={handleSidebarScroll}
      >
        {state.diskSessions.length === 0 && !state.diskSessionsLoaded && (
          <div className="flex items-center justify-center py-8">
            <span className="sidebar-spinner" />
          </div>
        )}
        {state.diskSessions.length === 0 && state.diskSessionsLoaded && (
          <div className="sidebar-empty">
            No sessions yet
          </div>
        )}
        {state.diskSessions.map((session) => {
          const hasChildren = (session.children?.length ?? 0) > 0;
          const isExpanded = expandedSessions.has(session.sessionId);
          const isLoadingSubagents = subagentsLoading.has(session.sessionId);
          return (
            <div key={session.sessionId}>
              <div className={`session-row${session.sessionId === activeSessionId ? " session-row-active" : ""}`}>
                <button
                  onClick={(e) => { e.stopPropagation(); toggleExpand(session.sessionId); }}
                  className={`session-chevron-slot${isExpanded ? " expanded" : ""}`}
                  tabIndex={0}
                  title={hasChildren ? `${session.children!.length} sub-agent${session.children!.length > 1 ? "s" : ""}` : "Show sub-agents"}
                >
                  {isLoadingSubagents ? (
                    <span className="sidebar-spinner" style={{ width: 12, height: 12 }} />
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M4.5 2.5L7.5 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <SessionItem
                    session={session}
                    isActive={session.sessionId === activeSessionId}
                    isLive={liveSessionIds.has(session.sessionId)}
                    turnStatus={session.turnStatus}
                    turnInfo={state.liveTurnStatus[session.sessionId] ?? (session.sessionId === state.currentSessionId ? state.turnStatus : null)}
                    hasChildren={hasChildren}
                    isUnread={!!state.unreadCompletedSessions[session.sessionId]}
                    onClick={() => {
                      if (session.sessionId !== activeSessionId)
                        resumeSession(session.sessionId);
                    }}
                    onMore={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      const rect = (e.target as HTMLElement).getBoundingClientRect();
                      setContextMenu({ sessionId: session.sessionId, title: session.title, x: rect.right, y: rect.bottom });
                    }}
                  />
                </div>
              </div>
              {isExpanded && (
                hasChildren
                  ? renderSubagentTree(session.children!, session.sessionId, 0)
                  : !isLoadingSubagents && (
                    <div className="subagent-empty-placeholder">No sub-agent sessions</div>
                  )
              )}
            </div>
          );
        })}
      </div>
      <div ref={scrollThumbRef} className="sidebar-scroll-thumb" />
      </div>

      {/* Context menu popover */}
      {contextMenu && (
        <SessionContextMenu
          sessionId={contextMenu.sessionId}
          sessionTitle={contextMenu.title}
          anchorPos={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Footer with logo + settings */}
      <SidebarFooter />
    </div>
  );
}

const isMac = navigator.platform.startsWith("Mac");
const MOD = isMac ? "\u2318" : "Ctrl";
const KEYBINDINGS: { keys: string; description: string }[] = [
  { keys: "Enter", description: "Send message" },
  { keys: "Shift+Enter", description: "New line" },
  { keys: "Escape", description: "Interrupt agent" },
  { keys: `${MOD}+Z`, description: "Undo" },
  { keys: `${MOD}+Shift+Z`, description: "Redo" },
  { keys: `${MOD}+Shift+P`, description: "Toggle protocol debug" },
  { keys: "/", description: "Slash commands" },
  { keys: "@", description: "Mention file" },
];

type FooterTab = "theme" | "keybindings";

function SidebarFooter() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<FooterTab>("theme");
  const footerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (footerRef.current && !footerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("click", handleClickOutside, true);
    return () => document.removeEventListener("click", handleClickOutside, true);
  }, [open]);

  return (
    <div ref={footerRef} className="relative shrink-0">
      {open && (
        <div className="theme-popover">
          <div className="popover-tabs">
            <button
              className={`popover-tab${tab === "theme" ? " active" : ""}`}
              onClick={() => setTab("theme")}
            >
              Theme
            </button>
            <button
              className={`popover-tab${tab === "keybindings" ? " active" : ""}`}
              onClick={() => setTab("keybindings")}
            >
              Keybindings
            </button>
          </div>
          {tab === "theme" && THEMES.map((t) => (
            <button
              key={t.id}
              className="theme-option"
              onClick={() => { setTheme(t.id); setOpen(false); }}
            >
              <span
                className="theme-swatch"
                style={{ background: t.swatch }}
              />
              <span className="theme-option-info">
                <span className="theme-option-name">{t.label}</span>
                <span className="theme-option-desc"> {t.description}</span>
              </span>
              <span className="theme-check">
                {theme === t.id ? "\u2713" : ""}
              </span>
            </button>
          ))}
          {tab === "keybindings" && (
            <div className="keybindings-list">
              {KEYBINDINGS.map((kb) => (
                <div key={kb.keys} className="keybinding-row">
                  <kbd className="keybinding-keys">{kb.keys}</kbd>
                  <span className="keybinding-desc">{kb.description}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="px-4 py-3 flex items-center gap-2">
        <svg
          className="w-3.5 h-3.5 shrink-0 opacity-80"
          viewBox="0 0 1200 1200"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            fill="#d97757"
            d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z"
          />
        </svg>
        <span className="text-[11px] font-semibold text-text opacity-80">Claude Code ACP</span>
        <div className="flex-1" />
        <button
          onClick={() => setOpen((prev) => !prev)}
          className="w-6 h-6 flex items-center justify-center rounded-md text-dim hover:text-text hover:bg-[var(--color-overlay)] transition-colors cursor-pointer"
          title="Settings"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

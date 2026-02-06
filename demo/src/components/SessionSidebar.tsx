import { useState, useRef, useEffect } from "react";
import { useWs } from "../context/WebSocketContext";
import type { DiskSession, SubagentChild, SubagentType } from "../types";

/** Strip XML tags from session titles and extract a readable summary. */
function cleanTitle(raw: string | null): string {
  if (!raw) return "No prompt";

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

  if (!cleaned) return hadTeammate ? "Teammate message" : "No prompt";
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

function SessionItem({
  session,
  isActive,
  isLive,
  hasChildren,
  onClick,
  onMore,
}: {
  session: DiskSession;
  isActive: boolean;
  isLive: boolean;
  hasChildren: boolean;
  onClick: () => void;
  onMore: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`session-item-btn group w-full min-w-0 overflow-hidden text-left pr-2 py-2 border-b border-border transition-colors cursor-pointer ${
        hasChildren ? "pl-6" : "pl-3"
      } ${
        isActive
          ? "bg-[var(--color-accent-dim)] border-l-2 border-l-[var(--color-accent)]"
          : "hover:bg-[var(--color-border)] border-l-2 border-l-transparent"
      }`}
    >
      <div className="flex items-center gap-1">
        <div
          className={`text-xs truncate flex-1 min-w-0 ${
            isActive ? "text-text font-medium" : "text-dim"
          }`}
        >
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
      <div className="text-[10px] text-dim mt-0.5 flex items-center justify-between min-w-0">
        <span className="truncate opacity-60 flex items-center gap-1 min-w-0">
          {isLive && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
          )}
          <span className="truncate">
            {shortPath(session.projectPath) ?? session.sessionId.slice(0, 8)}
            {session.gitBranch && (
              <span className="opacity-60"> ({session.gitBranch})</span>
            )}
          </span>
        </span>
        <span className="shrink-0 ml-1">
          {relativeTime(session.updatedAt)}
        </span>
      </div>
    </button>
  );
}

const AGENT_TYPE_STYLES: Record<SubagentType, { label: string; className: string }> = {
  code:    { label: "Code",    className: "subagent-badge code" },
  explore: { label: "Explore", className: "subagent-badge explore" },
  bash:    { label: "Bash",    className: "subagent-badge bash" },
  agent:   { label: "Agent",   className: "subagent-badge agent" },
};

function SubagentItem({
  child,
  parentSessionId,
  isActive,
  onClick,
}: {
  child: SubagentChild;
  parentSessionId: string;
  isActive: boolean;
  onClick: () => void;
}) {
  const badge = AGENT_TYPE_STYLES[child.agentType] ?? AGENT_TYPE_STYLES.agent;
  return (
    <button
      onClick={onClick}
      className={`w-full text-left pl-7 pr-3 py-1.5 border-b border-border transition-colors cursor-pointer ${
        isActive
          ? "bg-[var(--color-accent-dim)] border-l-2 border-l-[var(--color-purple)]"
          : "hover:bg-[var(--color-border)] border-l-2 border-l-transparent"
      }`}
    >
      <div className={`text-xs truncate flex items-center gap-1.5 ${isActive ? "text-text font-medium" : "text-dim"}`}>
        <span className={badge.className}>{badge.label}</span>
        <span className="truncate">{child.taskPrompt || "Sub-agent"}</span>
      </div>
      <div className="text-[10px] text-dim mt-0.5 flex items-center justify-between pl-3">
        <span className="truncate opacity-60">{child.agentId.slice(0, 8)}</span>
        <span className="shrink-0 ml-1">{relativeTime(child.timestamp)}</span>
      </div>
    </button>
  );
}

function SessionContextMenu({
  sessionId,
  anchorPos,
  onClose,
}: {
  sessionId: string;
  anchorPos: { x: number; y: number };
  onClose: () => void;
}) {
  const { deleteSession } = useWs();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  // Adjust position so menu doesn't overflow viewport
  const style: React.CSSProperties = {
    position: "fixed",
    left: anchorPos.x,
    top: anchorPos.y,
    zIndex: 50,
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

export function SessionSidebar() {
  const { state, newSession, resumeSession, resumeSubagent } = useWs();
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);

  // Use pending session id for optimistic active highlighting
  const activeSessionId = state.switchingToSessionId ?? state.currentSessionId;

  const toggleExpand = (sessionId: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const liveSessionIds = new Set(
    state.sessions.filter((s) => s.isLive).map((s) => s.sessionId),
  );

  return (
    <div className="w-72 shrink-0 bg-surface border-r border-border flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-border flex items-center justify-between">
        <span className="text-xs font-semibold text-dim uppercase tracking-wider">
          Sessions
        </span>
        <button
          onClick={newSession}
          className="w-6 h-6 flex items-center justify-center rounded text-dim hover:text-text hover:bg-[var(--color-border)] transition-colors text-lg leading-none cursor-pointer"
          title="New instance"
        >
          +
        </button>
      </div>

      {/* Unified session list */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {state.diskSessions.length === 0 && (
          <div className="px-3 py-3 text-xs text-dim text-center">
            No sessions found
          </div>
        )}
        {state.diskSessions.map((session) => {
          const hasChildren = (session.children?.length ?? 0) > 0;
          const isExpanded = expandedSessions.has(session.sessionId);
          return (
            <div key={session.sessionId}>
              <div className="relative flex items-center min-w-0">
                {hasChildren && (
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleExpand(session.sessionId); }}
                    className={`absolute left-1 top-1/2 -translate-y-1/2 z-10 session-chevron${isExpanded ? " expanded" : ""}`}
                    title={`${session.children!.length} sub-agent${session.children!.length > 1 ? "s" : ""}`}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M4.5 2.5L7.5 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
                <div className="flex-1 min-w-0">
                  <SessionItem
                    session={session}
                    isActive={session.sessionId === activeSessionId}
                    isLive={liveSessionIds.has(session.sessionId)}
                    hasChildren={hasChildren}
                    onClick={() => {
                      if (session.sessionId !== activeSessionId)
                        resumeSession(session.sessionId);
                    }}
                    onMore={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      const rect = (e.target as HTMLElement).getBoundingClientRect();
                      setContextMenu({ sessionId: session.sessionId, x: rect.right, y: rect.bottom });
                    }}
                  />
                </div>
              </div>
              {hasChildren && isExpanded &&
                session.children!.map((child) => (
                  <SubagentItem
                    key={child.agentId}
                    child={child}
                    parentSessionId={session.sessionId}
                    isActive={activeSessionId === `${session.sessionId}:subagent:${child.agentId}`}
                    onClick={() => resumeSubagent(session.sessionId, child.agentId)}
                  />
                ))}
            </div>
          );
        })}
      </div>

      {/* Context menu popover */}
      {contextMenu && (
        <SessionContextMenu
          sessionId={contextMenu.sessionId}
          anchorPos={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

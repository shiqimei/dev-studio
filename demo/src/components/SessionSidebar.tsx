import { useState } from "react";
import { useWs } from "../context/WebSocketContext";
import type { DiskSession, SubagentChild, SubagentType } from "../types";

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
  onClick,
}: {
  session: DiskSession;
  isActive: boolean;
  isLive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 border-b border-border transition-colors ${
        isActive
          ? "bg-[var(--color-accent-dim)] border-l-2 border-l-[var(--color-accent)]"
          : "hover:bg-[var(--color-border)] border-l-2 border-l-transparent"
      }`}
    >
      <div
        className={`text-xs truncate ${
          isActive ? "text-text font-medium" : "text-dim"
        }`}
      >
        {session.title || "New session"}
      </div>
      <div className="text-[10px] text-dim mt-0.5 flex items-center justify-between">
        <span className="truncate opacity-60 flex items-center gap-1">
          {isLive && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
          )}
          {session.sessionId.slice(0, 8)}
          {session.gitBranch && (
            <span className="opacity-60">({session.gitBranch})</span>
          )}
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
      className={`w-full text-left pl-7 pr-3 py-1.5 border-b border-border transition-colors ${
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

export function SessionSidebar() {
  const { state, newSession, resumeSession, resumeSubagent } = useWs();
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());

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
    <div className="w-60 shrink-0 bg-surface border-r border-border flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-border flex items-center justify-between">
        <span className="text-xs font-semibold text-dim uppercase tracking-wider">
          Sessions
        </span>
        <button
          onClick={newSession}
          className="w-6 h-6 flex items-center justify-center rounded text-dim hover:text-text hover:bg-[var(--color-border)] transition-colors text-lg leading-none"
          title="New instance"
        >
          +
        </button>
      </div>

      {/* Unified session list */}
      <div className="flex-1 overflow-y-auto">
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
              <div className="relative flex items-center">
                {hasChildren && (
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleExpand(session.sessionId); }}
                    className={`absolute left-1 z-10 session-chevron${isExpanded ? " expanded" : ""}`}
                    title={`${session.children!.length} sub-agent${session.children!.length > 1 ? "s" : ""}`}
                  >
                    ▶
                  </button>
                )}
                <div className="flex-1">
                  <SessionItem
                    session={session}
                    isActive={session.sessionId === state.currentSessionId}
                    isLive={liveSessionIds.has(session.sessionId)}
                    onClick={() => {
                      if (session.sessionId !== state.currentSessionId)
                        resumeSession(session.sessionId);
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
                    isActive={state.currentSessionId === `${session.sessionId}:subagent:${child.agentId}`}
                    onClick={() => resumeSubagent(session.sessionId, child.agentId)}
                  />
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

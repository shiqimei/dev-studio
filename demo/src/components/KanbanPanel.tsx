import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { useDrag, useDrop } from "react-dnd";
import { useWsState, useWsActions } from "../context/WebSocketContext";
import { ChatInput } from "./ChatInput";
import {
  SessionItem,
  SubagentItem,
  SessionContextMenu,
  findAncestorPath,
  findTeammateParent,
} from "./SessionSidebar";
import type { DiskSession, TurnStatus, SubagentChild } from "../types";

// ── Column definitions ──

type KanbanColumnId = "backlog" | "in_progress" | "in_review" | "recurring" | "completed";

interface ColumnDef {
  id: KanbanColumnId;
  label: string;
  emptyLabel: string;
}

const COLUMNS: ColumnDef[] = [
  { id: "backlog", label: "Backlog", emptyLabel: "No backlog sessions" },
  { id: "in_progress", label: "In Progress", emptyLabel: "No active sessions" },
  { id: "in_review", label: "In Review", emptyLabel: "No sessions to review" },
  { id: "recurring", label: "Recurring", emptyLabel: "No recurring sessions" },
  { id: "completed", label: "Completed", emptyLabel: "No completed sessions" },
];

// ── Drag-and-drop constants ──

const DRAG_TYPE = "KANBAN_SESSION";

interface KanbanDragItem {
  sessionId: string;
  sourceColumn: KanbanColumnId;
  index: number;
}

function categorizeSession(
  session: DiskSession,
  liveTurnStatus: Record<string, TurnStatus>,
  unreadCompletedSessions: Record<string, true>,
): KanbanColumnId {
  const live = liveTurnStatus[session.sessionId];
  // Currently running
  if (live?.status === "in_progress" || session.turnStatus === "in_progress") return "in_progress";
  // Just completed, unread — needs review
  if (
    (live?.status === "completed" || session.turnStatus === "completed") &&
    unreadCompletedSessions[session.sessionId]
  ) return "in_review";
  // Completed and read
  if (live?.status === "completed" || session.turnStatus === "completed") return "completed";
  // Live/connected sessions that recur
  if (session.isLive) return "recurring";
  // Everything else
  return "backlog";
}

// ── Kanban session row (mirrors sidebar session-row exactly) ──

function KanbanSessionRow({
  session,
  columnId,
  index,
  isActive,
  isLive,
  turnInfo,
  isUnread,
  activeSessionId,
  onSelect,
  onMore,
  onMoveCard,
  expandedSessions,
  toggleExpand,
  expandedAgents,
  toggleAgentExpand,
  subagentsLoading,
  resumeSession,
  resumeSubagent,
}: {
  session: DiskSession;
  columnId: KanbanColumnId;
  index: number;
  isActive: boolean;
  isLive: boolean;
  turnInfo?: TurnStatus | null;
  isUnread: boolean;
  activeSessionId: string | null;
  onSelect: () => void;
  onMore: (e: React.MouseEvent) => void;
  onMoveCard: (dragSessionId: string, sourceCol: KanbanColumnId, targetIndex: number, targetCol: KanbanColumnId) => void;
  expandedSessions: Set<string>;
  toggleExpand: (sessionId: string) => void;
  expandedAgents: Set<string>;
  toggleAgentExpand: (agentId: string) => void;
  subagentsLoading: Set<string>;
  resumeSession: (sessionId: string) => void;
  resumeSubagent: (parentSessionId: string, agentId: string) => void;
}) {
  const hasChildren = (session.children?.length ?? 0) > 0;
  const isExpanded = expandedSessions.has(session.sessionId);
  const isLoadingSubagents = subagentsLoading.has(session.sessionId);

  const cardRef = useRef<HTMLDivElement>(null);

  const [{ isDragging }, dragRef] = useDrag({
    type: DRAG_TYPE,
    item: (): KanbanDragItem => ({ sessionId: session.sessionId, sourceColumn: columnId, index }),
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  });

  const [, dropRef] = useDrop({
    accept: DRAG_TYPE,
    hover: (item: KanbanDragItem, monitor) => {
      if (!cardRef.current) return;
      if (item.sessionId === session.sessionId) return;

      const dragIdx = item.index;
      const hoverIdx = index;
      const dragCol = item.sourceColumn;
      const hoverCol = columnId;

      // For same-column reorder, use midpoint threshold to prevent jitter
      if (dragCol === hoverCol) {
        if (dragIdx === hoverIdx) return;
        const rect = cardRef.current.getBoundingClientRect();
        const midY = (rect.bottom - rect.top) / 2;
        const clientOffset = monitor.getClientOffset();
        if (!clientOffset) return;
        const hoverClientY = clientOffset.y - rect.top;
        // Moving down: only move when cursor is below midpoint
        if (dragIdx < hoverIdx && hoverClientY < midY) return;
        // Moving up: only move when cursor is above midpoint
        if (dragIdx > hoverIdx && hoverClientY > midY) return;
      }

      onMoveCard(item.sessionId, dragCol, hoverIdx, hoverCol);

      // Mutate the drag item to reflect its new position (prevents repeated shuffling)
      item.index = hoverIdx;
      item.sourceColumn = hoverCol;
    },
    drop: () => ({}), // Signal that a card handled the drop (so column-level drop is skipped)
  });

  // Combine drag and drop refs onto the same element
  dragRef(dropRef(cardRef));

  const renderSubagentTree = (children: SubagentChild[], parentSessionId: string, depth: number) => {
    return children.map((child) => {
      const hasKids = (child.children?.length ?? 0) > 0;
      const isAgentExpanded = expandedAgents.has(child.agentId);
      const isTeammate = !!child.sessionId;
      const isChildActive = isTeammate
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
            isActive={isChildActive}
            onClick={handleClick}
            depth={depth}
            hasChildren={hasKids}
            isExpanded={isAgentExpanded}
            onToggle={() => toggleAgentExpand(child.agentId)}
            isTeammate={isTeammate}
          />
          {hasKids && isAgentExpanded && renderSubagentTree(child.children!, parentSessionId, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div ref={cardRef} className={isDragging ? "kanban-card-dragging" : ""}>
      <div className={`session-row${isActive ? " session-row-active" : ""}`}>
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
            isActive={isActive}
            isLive={isLive}
            turnStatus={session.turnStatus}
            turnInfo={turnInfo}
            hasChildren={hasChildren}
            isUnread={isUnread}
            onClick={onSelect}
            onMore={onMore}
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
}

// ── Column component ──

function KanbanColumnView({
  column,
  sessions,
  activeSessionId,
  liveTurnStatus,
  currentSessionId,
  turnStatus,
  unreadCompletedSessions,
  onSelectSession,
  onMore,
  onMoveCard,
  expandedSessions,
  toggleExpand,
  expandedAgents,
  toggleAgentExpand,
  subagentsLoading,
  resumeSession,
  resumeSubagent,
  liveSessionIds,
}: {
  column: ColumnDef;
  sessions: DiskSession[];
  activeSessionId: string | null;
  liveTurnStatus: Record<string, TurnStatus>;
  currentSessionId: string | null;
  turnStatus: TurnStatus | null;
  unreadCompletedSessions: Record<string, true>;
  onSelectSession: (sessionId: string) => void;
  onMore: (sessionId: string, title: string | null, e: React.MouseEvent) => void;
  onMoveCard: (dragSessionId: string, sourceCol: KanbanColumnId, targetIndex: number, targetCol: KanbanColumnId) => void;
  expandedSessions: Set<string>;
  toggleExpand: (sessionId: string) => void;
  expandedAgents: Set<string>;
  toggleAgentExpand: (agentId: string) => void;
  subagentsLoading: Set<string>;
  resumeSession: (sessionId: string) => void;
  resumeSubagent: (parentSessionId: string, agentId: string) => void;
  liveSessionIds: Set<string>;
}) {
  const [{ isOver, canDrop }, dropRef] = useDrop({
    accept: DRAG_TYPE,
    drop: (item: KanbanDragItem, monitor) => {
      // If a card-level drop target already handled this, skip
      if (monitor.didDrop()) return;
      // Drop on empty column space — move card to end of this column
      onMoveCard(item.sessionId, item.sourceColumn, sessions.length, column.id);
    },
    collect: (monitor) => ({
      isOver: monitor.isOver({ shallow: true }),
      canDrop: monitor.canDrop(),
    }),
  });

  const dropClass = isOver && canDrop
    ? " kanban-column-drop-active"
    : "";

  return (
    <div ref={dropRef as any} className={`kanban-column${dropClass}`}>
      <div className="kanban-column-header">
        <span className="kanban-column-title">{column.label}</span>
        <span className="kanban-column-count">{sessions.length}</span>
      </div>
      <div className="kanban-column-body">
        {sessions.length === 0 ? (
          <div className="kanban-column-empty">{column.emptyLabel}</div>
        ) : (
          sessions.map((session, idx) => (
            <KanbanSessionRow
              key={session.sessionId}
              session={session}
              columnId={column.id}
              index={idx}
              isActive={session.sessionId === activeSessionId}
              isLive={liveSessionIds.has(session.sessionId)}
              turnInfo={liveTurnStatus[session.sessionId] ?? (session.sessionId === currentSessionId ? turnStatus : null)}
              isUnread={!!unreadCompletedSessions[session.sessionId]}
              activeSessionId={activeSessionId}
              onSelect={() => onSelectSession(session.sessionId)}
              onMore={(e) => onMore(session.sessionId, session.title, e)}
              onMoveCard={onMoveCard}
              expandedSessions={expandedSessions}
              toggleExpand={toggleExpand}
              expandedAgents={expandedAgents}
              toggleAgentExpand={toggleAgentExpand}
              subagentsLoading={subagentsLoading}
              resumeSession={resumeSession}
              resumeSubagent={resumeSubagent}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── Main panel ──

export function KanbanPanel() {
  const state = useWsState();
  const { resumeSession, resumeSubagent, requestSubagents, deleteSession, renameSession, deselectSession } = useWsActions();

  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [subagentsLoaded, setSubagentsLoaded] = useState<Set<string>>(new Set());
  const [subagentsLoading, setSubagentsLoading] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; title: string | null; x: number; y: number } | null>(null);
  const [columnOverrides, setColumnOverrides] = useState<Record<string, KanbanColumnId>>({});
  const [sortOrders, setSortOrders] = useState<Partial<Record<KanbanColumnId, string[]>>>({});

  const activeSessionId = state.switchingToSessionId ?? state.currentSessionId;

  // Auto-clear overrides when a session goes in_progress (so it moves to the right column automatically)
  useEffect(() => {
    setColumnOverrides((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const sessionId of Object.keys(next)) {
        const live = state.liveTurnStatus[sessionId];
        if (live?.status === "in_progress") {
          delete next[sessionId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [state.liveTurnStatus]);

  // Auto-expand sidebar tree when navigating to a sub-agent or teammate session
  useEffect(() => {
    if (!activeSessionId) return;

    let parentId: string;
    let targetId: string;

    const subMatch = activeSessionId.match(/^(.+):subagent:(.+)$/);
    if (subMatch) {
      [, parentId, targetId] = subMatch;
    } else {
      const parent = findTeammateParent(state.diskSessions, activeSessionId);
      if (!parent) return;
      parentId = parent.sessionId;
      targetId = activeSessionId;
    }

    setExpandedSessions((prev) => {
      if (prev.has(parentId)) return prev;
      const next = new Set(prev);
      next.add(parentId);
      return next;
    });

    if (!subagentsLoaded.has(parentId) && !subagentsLoading.has(parentId)) {
      setSubagentsLoading((p) => { const n = new Set(p); n.add(parentId); return n; });
      requestSubagents(parentId);
    }

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

  // Auto-fetch subagents when a turn completes
  const prevTurnStatusRef = useRef<string | undefined>();
  useEffect(() => {
    if (!activeSessionId) return;
    if (activeSessionId.includes(":subagent:")) return;

    const session = state.diskSessions.find((s) => s.sessionId === activeSessionId);
    const currentStatus = session?.turnStatus;
    const prevStatus = prevTurnStatusRef.current;
    prevTurnStatusRef.current = currentStatus;

    if (prevStatus === "in_progress" && currentStatus === "completed") {
      requestSubagents(activeSessionId);
    }
  }, [activeSessionId, state.diskSessions, requestSubagents]);

  // Mark subagents as loaded when they arrive
  useEffect(() => {
    for (const sessionId of subagentsLoading) {
      const session = state.diskSessions.find((s) => s.sessionId === sessionId);
      const hasSubagents = session?.children?.some((c: any) => !c.sessionId);
      if (hasSubagents || session) {
        setSubagentsLoaded((p) => { const n = new Set(p); n.add(sessionId); return n; });
        setSubagentsLoading((p) => { const n = new Set(p); n.delete(sessionId); return n; });
      }
    }
  }, [state.diskSessions, subagentsLoading]);

  const toggleExpand = (sessionId: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
        if (!subagentsLoaded.has(sessionId) && !subagentsLoading.has(sessionId)) {
          setSubagentsLoading((p) => { const n = new Set(p); n.add(sessionId); return n; });
          requestSubagents(sessionId);
        }
      }
      return next;
    });
  };

  const toggleAgentExpand = (agentId: string) => {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const columnData = useMemo(() => {
    const buckets: Record<KanbanColumnId, DiskSession[]> = {
      backlog: [],
      in_progress: [],
      in_review: [],
      recurring: [],
      completed: [],
    };
    for (const session of state.diskSessions) {
      const overrideCol = columnOverrides[session.sessionId];
      const col = overrideCol ?? categorizeSession(session, state.liveTurnStatus, state.unreadCompletedSessions);
      buckets[col].push(session);
    }
    const byUpdatedAt = (a: DiskSession, b: DiskSession) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return tb - ta;
    };
    for (const [colId, sessions] of Object.entries(buckets) as [KanbanColumnId, DiskSession[]][]) {
      const order = sortOrders[colId];
      if (order && order.length > 0) {
        const orderMap = new Map(order.map((id, i) => [id, i]));
        sessions.sort((a, b) => {
          const ai = orderMap.get(a.sessionId);
          const bi = orderMap.get(b.sessionId);
          if (ai !== undefined && bi !== undefined) return ai - bi;
          if (ai !== undefined) return -1;
          if (bi !== undefined) return 1;
          return byUpdatedAt(a, b);
        });
      } else {
        sessions.sort(byUpdatedAt);
      }
    }
    return buckets;
  }, [state.diskSessions, state.liveTurnStatus, state.unreadCompletedSessions, columnOverrides, sortOrders]);

  // Keep a ref to the latest columnData for use in handleMoveCard
  const columnDataRef = useRef(columnData);
  columnDataRef.current = columnData;

  const handleMoveCard = useCallback(
    (dragSessionId: string, sourceCol: KanbanColumnId, targetIndex: number, targetCol: KanbanColumnId) => {
      // Update column override if cross-column
      if (sourceCol !== targetCol) {
        setColumnOverrides((prev) => ({ ...prev, [dragSessionId]: targetCol }));
      }

      setSortOrders((prev) => {
        const next = { ...prev };

        // Initialize column sort order from current display order if not yet tracked
        if (!next[sourceCol]) {
          next[sourceCol] = columnDataRef.current[sourceCol].map((s) => s.sessionId);
        }
        if (sourceCol !== targetCol && !next[targetCol]) {
          next[targetCol] = columnDataRef.current[targetCol].map((s) => s.sessionId);
        }

        // Remove from source
        const sourceArr = [...next[sourceCol]!];
        const removeIdx = sourceArr.indexOf(dragSessionId);
        if (removeIdx !== -1) sourceArr.splice(removeIdx, 1);

        if (sourceCol === targetCol) {
          // In-column reorder
          sourceArr.splice(targetIndex, 0, dragSessionId);
          next[sourceCol] = sourceArr;
        } else {
          // Cross-column move
          next[sourceCol] = sourceArr;
          const targetArr = [...next[targetCol]!];
          targetArr.splice(targetIndex, 0, dragSessionId);
          next[targetCol] = targetArr;
        }

        return next;
      });
    },
    [],
  );

  const handleSelectSession = (sessionId: string) => {
    if (sessionId === activeSessionId) {
      deselectSession();
    } else {
      resumeSession(sessionId);
    }
  };

  const handleMore = (sessionId: string, title: string | null, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setContextMenu({ sessionId, title, x: rect.right, y: rect.bottom });
  };

  const liveSessionIds = useMemo(
    () => new Set(state.diskSessions.filter((s) => s.isLive).map((s) => s.sessionId)),
    [state.diskSessions],
  );

  return (
    <div className="kanban-panel">
      <div className="kanban-board">
        {COLUMNS.map((col) => (
          <KanbanColumnView
            key={col.id}
            column={col}
            sessions={columnData[col.id]}
            activeSessionId={activeSessionId}
            liveTurnStatus={state.liveTurnStatus}
            currentSessionId={state.currentSessionId}
            turnStatus={state.turnStatus}
            unreadCompletedSessions={state.unreadCompletedSessions}
            onSelectSession={handleSelectSession}
            onMore={handleMore}
            onMoveCard={handleMoveCard}
            expandedSessions={expandedSessions}
            toggleExpand={toggleExpand}
            expandedAgents={expandedAgents}
            toggleAgentExpand={toggleAgentExpand}
            subagentsLoading={subagentsLoading}
            resumeSession={resumeSession}
            resumeSubagent={resumeSubagent}
            liveSessionIds={liveSessionIds}
          />
        ))}
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

      <div className="kanban-bottom-overlay">
        <div className="kanban-input-area">
          <ChatInput />
        </div>
      </div>
    </div>
  );
}

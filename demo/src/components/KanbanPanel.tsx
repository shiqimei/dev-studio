import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { useDrag, useDrop } from "react-dnd";
import { useWsState, useWsActions } from "../context/WebSocketContext";
import { ChatInput } from "./ChatInput";
import { cleanTitle } from "../utils";
import {
  SessionItem,
  SubagentItem,
  SessionContextMenu,
  findAncestorPath,
  findTeammateParent,
} from "./SessionSidebar";
import type { DiskSession, TurnStatus, SubagentChild } from "../types";

// ── Inline backlog card editor ──

function BacklogNewCard({ onSave, onCancel }: { onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && text.trim()) {
      e.preventDefault();
      onSave(text.trim());
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <div className="kanban-new-card">
      <textarea
        ref={inputRef}
        className="kanban-new-card-input"
        placeholder="Describe the task..."
        value={text}
        rows={3}
        onChange={(e) => {
          setText(e.target.value);
          // Auto-resize between 3 and 10 rows
          const el = e.target;
          el.style.height = "auto";
          const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 18;
          const minH = lineHeight * 3;
          const maxH = lineHeight * 10;
          el.style.height = `${Math.min(Math.max(el.scrollHeight, minH), maxH)}px`;
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (!text.trim()) onCancel(); }}
      />
    </div>
  );
}

// ── Column definitions ──

type KanbanColumnId = "backlog" | "in_progress" | "in_review" | "recurring" | "completed";

interface ColumnDef {
  id: KanbanColumnId;
  label: string;
  emptyLabel: string;
}

const COLUMNS: ColumnDef[] = [
  { id: "backlog", label: "Backlog", emptyLabel: "No backlog tasks" },
  { id: "in_progress", label: "In Progress", emptyLabel: "No active tasks" },
  { id: "in_review", label: "In Review", emptyLabel: "No tasks to review" },
  { id: "completed", label: "Completed", emptyLabel: "No completed tasks" },
  { id: "recurring", label: "Recurring", emptyLabel: "No recurring tasks" },
];

// ── Drag-and-drop constants ──

const DRAG_TYPE = "KANBAN_SESSION";

interface KanbanDragItem {
  sessionId: string;
  sourceColumn: KanbanColumnId;
  index: number;
  selectedIds?: string[];
}

function categorizeSession(
  session: DiskSession,
  liveTurnStatus: Record<string, TurnStatus>,
): KanbanColumnId {
  const live = liveTurnStatus[session.sessionId];
  // Currently running
  if (live?.status === "in_progress" || session.turnStatus === "in_progress") return "in_progress";
  // Completed — always goes to "In Review"; only the user can move it to "Completed" manually
  if (live?.status === "completed" || session.turnStatus === "completed") return "in_review";
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
  isSelected,
  selectedCards,
  stackPosition,
  stackCount,
  onSelect,
  onCardClick,
  onMore,
  onMoveCard,
  onStackToggle,
  hideStackBadge,
  isEditing,
  onStartEditing,
  onSaveTitle,
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
  isSelected: boolean;
  selectedCards: Set<string>;
  stackPosition: "none" | "top" | "rest";
  stackCount: number;
  onSelect: () => void;
  onCardClick: (sessionId: string, columnId: KanbanColumnId, e: React.MouseEvent) => void;
  onMore: (e: React.MouseEvent) => void;
  onMoveCard: (dragSessionId: string, sourceCol: KanbanColumnId, targetIndex: number, targetCol: KanbanColumnId) => void;
  onStackToggle?: () => void;
  hideStackBadge?: boolean;
  isEditing?: boolean;
  onStartEditing?: () => void;
  onSaveTitle?: (title: string) => void;
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
    item: (): KanbanDragItem => ({
      sessionId: session.sessionId,
      sourceColumn: columnId,
      index,
      selectedIds: selectedCards.has(session.sessionId) && selectedCards.size > 1
        ? Array.from(selectedCards)
        : undefined,
    }),
    collect: (monitor) => ({ isDragging: monitor.isDragging() }),
  });

  const [, dropRef] = useDrop({
    accept: DRAG_TYPE,
    canDrop: (item: KanbanDragItem) => {
      // Disable card-level drop for multi-card drags — let column handle it
      if (item.selectedIds && item.selectedIds.length > 1) return false;
      return true;
    },
    hover: (item: KanbanDragItem, monitor) => {
      if (!cardRef.current) return;
      if (item.sessionId === session.sessionId) return;
      // Skip card-level reordering for multi-card drag (handled at column level)
      if (item.selectedIds && item.selectedIds.length > 1) return;

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

  // Inline title editing
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing) {
      setEditValue(cleanTitle(session.title));
      setTimeout(() => {
        const el = editInputRef.current;
        if (!el) return;
        el.focus();
        // Place cursor at end instead of selecting all
        el.setSelectionRange(el.value.length, el.value.length);
        // Auto-resize to fit content
        el.style.height = "auto";
        const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 18;
        const minH = lineHeight * 3;
        const maxH = lineHeight * 10;
        el.style.height = `${Math.min(Math.max(el.scrollHeight, minH), maxH)}px`;
      }, 0);
    }
  }, [isEditing, session.title]);

  const commitEdit = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== cleanTitle(session.title) && onSaveTitle) {
      onSaveTitle(trimmed);
    } else if (onSaveTitle) {
      onSaveTitle(""); // signal cancel (no change)
    }
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (onSaveTitle) onSaveTitle(""); // cancel
    }
  };

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

  const stackClass = stackPosition === "top" ? " kanban-stack-top"
    : stackPosition === "rest" ? " kanban-stack-rest" : "";

  return (
    <div
      ref={cardRef}
      className={`kanban-card-wrap${isDragging ? " kanban-card-dragging" : ""}${isSelected ? " kanban-card-selected" : ""}${stackClass}`}
      onClickCapture={(e) => {
        if (e.shiftKey) {
          e.stopPropagation();
          e.preventDefault();
          onCardClick(session.sessionId, columnId, e);
        }
      }}
    >
      {stackPosition === "top" && stackCount > 1 && (
        <>
          {!hideStackBadge && (
            <div
              className={`kanban-stack-badge${onStackToggle ? " kanban-stack-badge-clickable" : ""}`}
              onClick={onStackToggle ? (e) => { e.stopPropagation(); onStackToggle(); } : undefined}
            >
              {stackCount}
            </div>
          )}
          {/* Peek tabs behind the top card */}
          {Array.from({ length: Math.min(stackCount - 1, 3) }, (_, i) => (
            <div
              key={i}
              className={`kanban-stack-peek kanban-stack-peek-${i + 1}${onStackToggle ? " kanban-stack-peek-clickable" : ""}`}
              onClick={onStackToggle ? (e) => { e.stopPropagation(); onStackToggle(); } : undefined}
            />
          ))}
        </>
      )}
      {isEditing ? (
        <div className="kanban-card-editing">
          <textarea
            ref={editInputRef}
            className="kanban-card-edit-input"
            value={editValue}
            rows={3}
            onChange={(e) => {
              setEditValue(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 18;
              const minH = lineHeight * 3;
              const maxH = lineHeight * 10;
              el.style.height = `${Math.min(Math.max(el.scrollHeight, minH), maxH)}px`;
            }}
            onKeyDown={handleEditKeyDown}
            onBlur={commitEdit}
          />
        </div>
      ) : (
        <div className={`session-row${isActive ? " session-row-active" : ""}${isSelected ? " session-row-selected" : ""}`}>
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
      )}
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
  selectedCards,
  onCardClick,
  onSelectSession,
  onMore,
  onMoveCard,
  onBulkMove,
  editingCardId,
  onStartEditing,
  onSaveTitle,
  expandedSessions,
  toggleExpand,
  expandedAgents,
  toggleAgentExpand,
  subagentsLoading,
  resumeSession,
  resumeSubagent,
  liveSessionIds,
  editingNewCard,
  onAddCard,
  onSaveNewCard,
  onCancelNewCard,
}: {
  column: ColumnDef;
  sessions: DiskSession[];
  activeSessionId: string | null;
  liveTurnStatus: Record<string, TurnStatus>;
  currentSessionId: string | null;
  turnStatus: TurnStatus | null;
  unreadCompletedSessions: Record<string, true>;
  selectedCards: Set<string>;
  onCardClick: (sessionId: string, columnId: KanbanColumnId, e: React.MouseEvent) => void;
  onSelectSession: (sessionId: string, columnId: KanbanColumnId) => void;
  onMore: (sessionId: string, title: string | null, e: React.MouseEvent) => void;
  onMoveCard: (dragSessionId: string, sourceCol: KanbanColumnId, targetIndex: number, targetCol: KanbanColumnId) => void;
  onBulkMove?: (sessionIds: string[], targetCol: KanbanColumnId) => void;
  editingCardId?: string | null;
  onStartEditing?: (sessionId: string) => void;
  onSaveTitle?: (sessionId: string, title: string) => void;
  expandedSessions: Set<string>;
  toggleExpand: (sessionId: string) => void;
  expandedAgents: Set<string>;
  toggleAgentExpand: (agentId: string) => void;
  subagentsLoading: Set<string>;
  resumeSession: (sessionId: string) => void;
  resumeSubagent: (parentSessionId: string, agentId: string) => void;
  liveSessionIds: Set<string>;
  editingNewCard?: boolean;
  onAddCard?: () => void;
  onSaveNewCard?: (text: string) => void;
  onCancelNewCard?: () => void;
}) {
  const AUTO_STACK_THRESHOLD = 5;
  const [autoStackExpanded, setAutoStackExpanded] = useState(false);
  const shouldAutoStack = column.id === "completed" && sessions.length > AUTO_STACK_THRESHOLD && !autoStackExpanded;
  const autoStackCount = sessions.length - AUTO_STACK_THRESHOLD;

  const [{ isOver, canDrop }, dropRef] = useDrop({
    accept: DRAG_TYPE,
    drop: (item: KanbanDragItem, monitor) => {
      // If a card-level drop target already handled this, skip
      if (monitor.didDrop()) return;
      // Multi-card drag: move all selected cards to this column
      if (item.selectedIds && item.selectedIds.length > 1 && onBulkMove) {
        onBulkMove(item.selectedIds, column.id);
        return;
      }
      // Drop on empty column space — for completed column, drop at top by default
      // (card-level hover reordering already handles intentional positioning)
      const dropIndex = column.id === "completed" && item.sourceColumn !== "completed"
        ? 0
        : sessions.length;
      onMoveCard(item.sessionId, item.sourceColumn, dropIndex, column.id);
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
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
        {onAddCard && !editingNewCard && (
          <button className="kanban-add-btn" onClick={onAddCard} title="Add a card">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      <div className="kanban-column-body">
        {editingNewCard && onSaveNewCard && onCancelNewCard && (
          <BacklogNewCard onSave={onSaveNewCard} onCancel={onCancelNewCard} />
        )}
        {sessions.length === 0 && !editingNewCard ? (
          <div className="kanban-column-empty">{column.emptyLabel}</div>
        ) : (
          sessions.map((session, idx) => {
            // Compute stack position: first selected card in column is "top",
            // all other selected cards are "rest" (collapsed behind top card)
            const isSel = selectedCards.has(session.sessionId);
            const selCount = selectedCards.size;
            let stackPos: "none" | "top" | "rest" = "none";
            let stackCnt = selCount;
            let stackToggle: (() => void) | undefined;
            let hideBadge = false;
            if (isSel && selCount > 1) {
              // Selection-based stacking takes priority
              const firstSelectedIdx = sessions.findIndex((s) => selectedCards.has(s.sessionId));
              stackPos = idx === firstSelectedIdx ? "top" : "rest";
            } else if (shouldAutoStack && idx >= AUTO_STACK_THRESHOLD) {
              // Auto-stack older cards in completed column
              stackPos = idx === AUTO_STACK_THRESHOLD ? "top" : "rest";
              stackCnt = autoStackCount;
              hideBadge = true;
              if (idx === AUTO_STACK_THRESHOLD) {
                stackToggle = () => setAutoStackExpanded(true);
              }
            }
            return (
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
                isSelected={isSel}
                selectedCards={selectedCards}
                stackPosition={stackPos}
                stackCount={stackCnt}
                onSelect={() => onSelectSession(session.sessionId, column.id)}
                onCardClick={onCardClick}
                onMore={(e) => onMore(session.sessionId, session.title, e)}
                onMoveCard={onMoveCard}
                onStackToggle={stackToggle}
                hideStackBadge={hideBadge}
                isEditing={editingCardId === session.sessionId}
                onStartEditing={onStartEditing ? () => onStartEditing(session.sessionId) : undefined}
                onSaveTitle={onSaveTitle ? (title) => onSaveTitle(session.sessionId, title) : undefined}
                expandedSessions={expandedSessions}
                toggleExpand={toggleExpand}
                expandedAgents={expandedAgents}
                toggleAgentExpand={toggleAgentExpand}
                subagentsLoading={subagentsLoading}
                resumeSession={resumeSession}
                resumeSubagent={resumeSubagent}
              />
            );
          })
        )}
      </div>
      {column.id === "completed" && autoStackExpanded && sessions.length > AUTO_STACK_THRESHOLD && (
        <div className="kanban-column-footer">
          <button className="kanban-add-card-link" onClick={() => setAutoStackExpanded(false)}>
            Show less
          </button>
        </div>
      )}

    </div>
  );
}

// ── Main panel ──

export function KanbanPanel() {
  const state = useWsState();
  const { resumeSession, resumeSubagent, requestSubagents, deleteSession, renameSession, createBacklogSession, send, saveKanbanState } = useWsActions();

  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [subagentsLoaded, setSubagentsLoaded] = useState<Set<string>>(new Set());
  const [subagentsLoading, setSubagentsLoading] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; title: string | null; x: number; y: number } | null>(null);
  const [columnOverrides, setColumnOverrides] = useState<Record<string, KanbanColumnId>>(
    () => (state.kanbanColumnOverrides as Record<string, KanbanColumnId>) ?? {},
  );
  const [sortOrders, setSortOrders] = useState<Partial<Record<KanbanColumnId, string[]>>>(
    () => (state.kanbanSortOrders as Partial<Record<KanbanColumnId, string[]>>) ?? {},
  );
  const [editingNewCard, setEditingNewCard] = useState<KanbanColumnId | null>(null);
  const [pendingPrompts, setPendingPrompts] = useState<Record<string, string>>(
    () => state.kanbanPendingPrompts ?? {},
  );
  const [optimisticBacklog, setOptimisticBacklog] = useState<DiskSession[]>([]);
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());
  const lastClickedCardRef = useRef<{ sessionId: string; columnId: KanbanColumnId } | null>(null);

  const activeSessionId = state.switchingToSessionId ?? state.currentSessionId;

  const clearSelection = useCallback(() => {
    setSelectedCards(new Set());
    lastClickedCardRef.current = null;
  }, []);

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

  // Sync persisted kanban state from server (runs once when loaded)
  const kanbanInitialized = useRef(false);
  useEffect(() => {
    if (!state.kanbanStateLoaded || kanbanInitialized.current) return;
    kanbanInitialized.current = true;
    setColumnOverrides(state.kanbanColumnOverrides as Record<string, KanbanColumnId>);
    setSortOrders(state.kanbanSortOrders as Partial<Record<KanbanColumnId, string[]>>);
    setPendingPrompts(state.kanbanPendingPrompts);
  }, [state.kanbanStateLoaded, state.kanbanColumnOverrides, state.kanbanSortOrders, state.kanbanPendingPrompts]);

  // Debounced save to server when kanban state changes
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!kanbanInitialized.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveKanbanState(columnOverrides, sortOrders as Partial<Record<string, string[]>>, pendingPrompts);
    }, 300);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [columnOverrides, sortOrders, pendingPrompts, saveKanbanState]);

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
    // Merge real sessions with optimistic backlog entries
    const optimisticIds = new Set(optimisticBacklog.map((s) => s.sessionId));
    for (const session of state.diskSessions) {
      // Skip real sessions that duplicate an optimistic entry (shouldn't happen, but guard)
      if (optimisticIds.has(session.sessionId)) continue;
      const overrideCol = columnOverrides[session.sessionId];
      const col = overrideCol ?? categorizeSession(session, state.liveTurnStatus);
      buckets[col].push(session);
    }
    for (const session of optimisticBacklog) {
      const overrideCol = columnOverrides[session.sessionId];
      buckets[overrideCol ?? "backlog"].push(session);
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
  }, [state.diskSessions, state.liveTurnStatus, columnOverrides, sortOrders, optimisticBacklog]);

  // Keep a ref to the latest columnData for use in handleMoveCard
  const columnDataRef = useRef(columnData);
  columnDataRef.current = columnData;

  // Retire optimistic entries once the real session appears in diskSessions.
  // This prevents flicker: the optimistic card stays visible until the server-
  // broadcast session is ready to take over, so there's never a gap frame.
  useEffect(() => {
    if (optimisticBacklog.length === 0) return;
    const realIds = new Set(state.diskSessions.map((s) => s.sessionId));
    const stillPending = optimisticBacklog.filter((s) => !realIds.has(s.sessionId));
    if (stillPending.length !== optimisticBacklog.length) {
      setOptimisticBacklog(stillPending);
    }
  }, [state.diskSessions, optimisticBacklog]);

  const handleSaveNewCard = useCallback(async (text: string, targetCol: KanbanColumnId = "backlog") => {
    setEditingNewCard(null);

    // Optimistic: show the card immediately in the target column
    const tempId = `${targetCol}:${Date.now()}`;
    const now = new Date().toISOString();
    const optimistic: DiskSession = {
      sessionId: tempId,
      title: text,
      updatedAt: now,
      created: now,
      messageCount: 0,
      gitBranch: null,
      projectPath: null,
    };
    setOptimisticBacklog((prev) => [optimistic, ...prev]);
    if (targetCol === "backlog") {
      setPendingPrompts((prev) => ({ ...prev, [tempId]: text }));
    }
    setColumnOverrides((prev) => ({ ...prev, [tempId]: targetCol }));
    // Prepend to target column sort order so the new card appears at the top
    setSortOrders((prev) => {
      const order = prev[targetCol] ?? [];
      return { ...prev, [targetCol]: [tempId, ...order] };
    });

    try {
      const sessionId = await createBacklogSession(text);
      // Swap temp ID → real ID on the optimistic entry (keep it visible until
      // the SESSIONS broadcast arrives with the real session — the cleanup
      // useEffect above will retire it at that point, preventing flicker).
      setOptimisticBacklog((prev) =>
        prev.map((s) => (s.sessionId === tempId ? { ...s, sessionId: sessionId } : s)),
      );
      if (targetCol === "backlog") {
        setPendingPrompts((prev) => {
          const next = { ...prev, [sessionId]: prev[tempId] || text };
          delete next[tempId];
          return next;
        });
      }
      setColumnOverrides((prev) => {
        const next = { ...prev, [sessionId]: targetCol };
        delete next[tempId];
        return next;
      });
      setSortOrders((prev) => {
        const order = prev[targetCol];
        if (!order) return prev;
        return { ...prev, [targetCol]: order.map((id) => (id === tempId ? sessionId : id)) };
      });

      // If creating directly in in_progress, resume and send the prompt immediately
      if (targetCol === "in_progress") {
        resumeSession(sessionId);
        setTimeout(() => send(text), 300);
      }
    } catch (err) {
      console.error("Failed to create session:", err);
      // Roll back the optimistic entry
      setOptimisticBacklog((prev) => prev.filter((s) => s.sessionId !== tempId));
      if (targetCol === "backlog") {
        setPendingPrompts((prev) => { const next = { ...prev }; delete next[tempId]; return next; });
      }
      setColumnOverrides((prev) => { const next = { ...prev }; delete next[tempId]; return next; });
    }
  }, [createBacklogSession, resumeSession, send]);

  // Ref to track pendingPrompts in the move callback without stale closure
  const pendingPromptsRef = useRef(pendingPrompts);
  pendingPromptsRef.current = pendingPrompts;

  const handleMoveCard = useCallback(
    (dragSessionId: string, sourceCol: KanbanColumnId, targetIndex: number, targetCol: KanbanColumnId) => {
      // When dragging from backlog to in_progress, send the pending prompt
      if (sourceCol === "backlog" && targetCol === "in_progress" && pendingPromptsRef.current[dragSessionId]) {
        const prompt = pendingPromptsRef.current[dragSessionId];
        setPendingPrompts((prev) => {
          const next = { ...prev };
          delete next[dragSessionId];
          return next;
        });
        // Switch to the session and send the prompt
        resumeSession(dragSessionId);
        // Small delay to let the session switch complete before sending
        setTimeout(() => {
          send(prompt);
        }, 300);
      }

      // When dragging from in_review back to in_progress, retry with a refined prompt
      if (sourceCol === "in_review" && targetCol === "in_progress") {
        resumeSession(dragSessionId);
        setTimeout(() => {
          send(
            "Your previous attempt didn't fully meet expectations. Please re-examine the task with fresh eyes:\n\n" +
            "- Ultrathink about the problem — consider edge cases and alternative approaches you may have missed\n" +
            "- Try a fundamentally different strategy than what you used before\n" +
            "- Be more thorough and creative in your solution\n" +
            "- If you got stuck on something, take a step back and try a completely different angle\n\n" +
            "Please retry the task now.",
          );
        }, 300);
      }

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
    [resumeSession, send],
  );

  const handleCardClick = useCallback(
    (sessionId: string, columnId: KanbanColumnId, _e: React.MouseEvent) => {
      const anchor = lastClickedCardRef.current;
      if (anchor && anchor.columnId === columnId) {
        // Shift+click: range-select from anchor to this card
        const sessions = columnDataRef.current[columnId];
        const anchorIdx = sessions.findIndex((s) => s.sessionId === anchor.sessionId);
        const curIdx = sessions.findIndex((s) => s.sessionId === sessionId);
        if (anchorIdx !== -1 && curIdx !== -1) {
          const start = Math.min(anchorIdx, curIdx);
          const end = Math.max(anchorIdx, curIdx);
          const rangeIds = sessions.slice(start, end + 1).map((s) => s.sessionId);
          setSelectedCards(new Set(rangeIds));
          return;
        }
      }
      // No anchor or different column — just select this single card and set as anchor
      lastClickedCardRef.current = { sessionId, columnId };
      setSelectedCards(new Set([sessionId]));
    },
    [],
  );

  const handleBulkMove = useCallback(
    (sessionIds: string[], targetCol: KanbanColumnId) => {
      // Update column overrides for all cards
      setColumnOverrides((prev) => {
        const next = { ...prev };
        for (const id of sessionIds) {
          next[id] = targetCol;
        }
        return next;
      });
      // Update sort orders: remove from all source columns, append to target
      setSortOrders((prev) => {
        const next = { ...prev };
        const idSet = new Set(sessionIds);
        // Remove from all columns
        for (const colId of Object.keys(next) as KanbanColumnId[]) {
          if (next[colId]) {
            next[colId] = next[colId]!.filter((id) => !idSet.has(id));
          }
        }
        // Append to target
        if (!next[targetCol]) {
          next[targetCol] = columnDataRef.current[targetCol].map((s) => s.sessionId);
        }
        const targetArr = next[targetCol]!.filter((id) => !idSet.has(id));
        // For completed column, prepend so new cards appear at top
        if (targetCol === "completed") {
          targetArr.unshift(...sessionIds);
        } else {
          targetArr.push(...sessionIds);
        }
        next[targetCol] = targetArr;
        return next;
      });
      // Handle pending prompts for backlog → in_progress
      if (targetCol === "in_progress") {
        let sentFirst = false;
        for (const id of sessionIds) {
          if (!sentFirst && pendingPromptsRef.current[id]) {
            const prompt = pendingPromptsRef.current[id];
            setPendingPrompts((prev) => {
              const next = { ...prev };
              delete next[id];
              return next;
            });
            resumeSession(id);
            setTimeout(() => send(prompt), 300);
            sentFirst = true;
          } else if (!sentFirst) {
            // Check if this session was in the in_review column (retry flow)
            const col = columnOverrides[id] ?? categorizeSession(
              state.diskSessions.find((s) => s.sessionId === id)!,
              state.liveTurnStatus,
            );
            if (col === "in_review") {
              resumeSession(id);
              setTimeout(() => send(
                "Your previous attempt didn't fully meet expectations. Please re-examine the task with fresh eyes:\n\n" +
                "- Ultrathink about the problem — consider edge cases and alternative approaches you may have missed\n" +
                "- Try a fundamentally different strategy than what you used before\n" +
                "- Be more thorough and creative in your solution\n" +
                "- If you got stuck on something, take a step back and try a completely different angle\n\n" +
                "Please retry the task now.",
              ), 300);
              sentFirst = true;
            }
          }
        }
      }
      clearSelection();
    },
    [resumeSession, send, clearSelection, columnOverrides, state.diskSessions, state.liveTurnStatus],
  );

  const handleStartEditing = useCallback((sessionId: string) => {
    setEditingCardId(sessionId);
  }, []);

  const handleSaveTitle = useCallback((sessionId: string, title: string) => {
    setEditingCardId(null);
    if (title) {
      renameSession(sessionId, title);
    }
  }, [renameSession]);

  const handleSelectSession = (sessionId: string, columnId: KanbanColumnId) => {
    clearSelection();
    // Normal click sets the anchor for future shift+click range selection
    lastClickedCardRef.current = { sessionId, columnId };
    if (sessionId === activeSessionId) {
      // Already active — enter inline edit mode
      setEditingCardId(sessionId);
      return;
    }
    setEditingCardId(null);
    resumeSession(sessionId);
  };

  // Clear selection and editing on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editingCardId) setEditingCardId(null);
        if (selectedCards.size > 0) clearSelection();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedCards.size, clearSelection, editingCardId]);

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
            selectedCards={selectedCards}
            onCardClick={handleCardClick}
            onSelectSession={handleSelectSession}
            onMore={handleMore}
            onMoveCard={handleMoveCard}
            onBulkMove={handleBulkMove}
            editingCardId={editingCardId}
            onStartEditing={handleStartEditing}
            onSaveTitle={handleSaveTitle}
            expandedSessions={expandedSessions}
            toggleExpand={toggleExpand}
            expandedAgents={expandedAgents}
            toggleAgentExpand={toggleAgentExpand}
            subagentsLoading={subagentsLoading}
            resumeSession={resumeSession}
            resumeSubagent={resumeSubagent}
            liveSessionIds={liveSessionIds}
            {...((col.id === "backlog" || col.id === "in_progress") ? {
              editingNewCard: editingNewCard === col.id,
              onAddCard: () => setEditingNewCard(col.id),
              onSaveNewCard: (text: string) => handleSaveNewCard(text, col.id),
              onCancelNewCard: () => setEditingNewCard(null),
            } : {})}
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

import { useMemo, useState, useEffect, useLayoutEffect, useRef, useCallback, Fragment } from "react";
import { useDrag, useDrop } from "react-dnd";
import { useWsState, useWsActions, titleLockedSessions } from "../context/WebSocketContext";
import { RETRY_PROMPT } from "../kanban-prompts";
import { ChatInput } from "./ChatInput";
import { cleanTitle, toSupportedImage } from "../utils";
import {
  SessionItem,
  SubagentItem,
  SessionContextMenu,
  findAncestorPath,
  findTeammateParent,
} from "./SessionSidebar";
import { KanbanSearchModal } from "./KanbanSearchModal";
import type { DiskSession, TurnStatus, SubagentChild, ImageAttachment, KanbanOp } from "../types";

/** Build a preliminary "brewing" TurnStatus for optimistic rendering. */
function makeOptimisticTurnStatus(): TurnStatus {
  return { status: "in_progress", startedAt: Date.now(), activity: "brewing", approxTokens: 0, thinkingDurationMs: 0 };
}

// ── Inline backlog card editor ──

function BacklogNewCard({ onSave, onCancel }: { onSave: (text: string, images?: ImageAttachment[]) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && (text.trim() || images.length > 0)) {
      e.preventDefault();
      onSave(text.trim(), images.length > 0 ? images : undefined);
    } else if (e.key === "Escape") {
      onCancel();
    }
  };

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith("image/")) continue;
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      toSupportedImage(file).then((attachment) => {
        setImages((prev) => [...prev, attachment]);
      });
    }
  }, []);

  return (
    <div className="kanban-new-card">
      {images.length > 0 && (
        <div className="kanban-new-card-images">
          {images.map((img, i) => (
            <div key={`img-${i}`} className="kanban-new-card-image-chip">
              <img
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={`Pasted image ${i + 1}`}
              />
              <button
                type="button"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                className="kanban-new-card-image-remove"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={inputRef}
        className="kanban-new-card-input"
        placeholder={images.length > 0 ? "Add a description or send image..." : "Describe the task..."}
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
        onPaste={onPaste}
        onBlur={() => { if (!text.trim() && images.length === 0) onCancel(); }}
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
  // Completed or errored — goes to "In Review" for user to inspect
  if (live?.status === "completed" || live?.status === "error" || session.turnStatus === "completed" || session.turnStatus === "error") return "in_review";
  // Everything else
  return "backlog";
}

/** Human-readable label for a stopReason. */
function stopReasonLabel(reason: string | undefined): string | null {
  switch (reason) {
    case "error": return "Error";
    case "max_tokens": return "Max tokens";
    case "stop_sequence": return "Stop sequence";
    case "server_restart": return "Server restarted";
    case "disconnected": return "Disconnected";
    case undefined:
    case "end_turn":
    case "cancelled": return null; // normal completion — no badge needed
    default: return reason;
  }
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
  onDragHover,
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
  onDragHover?: (insertIndex: number | null) => void;
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
    hover: (item: KanbanDragItem, monitor) => {
      if (!cardRef.current || !onDragHover) return;
      if (item.selectedIds && item.selectedIds.length > 1) return;

      // Cross-column drop into completed: always indicate top position
      if (columnId === "completed" && item.sourceColumn !== "completed") {
        onDragHover(0);
        return;
      }

      const rect = cardRef.current.getBoundingClientRect();
      const clientOffset = monitor.getClientOffset();
      if (!clientOffset) return;
      const hoverClientY = clientOffset.y - rect.top;
      const midY = (rect.bottom - rect.top) / 2;
      const insertIdx = hoverClientY < midY ? index : index + 1;

      onDragHover(insertIdx);
    },
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

  // Derive stop reason badge
  const turnLive = turnInfo ?? undefined;
  const cardStopReason = turnLive?.stopReason;
  const badgeLabel = stopReasonLabel(cardStopReason);
  const isErrorCard = turnLive?.status === "error" || cardStopReason === "error";

  const stackClass = stackPosition === "top" ? " kanban-stack-top"
    : stackPosition === "rest" ? " kanban-stack-rest" : "";

  return (
    <div
      ref={cardRef}
      data-session-id={session.sessionId}
      className={`kanban-card-wrap${isDragging ? " kanban-card-dragging" : ""}${isSelected ? " kanban-card-selected" : ""}${isErrorCard ? " kanban-card-error" : ""}${stackClass}`}
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
              turnStatus={session.turnStatus ?? (columnId === "completed" ? "completed" : undefined)}
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
      {badgeLabel && (
        <div className={`kanban-stop-reason-badge${isErrorCard ? " kanban-stop-reason-error" : ""}`} title={`Turn ended: ${cardStopReason}`}>
          {isErrorCard && (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="5.5" stroke="currentColor" strokeWidth="1" />
              <path d="M6 3.5V6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <circle cx="6" cy="8.5" r="0.6" fill="currentColor" />
            </svg>
          )}
          {badgeLabel}
        </div>
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
  onSaveNewCard?: (text: string, images?: ImageAttachment[]) => void;
  onCancelNewCard?: () => void;
}) {
  const AUTO_STACK_THRESHOLD = 5;
  const [autoStackExpanded, setAutoStackExpanded] = useState(false);
  const shouldAutoStack = column.id === "completed" && sessions.length > AUTO_STACK_THRESHOLD && !autoStackExpanded;
  const autoStackCount = sessions.length - AUTO_STACK_THRESHOLD;

  // Drop indicator state — tracks where the insertion line should appear
  const [dropIndicatorIdx, setDropIndicatorIdx] = useState<number | null>(null);
  const dropIndicatorRef = useRef<number | null>(null);

  const handleDragHover = useCallback((idx: number | null) => {
    setDropIndicatorIdx(idx);
    dropIndicatorRef.current = idx;
  }, []);

  const [{ isOver, canDrop }, dropRef] = useDrop({
    accept: DRAG_TYPE,
    hover: (item: KanbanDragItem, monitor) => {
      // Only handle hovering over empty column space (not over cards)
      if (!monitor.isOver({ shallow: true })) return;
      if (item.selectedIds && item.selectedIds.length > 1) return;
      // Cross-column into completed: show indicator at top
      if (column.id === "completed" && item.sourceColumn !== "completed") {
        handleDragHover(0);
        return;
      }
      // Empty column or hovering above/below all cards — show indicator at
      // top (0) or bottom (sessions.length) based on existing indicator position.
      // If no indicator is set yet, default to appending at the end.
      if (sessions.length === 0) {
        handleDragHover(0);
      } else if (dropIndicatorRef.current === null) {
        handleDragHover(sessions.length);
      }
    },
    drop: (item: KanbanDragItem) => {
      const indicatorIdx = dropIndicatorRef.current;
      setDropIndicatorIdx(null);
      dropIndicatorRef.current = null;

      // Multi-card drag: move all selected cards to this column
      if (item.selectedIds && item.selectedIds.length > 1 && onBulkMove) {
        onBulkMove(item.selectedIds, column.id);
        return;
      }

      // Pass raw indicator position — handleMoveCard adjusts using actual visual positions
      const targetIdx = indicatorIdx ?? (column.id === "completed" && item.sourceColumn !== "completed" ? 0 : sessions.length);
      onMoveCard(item.sessionId, item.sourceColumn, targetIdx, column.id);
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
      canDrop: monitor.canDrop(),
    }),
  });

  // Clear drop indicator when drag leaves column
  useEffect(() => {
    if (!isOver) {
      setDropIndicatorIdx(null);
      dropIndicatorRef.current = null;
    }
  }, [isOver]);

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
        ) : (<>
          {sessions.map((session, idx) => {
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
              <Fragment key={session.sessionId}>
                {dropIndicatorIdx === idx && <div className="kanban-drop-indicator" />}
              <KanbanSessionRow
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
                onDragHover={handleDragHover}
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
              </Fragment>
            );
          })}
          {dropIndicatorIdx === sessions.length && <div className="kanban-drop-indicator" />}
        </>)}
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

// ── Optimistic overlay helper ──
// Replays pending ops on top of server-authoritative state to derive the
// optimistic view the UI should render. Pure function — no side effects.
function applyOpsToSnapshot(
  co: Record<string, string>,
  so: Partial<Record<string, string[]>>,
  ops: KanbanOp[],
): { columnOverrides: Record<string, string>; sortOrders: Partial<Record<string, string[]>> } {
  if (ops.length === 0) return { columnOverrides: co, sortOrders: so };
  const rco = { ...co };
  const rso: Record<string, string[] | undefined> = { ...so };
  for (const op of ops) {
    switch (op.op) {
      case "set_column": rco[op.sessionId] = op.column; break;
      case "remove_column": delete rco[op.sessionId]; break;
      case "set_sort_order": rso[op.column] = op.order; break;
      case "set_pending_prompt": break; // handled by pendingPrompts state
      case "remove_pending_prompt": break;
      case "bulk_set_columns":
        for (const e of op.entries) rco[e.sessionId] = e.column;
        break;
      case "bulk_remove_sort_entries":
        for (const id of op.sessionIds) {
          for (const col of Object.keys(rso)) {
            if (rso[col]) rso[col] = rso[col]!.filter((x) => x !== id);
          }
        }
        break;
    }
  }
  return { columnOverrides: rco, sortOrders: rso };
}

// ── Main panel ──

export function KanbanPanel() {
  const state = useWsState();
  const { dispatch, resumeSession, resumeSubagent, requestSubagents, deleteSession, renameSession, createBacklogSession, send, sendKanbanOp, updatePendingPrompt } = useWsActions();

  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [subagentsLoaded, setSubagentsLoaded] = useState<Set<string>>(new Set());
  const [subagentsLoading, setSubagentsLoading] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; title: string | null; x: number; y: number } | null>(null);
  const [editingNewCard, setEditingNewCard] = useState<KanbanColumnId | null>(null);

  // Derive columnOverrides and sortOrders from server state + pending ops overlay.
  // No local useState copies — the server is the single source of truth,
  // and pending ops provide instant optimistic feedback until acked.
  const { columnOverrides, sortOrders } = useMemo(() => {
    const allOps = state.kanbanPendingOps.flatMap((batch) => batch.ops);
    return applyOpsToSnapshot(
      state.kanbanColumnOverrides,
      state.kanbanSortOrders,
      allOps,
    );
  }, [state.kanbanColumnOverrides, state.kanbanSortOrders, state.kanbanPendingOps]);
  const [pendingPrompts, setPendingPrompts] = useState<Record<string, string>>(
    () => state.kanbanPendingPrompts ?? {},
  );
  const [pendingImages, setPendingImages] = useState<Record<string, ImageAttachment[]>>({});
  const [optimisticBacklog, setOptimisticBacklog] = useState<DiskSession[]>([]);
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const lastClickedCardRef = useRef<{ sessionId: string; columnId: KanbanColumnId } | null>(null);

  const activeSessionId = state.switchingToSessionId ?? state.currentSessionId;

  const clearSelection = useCallback(() => {
    setSelectedCards(new Set());
    lastClickedCardRef.current = null;
  }, []);

  // Auto-clear overrides when a session's turn status makes them redundant.
  // Checks the server-side overrides (not the overlay) to avoid feedback loops.
  // - in_progress: categorizeSession() already returns "in_progress", override is redundant
  // - completed/error with "in_progress" override: should transition to "in_review"
  // Skip sessions still in the optimistic backlog — their overrides must persist until the real
  // turn starts, otherwise the SESSIONS reducer can misinterpret the optimistic turn status as a
  // completed transition and briefly send the card to "in review".
  useEffect(() => {
    const optimisticIds = new Set(optimisticBacklog.map((s) => s.sessionId));
    const ops: KanbanOp[] = [];
    for (const [sessionId, col] of Object.entries(state.kanbanColumnOverrides)) {
      if (optimisticIds.has(sessionId)) continue;
      const live = state.liveTurnStatus[sessionId];
      if (live?.status === "in_progress") {
        ops.push({ op: "remove_column", sessionId });
      } else if ((live?.status === "completed" || live?.status === "error") && col === "in_progress") {
        ops.push({ op: "set_column", sessionId, column: "in_review" });
      }
    }
    if (ops.length > 0) {
      sendKanbanOp(ops);
    }
  }, [state.liveTurnStatus, state.kanbanColumnOverrides, optimisticBacklog, sendKanbanOp]);

  // Sync pending prompts from server when all client ops have been ack'd.
  // While ops are in-flight we keep local state to avoid clobbering optimistic
  // edits. Once pendingOps drains to zero the server snapshot is authoritative.
  // On reconnect/HMR, KANBAN_STATE_LOADED clears pendingOps so this fires
  // immediately with fresh server state.
  useEffect(() => {
    if (!state.kanbanStateLoaded) return;
    if (state.kanbanPendingOps.length > 0) return;
    setPendingPrompts(state.kanbanPendingPrompts);
  }, [state.kanbanPendingPrompts, state.kanbanStateLoaded, state.kanbanPendingOps]);

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
      const col = overrideCol ?? categorizeSession(session, state.liveTurnStatus);
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

  const handleSaveNewCard = useCallback(async (text: string, images?: ImageAttachment[], targetCol: KanbanColumnId = "backlog") => {
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
      updatePendingPrompt(tempId, text);
      if (images?.length) {
        setPendingImages((prev) => ({ ...prev, [tempId]: images }));
      }
    }
    // Set optimistic turn status immediately for in_progress cards
    if (targetCol === "in_progress") {
      dispatch({ type: "SET_OPTIMISTIC_TURN_STATUS", sessionId: tempId, status: makeOptimisticTurnStatus() });
    }
    // Optimistic overlay: send ops for temp ID (server stores them; overlay renders them)
    const currentOrder = columnDataRef.current[targetCol]?.map((s) => s.sessionId) ?? [];
    const tempOrder = [tempId, ...currentOrder];
    sendKanbanOp([
      { op: "set_column", sessionId: tempId, column: targetCol },
      { op: "set_sort_order", column: targetCol, order: tempOrder },
    ]);

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
        updatePendingPrompt(tempId, "");
        updatePendingPrompt(sessionId, text);
        setPendingImages((prev) => {
          if (!prev[tempId]) return prev;
          const next = { ...prev, [sessionId]: prev[tempId] };
          delete next[tempId];
          return next;
        });
      }

      // Swap temp→real ID in sort order and send ops to server
      const realOrder = tempOrder.map((id) => (id === tempId ? sessionId : id));
      const ops: KanbanOp[] = [
        { op: "set_column", sessionId, column: targetCol },
        { op: "set_sort_order", column: targetCol, order: realOrder },
      ];
      if (targetCol === "backlog") {
        ops.push({ op: "set_pending_prompt", sessionId, text });
      }
      sendKanbanOp(ops);

      // If creating directly in in_progress or recurring, resume and send the prompt immediately
      if (targetCol === "in_progress" || targetCol === "recurring") {
        dispatch({ type: "SET_OPTIMISTIC_TURN_STATUS", sessionId, status: makeOptimisticTurnStatus() });
        resumeSession(sessionId);
        setTimeout(() => send(text, images, undefined, { skipRouting: true }), 300);
      }
    } catch (err) {
      console.error("Failed to create session:", err);
      // Roll back the optimistic entry (pending ops for tempId will be drained by ack
      // or become harmless stale entries that cleanStaleSessions cleans up)
      setOptimisticBacklog((prev) => prev.filter((s) => s.sessionId !== tempId));
      if (targetCol === "backlog") {
        setPendingPrompts((prev) => { const next = { ...prev }; delete next[tempId]; return next; });
        updatePendingPrompt(tempId, "");
        setPendingImages((prev) => { const next = { ...prev }; delete next[tempId]; return next; });
      }
    }
  }, [dispatch, createBacklogSession, resumeSession, send, updatePendingPrompt, sendKanbanOp]);

  // Ref to track pendingPrompts in the move callback without stale closure
  const pendingPromptsRef = useRef(pendingPrompts);
  pendingPromptsRef.current = pendingPrompts;
  const pendingImagesRef = useRef(pendingImages);
  pendingImagesRef.current = pendingImages;

  const handleMoveCard = useCallback(
    (dragSessionId: string, sourceCol: KanbanColumnId, targetIndex: number, targetCol: KanbanColumnId) => {
      // Mark as manual move so FLIP animation is skipped for this card
      manualMoveIdsRef.current.add(dragSessionId);

      // ── Start task when moving any card into in_progress ──
      if (targetCol === "in_progress" && sourceCol !== "in_progress") {
        const pendingPrompt = pendingPromptsRef.current[dragSessionId];
        const promptImages = pendingImagesRef.current[dragSessionId];
        const session = columnDataRef.current[sourceCol].find((s) => s.sessionId === dragSessionId);

        if (sourceCol === "backlog") {
          // Clean up pending prompt/images
          if (pendingPrompt) {
            setPendingPrompts((prev) => {
              const next = { ...prev };
              delete next[dragSessionId];
              return next;
            });
            updatePendingPrompt(dragSessionId, "");
            setPendingImages((prev) => {
              if (!prev[dragSessionId]) return prev;
              const next = { ...prev };
              delete next[dragSessionId];
              return next;
            });
          }
          // Use pending prompt, or fall back to session title
          const effectivePrompt = pendingPrompt || session?.title;
          if (effectivePrompt) {
            dispatch({ type: "SET_OPTIMISTIC_TURN_STATUS", sessionId: dragSessionId, status: makeOptimisticTurnStatus() });
            resumeSession(dragSessionId);
            setTimeout(() => {
              send(effectivePrompt, pendingPrompt ? promptImages : undefined, undefined, { skipRouting: true });
            }, 300);
          }
        } else {
          // From in_review, completed, or recurring → retry with a refined prompt
          titleLockedSessions.add(dragSessionId);
          const originalTitle = session?.title;
          dispatch({ type: "SET_OPTIMISTIC_TURN_STATUS", sessionId: dragSessionId, status: makeOptimisticTurnStatus() });
          resumeSession(dragSessionId);
          setTimeout(() => {
            send(RETRY_PROMPT, undefined, undefined, { skipRouting: true });
            if (originalTitle) {
              setTimeout(() => {
                renameSession(dragSessionId, originalTitle);
                titleLockedSessions.delete(dragSessionId);
              }, 5000);
            } else {
              setTimeout(() => titleLockedSessions.delete(dragSessionId), 5000);
            }
          }, 300);
        }
      }

      // Compute new sort orders before setting state (used for both local state + ops)
      const sourceVisual = columnDataRef.current[sourceCol].map((s) => s.sessionId);
      let newSourceOrder: string[];
      let newTargetOrder: string[] | undefined;

      if (sourceCol === targetCol) {
        const currentIdx = sourceVisual.indexOf(dragSessionId);
        const filtered = sourceVisual.filter((id) => id !== dragSessionId);
        let adjustedTarget = targetIndex;
        if (currentIdx !== -1 && currentIdx < targetIndex) adjustedTarget--;
        filtered.splice(Math.min(adjustedTarget, filtered.length), 0, dragSessionId);
        newSourceOrder = filtered;
      } else {
        newSourceOrder = sourceVisual.filter((id) => id !== dragSessionId);
        const targetVisual = columnDataRef.current[targetCol].map((s) => s.sessionId);
        newTargetOrder = [...targetVisual];
        newTargetOrder.splice(Math.min(targetIndex, newTargetOrder.length), 0, dragSessionId);
      }

      // Send ops to server (pending ops overlay provides optimistic display)
      const ops: KanbanOp[] = [];
      if (sourceCol !== targetCol) {
        ops.push({ op: "set_column", sessionId: dragSessionId, column: targetCol });
      }
      ops.push({ op: "set_sort_order", column: sourceCol, order: newSourceOrder });
      if (newTargetOrder) {
        ops.push({ op: "set_sort_order", column: targetCol, order: newTargetOrder });
      }
      if (sourceCol === "backlog" && targetCol !== "backlog" && pendingPromptsRef.current[dragSessionId]) {
        ops.push({ op: "remove_pending_prompt", sessionId: dragSessionId });
      }
      sendKanbanOp(ops);
    },
    [dispatch, resumeSession, send, renameSession, sendKanbanOp],
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
      // Mark as manual moves so FLIP animation is skipped for these cards
      for (const id of sessionIds) manualMoveIdsRef.current.add(id);

      // Compute new sort orders from current derived state
      const idSet = new Set(sessionIds);
      const nextSort: Record<string, string[]> = {};
      for (const colId of Object.keys(sortOrders) as KanbanColumnId[]) {
        if (sortOrders[colId]) {
          nextSort[colId] = sortOrders[colId]!.filter((id) => !idSet.has(id));
        }
      }
      // Append to target
      if (!nextSort[targetCol]) {
        nextSort[targetCol] = columnDataRef.current[targetCol].map((s) => s.sessionId).filter((id) => !idSet.has(id));
      }
      // For completed column, prepend so new cards appear at top
      if (targetCol === "completed") {
        nextSort[targetCol].unshift(...sessionIds);
      } else {
        nextSort[targetCol].push(...sessionIds);
      }

      // Build ops — the pending ops overlay will update the UI instantly
      const sortOps: KanbanOp[] = [];
      for (const colId of Object.keys(nextSort)) {
        sortOps.push({ op: "set_sort_order", column: colId, order: nextSort[colId] });
      }
      const ops: KanbanOp[] = [
        { op: "bulk_set_columns", entries: sessionIds.map((id) => ({ sessionId: id, column: targetCol })) },
        ...sortOps,
      ];
      // Clean up pending prompts for cards moving out of backlog
      const removedPromptIds = sessionIds.filter((id) => pendingPromptsRef.current[id]);
      if (removedPromptIds.length > 0) {
        for (const id of removedPromptIds) ops.push({ op: "remove_pending_prompt", sessionId: id });
      }
      sendKanbanOp(ops);
      // Start the first card when bulk-moving into in_progress
      if (targetCol === "in_progress") {
        let sentFirst = false;
        for (const id of sessionIds) {
          if (sentFirst) break;
          const col = columnOverrides[id] ?? categorizeSession(
            state.diskSessions.find((s) => s.sessionId === id)!,
            state.liveTurnStatus,
          );

          if (col === "backlog") {
            const prompt = pendingPromptsRef.current[id];
            const promptImages = pendingImagesRef.current[id];
            if (prompt) {
              setPendingPrompts((prev) => { const next = { ...prev }; delete next[id]; return next; });
              updatePendingPrompt(id, "");
              setPendingImages((prev) => { if (!prev[id]) return prev; const next = { ...prev }; delete next[id]; return next; });
            }
            // Use pending prompt, or fall back to session title
            const session = state.diskSessions.find((s) => s.sessionId === id);
            const effectivePrompt = prompt || session?.title;
            if (effectivePrompt) {
              dispatch({ type: "SET_OPTIMISTIC_TURN_STATUS", sessionId: id, status: makeOptimisticTurnStatus() });
              resumeSession(id);
              setTimeout(() => send(effectivePrompt, prompt ? promptImages : undefined, undefined, { skipRouting: true }), 300);
              sentFirst = true;
            }
          } else {
            // From in_review, completed, or recurring → retry
            titleLockedSessions.add(id);
            const session = state.diskSessions.find((s) => s.sessionId === id);
            const originalTitle = session?.title;
            dispatch({ type: "SET_OPTIMISTIC_TURN_STATUS", sessionId: id, status: makeOptimisticTurnStatus() });
            resumeSession(id);
            setTimeout(() => {
              send(RETRY_PROMPT, undefined, undefined, { skipRouting: true });
              if (originalTitle) {
                setTimeout(() => { renameSession(id, originalTitle); titleLockedSessions.delete(id); }, 5000);
              } else {
                setTimeout(() => titleLockedSessions.delete(id), 5000);
              }
            }, 300);
            sentFirst = true;
          }
        }
      }
      clearSelection();
    },
    [dispatch, resumeSession, send, clearSelection, columnOverrides, sortOrders, state.diskSessions, state.liveTurnStatus, renameSession, sendKanbanOp],
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

  // Cmd+P / Ctrl+P to open card search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "p" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleMore = (sessionId: string, title: string | null, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setContextMenu({ sessionId, title, x: rect.right, y: rect.bottom });
  };

  // ── FLIP animation for automatic column transitions ──
  // Only animates cards that change columns due to state changes (e.g. task
  // completes and moves from in_progress → in_review). Manual drag-and-drop
  // moves are excluded — they have their own visual feedback.
  const boardRef = useRef<HTMLDivElement>(null);
  const cardPositionsRef = useRef<Map<string, DOMRect>>(new Map());
  const prevColumnMapRef = useRef<Map<string, string>>(new Map());
  const manualMoveIdsRef = useRef<Set<string>>(new Set());

  useLayoutEffect(() => {
    if (!boardRef.current) return;

    const anyDragging = boardRef.current.querySelector(".kanban-card-dragging") !== null;

    // Build current column membership
    const currentColumnMap = new Map<string, string>();
    for (const [colId, sessions] of Object.entries(columnData) as [string, DiskSession[]][]) {
      for (const s of sessions) currentColumnMap.set(s.sessionId, colId);
    }

    // Detect cards that changed columns
    const movedIds = new Set<string>();
    const manuallyMovedIds = new Set<string>();
    const prevMap = prevColumnMapRef.current;
    if (prevMap.size > 0) {
      for (const [id, col] of currentColumnMap) {
        const prevCol = prevMap.get(id);
        if (prevCol && prevCol !== col) {
          if (manualMoveIdsRef.current.has(id)) {
            manuallyMovedIds.add(id);
          } else {
            movedIds.add(id);
          }
        }
      }
    }
    prevColumnMapRef.current = currentColumnMap;
    manualMoveIdsRef.current.clear();

    // Suppress fadeSlideIn on ANY card that changed columns — the CSS entrance
    // animation on .kanban-card-wrap fires on the fresh DOM element React creates
    // in the new column parent. Must run before the anyDragging guard because
    // react-dnd's isDragging may still be true in the same render as the drop.
    const allChangedIds = new Set([...movedIds, ...manuallyMovedIds]);
    if (allChangedIds.size > 0) {
      boardRef.current.querySelectorAll<HTMLElement>("[data-session-id]").forEach((card) => {
        if (allChangedIds.has(card.dataset.sessionId!)) {
          card.style.animation = "none";
        }
      });
    }

    if (anyDragging) return;

    // FLIP-animate only automatic transitions
    if (movedIds.size > 0) {
      const prevPositions = cardPositionsRef.current;
      const cards = boardRef.current.querySelectorAll<HTMLElement>("[data-session-id]");

      cards.forEach((card) => {
        const id = card.dataset.sessionId!;
        if (!movedIds.has(id)) return;

        const prev = prevPositions.get(id);
        if (!prev) return;

        const curr = card.getBoundingClientRect();
        const dx = prev.left - curr.left;
        const dy = prev.top - curr.top;
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;

        card.style.animation = "none";
        card.style.transform = `translate(${dx}px, ${dy}px)`;
        card.style.transition = "none";
        card.getBoundingClientRect();
        card.style.transition = "transform 0.3s cubic-bezier(0.25, 0.1, 0.25, 1)";
        card.style.transform = "";

        const cleanup = () => {
          card.style.transition = "";
          card.style.transform = "";
          // Keep animation: none — removing it would re-trigger the CSS
          // fadeSlideIn animation on .kanban-card-wrap, causing a flicker.
          card.removeEventListener("transitionend", cleanup);
        };
        card.addEventListener("transitionend", cleanup);
        setTimeout(cleanup, 400);
      });
    }

    // Snapshot positions (skip during drag — layout is distorted)
    const nextPositions = new Map<string, DOMRect>();
    boardRef.current.querySelectorAll<HTMLElement>("[data-session-id]").forEach((card) => {
      if (!card.classList.contains("kanban-card-dragging")) {
        nextPositions.set(card.dataset.sessionId!, card.getBoundingClientRect());
      }
    });
    cardPositionsRef.current = nextPositions;
  });

  const liveSessionIds = useMemo(
    () => new Set(state.diskSessions.filter((s) => s.isLive).map((s) => s.sessionId)),
    [state.diskSessions],
  );

  return (
    <div className="kanban-panel">
      <div ref={boardRef} className="kanban-board">
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
            {...((col.id === "backlog" || col.id === "in_progress" || col.id === "recurring") ? {
              editingNewCard: editingNewCard === col.id,
              onAddCard: () => setEditingNewCard(col.id),
              onSaveNewCard: (text: string, images?: ImageAttachment[]) => handleSaveNewCard(text, images, col.id),
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

      {searchOpen && (
        <KanbanSearchModal
          columnData={columnData}
          onSelect={(sessionId, columnId) => {
            handleSelectSession(sessionId, columnId);
            // Scroll the selected card into view after the modal closes
            requestAnimationFrame(() => {
              const card = document.querySelector(`[data-session-id="${sessionId}"]`);
              card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
            });
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}

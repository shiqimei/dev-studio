import { useState, useEffect, useRef, useMemo } from "react";
import { cleanTitle } from "../utils";
import type { DiskSession } from "../types";

type KanbanColumnId = "backlog" | "in_progress" | "in_review" | "recurring" | "completed";

const isMac = navigator.platform.startsWith("Mac");

const COLUMN_LABELS: Record<KanbanColumnId, string> = {
  backlog: "Backlog",
  in_progress: "In Progress",
  in_review: "In Review",
  recurring: "Recurring",
  completed: "Completed",
};

interface KanbanSearchModalProps {
  columnData: Record<KanbanColumnId, DiskSession[]>;
  onSelect: (sessionId: string, columnId: KanbanColumnId) => void;
  onClose: () => void;
}

interface SearchResult {
  session: DiskSession;
  columnId: KanbanColumnId;
  title: string;
}

/** Highlight matching substring within text. Returns JSX fragments. */
function HighlightedTitle({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const q = query.toLowerCase();
  const idx = text.toLowerCase().indexOf(q);
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="kanban-search-highlight">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function KanbanSearchModal({ columnData, onSelect, onClose }: KanbanSearchModalProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Build flat list of all cards with their column info
  const allCards = useMemo(() => {
    const cards: SearchResult[] = [];
    for (const colId of Object.keys(COLUMN_LABELS) as KanbanColumnId[]) {
      for (const session of columnData[colId] ?? []) {
        cards.push({ session, columnId: colId, title: cleanTitle(session.title) });
      }
    }
    return cards;
  }, [columnData]);

  // Filter by query
  const results = useMemo(() => {
    if (!query.trim()) return allCards.slice(0, 50);
    const q = query.toLowerCase();
    return allCards.filter((r) => r.title.toLowerCase().includes(q)).slice(0, 50);
  }, [allCards, query]);

  // Reset active index when query changes
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Scroll active result into view
  useEffect(() => {
    const container = resultsRef.current;
    if (!container) return;
    const active = container.children[activeIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const result = results[activeIndex];
      if (result) {
        onSelect(result.session.sessionId, result.columnId);
        onClose();
      }
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div className="kanban-search-overlay" onClick={onClose}>
      <div className="kanban-search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="kanban-search-input-wrap">
          <svg className="kanban-search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="6" cy="6" r="4.5" />
            <path d="M9.5 9.5L13 13" />
          </svg>
          <input
            ref={inputRef}
            className="kanban-search-input"
            type="text"
            placeholder="Search cards..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="kanban-search-shortcut-hint">ESC</kbd>
        </div>
        <div className="kanban-search-results" ref={resultsRef}>
          {results.length === 0 ? (
            <div className="kanban-search-empty">No matching cards</div>
          ) : (
            results.map((r, i) => (
              <div
                key={r.session.sessionId}
                className={`kanban-search-result${i === activeIndex ? " active" : ""}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => {
                  onSelect(r.session.sessionId, r.columnId);
                  onClose();
                }}
              >
                <span className="kanban-search-result-title">
                  <HighlightedTitle text={r.title} query={query} />
                </span>
                <span className={`kanban-search-col-badge kanban-search-col-${r.columnId}`}>
                  {COLUMN_LABELS[r.columnId]}
                </span>
              </div>
            ))
          )}
        </div>
        {results.length > 0 && (
          <div className="kanban-search-footer">
            <span className="kanban-search-footer-hint">
              <kbd>{"\u2191"}</kbd><kbd>{"\u2193"}</kbd> navigate
            </span>
            <span className="kanban-search-footer-hint">
              <kbd>{"\u21B5"}</kbd> select
            </span>
            <span className="kanban-search-footer-hint">
              <kbd>{isMac ? "\u2318" : "Ctrl"}+P</kbd> close
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

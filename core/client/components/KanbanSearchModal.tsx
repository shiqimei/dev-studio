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
  score: number;
  /** Indices of matched characters in `title` (for fuzzy highlighting). */
  matchIndices: number[];
}

// ── Fuzzy matching engine ──

/**
 * Fuzzy-match `query` against `text`. Returns null if no match, or a
 * { score, indices } object. Scoring rewards:
 *  - Consecutive matches (characters in a row)
 *  - Start-of-word matches (after space, hyphen, underscore, or at index 0)
 *  - Early matches (closer to the start of the string)
 *  - Exact case matches
 */
function fuzzyMatch(
  text: string,
  query: string,
): { score: number; indices: number[] } | null {
  if (!query) return { score: 0, indices: [] };

  const tLower = text.toLowerCase();
  const qLower = query.toLowerCase();

  // Quick bail: every query char must exist somewhere in text
  let checkIdx = 0;
  for (let i = 0; i < qLower.length; i++) {
    checkIdx = tLower.indexOf(qLower[i], checkIdx);
    if (checkIdx === -1) return null;
    checkIdx++;
  }

  // Greedy forward match collecting the best indices
  const indices: number[] = [];
  let score = 0;
  let ti = 0;

  for (let qi = 0; qi < qLower.length; qi++) {
    const qc = qLower[qi];

    // Look for the best position for this query character.
    // Prefer: exact case > word boundary > consecutive > first occurrence
    let bestIdx = -1;
    let bestBonus = -1;

    for (let si = ti; si < tLower.length; si++) {
      if (tLower[si] !== qc) continue;

      let bonus = 0;

      // Consecutive match bonus (follows immediately after previous match)
      if (indices.length > 0 && si === indices[indices.length - 1] + 1) {
        bonus += 8;
      }

      // Word boundary bonus (start of string, or after separator)
      if (si === 0 || /[\s\-_./]/.test(text[si - 1])) {
        bonus += 6;
      }

      // Camel-case boundary bonus (lowercase followed by uppercase)
      if (si > 0 && text[si - 1] >= "a" && text[si - 1] <= "z" && text[si] >= "A" && text[si] <= "Z") {
        bonus += 5;
      }

      // Exact case bonus
      if (text[si] === query[qi]) {
        bonus += 1;
      }

      // Early position bonus (first 10 chars get a small bonus)
      if (si < 10) {
        bonus += (10 - si) * 0.2;
      }

      if (bonus > bestBonus) {
        bestBonus = bonus;
        bestIdx = si;
        // If we found a consecutive match, use it immediately
        if (indices.length > 0 && si === indices[indices.length - 1] + 1) break;
      }

      // Don't look too far ahead
      if (si - ti > 20 && bestIdx !== -1) break;
    }

    if (bestIdx === -1) return null; // shouldn't happen after the quick bail

    indices.push(bestIdx);
    score += bestBonus;
    ti = bestIdx + 1;
  }

  // Bonus for shorter overall span (tighter matches are better)
  if (indices.length > 1) {
    const span = indices[indices.length - 1] - indices[0];
    score += Math.max(0, 20 - span) * 0.5;
  }

  // Bonus for query matching a larger proportion of the title
  score += (query.length / text.length) * 5;

  return { score, indices };
}

/** Render text with non-contiguous characters highlighted. */
function FuzzyHighlight({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;

  const indexSet = new Set(indices);
  const parts: { str: string; highlighted: boolean }[] = [];
  let current = "";
  let currentHighlighted = indexSet.has(0);

  for (let i = 0; i < text.length; i++) {
    const isMatch = indexSet.has(i);
    if (isMatch !== currentHighlighted) {
      if (current) parts.push({ str: current, highlighted: currentHighlighted });
      current = text[i];
      currentHighlighted = isMatch;
    } else {
      current += text[i];
    }
  }
  if (current) parts.push({ str: current, highlighted: currentHighlighted });

  return (
    <>
      {parts.map((p, i) =>
        p.highlighted ? (
          <mark key={i} className="kanban-search-highlight">
            {p.str}
          </mark>
        ) : (
          <span key={i}>{p.str}</span>
        ),
      )}
    </>
  );
}

/** Tiny status dot indicator for search results. */
function StatusDot({ session, columnId }: { session: DiskSession; columnId: KanbanColumnId }) {
  if (columnId === "in_progress" || session.turnStatus === "in_progress") {
    return <span className="kanban-search-status-dot in-progress" title="In progress" />;
  }
  if (session.turnStatus === "error") {
    return <span className="kanban-search-status-dot error" title="Error" />;
  }
  return null;
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
    const cards: { session: DiskSession; columnId: KanbanColumnId; title: string }[] = [];
    for (const colId of Object.keys(COLUMN_LABELS) as KanbanColumnId[]) {
      for (const session of columnData[colId] ?? []) {
        cards.push({ session, columnId: colId, title: cleanTitle(session.title) });
      }
    }
    return cards;
  }, [columnData]);

  // Fuzzy filter + score + sort by relevance
  const results = useMemo<SearchResult[]>(() => {
    const q = query.trim();
    if (!q) {
      // No query: show all cards (no scoring needed)
      return allCards.slice(0, 50).map((c) => ({
        ...c,
        score: 0,
        matchIndices: [],
      }));
    }

    const scored: SearchResult[] = [];
    for (const card of allCards) {
      const match = fuzzyMatch(card.title, q);
      if (match) {
        scored.push({ ...card, score: match.score, matchIndices: match.indices });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, 50);
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

  const totalCards = allCards.length;

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
            placeholder={`Search ${totalCards} cards...`}
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
                <StatusDot session={r.session} columnId={r.columnId} />
                <span className="kanban-search-result-title">
                  <FuzzyHighlight text={r.title} indices={r.matchIndices} />
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

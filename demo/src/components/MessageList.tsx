import { Fragment, useState, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { useWsState, useWsActions } from "../context/WebSocketContext";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { UserMessage } from "./messages/UserMessage";
import { AssistantTurn } from "./messages/AssistantTurn";
import { AssistantMessage } from "./messages/AssistantMessage";
import { SystemMessage } from "./messages/SystemMessage";
import { Plan } from "./messages/Plan";
import { Permission } from "./messages/Permission";
import { TurnStatusBar, CompletedBar } from "./TurnStatusBar";
import type { ChatEntry, MessageEntry, PermissionEntry, ToolUseBlock } from "../types";

// ── Turn grouping ──────────────────────────

interface TurnGroup {
  id: string;
  userEntry: MessageEntry | null;
  entries: ChatEntry[];
}

/** Group messages into turn groups: each group starts at a user message and
 *  contains all entries until the next user message. */
function groupByUserTurn(messages: ChatEntry[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: TurnGroup | null = null;

  for (const entry of messages) {
    if (entry.type === "message" && entry.role === "user") {
      current = { id: entry.id, userEntry: entry, entries: [] };
      groups.push(current);
    } else {
      if (!current) {
        current = { id: "initial", userEntry: null, entries: [] };
        groups.push(current);
      }
      current.entries.push(entry);
    }
  }

  return groups;
}

/** Compute collapsed summary info for a turn group's entries. */
function computeStepsSummary(entries: ChatEntry[]) {
  let stepCount = 0;
  const toolNameSet = new Set<string>();
  let lastAssistant: MessageEntry | null = null;

  // Aggregate turn_completed stats across the group
  let totalDurationMs = 0;
  let totalOutputTokens: number | undefined;
  let totalThinkingMs: number | undefined;
  let totalCostUsd: number | undefined;

  for (const entry of entries) {
    if (entry.type === "turn_completed") {
      totalDurationMs += entry.durationMs;
      if (entry.outputTokens != null) {
        totalOutputTokens = (totalOutputTokens ?? 0) + entry.outputTokens;
      }
      if (entry.thinkingDurationMs != null) {
        totalThinkingMs = (totalThinkingMs ?? 0) + entry.thinkingDurationMs;
      }
      if (entry.costUsd != null) {
        totalCostUsd = (totalCostUsd ?? 0) + entry.costUsd;
      }
      continue;
    }
    if (entry.type !== "message" || entry.role !== "assistant") continue;
    lastAssistant = entry;
    for (const block of entry.content) {
      if (block.type === "thinking") stepCount++;
      if (block.type === "tool_use") {
        stepCount++;
        toolNameSet.add((block as ToolUseBlock).name);
      }
    }
  }

  // Extract trailing text blocks from the last assistant entry as the "result"
  const resultBlocks: MessageEntry["content"] = [];
  if (lastAssistant) {
    for (let i = lastAssistant.content.length - 1; i >= 0; i--) {
      if (lastAssistant.content[i].type === "text") {
        resultBlocks.unshift(lastAssistant.content[i]);
      } else {
        break;
      }
    }
  }

  const completedStatus = totalDurationMs > 0
    ? {
        status: "completed" as const,
        startedAt: 0,
        durationMs: totalDurationMs,
        outputTokens: totalOutputTokens,
        thinkingDurationMs: totalThinkingMs,
        costUsd: totalCostUsd,
      }
    : null;

  return { stepCount, toolNames: [...toolNameSet], resultBlocks, completedStatus };
}

// ── Collapsed turn group component ─────────

function CollapsedTurnGroup({
  entries,
  parentSessionId,
  onResumeSubagent,
}: {
  entries: ChatEntry[];
  parentSessionId: string | null;
  onResumeSubagent: (parentSessionId: string, agentId: string) => void;
}) {
  const { stepCount, toolNames, resultBlocks, completedStatus } = useMemo(
    () => computeStepsSummary(entries),
    [entries],
  );
  const [expanded, setExpanded] = useState(false);

  // Filter out turn_completed from expanded view (rendered separately below)
  const expandableEntries = useMemo(
    () => entries.filter((e) => e.type !== "turn_completed"),
    [entries],
  );

  if (stepCount === 0) {
    // No steps to collapse — render all entries normally
    return (
      <>
        {expandableEntries.map((entry, idx) => (
          <EntryRenderer
            key={entry.type === "message" ? entry.id : `e${idx}`}
            entry={entry}
            isLatest={false}
            parentSessionId={parentSessionId}
            onResumeSubagent={onResumeSubagent}
          />
        ))}
        {completedStatus && <CompletedBar status={completedStatus} />}
      </>
    );
  }

  return (
    <>
      <div
        className="steps-collapse"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`steps-chevron${expanded ? " expanded" : ""}`}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <path d="M4.5 2.5L8.5 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </span>
        <span className="steps-count">{stepCount} step{stepCount !== 1 ? "s" : ""}</span>
        {toolNames.length > 0 && (
          <span className="steps-tools"> · {toolNames.join(", ")}</span>
        )}
      </div>
      {expanded && (
        <div className="steps-expanded">
          {expandableEntries.map((entry, idx) => (
            <EntryRenderer
              key={entry.type === "message" ? entry.id : `e${idx}`}
              entry={entry}
              isLatest={false}
              parentSessionId={parentSessionId}
              onResumeSubagent={onResumeSubagent}
            />
          ))}
        </div>
      )}
      {!expanded && resultBlocks.map((block, i) => {
        if (block.type !== "text") return null;
        return (
          <AssistantMessage
            key={`result-${i}`}
            text={block.text}
            done={true}
          />
        );
      })}
      {completedStatus && <CompletedBar status={completedStatus} />}
    </>
  );
}

// ── Single entry renderer (shared) ─────────

function EntryRenderer({
  entry,
  isLatest,
  parentSessionId,
  onResumeSubagent,
}: {
  entry: ChatEntry;
  isLatest: boolean;
  parentSessionId: string | null;
  onResumeSubagent: (parentSessionId: string, agentId: string) => void;
}) {
  switch (entry.type) {
    case "message":
      if (entry.role === "user") {
        return <UserMessage entry={entry} isLatest={isLatest} />;
      }
      return (
        <AssistantTurn
          entry={entry}
          isLatest={isLatest}
          parentSessionId={parentSessionId}
          onResumeSubagent={onResumeSubagent}
        />
      );
    case "system":
      return <SystemMessage text={entry.text} isError={entry.isError} />;
    case "plan":
      return <Plan entries={entry.entries} />;
    case "turn_completed":
      return (
        <CompletedBar
          status={{
            status: "completed",
            startedAt: 0,
            durationMs: entry.durationMs,
            outputTokens: entry.outputTokens,
            thinkingDurationMs: entry.thinkingDurationMs,
            costUsd: entry.costUsd,
          }}
        />
      );
    case "permission":
      return (
        <Permission
          title={entry.title}
          requestId={entry.requestId}
          options={entry.options}
          status={entry.status}
          selectedOptionId={entry.selectedOptionId}
          selectedOptionName={entry.selectedOptionName}
        />
      );
  }
}

// ── MessageList ────────────────────────────

export function MessageList() {
  const state = useWsState();
  const { resumeSubagent } = useWsActions();
  const { ref, onScroll, scrollToBottom, isAtBottom } = useAutoScroll<HTMLDivElement>(state.messages, state.turnStatus);

  // Force scroll to bottom when the user sends a message, even if they had scrolled up
  const lastMsg = state.messages[state.messages.length - 1];
  const lastUserMsgId = lastMsg?.type === "message" && lastMsg.role === "user" ? lastMsg.id : undefined;
  useLayoutEffect(() => {
    if (lastUserMsgId) scrollToBottom();
  }, [lastUserMsgId, scrollToBottom]);

  // Derive parent session ID once for all assistant turns
  const parentSessionId = state.currentSessionId?.split(":subagent:")[0] ?? null;

  // Group messages into turn groups (entries between user messages)
  const turnGroups = useMemo(() => groupByUserTurn(state.messages), [state.messages]);

  // Custom overlay scrollbar
  const scrollThumbRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    onScroll();
    const el = e.currentTarget;
    const thumb = scrollThumbRef.current;
    if (!thumb) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight) {
      thumb.style.opacity = "0";
      return;
    }
    thumb.style.opacity = "1";
    const ratio = clientHeight / scrollHeight;
    const thumbH = Math.max(ratio * clientHeight, 24);
    const maxScroll = scrollHeight - clientHeight;
    const thumbTop = (scrollTop / maxScroll) * (clientHeight - thumbH);
    thumb.style.height = `${thumbH}px`;
    thumb.style.top = `${thumbTop}px`;
    clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      thumb.style.opacity = "0";
    }, 800);
  }, [onScroll]);

  return (
    <div className="chat-scroll-wrap">
    <div
      ref={ref}
      onScroll={handleScroll}
      className="chat-scroll-list px-5 py-4"
    >
      <div className="chat-content flex flex-col gap-1">
      {state.messages.length === 0 && (
        <div className="welcome-container">
          <div className="welcome-greeting">What do you want to build next?</div>
          <div className="welcome-hint">Send a message to get started, or type <span className="welcome-kbd">/</span> for commands</div>
        </div>
      )}
      {turnGroups.map((group, gi) => {
        const isLatestGroup = gi === turnGroups.length - 1;
        // Only render expanded when the latest group is actively streaming
        const isStreaming = isLatestGroup && state.turnStatus?.status === "in_progress";

        return (
          <Fragment key={group.id}>
            {group.userEntry && (
              <UserMessage
                entry={group.userEntry}
                isLatest={isLatestGroup && group.entries.length === 0}
              />
            )}

            {isStreaming ? (
              // Active turn: render all entries expanded (live streaming)
              group.entries.map((entry, idx) => {
                const isLatest = idx === group.entries.length - 1;
                return (
                  <EntryRenderer
                    key={entry.type === "message" ? entry.id : `${group.id}-e${idx}`}
                    entry={entry}
                    isLatest={isLatest}
                    parentSessionId={parentSessionId}
                    onResumeSubagent={resumeSubagent}
                  />
                );
              })
            ) : (
              // Completed turn: collapse all steps into a single summary
              <CollapsedTurnGroup
                entries={group.entries}
                parentSessionId={parentSessionId}
                onResumeSubagent={resumeSubagent}
              />
            )}
          </Fragment>
        );
      })}
      <TurnStatusBar status={state.turnStatus} />
      </div>
    </div>
    <div ref={scrollThumbRef} className="sidebar-scroll-thumb" />
    <button
      className={`scroll-to-bottom ${isAtBottom ? "" : "visible"}`}
      onClick={scrollToBottom}
      aria-label="Scroll to bottom"
    >
      <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M10 3C10.2761 3.00006 10.5 3.2239 10.5 3.5V15.293L14.6465 11.1465C14.8418 10.9514 15.1583 10.9513 15.3536 11.1465C15.5487 11.3417 15.5486 11.6583 15.3536 11.8535L10.3535 16.8535C10.2598 16.9473 10.1326 17 10 17C9.90062 17 9.8042 16.9703 9.72268 16.916L9.64651 16.8535L4.6465 11.8535C4.45138 11.6582 4.45128 11.3417 4.6465 11.1465C4.84172 10.9513 5.15827 10.9514 5.35353 11.1465L9.50003 15.293V3.5C9.50003 3.22386 9.72389 3 10 3Z" />
      </svg>
    </button>
    </div>
  );
}

import { useState, memo } from "react";
import { useWsState } from "../context/WebSocketContext";
import { EXECUTOR_ICONS } from "../executor-icons";
import type { ExecutorType } from "../types";

/** Format a raw model ID into a readable name.
 *  e.g. "claude-opus-4-6-20250219" → "Claude Opus 4.6" */
function formatModelName(modelId: string): string {
  // Try to extract family + variant from common patterns
  const m = modelId.match(/^(claude)-(\w+)-([\d]+)-([\d]+)/);
  if (m) {
    const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    const variant = m[2].charAt(0).toUpperCase() + m[2].slice(1);
    return `${family} ${variant} ${m[3]}.${m[4]}`;
  }
  return modelId;
}

export const SessionMetaBanner = memo(function SessionMetaBanner() {
  const state = useWsState();
  const [expanded, setExpanded] = useState(false);

  const currentSession = state.diskSessions.find(
    (s) => s.sessionId === state.currentSessionId?.replace(/:subagent:.+$/, ""),
  );
  const executorType: ExecutorType = currentSession?.executorType ?? "claude";
  const model = state.currentModel;
  const agentName = state.agentName;
  const agentVersion = state.agentVersion;

  // Don't render if we have no metadata yet
  if (!model && !agentName) return null;

  const iconSrc = EXECUTOR_ICONS[executorType];
  const displayModel = model ? formatModelName(model) : null;

  return (
    <div className="session-meta-banner">
      <div
        className="session-meta-collapsed"
        onClick={() => setExpanded(!expanded)}
      >
        <img src={iconSrc} width={14} height={14} alt="" className="session-meta-icon" />
        <span className="session-meta-summary">
          {agentName && <span className="session-meta-agent">{agentName}</span>}
          {agentVersion && <span className="session-meta-version">v{agentVersion}</span>}
          {displayModel && (
            <>
              <span className="session-meta-sep">/</span>
              <span className="session-meta-model">{displayModel}</span>
            </>
          )}
        </span>
        <span className={`session-meta-chevron${expanded ? " expanded" : ""}`}>
          <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
            <path d="M4.5 2.5L8.5 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </span>
      </div>
      {expanded && (
        <div className="session-meta-details">
          {agentName && (
            <div className="session-meta-row">
              <span className="session-meta-label">Agent</span>
              <span className="session-meta-value">
                {agentName}
                {agentVersion && ` v${agentVersion}`}
              </span>
            </div>
          )}
          {model && (
            <div className="session-meta-row">
              <span className="session-meta-label">Model</span>
              <span className="session-meta-value">{model}</span>
            </div>
          )}
          {executorType && (
            <div className="session-meta-row">
              <span className="session-meta-label">Executor</span>
              <span className="session-meta-value">{executorType === "codex" ? "Codex" : "Claude Code"}</span>
            </div>
          )}
          {state.currentSessionId && (
            <div className="session-meta-row">
              <span className="session-meta-label">Session</span>
              <span className="session-meta-value session-meta-mono">
                {state.currentSessionId.replace(/:subagent:.+$/, "").slice(0, 12)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

import { useState, useEffect } from "react";
import { useWs } from "../context/WebSocketContext";
import type { TurnStatus } from "../types";

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

function InProgressBar({ status }: { status: TurnStatus }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = now - status.startedAt;
  const tokens = status.approxTokens ?? 0;
  const thinkingMs = status.thinkingDurationMs ?? 0;

  const parts: string[] = [formatDuration(elapsed)];
  if (tokens > 0) parts.push(`↓ ${formatTokens(tokens)} tokens`);
  if (thinkingMs >= 1000) parts.push(`thought for ${formatDuration(thinkingMs)}`);

  return (
    <div className="turn-status turn-status-active">
      <span className="turn-status-dot">·</span>
      {" "}Brewing... ({parts.join(" · ")})
    </div>
  );
}

function CompletedBar({ status }: { status: TurnStatus }) {
  const duration = status.durationMs ?? 0;
  const tokens = status.outputTokens ?? status.approxTokens;
  const thinkingMs = status.thinkingDurationMs ?? 0;

  const parts: string[] = [formatDuration(duration)];
  if (tokens && tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
  if (thinkingMs >= 1000) parts.push(`thought for ${formatDuration(thinkingMs)}`);

  return (
    <div className="turn-status turn-status-done">
      * Brewed for {parts.join(" · ")}
    </div>
  );
}

export function TurnStatusBar() {
  const { state } = useWs();
  const { turnStatus } = state;

  if (!turnStatus) return null;

  if (turnStatus.status === "in_progress") {
    return <InProgressBar status={turnStatus} />;
  }

  return <CompletedBar status={turnStatus} />;
}

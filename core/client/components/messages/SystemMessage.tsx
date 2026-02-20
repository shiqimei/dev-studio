import { memo } from "react";

interface Props {
  text: string;
  isError?: boolean;
}

/** Try to extract a readable error message from raw API error text. */
function formatError(raw: string): string {
  // Pattern: "API Error: 400 {json...}"
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) return raw;

  const prefix = raw.slice(0, jsonStart).trim();
  try {
    const parsed = JSON.parse(raw.slice(jsonStart));
    const msg = parsed?.error?.message ?? parsed?.message;
    if (msg) return prefix ? `${prefix} — ${msg}` : msg;
  } catch { /* not valid JSON */ }
  return raw;
}

/** Parse compact boundary text like "[Compact boundary: auto, 12345 tokens]" */
function parseCompactBoundary(text: string): { trigger: string; tokens?: string } | null {
  const m = text.match(/^\[Compact boundary:\s*(.+)\]$/);
  if (!m) return null;
  const parts = m[1].split(",").map((s) => s.trim());
  const trigger = parts[0];
  const tokensMatch = parts[1]?.match(/^(\d[\d,]*)\s*tokens$/);
  return { trigger, tokens: tokensMatch ? tokensMatch[1] : undefined };
}

const CompactIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 6L8 2L12 6" />
    <path d="M4 10L8 14L12 10" />
  </svg>
);

export const SystemMessage = memo(function SystemMessage({ text, isError }: Props) {
  if (isError) {
    return (
      <div className="msg error">
        <span className="error-label">Error</span>
        {formatError(text)}
      </div>
    );
  }

  // Compact boundary marker
  const boundary = parseCompactBoundary(text);
  if (boundary) {
    return (
      <div className="compact-divider">
        <div className="compact-divider-line" />
        <span className="compact-divider-label">
          <CompactIcon />
          Context compacted
          {boundary.tokens && (
            <span className="compact-divider-detail">{boundary.tokens} tokens</span>
          )}
        </span>
        <div className="compact-divider-line" />
      </div>
    );
  }

  return <div className="msg system">{text}</div>;
});

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

export const SystemMessage = memo(function SystemMessage({ text, isError }: Props) {
  if (isError) {
    return (
      <div className="msg error">
        <span className="error-label">Error</span>
        {formatError(text)}
      </div>
    );
  }
  return <div className="msg system">{text}</div>;
});

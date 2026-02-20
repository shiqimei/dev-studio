import { useState, useRef, useEffect, memo } from "react";

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

interface Props {
  text: string;
  isLatest: boolean;
}

export const ThoughtMessage = memo(function ThoughtMessage({ text, isLatest }: Props) {
  if (!text) return null;
  const [open, setOpen] = useState(false);
  const preRef = useRef<HTMLDivElement>(null);

  // Auto-scroll collapsed preview to bottom so latest lines are visible
  useEffect(() => {
    if (!open && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [text, open]);

  return (
    <div className="tool-call">
      <div
        className="tool-header cursor-pointer"
        onClick={() => setOpen(!open)}
      >
        <span className="tool-kind thinking">Thinking</span>
        <span className="tool-title thought-hint">
          {open ? "Click to collapse" : "Click to expand"}
        </span>
        <span className="thought-token-count">{formatTokens(Math.ceil(text.length / 4))} tokens</span>
      </div>
      <div
        ref={preRef}
        className={`tool-content thought-content ${open ? "thought-expanded" : "thought-collapsed"}`}
      >
        {text}
      </div>
    </div>
  );
});

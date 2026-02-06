import { useState } from "react";

interface Props {
  text: string;
  isLatest: boolean;
}

function hintText(text: string): string {
  // Extract first 1-2 sentences as a preview
  const match = text.match(/^(.+?[.!?])\s+(.+?[.!?])?/s);
  if (match) {
    const hint = match[2] ? match[1] + " " + match[2] : match[1];
    return hint.length > 120 ? hint.slice(0, 120) + "..." : hint;
  }
  return text.length > 120 ? text.slice(0, 120) + "..." : text;
}

export function ThoughtMessage({ text, isLatest }: Props) {
  if (!text) return null;
  const [open, setOpen] = useState(isLatest);

  return (
    <div className="tool-call">
      <div
        className="tool-header cursor-pointer"
        onClick={() => setOpen(!open)}
      >
        <span className="tool-kind thinking">Thinking</span>
        <span className="tool-title thought-hint">
          {!open && hintText(text)}
        </span>
      </div>
      {open && <div className="tool-content thought-content">{text}</div>}
    </div>
  );
}

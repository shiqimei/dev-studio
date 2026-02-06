import { useState, useRef, useLayoutEffect } from "react";
import type { MessageEntry } from "../../types";

/** Collapsed height ≈ 5-6 lines of text at 1.5 line-height */
const COLLAPSED_HEIGHT = 130;

interface Props {
  entry: MessageEntry;
  isLatest: boolean;
}

export function UserMessage({ entry, isLatest }: Props) {
  const [preview, setPreview] = useState<string | null>(null);
  const [userExpanded, setUserExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  const expanded = userExpanded || isLatest;

  const images = entry.content.filter((b) => b.type === "image");
  const textParts = entry.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text);
  const text = textParts.join("\n");

  useLayoutEffect(() => {
    if (textRef.current) {
      setOverflows(textRef.current.scrollHeight > COLLAPSED_HEIGHT);
    }
  }, [text]);

  const collapsed = !expanded && overflows;

  return (
    <div className="msg user">
      {images.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {images.map((img, i) => {
            const src = `data:${(img as any).mimeType};base64,${(img as any).data}`;
            return (
              <img
                key={i}
                src={src}
                alt={`Attached image ${i + 1}`}
                className="max-h-48 max-w-64 rounded-md border border-border object-contain cursor-pointer hover:opacity-80 transition-opacity"
                onClick={() => setPreview(src)}
              />
            );
          })}
        </div>
      )}
      {text && (
        <div className="user-text-wrap">
          <div
            ref={textRef}
            className={collapsed ? "user-text-collapsed" : undefined}
          >
            {text}
          </div>
          {collapsed && (
            <div className="user-text-overlay" onClick={() => setUserExpanded(true)}>
              <span>Show more</span>
            </div>
          )}
          {overflows && expanded && !isLatest && (
            <button className="user-collapse-btn" onClick={() => setUserExpanded(false)}>
              Show less
            </button>
          )}
        </div>
      )}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-pointer"
          onClick={() => setPreview(null)}
        >
          <img
            src={preview}
            alt="Preview"
            className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg"
          />
        </div>
      )}
    </div>
  );
}

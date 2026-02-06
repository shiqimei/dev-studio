import { useState } from "react";
import type { MessageEntry } from "../../types";

interface Props {
  entry: MessageEntry;
}

export function UserMessage({ entry }: Props) {
  const [preview, setPreview] = useState<string | null>(null);
  const images = entry.content.filter((b) => b.type === "image");
  const textParts = entry.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text);
  const text = textParts.join("\n");

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
      {text && <span>{text}</span>}
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

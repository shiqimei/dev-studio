import type { MessageEntry } from "../../types";

interface Props {
  entry: MessageEntry;
}

export function UserMessage({ entry }: Props) {
  const images = entry.content.filter((b) => b.type === "image");
  const textParts = entry.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text);
  const text = textParts.join("\n");

  return (
    <div className="msg user">
      {images.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {images.map((img, i) => (
            <img
              key={i}
              src={`data:${(img as any).mimeType};base64,${(img as any).data}`}
              alt={`Attached image ${i + 1}`}
              className="max-h-48 max-w-64 rounded-md border border-border object-contain"
            />
          ))}
        </div>
      )}
      {text && <span>{text}</span>}
    </div>
  );
}

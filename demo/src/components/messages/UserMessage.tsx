import type { ImageAttachment } from "../../types";

interface Props {
  text: string;
  images?: ImageAttachment[];
}

export function UserMessage({ text, images }: Props) {
  return (
    <div className="msg user">
      {images && images.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {images.map((img, i) => (
            <img
              key={i}
              src={`data:${img.mimeType};base64,${img.data}`}
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

export const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/**
 * Convert an image blob to PNG if its type isn't supported by the API.
 * Returns { data: base64, mimeType } ready for ImageAttachment.
 */
export function toSupportedImage(blob: Blob): Promise<{ data: string; mimeType: string }> {
  if (SUPPORTED_IMAGE_TYPES.has(blob.type)) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        resolve({ data: dataUrl.split(",")[1], mimeType: blob.type });
      };
      reader.readAsDataURL(blob);
    });
  }

  // Convert to PNG via canvas
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const pngDataUrl = canvas.toDataURL("image/png");
      resolve({ data: pngDataUrl.split(",")[1], mimeType: "image/png" });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load image for conversion"));
    };
    img.src = url;
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function syntaxHighlight(json: string): string {
  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "json-num";
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? "json-key" : "json-str";
      } else if (/true|false/.test(match)) {
        cls = "json-bool";
      } else if (/null/.test(match)) {
        cls = "json-null";
      }
      return '<span class="' + cls + '">' + match + "</span>";
    },
  );
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  return m + "m " + (s % 60) + "s";
}

export function classifyTool(meta: any): string {
  const name = meta?.claudeCode?.toolName || "";
  if (name === "Task") return "agent";
  if (name === "Bash") return "bash";
  if (name) return "other";
  return "other";
}

/** Strip XML tags from session titles and extract a readable summary. */
export function cleanTitle(raw: string | null): string {
  if (!raw) return "New session";

  const tmRe = /<teammate-message\s+([^>]*)>([\s\S]*?)<\/teammate-message>/g;
  let cleaned = raw;
  let hadTeammate = false;

  cleaned = cleaned.replace(tmRe, (_match, attrStr, body) => {
    hadTeammate = true;
    const idMatch = attrStr.match(/teammate_id="([^"]*)"/);
    const from = idMatch?.[1] ?? "";
    const trimmed = body.trim();
    try {
      const json = JSON.parse(trimmed);
      if (json.subject) return `[${from}] ${json.subject}`;
      if (json.reason) return `[${from}] ${json.reason}`;
      if (json.type) return `[${from}] ${json.type.replace(/_/g, " ")}`;
    } catch {
      /* not JSON */
    }
    const firstLine = trimmed.split("\n")[0].slice(0, 80);
    return from ? `[${from}] ${firstLine}` : firstLine;
  });

  cleaned = cleaned.replace(/<[^>]+>/g, "").trim();
  if (!cleaned) return hadTeammate ? "Teammate message" : "New session";
  return cleaned;
}

/** Shorten a project path to the last 2 segments. */
export function shortPath(p: string | null): string | null {
  if (!p) return null;
  const parts = p.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return parts.slice(-2).join("/");
}

/** Format an ISO timestamp as a relative time string. */
export function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

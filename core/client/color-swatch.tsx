import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { harden } from "rehype-harden";
import type { Pluggable } from "unified";

/**
 * Regex matching CSS color codes: hex (#fff, #ffffff, #ffffffaa),
 * rgb/rgba(...), and hsl/hsla(...).
 */
const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/;
const FUNC_RE = /(?:rgba?|hsla?)\([^)]+\)/i;
const COLOR_RE = new RegExp(`${HEX_RE.source}|${FUNC_RE.source}`, "gi");

// ── HAST node helpers (minimal inline types to avoid dep on @types/hast) ──

interface HastText {
  type: "text";
  value: string;
}

interface HastElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}

interface HastRoot {
  type: "root";
  children: HastNode[];
}

type HastNode = HastText | HastElement | HastRoot | { type: string; [k: string]: unknown };

/** Split a text node value into an array of HAST text + swatch span nodes. */
function splitText(value: string): HastNode[] {
  COLOR_RE.lastIndex = 0;
  const nodes: HastNode[] = [];
  let last = 0;

  for (const m of value.matchAll(COLOR_RE)) {
    const color = m[0];
    const idx = m.index!;
    if (idx > last) nodes.push({ type: "text", value: value.slice(last, idx) });

    // Small colored square
    nodes.push({
      type: "element",
      tagName: "span",
      properties: { className: ["color-swatch"], style: `background:${color}` },
      children: [],
    });
    // The color text itself
    nodes.push({ type: "text", value: color });

    last = idx + color.length;
  }

  if (last < value.length) nodes.push({ type: "text", value: value.slice(last) });
  return nodes;
}

/** Recursively walk HAST tree, injecting color swatches into text nodes. */
function walk(node: HastNode): void {
  if (!("children" in node) || !Array.isArray(node.children)) return;

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i] as HastNode;

    // Skip <pre> subtrees (code blocks)
    if (child.type === "element" && (child as HastElement).tagName === "pre") continue;

    if (child.type === "text") {
      const text = (child as HastText).value;
      COLOR_RE.lastIndex = 0;
      if (!COLOR_RE.test(text)) {
        COLOR_RE.lastIndex = 0;
        continue;
      }
      COLOR_RE.lastIndex = 0;

      const replacement = splitText(text);
      node.children.splice(i, 1, ...replacement);
      i += replacement.length - 1; // skip past inserted nodes
    } else {
      walk(child);
    }
  }
}

/** Rehype plugin that injects color-swatch preview spans next to color codes. */
function rehypeColorSwatch() {
  return (tree: HastRoot) => walk(tree);
}

/**
 * Streamdown rehype plugin list: default pipeline (raw → sanitize → harden)
 * plus the color-swatch plugin appended at the end (runs after sanitize,
 * so injected style attributes are preserved).
 */
export const colorSwatchRehypePlugins: Pluggable[] = [
  rehypeRaw as Pluggable,
  [rehypeSanitize, {}] as Pluggable,
  [
    harden,
    {
      allowedImagePrefixes: ["*"],
      allowedLinkPrefixes: ["*"],
      allowedProtocols: ["*"],
      defaultOrigin: undefined,
      allowDataImages: true,
    },
  ] as Pluggable,
  rehypeColorSwatch as Pluggable,
];

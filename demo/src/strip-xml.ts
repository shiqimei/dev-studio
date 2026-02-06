/**
 * Strip CLI-injected XML tags from text content.
 *
 * Tags like <local-command-caveat>, <system-reminder>, <teammate-message> etc.
 * are internal protocol wrappers that shouldn't be shown raw in the UI.
 *
 * - Tags with content meant to be hidden (caveat, system-reminder) → removed entirely
 * - Tags wrapping user-visible content (teammate-message) → unwrap to inner text
 * - Stray opening/closing tags without a match → removed
 */

/** Tags whose entire content should be removed. */
const HIDDEN_TAGS = [
  "local-command-caveat",
  "system-reminder",
  "command-message",
];

/** Tags whose content should be kept (unwrap the tags). */
const UNWRAP_TAGS = [
  "teammate-message",
  "command-name",
  "command-args",
  "local-command-stdout",
];

/** Combined regex for hidden tags: remove tag + content. */
const HIDDEN_RE = new RegExp(
  `<(${HIDDEN_TAGS.join("|")})[^>]*>[\\s\\S]*?<\\/\\1>`,
  "g",
);

/** Combined regex for unwrappable tags: keep inner content. */
const UNWRAP_RE = new RegExp(
  `<(${UNWRAP_TAGS.join("|")})[^>]*>([\\s\\S]*?)<\\/\\1>`,
  "g",
);

/** Catch-all for any remaining CLI-style XML tags (self-closing or paired). */
const STRAY_TAG_RE =
  /<\/?(local-command-caveat|command-name|command-message|command-args|local-command-stdout|system-reminder|teammate-message)[^>]*>/g;

/**
 * Strip CLI XML tags from text, returning cleaned content.
 * Returns empty string if nothing remains after stripping.
 */
export function stripCliXml(text: string): string {
  if (!text) return "";
  let result = text;
  // 1. Remove hidden tags entirely
  result = result.replace(HIDDEN_RE, "");
  // 2. Unwrap visible tags (keep inner content)
  result = result.replace(UNWRAP_RE, "$2");
  // 3. Remove any leftover stray tags
  result = result.replace(STRAY_TAG_RE, "");
  return result.trim();
}

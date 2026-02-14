/**
 * Path computation for Codex session storage.
 * Codex stores sessions in ~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{ts}-{uuid}.jsonl
 */
import * as path from "node:path";
import * as os from "node:os";

/** Root Codex config directory (defaults to ~/.codex). */
export const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");

/** Returns the Codex sessions root directory. */
export function getCodexSessionsDir(codexHome = CODEX_HOME): string {
  return path.join(codexHome, "sessions");
}

/**
 * Extract the session ID (UUID) from a Codex rollout filename.
 * Filename format: rollout-{YYYY}-{MM}-{DD}T{HH}-{MM}-{SS}-{UUID}.jsonl
 */
export function extractSessionIdFromFilename(filename: string): string | null {
  // UUID is the part after the timestamp: rollout-2026-02-13T01-19-51-{uuid}.jsonl
  // The timestamp is always rollout-YYYY-MM-DDTHH-MM-SS (27 chars for "rollout-" + "YYYY-MM-DDTHH-MM-SS")
  const match = filename.match(
    /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/,
  );
  return match ? match[1] : null;
}

/**
 * Extract the creation timestamp from a Codex rollout filename.
 * Returns an ISO 8601 string.
 */
export function extractTimestampFromFilename(filename: string): string | null {
  const match = filename.match(
    /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/,
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

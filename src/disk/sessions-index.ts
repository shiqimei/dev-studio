/**
 * Read and parse sessions-index.json from disk.
 * No SDK dependencies — pure filesystem access.
 */
import * as fs from "node:fs";
import { getSessionsIndexPath } from "./paths.js";
import type { SessionIndexEntry, SessionsIndex } from "./types.js";

/**
 * Reads the sessions-index.json for a given project directory.
 * Returns the parsed entries, filtering out sidechains.
 * Returns an empty array if the file is missing or malformed.
 */
export function readSessionsIndex(projectDir: string): SessionIndexEntry[] {
  const indexPath = getSessionsIndexPath(projectDir);
  try {
    const raw = fs.readFileSync(indexPath, "utf-8");
    const index = JSON.parse(raw) as SessionsIndex;
    return index.entries.filter((e) => !e.isSidechain);
  } catch {
    return [];
  }
}

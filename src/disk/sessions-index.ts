/**
 * Read and parse sessions-index.json from disk.
 * No SDK dependencies — pure filesystem access.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionsIndexPath, getSessionJsonlPath, getSubagentsDir } from "./paths.js";
import type { SessionIndexEntry, SessionsIndex } from "./types.js";

/**
 * Reads the sessions-index.json for a given project directory (async).
 * Returns the parsed entries, filtering out sidechains.
 * Returns an empty array if the file is missing or malformed.
 */
export async function readSessionsIndex(projectDir: string): Promise<SessionIndexEntry[]> {
  const indexPath = getSessionsIndexPath(projectDir);
  try {
    const raw = await fs.promises.readFile(indexPath, "utf-8");
    const index = JSON.parse(raw) as SessionsIndex;
    return index.entries.filter((e) => !e.isSidechain);
  } catch {
    return [];
  }
}

/**
 * Synchronous version for callers that can't be async yet.
 */
export function readSessionsIndexSync(projectDir: string): SessionIndexEntry[] {
  const indexPath = getSessionsIndexPath(projectDir);
  try {
    const raw = fs.readFileSync(indexPath, "utf-8");
    const index = JSON.parse(raw) as SessionsIndex;
    return index.entries.filter((e) => !e.isSidechain);
  } catch {
    return [];
  }
}

/**
 * Deletes a session from the sessions-index.json and removes its JSONL + subagent files.
 * Returns true if the session was found and removed, false otherwise.
 */
/**
 * Renames a session by updating its firstPrompt in sessions-index.json.
 * Returns true if the session was found and renamed, false otherwise.
 */
export async function renameSessionOnDisk(projectDir: string, sessionId: string, newTitle: string): Promise<boolean> {
  const indexPath = getSessionsIndexPath(projectDir);
  try {
    const raw = await fs.promises.readFile(indexPath, "utf-8");
    const index = JSON.parse(raw) as SessionsIndex;
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (!entry) return false;
    entry.firstPrompt = newTitle;
    await fs.promises.writeFile(indexPath, JSON.stringify(index, null, 2));
    return true;
  } catch (err) {
    console.error(`[renameSessionOnDisk] Error:`, err);
    return false;
  }
}

export async function deleteSessionFromDisk(projectDir: string, sessionId: string): Promise<boolean> {
  const indexPath = getSessionsIndexPath(projectDir);
  console.log(`[deleteSessionFromDisk] indexPath=${indexPath}, sessionId=${sessionId}`);

  // Remove entry from index
  try {
    const raw = await fs.promises.readFile(indexPath, "utf-8");
    const index = JSON.parse(raw) as SessionsIndex;
    const before = index.entries.length;
    const ids = index.entries.map((e) => e.sessionId);
    console.log(`[deleteSessionFromDisk] Found ${before} entries. IDs: ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? "..." : ""}`);
    console.log(`[deleteSessionFromDisk] Looking for: "${sessionId}", match: ${ids.includes(sessionId)}`);
    index.entries = index.entries.filter((e) => e.sessionId !== sessionId);
    if (index.entries.length === before) return false; // not found
    await fs.promises.writeFile(indexPath, JSON.stringify(index, null, 2));
    console.log(`[deleteSessionFromDisk] Wrote updated index with ${index.entries.length} entries`);
  } catch (err) {
    console.error(`[deleteSessionFromDisk] Error:`, err);
    return false;
  }

  // Remove JSONL file and subagents directory in parallel
  const jsonlPath = getSessionJsonlPath(projectDir, sessionId);
  const subDir = getSubagentsDir(projectDir, sessionId);
  await Promise.all([
    fs.promises.unlink(jsonlPath).catch(() => {}),
    fs.promises.rm(subDir, { recursive: true, force: true }).catch(() => {}),
  ]);

  // Remove session directory if empty
  const sessionDir = path.join(projectDir, sessionId);
  try {
    const remaining = await fs.promises.readdir(sessionDir);
    if (remaining.length === 0) await fs.promises.rmdir(sessionDir);
  } catch {}

  return true;
}

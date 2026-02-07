/**
 * Reader for ~/.claude/tasks/{sessionId}/{taskId}.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getTasksDir } from "./paths.js";

export interface TaskEntry {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  blocks: string[];
  blockedBy: string[];
}

export function getSessionTasksDir(sessionId: string): string {
  return path.join(getTasksDir(), sessionId);
}

export async function readSessionTasks(sessionId: string): Promise<TaskEntry[]> {
  const dir = getSessionTasksDir(sessionId);
  try {
    const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".json"));
    const tasks = await Promise.all(
      files.map(async (file) => {
        try {
          const raw = await fs.promises.readFile(path.join(dir, file), "utf-8");
          return JSON.parse(raw) as TaskEntry;
        } catch {
          return null; // skip malformed task files
        }
      }),
    );
    return tasks.filter((t): t is TaskEntry => t !== null);
  } catch {
    return [];
  }
}

export async function listSessionsWithTasks(): Promise<string[]> {
  const dir = getTasksDir();
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

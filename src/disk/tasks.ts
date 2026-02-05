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

export function readSessionTasks(sessionId: string): TaskEntry[] {
  const dir = getSessionTasksDir(sessionId);
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const tasks: TaskEntry[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), "utf-8");
        tasks.push(JSON.parse(raw) as TaskEntry);
      } catch {
        // skip malformed task files
      }
    }
    return tasks;
  } catch {
    return [];
  }
}

export function listSessionsWithTasks(): string[] {
  const dir = getTasksDir();
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

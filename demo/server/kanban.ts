/**
 * Kanban board state persistence.
 * Reads/writes kanban.json in the project directory (~/.claude/projects/[cwd-hash]/).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface KanbanState {
  version: 1;
  columnOverrides: Record<string, string>;
  sortOrders: Partial<Record<string, string[]>>;
  pendingPrompts: Record<string, string>;
  updatedAt: string;
}

const KANBAN_FILENAME = "kanban.json";

export function getProjectDir(cwd: string): string {
  const configDir = process.env.CLAUDE ?? path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects", cwd.replace(/\//g, "-"));
}

export async function readKanbanState(projectDir: string): Promise<KanbanState | null> {
  try {
    const raw = await fs.promises.readFile(path.join(projectDir, KANBAN_FILENAME), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1) return null;
    return parsed as KanbanState;
  } catch {
    return null;
  }
}

export async function writeKanbanState(projectDir: string, state: KanbanState): Promise<void> {
  await fs.promises.mkdir(projectDir, { recursive: true });
  await fs.promises.writeFile(path.join(projectDir, KANBAN_FILENAME), JSON.stringify(state, null, 2));
}

/**
 * Remove entries referencing sessions not in validSessionIds.
 * Returns a new state if changes were made, null otherwise.
 */
export function cleanKanbanState(
  state: KanbanState,
  validSessionIds: Set<string>,
): KanbanState | null {
  let changed = false;

  const newOverrides: Record<string, string> = {};
  for (const [id, col] of Object.entries(state.columnOverrides)) {
    if (validSessionIds.has(id)) {
      newOverrides[id] = col;
    } else {
      changed = true;
    }
  }

  const newPrompts: Record<string, string> = {};
  for (const [id, prompt] of Object.entries(state.pendingPrompts)) {
    if (validSessionIds.has(id)) {
      newPrompts[id] = prompt;
    } else {
      changed = true;
    }
  }

  const newSortOrders: Partial<Record<string, string[]>> = {};
  for (const [col, order] of Object.entries(state.sortOrders)) {
    if (!order) continue;
    const filtered = order.filter((id) => validSessionIds.has(id));
    if (filtered.length !== order.length) changed = true;
    if (filtered.length > 0) newSortOrders[col] = filtered;
  }

  if (!changed) return null;
  return {
    ...state,
    columnOverrides: newOverrides,
    sortOrders: newSortOrders,
    pendingPrompts: newPrompts,
    updatedAt: new Date().toISOString(),
  };
}

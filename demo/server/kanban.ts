/**
 * Kanban types and legacy helpers.
 * State persistence is handled by kanban-db.ts (SQLite).
 */
import * as path from "node:path";
import * as os from "node:os";

// ── Operation types for delta-based updates ──

export type KanbanOp =
  | { op: "set_column"; sessionId: string; column: string }
  | { op: "remove_column"; sessionId: string }
  | { op: "set_sort_order"; column: string; order: string[] }
  | { op: "set_pending_prompt"; sessionId: string; text: string }
  | { op: "remove_pending_prompt"; sessionId: string }
  | { op: "bulk_set_columns"; entries: { sessionId: string; column: string }[] }
  | { op: "bulk_remove_sort_entries"; sessionIds: string[] };

/** Legacy project dir (used for JSON migration path). */
export function getProjectDir(cwd: string): string {
  return path.join(os.homedir(), ".devstudio", "projects", cwd.replace(/\//g, "-"));
}

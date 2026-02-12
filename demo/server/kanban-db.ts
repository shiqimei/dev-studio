/**
 * DevStudio state persistence via SQLite.
 * Database stored at ~/.devstudio/data.db with atomic SQL operations.
 * Manages kanban board state and opened projects.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { log } from "./log.js";
import type { KanbanOp } from "./kanban.js";

const DB_DIR = path.join(os.homedir(), ".devstudio");
const DB_PATH = path.join(DB_DIR, "data.db");

let db: Database | null = null;

/** Broadcast-ready snapshot of kanban state (matches the wire format). */
export interface KanbanSnapshot {
  columnOverrides: Record<string, string>;
  sortOrders: Partial<Record<string, string[]>>;
  pendingPrompts: Record<string, string>;
  version: number;
}

// ── Initialization ──

function getDb(): Database {
  if (db) return db;

  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);

  // Performance: WAL mode for concurrent reads + writes
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS kanban_column_overrides (
      session_id  TEXT PRIMARY KEY,
      column_name TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS kanban_sort_orders (
      column_name TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      position    INTEGER NOT NULL,
      PRIMARY KEY (column_name, session_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS kanban_pending_prompts (
      session_id TEXT PRIMARY KEY,
      text       TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS kanban_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      path          TEXT NOT NULL UNIQUE,
      name          TEXT,
      is_active     INTEGER NOT NULL DEFAULT 0,
      position      INTEGER NOT NULL DEFAULT 0,
      added_at      TEXT NOT NULL DEFAULT (datetime('now')),
      last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Seed version if missing (backward compat: migrate from updated_at)
  const versionRow = db.query("SELECT value FROM kanban_meta WHERE key = 'version'").get() as {
    value: string;
  } | null;
  if (!versionRow) {
    db.run("INSERT INTO kanban_meta (key, value) VALUES ('version', '1')");
  }

  log.info({ path: DB_PATH }, "kanban-db: initialized");
  return db;
}

// ── Prepared statements (lazy) ──

let _stmts: ReturnType<typeof prepareStatements> | null = null;

function prepareStatements(d: Database) {
  return {
    upsertColumn: d.prepare(
      "INSERT INTO kanban_column_overrides (session_id, column_name) VALUES (?1, ?2) ON CONFLICT(session_id) DO UPDATE SET column_name = ?2",
    ),
    deleteColumn: d.prepare("DELETE FROM kanban_column_overrides WHERE session_id = ?"),
    deleteSortByColumn: d.prepare("DELETE FROM kanban_sort_orders WHERE column_name = ?"),
    insertSort: d.prepare(
      "INSERT INTO kanban_sort_orders (column_name, session_id, position) VALUES (?1, ?2, ?3)",
    ),
    upsertPrompt: d.prepare(
      "INSERT INTO kanban_pending_prompts (session_id, text) VALUES (?1, ?2) ON CONFLICT(session_id) DO UPDATE SET text = ?2",
    ),
    deletePrompt: d.prepare("DELETE FROM kanban_pending_prompts WHERE session_id = ?"),
  };
}

function stmts(): ReturnType<typeof prepareStatements> {
  if (!_stmts) _stmts = prepareStatements(getDb());
  return _stmts;
}

// ── Atomic operations ──

/** Increment the monotonic version counter and return the new value. */
function bumpVersion(): number {
  const d = getDb();
  const row = d.query("SELECT value FROM kanban_meta WHERE key = 'version'").get() as {
    value: string;
  } | null;
  const current = row ? parseInt(row.value, 10) : 0;
  const next = current + 1;
  d.run("INSERT OR REPLACE INTO kanban_meta (key, value) VALUES ('version', ?)", [String(next)]);
  return next;
}

/**
 * Apply a batch of kanban ops atomically in a single transaction.
 * Returns the new version number.
 */
export function applyKanbanOps(ops: KanbanOp[]): number {
  const d = getDb();
  const s = stmts();

  const run = d.transaction(() => {
    for (const op of ops) {
      switch (op.op) {
        case "set_column":
          s.upsertColumn.run(op.sessionId, op.column);
          break;
        case "remove_column":
          s.deleteColumn.run(op.sessionId);
          break;
        case "set_sort_order":
          s.deleteSortByColumn.run(op.column);
          for (let i = 0; i < op.order.length; i++) {
            s.insertSort.run(op.column, op.order[i], i);
          }
          break;
        case "set_pending_prompt":
          s.upsertPrompt.run(op.sessionId, op.text);
          break;
        case "remove_pending_prompt":
          s.deletePrompt.run(op.sessionId);
          break;
        case "bulk_set_columns":
          for (const entry of op.entries) {
            s.upsertColumn.run(entry.sessionId, entry.column);
          }
          break;
        case "bulk_remove_sort_entries": {
          if (op.sessionIds.length === 0) break;
          const placeholders = op.sessionIds.map(() => "?").join(",");
          d.run(
            `DELETE FROM kanban_sort_orders WHERE session_id IN (${placeholders})`,
            op.sessionIds,
          );
          break;
        }
      }
    }
    return bumpVersion();
  });

  return run();
}

/**
 * Remove all kanban data for sessions not in the valid set.
 * Returns true if anything changed.
 */
export function cleanStaleSessions(validSessionIds: Set<string>): boolean {
  const d = getDb();

  if (validSessionIds.size === 0) {
    // Edge case: no valid sessions → clear everything
    const changed = d.transaction(() => {
      const c1 = d.run("DELETE FROM kanban_column_overrides").changes;
      const c2 = d.run("DELETE FROM kanban_sort_orders").changes;
      const c3 = d.run("DELETE FROM kanban_pending_prompts").changes;
      if (c1 + c2 + c3 > 0) {
        bumpVersion();
        return true;
      }
      return false;
    })();
    return changed;
  }

  // Build a temp table with valid IDs for efficient NOT IN queries
  const changed = d.transaction(() => {
    d.run("CREATE TEMP TABLE IF NOT EXISTS _valid_ids (id TEXT PRIMARY KEY)");
    d.run("DELETE FROM _valid_ids");

    const ins = d.prepare("INSERT INTO _valid_ids (id) VALUES (?)");
    for (const id of validSessionIds) {
      ins.run(id);
    }

    const c1 = d.run(
      "DELETE FROM kanban_column_overrides WHERE session_id NOT IN (SELECT id FROM _valid_ids)",
    ).changes;
    const c2 = d.run(
      "DELETE FROM kanban_sort_orders WHERE session_id NOT IN (SELECT id FROM _valid_ids)",
    ).changes;
    const c3 = d.run(
      "DELETE FROM kanban_pending_prompts WHERE session_id NOT IN (SELECT id FROM _valid_ids)",
    ).changes;

    // Also clean up sort_orders columns that are now empty
    d.run(
      "DELETE FROM kanban_sort_orders WHERE column_name IN (SELECT DISTINCT column_name FROM kanban_sort_orders GROUP BY column_name HAVING COUNT(*) = 0)",
    );

    d.run("DROP TABLE IF EXISTS _valid_ids");

    if (c1 + c2 + c3 > 0) {
      bumpVersion();
      return true;
    }
    return false;
  })();

  return changed;
}

/**
 * Read the full kanban state as a snapshot (for broadcasting to clients).
 */
export function getKanbanSnapshot(): KanbanSnapshot {
  const d = getDb();

  // Column overrides
  const columnOverrides: Record<string, string> = {};
  const cols = d
    .query("SELECT session_id, column_name FROM kanban_column_overrides")
    .all() as Array<{ session_id: string; column_name: string }>;
  for (const row of cols) {
    columnOverrides[row.session_id] = row.column_name;
  }

  // Sort orders
  const sortOrders: Partial<Record<string, string[]>> = {};
  const sorts = d
    .query("SELECT column_name, session_id FROM kanban_sort_orders ORDER BY column_name, position")
    .all() as Array<{ column_name: string; session_id: string }>;
  for (const row of sorts) {
    if (!sortOrders[row.column_name]) sortOrders[row.column_name] = [];
    sortOrders[row.column_name]!.push(row.session_id);
  }

  // Pending prompts
  const pendingPrompts: Record<string, string> = {};
  const prompts = d
    .query("SELECT session_id, text FROM kanban_pending_prompts")
    .all() as Array<{ session_id: string; text: string }>;
  for (const row of prompts) {
    pendingPrompts[row.session_id] = row.text;
  }

  // Version
  const meta = d.query("SELECT value FROM kanban_meta WHERE key = 'version'").get() as {
    value: string;
  } | null;
  const version = meta ? parseInt(meta.value, 10) : 0;

  return { columnOverrides, sortOrders, pendingPrompts, version };
}

/**
 * Full-state overwrite (for legacy save_kanban_state and JSON migration).
 */
export function setKanbanState(state: Omit<KanbanSnapshot, "version">): void {
  const d = getDb();
  const s = stmts();

  d.transaction(() => {
    // Clear all existing data
    d.run("DELETE FROM kanban_column_overrides");
    d.run("DELETE FROM kanban_sort_orders");
    d.run("DELETE FROM kanban_pending_prompts");

    // Insert column overrides
    for (const [sessionId, column] of Object.entries(state.columnOverrides)) {
      s.upsertColumn.run(sessionId, column);
    }

    // Insert sort orders
    for (const [column, order] of Object.entries(state.sortOrders)) {
      if (!order) continue;
      for (let i = 0; i < order.length; i++) {
        s.insertSort.run(column, order[i], i);
      }
    }

    // Insert pending prompts
    for (const [sessionId, text] of Object.entries(state.pendingPrompts)) {
      s.upsertPrompt.run(sessionId, text);
    }

    bumpVersion();
  })();
}

/**
 * Ensure the database is initialized (creates file + tables if needed).
 * Safe to call multiple times. Must be called before any other operations.
 */
export function init(): void {
  getDb();
}

/**
 * Migrate existing JSON kanban state into SQLite (one-time on first boot).
 * Requires init() to have been called first.
 * Returns true if migration occurred.
 */
export function migrateFromJson(projectDir: string): boolean {
  const d = getDb();
  const jsonPath = path.join(projectDir, "kanban.json");

  // Check if DB already has data (skip migration)
  const count = d.query("SELECT COUNT(*) as n FROM kanban_column_overrides").get() as {
    n: number;
  };
  if (count.n > 0) {
    log.info("kanban-db: skipping JSON migration (DB already has data)");
    return false;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(jsonPath, "utf-8");
  } catch {
    log.info({ jsonPath }, "kanban-db: no kanban.json to migrate");
    return false;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    log.warn({ jsonPath, err: err.message }, "kanban-db: failed to parse kanban.json");
    return false;
  }

  if (parsed.version !== 1) {
    log.warn({ jsonPath, version: parsed.version }, "kanban-db: unsupported kanban.json version");
    return false;
  }

  setKanbanState({
    columnOverrides: parsed.columnOverrides ?? {},
    sortOrders: parsed.sortOrders ?? {},
    pendingPrompts: parsed.pendingPrompts ?? {},
  });

  log.info({ jsonPath }, "kanban-db: migrated from JSON");
  return true;
}

// ── Projects ──

export interface ProjectRow {
  id: number;
  path: string;
  name: string | null;
  is_active: number;
  position: number;
  added_at: string;
  last_opened_at: string;
}

export interface ProjectState {
  projects: string[];
  activeProject: string | null;
}

/** Read all projects ordered by position, returning the simplified state. */
export function getProjects(): ProjectState {
  const d = getDb();
  const rows = d
    .query("SELECT path, is_active FROM projects ORDER BY position ASC, id ASC")
    .all() as Array<{ path: string; is_active: number }>;
  const projects = rows.map((r) => r.path);
  const active = rows.find((r) => r.is_active === 1);
  return { projects, activeProject: active?.path ?? null };
}

/** Add a project. Derives `name` from the last path segment. Sets it as active. */
export function addProject(projectPath: string): ProjectState {
  const d = getDb();
  const name = path.basename(projectPath);
  const maxPos = d.query("SELECT COALESCE(MAX(position), -1) as m FROM projects").get() as {
    m: number;
  };

  d.transaction(() => {
    d.run("UPDATE projects SET is_active = 0");
    d.run(
      `INSERT INTO projects (path, name, is_active, position)
       VALUES (?1, ?2, 1, ?3)
       ON CONFLICT(path) DO UPDATE SET is_active = 1, last_opened_at = datetime('now')`,
      [projectPath, name, maxPos.m + 1],
    );
  })();

  return getProjects();
}

/** Remove a project by path. If it was active, activate the first remaining. */
export function removeProject(projectPath: string): ProjectState {
  const d = getDb();

  d.transaction(() => {
    const row = d.query("SELECT is_active FROM projects WHERE path = ?").get(projectPath) as {
      is_active: number;
    } | null;
    d.run("DELETE FROM projects WHERE path = ?", [projectPath]);

    if (row?.is_active === 1) {
      const first = d
        .query("SELECT id FROM projects ORDER BY position ASC, id ASC LIMIT 1")
        .get() as { id: number } | null;
      if (first) {
        d.run("UPDATE projects SET is_active = 1 WHERE id = ?", [first.id]);
      }
    }
  })();

  return getProjects();
}

/** Set a project as active (deactivates all others). */
export function setActiveProject(projectPath: string): ProjectState {
  const d = getDb();
  d.transaction(() => {
    d.run("UPDATE projects SET is_active = 0");
    d.run("UPDATE projects SET is_active = 1, last_opened_at = datetime('now') WHERE path = ?", [
      projectPath,
    ]);
  })();
  return getProjects();
}

/**
 * Migrate projects from the legacy state.json file into SQLite (one-time).
 * Returns true if migration occurred.
 */
export function migrateProjectsFromJson(): boolean {
  const d = getDb();

  // Skip if DB already has projects
  const count = d.query("SELECT COUNT(*) as n FROM projects").get() as { n: number };
  if (count.n > 0) {
    return false;
  }

  const stateFile = path.join(os.homedir(), ".devstudio", "state.json");
  let raw: string;
  try {
    raw = fs.readFileSync(stateFile, "utf-8");
  } catch {
    return false;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }

  const projects: string[] = Array.isArray(parsed.projects) ? parsed.projects : [];
  const activeProject: string | null = parsed.activeProject ?? null;

  if (projects.length === 0) return false;

  d.transaction(() => {
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i];
      const name = path.basename(p);
      const isActive = p === activeProject ? 1 : 0;
      d.run(
        "INSERT OR IGNORE INTO projects (path, name, is_active, position) VALUES (?, ?, ?, ?)",
        [p, name, isActive, i],
      );
    }
  })();

  log.info({ stateFile, count: projects.length }, "projects: migrated from state.json");
  return true;
}

/**
 * Seed the projects table with the current working directory if empty.
 */
export function seedProjectsFromCwd(): void {
  const d = getDb();
  const count = d.query("SELECT COUNT(*) as n FROM projects").get() as { n: number };
  if (count.n > 0) return;

  const cwd = process.env.ACP_CWD || process.cwd();
  const name = path.basename(cwd);
  d.run("INSERT INTO projects (path, name, is_active, position) VALUES (?, ?, 1, 0)", [cwd, name]);
  log.info({ cwd }, "projects: seeded from cwd");
}

/**
 * Close the database connection (for clean shutdown).
 */
export function close(): void {
  if (db) {
    db.close();
    db = null;
    _stmts = null;
  }
}

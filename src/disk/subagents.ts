/**
 * Scan subagent directories for a given session.
 * No SDK dependencies — pure filesystem access.
 */
import * as fs from "node:fs";
import { getSubagentsDir, getSessionJsonlPath, getSubagentJsonlPath } from "./paths.js";
import type { SubagentMeta, SubagentType } from "./types.js";

/** Internal agent filename patterns to filter out. */
const INTERNAL_PATTERNS = ["compact", "prompt_suggestion"];

/**
 * Extract the task prompt from a JSONL entry's message content.
 * Returns the first 120 characters of the text content.
 */
function extractTaskPrompt(entry: any): string {
  const content = entry?.message?.content;
  if (!content) return "";
  if (typeof content === "string") return content.slice(0, 120);
  if (Array.isArray(content)) {
    const textBlock = content.find((c: any) => c.type === "text");
    return (textBlock?.text ?? "").slice(0, 120);
  }
  return "";
}

/** Map raw subagent_type string from Task tool input to our SubagentType. */
function normalizeSubagentType(raw: string): SubagentType {
  switch (raw.toLowerCase()) {
    case "explore":
      return "explore";
    case "plan":
      return "plan";
    case "bash":
      return "bash";
    case "general-purpose":
      return "code";
    default:
      return "agent";
  }
}

/**
 * Scan any JSONL file for Task tool calls and extract the spawned agent IDs + types.
 * Single-pass: collects tool_use and tool_result entries simultaneously.
 * Returns array of { agentId, type }.
 */
async function scanJsonlForTaskSpawns(jsonlPath: string): Promise<{ agentId: string; type: SubagentType }[]> {
  const results: { agentId: string; type: SubagentType }[] = [];

  try {
    const raw = await fs.promises.readFile(jsonlPath, "utf-8");

    const taskTypeByToolId = new Map<string, string>();
    // Deferred tool_results whose tool_use hasn't been seen yet (rare but possible with streaming)
    const pendingResults: { toolUseId: string; resultText: string }[] = [];
    const agentIdRe = /agentId:\s*([a-f0-9]+)/;

    // Iterate lines without creating intermediate array (same pattern as parseJsonlFile)
    let lineStart = 0;
    while (lineStart < raw.length) {
      const lineEnd = raw.indexOf("\n", lineStart);
      const end = lineEnd === -1 ? raw.length : lineEnd;
      if (end <= lineStart) { lineStart = end + 1; continue; }
      const line = raw.substring(lineStart, end);
      lineStart = end + 1;
      try {
        const entry = JSON.parse(line);
        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;

        if (entry.type === "assistant") {
          for (const block of content) {
            if (block.type === "tool_use" && block.name === "Task" && block.input?.subagent_type) {
              taskTypeByToolId.set(block.id, block.input.subagent_type);
            }
          }
        } else if (entry.type === "user") {
          for (const block of content) {
            if (block.type !== "tool_result") continue;
            const subagentType = taskTypeByToolId.get(block.tool_use_id);

            // Extract agentId from result text
            let resultText = "";
            const rc = block.content;
            if (typeof rc === "string") {
              resultText = rc;
            } else if (Array.isArray(rc)) {
              for (const rb of rc) {
                if (rb?.type === "text") resultText += rb.text ?? "";
              }
            }

            if (subagentType) {
              const match = agentIdRe.exec(resultText);
              if (match) {
                results.push({ agentId: match[1], type: normalizeSubagentType(subagentType) });
                taskTypeByToolId.delete(block.tool_use_id);
              }
            } else if (resultText.includes("agentId:")) {
              // tool_use not seen yet — defer
              pendingResults.push({ toolUseId: block.tool_use_id, resultText });
            }
          }
        }
      } catch { /* skip */ }
    }

    // Resolve any deferred results
    for (const pending of pendingResults) {
      const subagentType = taskTypeByToolId.get(pending.toolUseId);
      if (!subagentType) continue;
      const match = agentIdRe.exec(pending.resultText);
      if (match) {
        results.push({ agentId: match[1], type: normalizeSubagentType(subagentType) });
      }
    }
  } catch {
    // JSONL missing or unreadable
  }

  return results;
}

/**
 * Detect agent type from a subagent's own JSONL content.
 * Used as a fallback when parent session scanning fails (e.g., after context compression).
 *
 * Heuristic: read the first few lines to find the model field in the first assistant message.
 * - Haiku models → "explore" (Explore agents always use haiku)
 * - Otherwise → "agent" (cannot reliably distinguish plan/code without parent context)
 */
async function detectTypeFromSubagentJsonl(jsonlPath: string): Promise<SubagentType> {
  try {
    const fh = await fs.promises.open(jsonlPath, "r");
    try {
    // Read enough to cover the first few JSONL entries
    const buf = Buffer.alloc(16384);
    const { bytesRead } = await fh.read(buf, 0, 16384, 0);

    const chunk = buf.toString("utf-8", 0, bytesRead);
    for (const line of chunk.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "assistant") continue;
        const model: string = entry.message?.model ?? "";
        if (model.includes("haiku")) return "explore";
        // Non-haiku model found — can't distinguish plan vs code, stop looking
        break;
      } catch { /* skip malformed line */ }
    }
    } finally { await fh.close(); }
  } catch { /* file unreadable */ }
  return "agent";
}

/**
 * Build a hierarchy map: agentId → { type, parentAgentId? }
 *
 * 1. Scan parent session JSONL → get direct-child agent IDs
 * 2. Any agent in the directory but NOT a direct child is an "orphan"
 * 3. Scan each direct child's JSONL to find which orphans they spawned
 * 4. Iterate for deeper nesting until all orphans resolved or no progress
 * 5. For remaining orphans, detect type from their own JSONL content (model heuristic)
 */
async function buildAgentHierarchy(
  projectDir: string,
  sessionId: string,
  allAgentIds: string[],
): Promise<Map<string, { type: SubagentType; parentAgentId?: string }>> {
  const map = new Map<string, { type: SubagentType; parentAgentId?: string }>();

  // Step 1: scan parent session JSONL for direct children
  const parentPath = getSessionJsonlPath(projectDir, sessionId);
  const directSpawns = await scanJsonlForTaskSpawns(parentPath);
  const directChildIds = new Set<string>();

  for (const spawn of directSpawns) {
    directChildIds.add(spawn.agentId);
    map.set(spawn.agentId, { type: spawn.type });
  }

  // Step 2: identify orphans (in directory but not direct children)
  const allIdSet = new Set(allAgentIds);
  let orphanIds = new Set<string>();
  for (const id of allIdSet) {
    if (!directChildIds.has(id)) {
      orphanIds.add(id);
    }
  }

  if (orphanIds.size === 0) return map;

  // Step 3: iteratively scan child JSONLs to resolve orphans
  // Start with direct children, then expand to newly-discovered parents
  // Scan all parents at each level in parallel
  let parentsToScan = [...directChildIds];

  while (orphanIds.size > 0 && parentsToScan.length > 0) {
    const nextParents: string[] = [];

    const scanResults = await Promise.all(
      parentsToScan.map(async (parentId) => {
        const childJsonlPath = getSubagentJsonlPath(projectDir, sessionId, parentId);
        const childSpawns = await scanJsonlForTaskSpawns(childJsonlPath);
        return { parentId, childSpawns };
      }),
    );

    for (const { parentId, childSpawns } of scanResults) {
      for (const spawn of childSpawns) {
        if (orphanIds.has(spawn.agentId)) {
          map.set(spawn.agentId, { type: spawn.type, parentAgentId: parentId });
          orphanIds.delete(spawn.agentId);
          nextParents.push(spawn.agentId);
        }
      }
    }

    parentsToScan = nextParents;
  }

  // Any remaining orphans: detect type from their own JSONL content in parallel
  const orphanDetections = await Promise.all(
    [...orphanIds].filter((id) => !map.has(id)).map(async (id) => {
      const orphanJsonlPath = getSubagentJsonlPath(projectDir, sessionId, id);
      const detectedType = await detectTypeFromSubagentJsonl(orphanJsonlPath);
      return { id, detectedType };
    }),
  );
  for (const { id, detectedType } of orphanDetections) {
    map.set(id, { type: detectedType });
  }

  return map;
}

/**
 * Convert a flat list of SubagentMeta (with parentAgentId) into a tree.
 * Returns only root-level agents; children are nested under their parents.
 */
export function buildSubagentTree(agents: SubagentMeta[]): SubagentMeta[] {
  const byId = new Map<string, SubagentMeta>();
  for (const a of agents) {
    // Clone to avoid mutating the original and ensure children array exists
    byId.set(a.agentId, { ...a, children: [] });
  }

  const roots: SubagentMeta[] = [];

  for (const agent of byId.values()) {
    if (agent.parentAgentId && byId.has(agent.parentAgentId)) {
      byId.get(agent.parentAgentId)!.children!.push(agent);
    } else {
      roots.push(agent);
    }
  }

  // Strip empty children arrays for cleanliness
  function stripEmpty(nodes: SubagentMeta[]) {
    for (const n of nodes) {
      if (n.children && n.children.length === 0) {
        delete n.children;
      } else if (n.children) {
        stripEmpty(n.children);
      }
    }
  }
  stripEmpty(roots);

  return roots;
}

/**
 * Read team metadata from the first line of a session's JSONL (async).
 * Teammate sessions have `teamName` and `agentName`; team leaders have `teamName` only.
 * Returns null if the session is not part of a team.
 */
export async function readSessionTeamInfo(
  projectDir: string,
  sessionId: string,
): Promise<{ teamName: string; agentName?: string } | null> {
  const jsonlPath = getSessionJsonlPath(projectDir, sessionId);
  try {
    const fh = await fs.promises.open(jsonlPath, "r");
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, 8192, 0);

      const chunk = buf.toString("utf-8", 0, bytesRead);
      const firstLine = chunk.split("\n")[0];
      if (!firstLine) return null;

      const entry = JSON.parse(firstLine);
      if (!entry.teamName) return null;

      return {
        teamName: entry.teamName,
        ...(entry.agentName ? { agentName: entry.agentName } : {}),
      };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * Check if a session is a team leader by scanning its JSONL for TeamCreate tool calls.
 * Returns the team_name if found, null otherwise.
 * Only called as a fallback when teammates exist but no leader was detected via first-line metadata.
 */
export async function findTeamCreateInSession(projectDir: string, sessionId: string): Promise<string | null> {
  const jsonlPath = getSessionJsonlPath(projectDir, sessionId);
  try {
    const raw = await fs.promises.readFile(jsonlPath, "utf-8");
    if (!raw.includes('"TeamCreate"')) return null;

    // Iterate lines without creating intermediate array
    let lineStart = 0;
    while (lineStart < raw.length) {
      const lineEnd = raw.indexOf("\n", lineStart);
      const end = lineEnd === -1 ? raw.length : lineEnd;
      if (end > lineStart) {
        const line = raw.substring(lineStart, end);
        if (line.includes('"TeamCreate"')) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === "assistant") {
              const content = entry.message?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "tool_use" && block.name === "TeamCreate" && block.input?.team_name) {
                    return block.input.team_name;
                  }
                }
              }
            }
          } catch { /* skip malformed lines */ }
        }
      }
      lineStart = end + 1;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Reads subagent metadata for a given session.
 * Scans {projectDir}/{sessionId}/subagents/ for agent-*.jsonl files,
 * reads the first line of each to extract metadata.
 * Resolves agent type and parent relationships from JSONL Task tool invocations.
 * Filters out internal agents (compact, prompt_suggestion).
 * Returns results sorted by timestamp ascending.
 */
export async function readSubagents(projectDir: string, sessionId: string): Promise<SubagentMeta[]> {
  const dir = getSubagentsDir(projectDir, sessionId);
  try {
    let files: string[];
    try {
      files = (await fs.promises.readdir(dir)).filter(
        (f) => f.startsWith("agent-") && f.endsWith(".jsonl"),
      );
    } catch {
      return []; // directory doesn't exist
    }

    // Collect all agent IDs and basic metadata in parallel
    const agentEntries = (await Promise.all(
      files
        .filter((filename) => !INTERNAL_PATTERNS.some((p) => filename.includes(p)))
        .map(async (filename) => {
          const filePath = `${dir}/${filename}`;
          try {
            const fh = await fs.promises.open(filePath, "r");
            try {
              const buf = Buffer.alloc(8192);
              const { bytesRead } = await fh.read(buf, 0, 8192, 0);
              const chunk = buf.toString("utf-8", 0, bytesRead);
              const firstLine = chunk.split("\n")[0];
              if (!firstLine) return null;

              const entry = JSON.parse(firstLine);
              const agentId = entry.agentId ?? filename.replace(/^agent-/, "").replace(/\.jsonl$/, "");
              const timestamp = entry.timestamp ?? "";
              const taskPrompt = extractTaskPrompt(entry);
              return { agentId, filename, timestamp, taskPrompt };
            } finally {
              await fh.close();
            }
          } catch {
            return null; // Skip malformed files
          }
        }),
    )).filter((e): e is NonNullable<typeof e> => e !== null);

    // Build hierarchy map (agentId → { type, parentAgentId? })
    const allAgentIds = agentEntries.map((e) => e.agentId);
    const hierarchy = await buildAgentHierarchy(projectDir, sessionId, allAgentIds);

    const results: SubagentMeta[] = agentEntries.map((e) => {
      const info = hierarchy.get(e.agentId);
      return {
        agentId: e.agentId,
        parentSessionId: sessionId,
        filename: e.filename,
        timestamp: e.timestamp,
        taskPrompt: e.taskPrompt,
        agentType: info?.type ?? "agent",
        ...(info?.parentAgentId ? { parentAgentId: info.parentAgentId } : {}),
      };
    });

    return results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch {
    return [];
  }
}

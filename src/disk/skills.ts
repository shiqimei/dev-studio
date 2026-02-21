/**
 * Skills — read from ~/.claude/skills/ (human-authored) and ~/.devstudio/skills/ (agent-authored).
 *
 * Rung 2: readSkills / listSkillNames — read-only, human-maintained.
 * Rung 3: createDevStudioSkill / readDevStudioSkills — writable by agents.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getSkillsDir, getDevStudioSkillsDir } from "./paths.js";

export interface SkillInfo {
  name: string;
  path: string;
  hasSkillMd: boolean;
  /** "claude" for ~/.claude/skills/, "devstudio" for ~/.devstudio/skills/ */
  source?: "claude" | "devstudio";
}

// ---------------------------------------------------------------------------
// Rung 2: Read-only skills from ~/.claude/skills/
// ---------------------------------------------------------------------------

export async function readSkills(): Promise<SkillInfo[]> {
  const dir = getSkillsDir();
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const results = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const skillPath = path.join(dir, e.name);
          let hasSkillMd = false;
          try {
            await fs.promises.access(path.join(skillPath, "skill.md"));
            hasSkillMd = true;
          } catch { /* doesn't exist */ }
          return { name: e.name, path: skillPath, hasSkillMd, source: "claude" as const };
        }),
    );
    return results;
  } catch {
    return [];
  }
}

export async function listSkillNames(): Promise<string[]> {
  const dir = getSkillsDir();
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Rung 3: Agent-writable skills in ~/.devstudio/skills/
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Create or overwrite a skill in ~/.devstudio/skills/{name}/skill.md */
export async function createDevStudioSkill(name: string, content: string): Promise<string> {
  if (!SLUG_RE.test(name)) {
    throw new Error(
      `Invalid skill name "${name}". Must be lowercase alphanumeric with hyphens/underscores, 1-63 chars.`,
    );
  }
  if (!content.trim()) {
    throw new Error("Skill content must not be empty.");
  }
  const skillDir = path.join(getDevStudioSkillsDir(), name);
  await fs.promises.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "skill.md");
  await fs.promises.writeFile(skillPath, content, "utf8");
  return skillPath;
}

/** Read all agent-authored skills from ~/.devstudio/skills/ */
export async function readDevStudioSkills(): Promise<SkillInfo[]> {
  const dir = getDevStudioSkillsDir();
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const results = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const skillPath = path.join(dir, e.name);
          let hasSkillMd = false;
          try {
            await fs.promises.access(path.join(skillPath, "skill.md"));
            hasSkillMd = true;
          } catch { /* doesn't exist */ }
          return { name: e.name, path: skillPath, hasSkillMd, source: "devstudio" as const };
        }),
    );
    return results;
  } catch {
    return [];
  }
}

/** List names of agent-authored skills */
export async function listDevStudioSkillNames(): Promise<string[]> {
  const dir = getDevStudioSkillsDir();
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

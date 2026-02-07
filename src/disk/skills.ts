/**
 * Reader for ~/.claude/skills/ directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getSkillsDir } from "./paths.js";

export interface SkillInfo {
  name: string;
  path: string;
  hasSkillMd: boolean;
}

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
          return { name: e.name, path: skillPath, hasSkillMd };
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

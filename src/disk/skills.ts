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

export function readSkills(): SkillInfo[] {
  const dir = getSkillsDir();
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const skillPath = path.join(dir, e.name);
        const hasSkillMd = fs.existsSync(path.join(skillPath, "skill.md"));
        return { name: e.name, path: skillPath, hasSkillMd };
      });
  } catch {
    return [];
  }
}

export function listSkillNames(): string[] {
  const dir = getSkillsDir();
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

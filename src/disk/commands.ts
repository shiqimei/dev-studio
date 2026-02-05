/**
 * Reader for ~/.claude/commands/*.md.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getCommandsDir } from "./paths.js";

export interface CommandDefinition {
  name: string;
  content: string;
}

export function readCommands(): CommandDefinition[] {
  const dir = getCommandsDir();
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    return files.map((file) => ({
      name: file.replace(/\.md$/, ""),
      content: fs.readFileSync(path.join(dir, file), "utf-8"),
    }));
  } catch {
    return [];
  }
}

export function listCommandNames(): string[] {
  const dir = getCommandsDir();
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

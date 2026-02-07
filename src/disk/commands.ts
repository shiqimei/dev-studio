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

export async function readCommands(): Promise<CommandDefinition[]> {
  const dir = getCommandsDir();
  try {
    const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".md"));
    const results = await Promise.all(
      files.map(async (file) => ({
        name: file.replace(/\.md$/, ""),
        content: await fs.promises.readFile(path.join(dir, file), "utf-8"),
      })),
    );
    return results;
  } catch {
    return [];
  }
}

export async function listCommandNames(): Promise<string[]> {
  const dir = getCommandsDir();
  try {
    return (await fs.promises.readdir(dir))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

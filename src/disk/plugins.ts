/**
 * Reader for ~/.claude/plugins/installed_plugins.json.
 */
import * as fs from "node:fs";
import { getPluginsPath } from "./paths.js";

export interface PluginInstallation {
  scope: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha?: string;
}

export interface InstalledPlugins {
  version: number;
  plugins: Record<string, PluginInstallation[]>;
}

export async function readInstalledPlugins(): Promise<InstalledPlugins | null> {
  try {
    const raw = await fs.promises.readFile(getPluginsPath(), "utf-8");
    return JSON.parse(raw) as InstalledPlugins;
  } catch {
    return null;
  }
}

export async function listPluginNames(): Promise<string[]> {
  const data = await readInstalledPlugins();
  if (!data) return [];
  return Object.keys(data.plugins);
}

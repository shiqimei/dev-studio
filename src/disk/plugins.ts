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

export function readInstalledPlugins(): InstalledPlugins | null {
  try {
    const raw = fs.readFileSync(getPluginsPath(), "utf-8");
    return JSON.parse(raw) as InstalledPlugins;
  } catch {
    return null;
  }
}

export function listPluginNames(): string[] {
  const data = readInstalledPlugins();
  if (!data) return [];
  return Object.keys(data.plugins);
}

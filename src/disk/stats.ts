/**
 * Reader for ~/.claude/stats-cache.json.
 */
import * as fs from "node:fs";
import { getStatsCachePath } from "./paths.js";

export interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface StatsCache {
  version: number;
  lastComputedDate: string;
  dailyActivity: DailyActivity[];
}

export async function readStatsCache(): Promise<StatsCache | null> {
  try {
    const raw = await fs.promises.readFile(getStatsCachePath(), "utf-8");
    return JSON.parse(raw) as StatsCache;
  } catch {
    return null;
  }
}

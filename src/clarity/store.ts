import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.ts";
import type { Snapshot } from "./types.ts";

/**
 * Append-only JSONL time series of Clarity snapshots.
 *
 * This file is the reason the system works at all. The API only looks back 1-3
 * days and only answers 10 times a day, so trend detection ("rage clicks on
 * /checkout tripled this week") is impossible against the API directly, it is
 * only possible against an accumulated local history. Every analysis reads from
 * here; nothing but `snapshot` touches the network.
 */

function storePath(): string {
  return resolve(config.dataDir, "snapshots.jsonl");
}

export function append(snapshot: Snapshot): void {
  mkdirSync(config.dataDir, { recursive: true });
  appendFileSync(storePath(), JSON.stringify(snapshot) + "\n");
}

export function readAll(): Snapshot[] {
  const path = storePath();
  if (!existsSync(path)) return [];
  const out: Snapshot[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Snapshot);
    } catch {
      // One corrupt line shouldn't discard the whole history.
      console.warn("[store] skipping malformed snapshot line");
    }
  }
  return out;
}

/** Most recent snapshot, or undefined if we've never pulled. */
export function latest(): Snapshot | undefined {
  const all = readAll();
  return all.length ? all[all.length - 1] : undefined;
}

/**
 * The snapshot closest to `daysAgo` days before now, the baseline the outer
 * loop compares against when deciding whether a shipped fix actually worked.
 */
export function nearest(daysAgo: number): Snapshot | undefined {
  const all = readAll();
  if (!all.length) return undefined;
  const target = Date.now() - daysAgo * 86_400_000;
  let best = all[0]!;
  let bestDelta = Math.abs(Date.parse(best.fetchedAt) - target);
  for (const snapshot of all) {
    const delta = Math.abs(Date.parse(snapshot.fetchedAt) - target);
    if (delta < bestDelta) {
      best = snapshot;
      bestDelta = delta;
    }
  }
  return best;
}

export function count(): number {
  return readAll().length;
}

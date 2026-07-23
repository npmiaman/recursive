import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.ts";
import type { Incident, Signal } from "./types.ts";

/**
 * Per-project storage. Every path is scoped by project id, there is no function
 * here that reads across projects, which is the structural half of tenant
 * isolation (ARCHITECTURE.md §4).
 */

function projectDir(projectId: string): string {
  // Guard against a project id escaping its directory.
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = resolve(config.dataDir, "projects", safe);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* one bad line must not discard the history */
    }
  }
  return out;
}

// ---------------------------------------------------------------- signals

export function appendSignals(projectId: string, signals: Signal[]): void {
  if (signals.length === 0) return;
  const path = resolve(projectDir(projectId), "signals.jsonl");
  appendFileSync(path, signals.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

export function readSignals(projectId: string, sinceMs?: number): Signal[] {
  const all = readJsonl<Signal>(resolve(projectDir(projectId), "signals.jsonl"));
  if (sinceMs === undefined) return all;
  const cutoff = Date.now() - sinceMs;
  return all.filter((s) => Date.parse(s.at) >= cutoff);
}

// ---------------------------------------------------------------- releases

export interface Release {
  id: string;
  projectId: string;
  at: string;
  /** Commit sha, if known, needed for rollback. */
  sha?: string;
  /** The release this superseded, i.e. the rollback target. */
  previous?: string;
  note?: string;
}

export function recordRelease(release: Release): void {
  appendFileSync(
    resolve(projectDir(release.projectId), "releases.jsonl"),
    JSON.stringify(release) + "\n",
  );
}

export function readReleases(projectId: string): Release[] {
  return readJsonl<Release>(resolve(projectDir(projectId), "releases.jsonl")).sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  );
}

export function latestRelease(projectId: string): Release | undefined {
  const all = readReleases(projectId);
  return all[all.length - 1];
}

// ---------------------------------------------------------------- incidents

export function readIncidents(projectId: string): Incident[] {
  const path = resolve(projectDir(projectId), "incidents.json");
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Incident[];
  } catch {
    return [];
  }
}

export function writeIncidents(projectId: string, incidents: Incident[]): void {
  writeFileSync(
    resolve(projectDir(projectId), "incidents.json"),
    JSON.stringify(incidents, null, 2),
  );
}

export function upsertIncident(projectId: string, incident: Incident): void {
  const all = readIncidents(projectId).filter((i) => i.id !== incident.id);
  all.push(incident);
  writeIncidents(projectId, all);
}

// ---------------------------------------------------------------- audit

export interface AuditRecord {
  at: string;
  projectId: string;
  /** What happened. */
  action: string;
  /** Which incident prompted it. */
  incidentId?: string;
  /** Who or what authorised it. */
  actor: "autonomous" | "human" | "system";
  /** Evidence and reasoning, so the decision can be reviewed later. */
  detail: Record<string, unknown>;
  outcome: "executed" | "blocked" | "failed" | "reverted";
}

/**
 * Append-only. If Recursive touched a customer's production there is an
 * immutable record of what, why, on what evidence, and under whose authority
 * (ARCHITECTURE.md §3). Never rewritten, never compacted in place.
 */
export function audit(record: AuditRecord): void {
  appendFileSync(
    resolve(projectDir(record.projectId), "audit.jsonl"),
    JSON.stringify(record) + "\n",
  );
}

export function readAudit(projectId: string): AuditRecord[] {
  return readJsonl<AuditRecord>(resolve(projectDir(projectId), "audit.jsonl"));
}

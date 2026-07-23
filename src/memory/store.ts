import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.ts";
import type {
  AttemptRecord,
  CausalLink,
  ChangeRecord,
  FailureRecord,
  MemoryRecord,
  OutcomeRecord,
} from "./types.ts";

/**
 * The memory store. One database per project.
 *
 * APPEND-ONLY BY CONSTRUCTION. There is no delete or update function in this
 * file, and none should ever be added. A memory you can prune is a memory you
 * will eventually prune wrongly, usually the week before the same bug returns.
 * Corrections are expressed by appending a newer record, never by editing an
 * older one, so the history of what we believed stays intact and auditable.
 *
 * `node:sqlite` is built into Node: real indexes and queries, no dependency, and
 * a single file per project that is trivial to back up.
 */

const databases = new Map<string, DatabaseSync>();

function open(projectId: string): DatabaseSync {
  const cached = databases.get(projectId);
  if (cached) return cached;

  const dir = resolve(config.dataDir, "memory");
  mkdirSync(dir, { recursive: true });
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, "_");

  const db = new DatabaseSync(resolve(dir, `${safe}.db`));

  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS records (
 id          TEXT PRIMARY KEY,
 type        TEXT NOT NULL,
 at          TEXT NOT NULL,
      -- Denormalised for indexing; the full record lives in payload.
 fingerprint TEXT,
 route       TEXT,
 signal_class TEXT,
 failure_id  TEXT,
 change_ref  TEXT,
      -- File path for file-knowledge records. A dedicated column rather than a
      -- LIKE over the JSON payload: LIKE '%path%' also matches every record that
      -- merely IMPORTS that file, which silently returns the wrong file's data.
 path        TEXT,
 payload     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_type_at      ON records(type, at DESC);
    CREATE INDEX IF NOT EXISTS idx_fingerprint  ON records(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_failure      ON records(failure_id);
    CREATE INDEX IF NOT EXISTS idx_route        ON records(route);
    CREATE INDEX IF NOT EXISTS idx_path         ON records(path, at DESC);

    -- Files touched by a record, for overlap matching. Separate table so a
    -- "which past failures involved this file?" query is an index hit rather
    -- than a scan over JSON.
    CREATE TABLE IF NOT EXISTS record_files (
 record_id TEXT NOT NULL,
 path      TEXT NOT NULL,
 role      TEXT NOT NULL,   -- 'implicated' | 'changed'
      PRIMARY KEY (record_id, path, role)
    );
    CREATE INDEX IF NOT EXISTS idx_files_path ON record_files(path);

    -- Full-text over failure messages and reasoning, for lexical similarity.
    CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
 id UNINDEXED, text, tokenize = 'porter'
    );
  `);

  databases.set(projectId, db);
  return db;
}

/** Text a record contributes to the full-text index. */
function searchableText(record: MemoryRecord): string {
  switch (record.type) {
    case "failure":
      return [record.message, record.signalClass, record.route, record.evidence?.slice(0, 2000)]
        .filter(Boolean)
        .join(" ");
    case "attempt":
      return [record.hypothesis, record.approach, record.rationale, record.whyItFailed]
        .filter(Boolean)
        .join(" ");
    case "causal":
      return record.lesson;
    case "change":
      return [record.subject, ...record.files].join(" ");
    case "outcome":
      return record.note;
    case "file-knowledge":
      // Path, purpose and domain concepts. The summary is the important part:
      // it is what lets a bug report worded in business terms reach a file
      // written in technical ones.
      return [
        record.path,
        record.summary,
        record.concepts?.join(" "),
        record.impact,
        record.exports.join(" "),
      ]
        .filter(Boolean)
        .join(" ");
    default:
      return "";
  }
}

/**
 * Append a record. The ONLY write path in this module.
 * Ids are generated here so a caller cannot overwrite an existing record by
 * reusing one, the primary key makes that a hard error rather than a silent
 * mutation.
 */
export function append<T extends MemoryRecord>(record: Omit<T, "id"> & { id?: string }): T {
  const db = open(record.projectId);
  const full = { ...record, id: record.id ?? randomUUID() } as T;

  const asAny = full as unknown as Record<string, unknown>;

  db.prepare(
    `INSERT OR IGNORE INTO records
       (id, type, at, fingerprint, route, signal_class, failure_id, change_ref, path, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    full.id,
    full.type,
    full.at,
    (asAny["fingerprint"] as string) ?? null,
    (asAny["route"] as string) ?? null,
    (asAny["signalClass"] as string) ?? null,
    (asAny["failureId"] as string) ?? null,
    (asAny["changeRef"] as string) ?? (asAny["ref"] as string) ?? null,
    full.type === "file-knowledge" ? (asAny["path"] as string) : null,
    JSON.stringify(full),
  );

  const files = (asAny["implicatedFiles"] as string[]) ?? [];
  const changed = (asAny["filesChanged"] as string[]) ?? (asAny["files"] as string[]) ?? [];
  const insertFile = db.prepare(
    `INSERT OR IGNORE INTO record_files (record_id, path, role) VALUES (?, ?, ?)`,
  );
  for (const path of files) insertFile.run(full.id, path, "implicated");
  for (const path of changed) insertFile.run(full.id, path, "changed");

  const text = searchableText(full);
  if (text.trim()) {
    db.prepare(`INSERT INTO records_fts (id, text) VALUES (?, ?)`).run(full.id, text);
  }

  return full;
}

function parse<T extends MemoryRecord>(row: unknown): T {
  return JSON.parse(String((row as Record<string, unknown>)["payload"])) as T;
}

export function getFailure(projectId: string, failureId: string): FailureRecord | undefined {
  const row = open(projectId)
    .prepare(`SELECT payload FROM records WHERE id = ? AND type = 'failure'`)
    .get(failureId);
  return row ? parse<FailureRecord>(row) : undefined;
}

/** Every past occurrence of this exact defect. The strongest possible match. */
export function failuresByFingerprint(projectId: string, fingerprint: string): FailureRecord[] {
  return open(projectId)
    .prepare(
      `SELECT payload FROM records WHERE type = 'failure' AND fingerprint = ? ORDER BY at DESC`,
    )
    .all(fingerprint)
    .map((r) => parse<FailureRecord>(r));
}

export function failuresOnRoute(projectId: string, route: string, limit = 20): FailureRecord[] {
  return open(projectId)
    .prepare(
      `SELECT payload FROM records WHERE type = 'failure' AND route = ? ORDER BY at DESC LIMIT ?`,
    )
    .all(route, limit)
    .map((r) => parse<FailureRecord>(r));
}

/** Past failures that involved any of these files, the code-overlap matcher. */
export function failuresTouchingFiles(
  projectId: string,
  paths: string[],
  limit = 30,
): { failure: FailureRecord; sharedFiles: string[] }[] {
  if (paths.length === 0) return [];
  const db = open(projectId);

  const placeholders = paths.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT r.payload AS payload, GROUP_CONCAT(f.path) AS shared
       FROM record_files f
       JOIN records r ON r.id = f.record_id
       WHERE f.path IN (${placeholders}) AND r.type = 'failure'
       GROUP BY r.id
       ORDER BY COUNT(f.path) DESC
       LIMIT ?`,
    )
    .all(...paths, limit);

  return rows.map((row) => ({
    failure: parse<FailureRecord>(row),
    sharedFiles: String((row as Record<string, unknown>)["shared"] ?? "").split(","),
  }));
}

/** Lexical similarity over failure text and past reasoning. */
export function searchText(
  projectId: string,
  query: string,
  limit = 20,
): { id: string; rank: number }[] {
  const db = open(projectId);
  // FTS5 treats punctuation as syntax; strip it so an error message doesn't
  // become a malformed query and throw.
  const safe = query
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 30)
    .join(" OR ");
  if (!safe) return [];

  try {
    return db
      .prepare(`SELECT id, rank FROM records_fts WHERE records_fts MATCH ? ORDER BY rank LIMIT ?`)
      .all(safe, limit)
      .map((r) => {
        const row = r as Record<string, unknown>;
        return { id: String(row["id"]), rank: Number(row["rank"]) };
      });
  } catch {
    return [];
  }
}

export function attemptsFor(projectId: string, failureId: string): AttemptRecord[] {
  return open(projectId)
    .prepare(
      `SELECT payload FROM records WHERE type = 'attempt' AND failure_id = ? ORDER BY at ASC`,
    )
    .all(failureId)
    .map((r) => parse<AttemptRecord>(r));
}

export function outcomeFor(projectId: string, failureId: string): OutcomeRecord | undefined {
  const row = open(projectId)
    .prepare(
      `SELECT payload FROM records WHERE type = 'outcome' AND failure_id = ? ORDER BY at DESC LIMIT 1`,
    )
    .get(failureId);
  return row ? parse<OutcomeRecord>(row) : undefined;
}

export function causalFor(projectId: string, failureId: string): CausalLink | undefined {
  const row = open(projectId)
    .prepare(
      `SELECT payload FROM records WHERE type = 'causal' AND failure_id = ? ORDER BY at DESC LIMIT 1`,
    )
    .get(failureId);
  return row ? parse<CausalLink>(row) : undefined;
}

/** Accumulated lessons, most-trusted first, the distilled form of the memory. */
export function lessons(projectId: string, limit = 50): CausalLink[] {
  return open(projectId)
    .prepare(`SELECT payload FROM records WHERE type = 'causal' ORDER BY at DESC LIMIT ?`)
    .all(limit)
    .map((r) => parse<CausalLink>(r))
    .sort((a, b) => b.confidence - a.confidence);
}

export function recordById(projectId: string, id: string): MemoryRecord | undefined {
  const row = open(projectId).prepare(`SELECT payload FROM records WHERE id = ?`).get(id);
  return row ? parse<MemoryRecord>(row) : undefined;
}

export interface MemoryStats {
  changes: number;
  failures: number;
  attempts: number;
  outcomes: number;
  lessons: number;
  /** Share of attempts that were kept, the system's own hit rate over time. */
  attemptSuccessRate: number | null;
  oldest?: string;
}

export function stats(projectId: string): MemoryStats {
  const db = open(projectId);
  const count = (type: string): number => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM records WHERE type = ?`).get(type);
    return Number((row as Record<string, unknown>)["n"] ?? 0);
  };

  const kept = db
    .prepare(
      `SELECT COUNT(*) AS n FROM records WHERE type = 'attempt' AND payload LIKE '%"outcome":"kept"%'`,
    )
    .get();
  const attempts = count("attempt");
  const keptCount = Number((kept as Record<string, unknown>)["n"] ?? 0);

  const oldestRow = db.prepare(`SELECT MIN(at) AS at FROM records`).get();

  return {
    changes: count("change"),
    failures: count("failure"),
    attempts,
    outcomes: count("outcome"),
    lessons: count("causal"),
    attemptSuccessRate: attempts > 0 ? keptCount / attempts : null,
    oldest: (oldestRow as Record<string, unknown>)["at"] as string | undefined,
  };
}

export type { ChangeRecord, FailureRecord, AttemptRecord, OutcomeRecord, CausalLink };

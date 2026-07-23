import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

/**
 * Storage.
 *
 * `node:sqlite`, built into Node, no dependency, and a real database rather
 * than JSON files. For a self-hosted dashboard serving one team that is the
 * correct choice; swapping it for Postgres later is a driver change, not a
 * rewrite, because everything below goes through these functions.
 */

const DATA_DIR = resolve(process.cwd(), ".data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(resolve(DATA_DIR, "recursive.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS accounts (
 id TEXT PRIMARY KEY,
 email TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 password_salt TEXT NOT NULL,
 name TEXT,
 created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY,
 account_id TEXT NOT NULL,
 kind TEXT NOT NULL,          -- 'web' | 'cli'
 label TEXT,
 created_at TEXT NOT NULL,
 last_used_at TEXT,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS device_codes (
 device_code TEXT PRIMARY KEY,
 user_code TEXT UNIQUE NOT NULL,
 account_id TEXT,
 status TEXT NOT NULL,        -- 'pending' | 'approved' | 'denied'
 issued_token TEXT,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 trigger TEXT NOT NULL,
 status TEXT NOT NULL,
 started_at TEXT NOT NULL,
 ended_at TEXT,
 duration_ms INTEGER,
 payload TEXT NOT NULL        -- full Run object
  );
  CREATE INDEX IF NOT EXISTS runs_account_started ON runs(account_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS run_events (
 run_id TEXT NOT NULL,
 seq INTEGER NOT NULL,
 at TEXT NOT NULL,
 stage TEXT NOT NULL,
 type TEXT NOT NULL,
 message TEXT NOT NULL,
 duration_ms INTEGER,
 data TEXT,
    PRIMARY KEY (run_id, seq)
  );

  -- One row per model call routed through the shared-key gateway. This is how
  -- the dashboard knows which account used how much of the shared key.
  CREATE TABLE IF NOT EXISTS usage (
 id TEXT PRIMARY KEY,
 account_id TEXT NOT NULL,
 at TEXT NOT NULL,
 model TEXT NOT NULL,
 prompt_tokens INTEGER NOT NULL DEFAULT 0,
 completion_tokens INTEGER NOT NULL DEFAULT 0,
 ok INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );
  CREATE INDEX IF NOT EXISTS usage_account_at ON usage(account_id, at DESC);
`);

// ------------------------------------------------------------ accounts

function hashPassword(password: string, salt: string): string {
  // scrypt is memory-hard, so a leaked database is expensive to attack offline.
  // N=16384 is the Node default and a reasonable interactive-login cost.
  return scryptSync(password, salt, 64).toString("hex");
}

export interface Account {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
}

export function createAccount(email: string, password: string, name?: string): Account {
  const salt = randomBytes(16).toString("hex");
  const account: Account = {
    id: randomUUID(),
    email: email.toLowerCase().trim(),
    name: name ?? null,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO accounts (id, email, password_hash, password_salt, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    account.id,
    account.email,
    hashPassword(password, salt),
    salt,
    account.name,
    account.createdAt,
  );
  return account;
}

export function findAccountByEmail(
  email: string,
): (Account & { passwordHash: string; passwordSalt: string }) | undefined {
  const row = db
    .prepare(`SELECT * FROM accounts WHERE email = ?`)
    .get(email.toLowerCase().trim()) as Record<string, string> | undefined;
  if (!row) return undefined;
  return {
    id: row["id"]!,
    email: row["email"]!,
    name: (row["name"] as string | null) ?? null,
    createdAt: row["created_at"]!,
    passwordHash: row["password_hash"]!,
    passwordSalt: row["password_salt"]!,
  };
}

export function verifyPassword(email: string, password: string): Account | undefined {
  const account = findAccountByEmail(email);
  if (!account) return undefined;
  const candidate = Buffer.from(hashPassword(password, account.passwordSalt), "hex");
  const stored = Buffer.from(account.passwordHash, "hex");
  // Constant-time compare, a length mismatch alone would leak information.
  if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) return undefined;
  return { id: account.id, email: account.email, name: account.name, createdAt: account.createdAt };
}

// ------------------------------------------------------------ sessions

/**
 * Only the HASH of a token is stored. A stolen database then yields no usable
 * tokens, the same reason passwords aren't stored in the clear.
 */
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function issueToken(accountId: string, kind: "web" | "cli", label?: string): string {
  const token = `rec_${kind}_${randomBytes(32).toString("hex")}`;
  db.prepare(
    `INSERT INTO sessions (token_hash, account_id, kind, label, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(tokenHash(token), accountId, kind, label ?? null, new Date().toISOString());
  return token;
}

export function resolveToken(token: string): Account | undefined {
  const row = db
    .prepare(
      `SELECT a.id, a.email, a.name, a.created_at
       FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash(token)) as Record<string, string> | undefined;
  if (!row) return undefined;

  db.prepare(`UPDATE sessions SET last_used_at = ? WHERE token_hash = ?`).run(
    new Date().toISOString(),
    tokenHash(token),
  );
  return {
    id: row["id"]!,
    email: row["email"]!,
    name: (row["name"] as string | null) ?? null,
    createdAt: row["created_at"]!,
  };
}

export function revokeToken(token: string): void {
  db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash(token));
}

export function listCliTokens(
  accountId: string,
): { label: string | null; createdAt: string; lastUsedAt: string | null }[] {
  return db
    .prepare(
      `SELECT label, created_at, last_used_at FROM sessions
       WHERE account_id = ? AND kind = 'cli' ORDER BY created_at DESC`,
    )
    .all(accountId)
    .map((r) => {
      const row = r as Record<string, string | null>;
      return {
        label: row["label"] ?? null,
        createdAt: row["created_at"]!,
        lastUsedAt: row["last_used_at"] ?? null,
      };
    });
}

// ------------------------------------------------------------ device flow

/** Human-typable: no vowels (no accidental words), no 0/O/1/I ambiguity. */
function generateUserCode(): string {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ23456789";
  const pick = () => alphabet[randomBytes(1)[0]! % alphabet.length];
  return `${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`;
}

export function createDeviceCode(): { deviceCode: string; userCode: string; expiresAt: string } {
  const deviceCode = randomBytes(32).toString("hex");
  const userCode = generateUserCode();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  db.prepare(
    `INSERT INTO device_codes (device_code, user_code, status, created_at, expires_at)
     VALUES (?, ?, 'pending', ?, ?)`,
  ).run(deviceCode, userCode, new Date().toISOString(), expiresAt);
  return { deviceCode, userCode, expiresAt };
}

export function findDeviceCodeByUserCode(userCode: string) {
  const row = db
    .prepare(`SELECT * FROM device_codes WHERE user_code = ?`)
    .get(userCode.toUpperCase().trim()) as Record<string, string> | undefined;
  return row;
}

export function approveDeviceCode(userCode: string, accountId: string): boolean {
  const row = findDeviceCodeByUserCode(userCode);
  if (!row || row["status"] !== "pending") return false;
  if (Date.parse(row["expires_at"]!) < Date.now()) return false;

  const token = issueToken(accountId, "cli", "terminal");
  db.prepare(
    `UPDATE device_codes SET status = 'approved', account_id = ?, issued_token = ? WHERE user_code = ?`,
  ).run(accountId, token, userCode.toUpperCase().trim());
  return true;
}

export function denyDeviceCode(userCode: string): void {
  db.prepare(`UPDATE device_codes SET status = 'denied' WHERE user_code = ?`).run(
    userCode.toUpperCase().trim(),
  );
}

export function pollDeviceCode(deviceCode: string) {
  const row = db.prepare(`SELECT * FROM device_codes WHERE device_code = ?`).get(deviceCode) as
    Record<string, string> | undefined;
  if (!row) return { status: "expired" as const };
  if (Date.parse(row["expires_at"]!) < Date.now()) return { status: "expired" as const };
  if (row["status"] === "denied") return { status: "denied" as const };
  if (row["status"] === "approved" && row["issued_token"]) {
    const account = db
      .prepare(`SELECT email FROM accounts WHERE id = ?`)
      .get(row["account_id"]!) as Record<string, string> | undefined;
    // One-shot: clear the token so a leaked device code can't re-fetch it.
    db.prepare(`UPDATE device_codes SET issued_token = NULL WHERE device_code = ?`).run(deviceCode);
    return {
      status: "approved" as const,
      token: row["issued_token"]!,
      accountId: row["account_id"]!,
      email: account?.["email"] ?? "",
    };
  }
  return { status: "pending" as const };
}

// ------------------------------------------------------------ runs

export function insertRun(
  accountId: string,
  run: Record<string, unknown>,
  events: Record<string, unknown>[],
): void {
  db.prepare(
    `INSERT OR REPLACE INTO runs (id, account_id, project_id, kind, trigger, status, started_at, ended_at, duration_ms, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    String(run["id"]),
    accountId,
    String(run["projectId"] ?? "default"),
    String(run["kind"]),
    String(run["trigger"] ?? "manual"),
    String(run["status"]),
    String(run["startedAt"]),
    run["endedAt"] ? String(run["endedAt"]) : null,
    typeof run["durationMs"] === "number" ? run["durationMs"] : null,
    JSON.stringify(run),
  );

  const insertEvent = db.prepare(
    `INSERT OR REPLACE INTO run_events (run_id, seq, at, stage, type, message, duration_ms, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const event of events) {
    insertEvent.run(
      String(run["id"]),
      Number(event["seq"] ?? 0),
      String(event["at"]),
      String(event["stage"]),
      String(event["type"]),
      String(event["message"]),
      typeof event["durationMs"] === "number" ? event["durationMs"] : null,
      event["data"] ? JSON.stringify(event["data"]) : null,
    );
  }
}

export interface RunRow {
  id: string;
  kind: string;
  status: string;
  trigger: string;
  projectId: string;
  startedAt: string;
  durationMs: number | null;
  payload: Record<string, unknown>;
}

function toRunRow(r: unknown): RunRow {
  const row = r as Record<string, string | number | null>;
  return {
    id: String(row["id"]),
    kind: String(row["kind"]),
    status: String(row["status"]),
    trigger: String(row["trigger"]),
    projectId: String(row["project_id"]),
    startedAt: String(row["started_at"]),
    durationMs: typeof row["duration_ms"] === "number" ? row["duration_ms"] : null,
    payload: JSON.parse(String(row["payload"])) as Record<string, unknown>,
  };
}

export function listRuns(accountId: string, limit = 50): RunRow[] {
  return db
    .prepare(`SELECT * FROM runs WHERE account_id = ? ORDER BY started_at DESC LIMIT ?`)
    .all(accountId, limit)
    .map(toRunRow);
}

export function getRun(accountId: string, runId: string): RunRow | undefined {
  const row = db
    .prepare(`SELECT * FROM runs WHERE account_id = ? AND id = ?`)
    .get(accountId, runId);
  return row ? toRunRow(row) : undefined;
}

export function getRunEvents(runId: string) {
  return db
    .prepare(`SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC`)
    .all(runId)
    .map((r) => {
      const row = r as Record<string, string | number | null>;
      return {
        seq: Number(row["seq"]),
        at: String(row["at"]),
        stage: String(row["stage"]),
        type: String(row["type"]),
        message: String(row["message"]),
        durationMs: typeof row["duration_ms"] === "number" ? row["duration_ms"] : null,
        data: row["data"] ? (JSON.parse(String(row["data"])) as Record<string, unknown>) : null,
      };
    });
}

// ------------------------------------------------------------ analytics

/**
 * The product-health questions.
 *
 * Chosen to answer "what's working, what isn't, where do we improve", not
 * because they're easy to compute. The retrieval number in particular is the
 * one that tells us whether the hardest part of the system is doing its job,
 * measured on real usage rather than a benchmark we wrote the answers to.
 */
export interface Insights {
  totalRuns: number;
  runsByKind: { kind: string; count: number; failed: number }[];
  /** Repair: share of attempts the probe accepted. */
  fixAcceptanceRate: number | null;
  attemptsTried: number;
  attemptsKept: number;
  /** Retrieval: share of repairs where retrieval surfaced the edited file. */
  retrievalHitRate: number | null;
  /** Retrieval: share where it was ranked first. */
  retrievalTop1Rate: number | null;
  retrievalSamples: number;
  /** Containment: how often guardrails blocked a proposed action. */
  containmentBlockedRate: number | null;
  medianDurationMs: Record<string, number>;
  recentFailures: { id: string; kind: string; reason: string; at: string }[];
}

export function computeInsights(accountId: string): Insights {
  const runs = listRuns(accountId, 1000);

  const byKind = new Map<string, { count: number; failed: number; durations: number[] }>();
  let attemptsTried = 0;
  let attemptsKept = 0;
  let retrievalHits = 0;
  let retrievalTop1 = 0;
  let retrievalSamples = 0;
  let containProposed = 0;
  let containBlocked = 0;
  const recentFailures: Insights["recentFailures"] = [];

  for (const run of runs) {
    const entry = byKind.get(run.kind) ?? { count: 0, failed: 0, durations: [] };
    entry.count++;
    if (run.status === "failed") entry.failed++;
    if (run.durationMs) entry.durations.push(run.durationMs);
    byKind.set(run.kind, entry);

    const outcome = (run.payload["outcome"] ?? {}) as Record<string, unknown>;

    if (typeof outcome["attemptsTried"] === "number") attemptsTried += outcome["attemptsTried"];
    if (typeof outcome["attemptsKept"] === "number") attemptsKept += outcome["attemptsKept"];

    if (typeof outcome["retrievalHitRank"] === "number") {
      retrievalSamples++;
      if (outcome["retrievalHitRank"] > 0) retrievalHits++;
      if (outcome["retrievalHitRank"] === 1) retrievalTop1++;
    }

    if (typeof outcome["actionAllowed"] === "boolean") {
      containProposed++;
      if (!outcome["actionAllowed"]) containBlocked++;
    }

    if (run.status === "failed" && recentFailures.length < 8) {
      recentFailures.push({
        id: run.id,
        kind: run.kind,
        reason: String(outcome["failureReason"] ?? "unknown"),
        at: run.startedAt,
      });
    }
  }

  const medianDurationMs: Record<string, number> = {};
  for (const [kind, entry] of byKind) {
    if (entry.durations.length === 0) continue;
    const sorted = entry.durations.sort((a, b) => a - b);
    medianDurationMs[kind] = sorted[Math.floor(sorted.length / 2)]!;
  }

  return {
    totalRuns: runs.length,
    runsByKind: [...byKind].map(([kind, e]) => ({ kind, count: e.count, failed: e.failed })),
    fixAcceptanceRate: attemptsTried > 0 ? attemptsKept / attemptsTried : null,
    attemptsTried,
    attemptsKept,
    retrievalHitRate: retrievalSamples > 0 ? retrievalHits / retrievalSamples : null,
    retrievalTop1Rate: retrievalSamples > 0 ? retrievalTop1 / retrievalSamples : null,
    retrievalSamples,
    containmentBlockedRate: containProposed > 0 ? containBlocked / containProposed : null,
    medianDurationMs,
    recentFailures,
  };
}

// ------------------------------------------------------------ usage metering

/** Record one model call routed through the shared-key gateway. */
export function recordUsage(input: {
  accountId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  ok: boolean;
}): void {
  db.prepare(
    `INSERT INTO usage (id, account_id, at, model, prompt_tokens, completion_tokens, ok)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.accountId,
    new Date().toISOString(),
    input.model,
    input.promptTokens,
    input.completionTokens,
    input.ok ? 1 : 0,
  );
}

export interface UsageSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  failedCalls: number;
  /** Calls in the last 60 seconds, for the shared 40 RPM reality. */
  callsLastMinute: number;
  /** Per-day totals, oldest first, for a simple trend. */
  daily: { day: string; calls: number; tokens: number }[];
}

function summarize(accountId: string | null): UsageSummary {
  const where = accountId ? "WHERE account_id = ?" : "";
  const args = accountId ? [accountId] : [];

  const totals = db
    .prepare(
      `SELECT COUNT(*) c, COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) k,
              COALESCE(SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END),0) f
       FROM usage ${where}`,
    )
    .get(...args) as Record<string, number>;

  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const lastMinute = db
    .prepare(
      `SELECT COUNT(*) c FROM usage ${where ? where + " AND" : "WHERE"} at > ?`,
    )
    .get(...args, minuteAgo) as Record<string, number>;

  const daily = db
    .prepare(
      `SELECT substr(at,1,10) day, COUNT(*) calls, COALESCE(SUM(prompt_tokens+completion_tokens),0) tokens
       FROM usage ${where} GROUP BY day ORDER BY day DESC LIMIT 14`,
    )
    .all(...args)
    .map((r) => {
      const row = r as Record<string, string | number>;
      return { day: String(row["day"]), calls: Number(row["calls"]), tokens: Number(row["tokens"]) };
    })
    .reverse();

  return {
    calls: Number(totals["c"]),
    promptTokens: Number(totals["p"]),
    completionTokens: Number(totals["k"]),
    totalTokens: Number(totals["p"]) + Number(totals["k"]),
    failedCalls: Number(totals["f"]),
    callsLastMinute: Number(lastMinute["c"]),
    daily,
  };
}

/** Usage for one account. */
export function usageForAccount(accountId: string): UsageSummary {
  return summarize(accountId);
}

/** Usage across everyone, plus a per-account breakdown. Owner-only view. */
export function usageAllAccounts(): {
  total: UsageSummary;
  perAccount: { accountId: string; email: string; calls: number; totalTokens: number; lastUsedAt: string | null }[];
} {
  const perAccount = db
    .prepare(
      `SELECT a.id, a.email,
              COUNT(u.id) calls,
              COALESCE(SUM(u.prompt_tokens+u.completion_tokens),0) tokens,
              MAX(u.at) last
       FROM accounts a LEFT JOIN usage u ON u.account_id = a.id
       GROUP BY a.id ORDER BY tokens DESC`,
    )
    .all()
    .map((r) => {
      const row = r as Record<string, string | number | null>;
      return {
        accountId: String(row["id"]),
        email: String(row["email"]),
        calls: Number(row["calls"] ?? 0),
        totalTokens: Number(row["tokens"] ?? 0),
        lastUsedAt: row["last"] ? String(row["last"]) : null,
      };
    });
  return { total: summarize(null), perAccount };
}

/**
 * The owner is the first account created, i.e. whoever set up this dashboard.
 * Only the owner sees everyone's usage; a normal member sees only their own.
 */
export function isOwner(accountId: string): boolean {
  const first = db
    .prepare(`SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1`)
    .get() as Record<string, string> | undefined;
  return !!first && first["id"] === accountId;
}

export { db };

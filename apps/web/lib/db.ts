import { Pool } from "pg";
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

/**
 * Storage, on Postgres.
 *
 * The dashboard started on node:sqlite, which is perfect for a single-server
 * deploy but cannot run on serverless (Vercel functions are stateless with no
 * shared disk). So the store is Postgres, reached through `pg` with a
 * connection string. Neon's pooled URL works here unchanged.
 *
 * Everything still goes through the functions below, so callers only had to
 * learn one thing: these are async now. A `?`-to-`$n` shim keeps the SQL
 * readable, and the schema is created lazily on first use.
 */

// Accept whatever name the provider injects. Vercel's Neon integration sets
// DATABASE_URL and POSTGRES_URL; Supabase gives a plain connection string. Any
// of them works.
const CONNECTION =
  process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL;

const pool = new Pool({
  connectionString: CONNECTION,
  // Managed Postgres (Neon, Supabase) requires TLS; a local Docker Postgres does
  // not. Detect the local case so both work with no config.
  ssl: CONNECTION && !/localhost|127\.0\.0\.1/.test(CONNECTION) ? { rejectUnauthorized: false } : undefined,
  max: 5,
});

const SCHEMA = `
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
    kind TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS device_codes (
    device_code TEXT PRIMARY KEY,
    user_code TEXT UNIQUE NOT NULL,
    account_id TEXT,
    status TEXT NOT NULL,
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
    payload TEXT NOT NULL
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
  CREATE TABLE IF NOT EXISTS usage (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    at TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS usage_account_at ON usage(account_id, at DESC);
`;

let schemaReady: Promise<unknown> | undefined;
function ensureSchema(): Promise<unknown> {
  if (!schemaReady) schemaReady = pool.query(SCHEMA);
  return schemaReady;
}

/** Run a query, converting `?` placeholders to Postgres `$n`. Returns rows. */
async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  await ensureSchema();
  let i = 0;
  const converted = text.replace(/\?/g, () => `$${++i}`);
  const result = await pool.query(converted, params);
  return result.rows as T[];
}

async function one<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(text, params))[0];
}

// ------------------------------------------------------------ accounts

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

export interface Account {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
}

export async function createAccount(email: string, password: string, name?: string): Promise<Account> {
  const salt = randomBytes(16).toString("hex");
  const account: Account = {
    id: randomUUID(),
    email: email.toLowerCase().trim(),
    name: name ?? null,
    createdAt: new Date().toISOString(),
  };
  await q(
    `INSERT INTO accounts (id, email, password_hash, password_salt, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [account.id, account.email, hashPassword(password, salt), salt, account.name, account.createdAt],
  );
  return account;
}

export async function findAccountByEmail(
  email: string,
): Promise<(Account & { passwordHash: string; passwordSalt: string }) | undefined> {
  const row = await one<Record<string, string>>(`SELECT * FROM accounts WHERE email = ?`, [
    email.toLowerCase().trim(),
  ]);
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

export async function verifyPassword(email: string, password: string): Promise<Account | undefined> {
  const account = await findAccountByEmail(email);
  if (!account) return undefined;
  const candidate = Buffer.from(hashPassword(password, account.passwordSalt), "hex");
  const stored = Buffer.from(account.passwordHash, "hex");
  if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) return undefined;
  return { id: account.id, email: account.email, name: account.name, createdAt: account.createdAt };
}

// ------------------------------------------------------------ sessions

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueToken(accountId: string, kind: "web" | "cli", label?: string): Promise<string> {
  const token = `rec_${kind}_${randomBytes(32).toString("hex")}`;
  await q(
    `INSERT INTO sessions (token_hash, account_id, kind, label, created_at) VALUES (?, ?, ?, ?, ?)`,
    [tokenHash(token), accountId, kind, label ?? null, new Date().toISOString()],
  );
  return token;
}

export async function resolveToken(token: string): Promise<Account | undefined> {
  const row = await one<Record<string, string>>(
    `SELECT a.id, a.email, a.name, a.created_at
     FROM sessions s JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = ?`,
    [tokenHash(token)],
  );
  if (!row) return undefined;
  await q(`UPDATE sessions SET last_used_at = ? WHERE token_hash = ?`, [
    new Date().toISOString(),
    tokenHash(token),
  ]);
  return {
    id: row["id"]!,
    email: row["email"]!,
    name: (row["name"] as string | null) ?? null,
    createdAt: row["created_at"]!,
  };
}

export async function revokeToken(token: string): Promise<void> {
  await q(`DELETE FROM sessions WHERE token_hash = ?`, [tokenHash(token)]);
}

export async function listCliTokens(
  accountId: string,
): Promise<{ id: string; label: string | null; createdAt: string; lastUsedAt: string | null }[]> {
  const rows = await q<Record<string, string | null>>(
    `SELECT token_hash, label, created_at, last_used_at FROM sessions
     WHERE account_id = ? AND kind = 'cli' ORDER BY created_at DESC`,
    [accountId],
  );
  return rows.map((row) => ({
    // The token HASH is a safe public identifier: it names the session for
    // revocation without being the token itself.
    id: row["token_hash"]!,
    label: row["label"] ?? null,
    createdAt: row["created_at"]!,
    lastUsedAt: row["last_used_at"] ?? null,
  }));
}

/** Revoke one CLI session by its id (token hash), scoped to the account. */
export async function revokeCliSession(accountId: string, id: string): Promise<boolean> {
  const rows = await q(
    `DELETE FROM sessions WHERE account_id = ? AND token_hash = ? AND kind = 'cli' RETURNING token_hash`,
    [accountId, id],
  );
  return rows.length > 0;
}

/** Change an account's password (the account is already authenticated). */
export async function updatePassword(accountId: string, newPassword: string): Promise<void> {
  const salt = randomBytes(16).toString("hex");
  await q(`UPDATE accounts SET password_hash = ?, password_salt = ? WHERE id = ?`, [
    hashPassword(newPassword, salt),
    salt,
    accountId,
  ]);
}

/** Calls by this account since a timestamp, for gateway rate limiting. */
export async function countRecentUsage(accountId: string, sinceIso: string): Promise<number> {
  const row = await one<Record<string, string>>(
    `SELECT COUNT(*) c FROM usage WHERE account_id = ? AND at > ?`,
    [accountId, sinceIso],
  );
  return Number(row?.["c"] ?? 0);
}

/** Trivial query to keep a free-tier database from pausing. */
export async function health(): Promise<boolean> {
  const row = await one<Record<string, number>>(`SELECT 1 AS ok`);
  return row?.["ok"] === 1;
}

// ------------------------------------------------------------ device flow

function generateUserCode(): string {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ23456789";
  const pick = () => alphabet[randomBytes(1)[0]! % alphabet.length];
  return `${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`;
}

export async function createDeviceCode(): Promise<{ deviceCode: string; userCode: string; expiresAt: string }> {
  const deviceCode = randomBytes(32).toString("hex");
  const userCode = generateUserCode();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await q(
    `INSERT INTO device_codes (device_code, user_code, status, created_at, expires_at)
     VALUES (?, ?, 'pending', ?, ?)`,
    [deviceCode, userCode, new Date().toISOString(), expiresAt],
  );
  return { deviceCode, userCode, expiresAt };
}

export async function findDeviceCodeByUserCode(userCode: string): Promise<Record<string, string> | undefined> {
  return one<Record<string, string>>(`SELECT * FROM device_codes WHERE user_code = ?`, [
    userCode.toUpperCase().trim(),
  ]);
}

export async function approveDeviceCode(userCode: string, accountId: string): Promise<boolean> {
  const row = await findDeviceCodeByUserCode(userCode);
  if (!row || row["status"] !== "pending") return false;
  if (Date.parse(row["expires_at"]!) < Date.now()) return false;

  const token = await issueToken(accountId, "cli", "terminal");
  await q(`UPDATE device_codes SET status = 'approved', account_id = ?, issued_token = ? WHERE user_code = ?`, [
    accountId,
    token,
    userCode.toUpperCase().trim(),
  ]);
  return true;
}

export async function denyDeviceCode(userCode: string): Promise<void> {
  await q(`UPDATE device_codes SET status = 'denied' WHERE user_code = ?`, [userCode.toUpperCase().trim()]);
}

export async function pollDeviceCode(deviceCode: string): Promise<{ status: string; token?: string; accountId?: string; email?: string }> {
  const row = await one<Record<string, string>>(`SELECT * FROM device_codes WHERE device_code = ?`, [deviceCode]);
  if (!row) return { status: "expired" };
  if (Date.parse(row["expires_at"]!) < Date.now()) return { status: "expired" };
  if (row["status"] === "denied") return { status: "denied" };
  if (row["status"] === "approved" && row["issued_token"]) {
    const account = await one<Record<string, string>>(`SELECT email FROM accounts WHERE id = ?`, [row["account_id"]!]);
    // One-shot: clear the token so a leaked device code can't re-fetch it.
    await q(`UPDATE device_codes SET issued_token = NULL WHERE device_code = ?`, [deviceCode]);
    return {
      status: "approved",
      token: row["issued_token"]!,
      accountId: row["account_id"]!,
      email: account?.["email"] ?? "",
    };
  }
  return { status: "pending" };
}

// ------------------------------------------------------------ runs

export async function insertRun(
  accountId: string,
  run: Record<string, unknown>,
  events: Record<string, unknown>[],
): Promise<void> {
  await q(
    `INSERT INTO runs (id, account_id, project_id, kind, trigger, status, started_at, ended_at, duration_ms, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status, ended_at = EXCLUDED.ended_at,
       duration_ms = EXCLUDED.duration_ms, payload = EXCLUDED.payload`,
    [
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
    ],
  );

  for (const event of events) {
    await q(
      `INSERT INTO run_events (run_id, seq, at, stage, type, message, duration_ms, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, seq) DO UPDATE SET
         message = EXCLUDED.message, type = EXCLUDED.type, data = EXCLUDED.data`,
      [
        String(run["id"]),
        Number(event["seq"] ?? 0),
        String(event["at"]),
        String(event["stage"]),
        String(event["type"]),
        String(event["message"]),
        typeof event["durationMs"] === "number" ? event["durationMs"] : null,
        event["data"] ? JSON.stringify(event["data"]) : null,
      ],
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

function toRunRow(row: Record<string, string | number | null>): RunRow {
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

export async function listRuns(accountId: string, limit = 50): Promise<RunRow[]> {
  const rows = await q<Record<string, string | number | null>>(
    `SELECT * FROM runs WHERE account_id = ? ORDER BY started_at DESC LIMIT ?`,
    [accountId, limit],
  );
  return rows.map(toRunRow);
}

export async function getRun(accountId: string, runId: string): Promise<RunRow | undefined> {
  const row = await one<Record<string, string | number | null>>(
    `SELECT * FROM runs WHERE account_id = ? AND id = ?`,
    [accountId, runId],
  );
  return row ? toRunRow(row) : undefined;
}

export async function getRunEvents(runId: string) {
  const rows = await q<Record<string, string | number | null>>(
    `SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC`,
    [runId],
  );
  return rows.map((row) => ({
    seq: Number(row["seq"]),
    at: String(row["at"]),
    stage: String(row["stage"]),
    type: String(row["type"]),
    message: String(row["message"]),
    durationMs: typeof row["duration_ms"] === "number" ? row["duration_ms"] : null,
    data: row["data"] ? (JSON.parse(String(row["data"])) as Record<string, unknown>) : null,
  }));
}

// ------------------------------------------------------------ analytics

export interface Insights {
  totalRuns: number;
  runsByKind: { kind: string; count: number; failed: number }[];
  fixAcceptanceRate: number | null;
  attemptsTried: number;
  attemptsKept: number;
  retrievalHitRate: number | null;
  retrievalTop1Rate: number | null;
  retrievalSamples: number;
  containmentBlockedRate: number | null;
  medianDurationMs: Record<string, number>;
  recentFailures: { id: string; kind: string; reason: string; at: string }[];
}

export async function computeInsights(accountId: string): Promise<Insights> {
  const runs = await listRuns(accountId, 1000);

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

export async function recordUsage(input: {
  accountId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  ok: boolean;
}): Promise<void> {
  await q(
    `INSERT INTO usage (id, account_id, at, model, prompt_tokens, completion_tokens, ok)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      input.accountId,
      new Date().toISOString(),
      input.model,
      input.promptTokens,
      input.completionTokens,
      input.ok ? 1 : 0,
    ],
  );
}

export interface UsageSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  failedCalls: number;
  callsLastMinute: number;
  daily: { day: string; calls: number; tokens: number }[];
}

async function summarize(accountId: string | null): Promise<UsageSummary> {
  const where = accountId ? "WHERE account_id = ?" : "";
  const args = accountId ? [accountId] : [];

  const totals = (await one<Record<string, string>>(
    `SELECT COUNT(*) c, COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) k,
            COALESCE(SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END),0) f
     FROM usage ${where}`,
    args,
  ))!;

  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const lastMinute = (await one<Record<string, string>>(
    `SELECT COUNT(*) c FROM usage ${where ? where + " AND" : "WHERE"} at > ?`,
    [...args, minuteAgo],
  ))!;

  const daily = (
    await q<Record<string, string | number>>(
      `SELECT substr(at,1,10) AS day, COUNT(*) AS calls, COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens
       FROM usage ${where} GROUP BY substr(at,1,10) ORDER BY day DESC LIMIT 14`,
      args,
    )
  )
    .map((row) => ({ day: String(row["day"]), calls: Number(row["calls"]), tokens: Number(row["tokens"]) }))
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

export async function usageForAccount(accountId: string): Promise<UsageSummary> {
  return summarize(accountId);
}

export async function usageAllAccounts(): Promise<{
  total: UsageSummary;
  perAccount: { accountId: string; email: string; calls: number; totalTokens: number; lastUsedAt: string | null }[];
}> {
  const perAccount = (
    await q<Record<string, string | number | null>>(
      `SELECT a.id, a.email,
              COUNT(u.id) calls,
              COALESCE(SUM(u.prompt_tokens+u.completion_tokens),0) tokens,
              MAX(u.at) last
       FROM accounts a LEFT JOIN usage u ON u.account_id = a.id
       GROUP BY a.id, a.email ORDER BY tokens DESC`,
    )
  ).map((row) => ({
    accountId: String(row["id"]),
    email: String(row["email"]),
    calls: Number(row["calls"] ?? 0),
    totalTokens: Number(row["tokens"] ?? 0),
    lastUsedAt: row["last"] ? String(row["last"]) : null,
  }));
  return { total: await summarize(null), perAccount };
}

/** The owner is the first account created, i.e. whoever set up this dashboard. */
export async function isOwner(accountId: string): Promise<boolean> {
  const first = await one<Record<string, string>>(`SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1`);
  return !!first && first["id"] === accountId;
}

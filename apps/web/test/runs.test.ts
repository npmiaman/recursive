import { createAccount, insertRun, getRun, getRunEvents, listRuns } from "../lib/db.ts";
import { Pool } from "pg";

/**
 * The run-streaming contract `recursive watch` depends on.
 *
 * Live streaming works by the runner POSTing the SAME run id repeatedly with
 * growing batches of events, and the watcher polling them back. That only holds
 * if the store is incremental and idempotent: a re-sent event must not double,
 * a later status must win, and events must come back in seq order. This pins
 * exactly those properties. (The full HTTP round trip is exercised separately.)
 *
 * Run: DATABASE_URL=postgres://... node --experimental-strip-types apps/web/test/runs.test.ts
 */

if (!process.env.DATABASE_URL) {
  console.log("SKIP: set DATABASE_URL to a Postgres to run the runs tests.");
  process.exit(0);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127/.test(process.env.DATABASE_URL) ? undefined : { rejectUnauthorized: false },
});
async function cleanupAccount(id: string) {
  await pool.query("DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE account_id = $1)", [id]);
  await pool.query("DELETE FROM runs WHERE account_id = $1", [id]);
  await pool.query("DELETE FROM accounts WHERE id = $1", [id]);
}

let failures = 0;
const check = async (name: string, fn: () => Promise<boolean> | boolean) => {
  try {
    const ok = await fn();
    console.log(`${ok ? "✓" : "✗"} ${name}`);
    if (!ok) failures++;
  } catch (e) {
    failures++;
    console.error(`✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
  }
};

const account = await createAccount(`runs-${Date.now()}@test.dev`, "pw-runs-test");
const runId = `run-${Date.now()}`;
const ev = (seq: number, message: string, extra: Record<string, unknown> = {}) => ({
  runId,
  seq,
  at: new Date().toISOString(),
  stage: "repair",
  type: "info",
  message,
  ...extra,
});

await check("first push creates a running run with its first events", async () => {
  await insertRun(
    account.id,
    { id: runId, projectId: "p", kind: "repair", trigger: "manual", status: "running", startedAt: new Date().toISOString() },
    [ev(0, "started"), ev(1, "diagnosing")],
  );
  const run = await getRun(account.id, runId);
  const events = await getRunEvents(runId);
  return run?.status === "running" && events.length === 2 && events[0]!.message === "started";
});

await check("a later push APPENDS new events (incremental, not replace)", async () => {
  await insertRun(
    account.id,
    { id: runId, projectId: "p", kind: "repair", trigger: "manual", status: "running", startedAt: new Date().toISOString() },
    [ev(2, "editing checkout.tsx")],
  );
  const events = await getRunEvents(runId);
  return events.length === 3 && events[2]!.message === "editing checkout.tsx";
});

await check("re-sending an already-stored seq does NOT duplicate", async () => {
  await insertRun(
    account.id,
    { id: runId, projectId: "p", kind: "repair", trigger: "manual", status: "running", startedAt: new Date().toISOString() },
    [ev(2, "editing checkout.tsx"), ev(3, "re-running the flow")],
  );
  const events = await getRunEvents(runId);
  // seq 2 was already there; only seq 3 is new -> 4 total, no dupes.
  return events.length === 4 && events.filter((e) => e.seq === 2).length === 1;
});

await check("events come back in seq order", async () => {
  const events = await getRunEvents(runId);
  return events.every((e, i) => i === 0 || e.seq > events[i - 1]!.seq);
});

await check("a terminal push updates status (later status wins)", async () => {
  await insertRun(
    account.id,
    { id: runId, projectId: "p", kind: "repair", trigger: "manual", status: "succeeded", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1234 },
    [ev(4, "run.succeeded", { type: "run.succeeded" })],
  );
  const run = await getRun(account.id, runId);
  return run?.status === "succeeded" && run?.durationMs === 1234;
});

await check("listRuns surfaces the run for watch-with-no-id", async () => {
  const runs = await listRuns(account.id, 25);
  return runs.some((r) => r.id === runId && r.status === "succeeded");
});

await check("another account cannot read this run (scoped)", async () => {
  const other = await createAccount(`other-${Date.now()}@test.dev`, "pw");
  const stolen = await getRun(other.id, runId);
  // cleanup the extra account below via cascade delete
  await cleanupAccount(other.id);
  return stolen === undefined;
});

// ---- cleanup ----
await cleanupAccount(account.id);
await pool.end();

console.log(failures === 0 ? "\nall run-streaming checks passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

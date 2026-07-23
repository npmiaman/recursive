import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.ts";
import { appendSignals } from "../detect/store.ts";
import { fingerprint, type Signal } from "../detect/types.ts";
import { Repo } from "../repo/git.ts";
import { flowsAffectedBy, loadFlows, type Flow, type FlowManifest } from "./flows.ts";
import { TIER_MAX_STEPS, TIER_MODELS, type RhaiOptions, type RhaiResult } from "./rhai.ts";
import { enginePreflight, runFlowWithEngine, type SweepEngine } from "./engine.ts";
import { BrowserPool } from "../browse/pool.ts";
import { captureBaselines, verify, type VerificationOutcome } from "./verify.ts";
import { verifyBackend, type BackendVerification } from "./backend.ts";
import { scoreFlows, selectForDailySweep, type FlowHistory, type RiskScore } from "./risk.ts";

/**
 * Sweeps, scheduled browsing-agent regression runs.
 *
 * Two modes, deliberately different in scope:
 *
 *   PR sweep    After a merge. Tests only the flows the diff put at risk, so it
 * finishes in minutes and can gate a deploy.
 *   Daily sweep Every core flow plus the highest-risk remainder. Catches the
 * breakage no diff predicted, dependency drift, expired
 * credentials, a third party changing under you.
 *
 * A confirmed failure becomes a signal, which flows into exactly the same
 * pipeline as a real user's failure: correlate → incident → retrieve → repair.
 * That reuse is the point. The browsing agent is a new *source* of failures, not
 * a parallel system that needs its own diagnosis and fixing machinery.
 */

export type SweepMode = "pr" | "daily";

export interface SweepPlanEntry {
  flow: Flow;
  reason: string;
  riskScore?: number;
  factors?: string[];
}

export interface SweepResult {
  id: string;
  mode: SweepMode;
  startedAt: string;
  endedAt: string;
  planned: number;
  passed: number;
  failed: number;
  errored: number;
  /** Failures that reproduced on a re-run, these become signals. */
  confirmed: {
    flow: Flow;
    results: RhaiResult[];
    verification?: VerificationOutcome;
    backend?: BackendVerification;
  }[];
  /** Chronically flaky flows, skipped rather than allowed to keep crying wolf. */
  quarantined: Flow[];
  /** Failures that passed on re-run. Recorded, not acted on. */
  flakes: { flow: Flow; results: RhaiResult[] }[];
  signals: Signal[];
}

// ------------------------------------------------------------ history

function historyPath(): string {
  mkdirSync(config.dataDir, { recursive: true });
  return resolve(config.dataDir, "sweep-history.jsonl");
}

interface HistoryRecord {
  at: string;
  flowId: string;
  status: RhaiResult["status"];
  mode: SweepMode;
  summary: string;
}

function recordHistory(record: HistoryRecord): void {
  appendFileSync(historyPath(), JSON.stringify(record) + "\n");
}

export function loadHistory(): Map<string, FlowHistory> {
  const path = historyPath();
  const history = new Map<string, FlowHistory>();
  if (!existsSync(path)) return history;

  const cutoff = Date.now() - 30 * 86_400_000;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record: HistoryRecord;
    try {
      record = JSON.parse(line) as HistoryRecord;
    } catch {
      continue;
    }

    const entry = history.get(record.flowId) ?? {
      flowId: record.flowId,
      recentFailures: 0,
      totalRuns: 0,
    };
    entry.totalRuns++;
    entry.lastTestedAt = record.at;
    if (record.status === "failed") {
      entry.lastFailedAt = record.at;
      if (Date.parse(record.at) >= cutoff) entry.recentFailures++;
    }
    history.set(record.flowId, entry);
  }
  return history;
}

// ------------------------------------------------------------ planning

export function planPRSweep(
  repoPath: string,
  manifest: FlowManifest,
  baseRef: string,
  headRef = "HEAD",
  projectId?: string,
): SweepPlanEntry[] {
  const repo = new Repo(repoPath);
  const changed = repo.changedBetween(baseRef, headRef).map((c) => c.path);

  const affected = flowsAffectedBy(manifest, changed, { projectId });
  const history = loadHistory();
  const scored = new Map(
    scoreFlows({
      flows: affected.map((a) => a.flow),
      repoPath,
      history,
      recentlyChanged: changed,
      projectId,
    }).map((s) => [s.flow.id, s]),
  );

  return affected
    .map(({ flow, reason }) => ({
      flow,
      reason,
      riskScore: scored.get(flow.id)?.score,
      factors: scored.get(flow.id)?.factors,
    }))
    .sort((a, b) => (b.riskScore ?? 0) - (a.riskScore ?? 0));
}

export function planDailySweep(
  repoPath: string,
  manifest: FlowManifest,
  maxFlows = 12,
  projectId?: string,
): SweepPlanEntry[] {
  let recentlyChanged: string[] = [];
  try {
    const repo = new Repo(repoPath);
    // Everything that landed in the last day, the daily sweep's own diff.
    const commits = repo.log({ since: "1 day ago" });
    recentlyChanged = commits.flatMap((c) => repo.changedFiles(c.sha).map((f) => f.path));
  } catch {
    /* not a git repo, risk model degrades but still runs */
  }

  const scored: RiskScore[] = scoreFlows({
    flows: manifest.flows,
    repoPath,
    history: loadHistory(),
    recentlyChanged,
    projectId,
  });

  return selectForDailySweep(scored, maxFlows).map((s) => ({
    flow: s.flow,
    reason: s.flow.critical ? "core flow" : "high risk",
    riskScore: s.score,
    factors: s.factors,
  }));
}

// ------------------------------------------------------ per-flow runner

type FlowOutcome =
  | { kind: "passed"; flow: Flow }
  | { kind: "errored"; flow: Flow }
  | { kind: "quarantined"; flow: Flow }
  | { kind: "flake"; flow: Flow; results: RhaiResult[] }
  | {
      kind: "failed";
      flow: Flow;
      results: RhaiResult[];
      verification?: VerificationOutcome;
      backend?: BackendVerification;
    };

/**
 * A flow that fails intermittently and never reproduces is telling you the test
 * is broken, not the product. After enough of those it must stop raising alarms
 *, a channel that cries wolf gets muted, and then the real failure is missed too.
 */
const QUARANTINE_THRESHOLD = 5;

function isQuarantined(flowId: string, history: Map<string, FlowHistory>): boolean {
  const entry = history.get(flowId);
  if (!entry || entry.totalRuns < 8) return false;
  // Failing most of the time without ever being fixed = an unreliable test.
  return (
    entry.recentFailures >= QUARANTINE_THRESHOLD && entry.recentFailures / entry.totalRuns > 0.6
  );
}

async function runOneFlow(
  flow: Flow,
  base: RhaiOptions,
  history: Map<string, FlowHistory>,
  mode: SweepMode,
  log: (line: string) => void,
  backend?: { url?: string; token?: string },
  engine: SweepEngine = "internal",
  pool?: BrowserPool,
): Promise<FlowOutcome> {
  if (isQuarantined(flow.id, history)) {
    log(`  ⊘ ${flow.name}, quarantined (chronically flaky; fix the flow definition)`);
    return { kind: "quarantined", flow };
  }

  const tier = flow.tier ?? "standard";
  const optionsFor = (t: "fast" | "standard" | "careful") => ({
    ...base,
    engine,
    pool,
    model: TIER_MODELS[t],
    maxSteps: flow.maxSteps ?? TIER_MAX_STEPS[t],
  });

  // Ground truth sampled BEFORE the flow, so a count delta is meaningful.
  const conditions = flow.verify ?? [];
  const baselines = await captureBaselines(conditions);
  // Everything the server does from here on belongs to this flow.
  const windowStart = new Date().toISOString();

  const first = await runFlowWithEngine(flow, optionsFor(tier));
  recordHistory({
    at: new Date().toISOString(),
    flowId: flow.id,
    status: first.status,
    mode,
    summary: first.summary,
  });

  if (first.status === "error") {
    log(`  ! ${flow.name}, ${first.infrastructureError ?? first.summary}`);
    return { kind: "errored", flow };
  }

  // The UI said it worked. Now check whether anything outside the UI agrees.
  if (first.status === "passed") {
    const verification = await verify(conditions, baselines, true);
    const backendCheck = await verifyBackend({
      flowId: flow.id,
      traceUrl: backend?.url,
      token: backend?.token,
      since: windowStart,
      uiPassed: verification.passed,
    });

    if (verification.passed && !backendCheck.failed) {
      const learned = backendCheck.shape ? `, shape×${backendCheck.shape.samples}` : "";
      log(`  ✓ ${flow.name}  (${(first.durationMs / 1000).toFixed(0)}s, ${tier}${learned})`);
      return { kind: "passed", flow };
    }

    // The most valuable finding a sweep can produce: it LOOKED fine and wasn't.
    // No amount of manual clicking catches this, because manual clicking is
    // exactly the thing that was fooled.
    log(`  ✗ ${flow.name}. UI reported success but the system disagrees:`);
    for (const check of verification.results.filter((r) => !r.passed)) {
      log(`      ✗ ${check.name}: ${check.detail}`);
    }
    for (const finding of backendCheck.findings.filter((f) => f.severity === "failure")) {
      log(`      ✗ backend: ${finding.title}`);
      log(`          ${finding.detail}`);
    }
    return { kind: "failed", flow, results: [first], verification, backend: backendCheck };
  }

  log(`  ✗ ${flow.name}, ${first.summary}`);

  // A cheap model failing is weak evidence. Re-run at a stronger tier before
  // believing it, so the fast path can never cost correctness.
  const retryTier = tier === "fast" ? "standard" : tier === "standard" ? "careful" : "careful";
  log(` confirming at '${retryTier}'…`);

  const second = await runFlowWithEngine(flow, optionsFor(retryTier));
  recordHistory({
    at: new Date().toISOString(),
    flowId: flow.id,
    status: second.status,
    mode,
    summary: second.summary,
  });

  if (second.status === "passed") {
    const verification = await verify(conditions, baselines, true);
    if (verification.passed) {
      log(` passed at '${retryTier}', recorded as a flake, not acted on`);
      return { kind: "flake", flow, results: [first, second] };
    }
    log(` passed visually but ground truth disagrees, treating as a real failure`);
    return { kind: "failed", flow, results: [first, second], verification };
  }

  if (second.status === "error") {
    log(` retry hit an environment problem, not counted as a product failure`);
    return { kind: "errored", flow };
  }

  log(` reproduced, raising a signal`);
  return { kind: "failed", flow, results: [first, second] };
}

/** Bounded-concurrency map. Browsers are memory-hungry; unbounded fan-out thrashes. */
async function runInParallel<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function pump(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
  return results;
}

// ------------------------------------------------------------ execution

export interface SweepOptions {
  repoPath: string;
  projectId: string;
  mode: SweepMode;
  /** For PR sweeps: the ref to diff against. */
  baseRef?: string;
  headRef?: string;
  maxFlows?: number;
  headless?: boolean;
  /** Flows run at once. Browsers are memory-hungry; 3 is a safe default. */
  concurrency?: number;
  /** Which browser agent drives the flows. Defaults to the internal one. */
  engine?: SweepEngine;
  /** Plan only, show what would run, execute nothing. */
  dryRun?: boolean;
  onProgress?: (line: string) => void;
}

export async function sweep(options: SweepOptions): Promise<SweepResult> {
  const log = options.onProgress ?? ((l: string) => console.log(l));
  const startedAt = new Date().toISOString();

  const manifest = loadFlows(options.repoPath);
  if (!manifest) {
    throw new Error(
      `No flow manifest found. Create recursive.flows.json in ${options.repoPath} ` +
        `(run \`recursive sweep init\` for a starter).`,
    );
  }

  const plan =
    options.mode === "pr"
      ? planPRSweep(
          options.repoPath,
          manifest,
          options.baseRef ?? "HEAD~1",
          options.headRef,
          options.projectId,
        )
      : planDailySweep(options.repoPath, manifest, options.maxFlows, options.projectId);

  log(`\n${options.mode === "pr" ? "PR" : "Daily"} sweep, ${plan.length} flow(s) planned\n`);
  for (const entry of plan) {
    log(`  [${String(entry.riskScore ?? 0).padStart(3)}] ${entry.flow.name}`);
    log(`        ${entry.reason}`);
    for (const factor of entry.factors ?? []) log(`        · ${factor}`);
  }

  const result: SweepResult = {
    id: randomUUID(),
    mode: options.mode,
    startedAt,
    endedAt: startedAt,
    planned: plan.length,
    passed: 0,
    failed: 0,
    errored: 0,
    confirmed: [],
    quarantined: [],
    flakes: [],
    signals: [],
  };

  if (options.dryRun) {
    log(`\n dry run, nothing executed.`);
    result.endedAt = new Date().toISOString();
    return result;
  }
  if (plan.length === 0) {
    log(`\n nothing to test.`);
    result.endedAt = new Date().toISOString();
    return result;
  }

  const engine: SweepEngine = options.engine ?? "internal";
  const check = await enginePreflight(engine);
  if (!check.ok) throw new Error(`engine '${engine}' is not ready: ${check.reason}`);

  // One browser for the whole sweep when running internally, launching Chrome
  // per flow would undo the speed work.
  const pool =
    engine === "internal" ? new BrowserPool({ headless: options.headless !== false }) : undefined;
  if (pool) await pool.start();

  const rhaiOptions = {
    baseUrl: manifest.baseUrl,
    headless: options.headless !== false,
  };

  const concurrency = options.concurrency ?? 3;
  log(`\nRunning on '${engine}' engine (${concurrency} at a time)…\n`);

  const history = loadHistory();
  const outcomes = await runInParallel(plan, concurrency, async (entry) =>
    runOneFlow(
      entry.flow,
      rhaiOptions,
      history,
      options.mode,
      log,
      {
        url: manifest.backendTraceUrl,
        token: manifest.backendTokenEnv ? process.env[manifest.backendTokenEnv] : undefined,
      },
      engine,
      pool,
    ),
  );

  for (const outcome of outcomes) {
    if (outcome.kind === "quarantined") {
      result.quarantined.push(outcome.flow);
      continue;
    }
    if (outcome.kind === "passed") {
      result.passed++;
      continue;
    }
    if (outcome.kind === "errored") {
      result.errored++;
      continue;
    }
    if (outcome.kind === "flake") {
      result.flakes.push({ flow: outcome.flow, results: outcome.results });
      continue;
    }
    result.failed++;
    result.confirmed.push({
      flow: outcome.flow,
      results: outcome.results,
      verification: outcome.verification,
      backend: outcome.backend,
    });
  }

  // ---- confirmed failures become signals -------------------------------
  const now = new Date().toISOString();
  result.signals = result.confirmed.map(({ flow, results, verification, backend }) => {
    const evidence = results[results.length - 1]!;
    // When the UI claimed success, say so explicitly. That framing is what tells
    // a human this is a data-integrity bug rather than a rendering one, and it
    // is the class of bug manual testing cannot find, because manual testing is
    // exactly what got fooled.
    const message = verification?.uiLied
      ? `Flow '${flow.name}' appeared to succeed but did not: ` +
        verification.results
          .filter((r) => !r.passed)
          .map((r) => `${r.name}, ${r.detail}`)
          .join("; ")
      : backend?.failed
        ? `Flow '${flow.name}' failed on the server: ` +
          backend.findings
            .filter((f) => f.severity === "failure")
            .map((f) => f.title)
            .join("; ")
        : `Flow '${flow.name}' failed: ${evidence.summary}`;
    const route = flow.url;

    return {
      id: randomUUID(),
      projectId: options.projectId,
      class: "flow-failure" as const,
      source: "synthetic" as const,
      at: now,
      route,
      cohort: {},
      fingerprint: fingerprint({ class: "flow-failure", route, message }),
      message,
      // The transcript is the diagnosis input, it records what the agent did,
      // what it expected, and what it saw instead.
      // Browser transcript plus what the server did, the two halves a
      // diagnosis needs: what the user saw, and what actually happened.
      stack: [
        evidence.transcript.slice(0, 5000),
        backend?.findings.length
          ? "\n\n--- server ---\n" +
            backend.findings.map((f) => `${f.severity}: ${f.title}\n  ${f.detail}`).join("\n")
          : "",
        backend?.trace?.errors.length ? "\n" + (backend.trace.errors[0]?.stack ?? "") : "",
      ]
        .join("")
        .slice(0, 8000),
      count: 1,
      // A broken core flow affects everyone who attempts it, so it clears the
      // min-sessions floor on its own rather than being filtered as noise.
      sessions: flow.critical ? 50 : 10,
    };
  });

  if (result.signals.length) appendSignals(options.projectId, result.signals);

  if (pool) await pool.stop();
  result.endedAt = new Date().toISOString();

  log(
    `\n${result.passed} passed · ${result.failed} failed · ${result.flakes.length} flaky · ` +
      `${result.quarantined.length} quarantined · ${result.errored} errored`,
  );
  if (result.confirmed.length) {
    log(`\n${result.confirmed.length} confirmed failure(s) raised as signals.`);
    log(`Next: \`recursive incidents\` to see them, then \`recursive fix\` to repair.`);
  }

  return result;
}

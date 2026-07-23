#!/usr/bin/env node
import { resolve } from "node:path";
import { config } from "./config.ts";
import { fetchInsights } from "./clarity/client.ts";
import * as budget from "./clarity/budget.ts";
import * as store from "./clarity/store.ts";
import { diagnose } from "./diagnose/rank.ts";
import { describe, type Issue } from "./diagnose/issues.ts";
import { scoreOnce, formatScore } from "./score/index.ts";
import { hillClimb } from "./loop/inner.ts";
import { ship, readShipped } from "./loop/ship.ts";
import { verify, readCalibration } from "./loop/outer.ts";
import { listProjects, resolveProject } from "./tenant.ts";
import { ingest } from "./detect/ingest.ts";
import { correlate, describeIncident } from "./detect/correlate.ts";
import { readAudit, readSignals } from "./detect/store.ts";
import { runHealthChecks } from "./detect/health.ts";
import { heal, verifyContainment } from "./heal/tier0.ts";
import { seedScenario, DEMO_PROJECT_ID } from "./demo.ts";

const HELP = `
Recursive — detect breakage (including the silent kind), contain it, repair it.

DETECT
  ingest [file]       Ingest a telemetry batch (JSON file, or stdin).
  health              Run synthetic journey checks — needs no live traffic.
  incidents           Correlate recent signals into incidents.
                        --project ID      target project
                        --window N        minutes to correlate (default 60)

TIER 0 — CONTAIN (seconds, reversible, no human)
  heal                Evaluate incidents and contain what is safely containable.
                        --dry-run         evaluate guardrails, execute nothing
  containment         Did containment actually work? Reverts trust if not.
  audit               Immutable log of every autonomous action and why.

TIER 1 — REPAIR (minutes, always a PR)
  snapshot            Pull Clarity data into the local time series.
  diagnose            Rank friction issues from the latest snapshot.
  score <index>       Measure one issue's page with the headless probe.
  fix [index]         Hill-climb a fix, then open a PR.
                        --top-issue       pick the highest-severity issue
                        --max-iter N      cap iterations (default ${config.maxIterations})
                        --dry-run         commit to a branch, don't push
  verify              Re-sample Clarity to confirm shipped fixes worked.

GENERAL
  projects            List configured projects and their guardrails.
  status              Budget, snapshots, shipped fixes, probe calibration.
  demo                Seed a realistic silent-breakage scenario and show the loop.

No Clarity token and no customer needed: \`npm run cli -- demo\` seeds a scenario
and runs detection + containment end to end against fixtures.
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function loadIssues(): Promise<Issue[]> {
  const latest = store.latest();
  if (!latest) {
    console.error("No snapshots yet. Run `npm run snapshot` first.");
    process.exit(1);
  }
  const baseline = store.nearest(7);
  const minSessions = Number(arg("min-sessions") ?? 200);
  return diagnose(latest, baseline === latest ? undefined : baseline, { minSessions });
}

async function cmdSnapshot(): Promise<void> {
  const days = Number(arg("days") ?? 3);
  if (![1, 2, 3].includes(days)) {
    console.error("--days must be 1, 2 or 3 (the API accepts nothing else).");
    process.exit(1);
  }
  const before = budget.state();
  console.log(
    `Clarity budget: ${before.remaining}/${before.limit} calls left today (${before.date} UTC)`,
  );

  const snapshot = await fetchInsights({
    numOfDays: days as 1 | 2 | 3,
    dimensions: ["URL"],
    label: "cli-snapshot",
  });
  store.append(snapshot);

  const metrics = snapshot.payload.map((b) => `${b.metricName}(${b.information.length})`);
  console.log(`✓ ${snapshot.source} snapshot stored — ${metrics.join(", ")}`);
  console.log(`  ${store.count()} snapshot(s) in local history.`);
  if (snapshot.source === "mock") {
    console.log("  (fixtures — set CLARITY_API_TOKEN for live data)");
  }
}

async function cmdDiagnose(): Promise<void> {
  const issues = await loadIssues();
  const top = Number(arg("top") ?? 10);

  if (issues.length === 0) {
    console.log("No friction issues cleared the thresholds. Try --min-sessions 0.");
    return;
  }

  console.log(`\n${issues.length} issue(s) found. Top ${Math.min(top, issues.length)} by severity:\n`);
  issues.slice(0, top).forEach((issue, i) => {
    console.log(`  ${String(i).padStart(2)}. ${describe(issue)}`);
  });
  console.log(`\nRun \`npm run cli -- fix <index>\` or \`--top-issue\` to start a hill-climb.`);
}

async function cmdScore(): Promise<void> {
  const issues = await loadIssues();
  const index = Number(process.argv[3] ?? 0);
  const issue = issues[index];
  if (!issue) {
    console.error(`No issue at index ${index}. Run \`diagnose\` to list them.`);
    process.exit(1);
  }
  console.log(describe(issue));
  console.log("measuring…\n");
  console.log(formatScore(await scoreOnce(issue)));
}

async function cmdFix(): Promise<void> {
  if (!config.targetRepoPath) {
    console.error("TARGET_REPO_PATH must be set to run the fix loop.");
    process.exit(1);
  }

  const issues = await loadIssues();
  const index = flag("top-issue") ? 0 : Number(process.argv[3] ?? 0);
  const issue = issues[index];
  if (!issue) {
    console.error(`No issue at index ${index}. Run \`diagnose\` to list them.`);
    process.exit(1);
  }

  const result = await hillClimb(issue, {
    maxIterations: arg("max-iter") ? Number(arg("max-iter")) : undefined,
    skipResearch: flag("no-research"),
  });

  if (result.acceptedCommits.length === 0) {
    console.log("\nNo change improved the score. Nothing shipped.");
    console.log("The journal in data/runs/ records every approach tried and why it was rejected.");
    return;
  }

  console.log("\nShipping…");
  await ship(result, { dryRun: flag("dry-run") });
  console.log(
    `\nThe probe says this is better. Clarity hasn't voted yet — ` +
      `run \`npm run verify\` in ${config.verifyAfterDays} days.`,
  );
}

async function cmdVerify(): Promise<void> {
  await verify({ force: flag("force") });
}

async function cmdStatus(): Promise<void> {
  const b = budget.state();
  console.log(`\nClarity API budget   ${b.remaining}/${b.limit} remaining today (${b.date} UTC)`);
  console.log(`Mode                 ${config.clarityMode}${config.clarityToken ? "" : " (no token — using fixtures)"}`);
  console.log(`Snapshots stored     ${store.count()}`);
  console.log(`Target site          ${config.targetBaseUrl}`);
  console.log(`Target repo          ${config.targetRepoPath ?? "(unset — fix loop disabled)"}`);

  const shipped = readShipped();
  const verified = shipped.filter((f) => f.verification);
  console.log(`\nShipped fixes        ${shipped.length} (${verified.length} verified)`);
  for (const fix of shipped.slice(-8)) {
    const v = fix.verification;
    const mark = !v ? "pending" : v.verdict;
    console.log(`  [${mark.padEnd(12)}] ${fix.kind} on ${fix.url}${fix.prUrl ? ` — ${fix.prUrl}` : ""}`);
  }

  const calibration = Object.values(readCalibration());
  if (calibration.length) {
    console.log(`\nProbe calibration    (does the proxy predict reality?)`);
    for (const c of calibration) {
      console.log(
        `  ${c.kind.padEnd(18)} trust ${c.trust.toFixed(2)}  ` +
          `${c.confirmed} confirmed / ${c.falsePositive} no-change / ${c.harmful} harmful`,
      );
    }
  }
  console.log();
}

// ------------------------------------------------------------ detect / heal

function project() {
  return resolveProject(arg("project"));
}

async function cmdProjects(): Promise<void> {
  const all = listProjects();
  if (all.length === 0) {
    console.log("No projects configured. Run `npm run cli -- demo` to seed one.");
    return;
  }
  for (const p of all) {
    const g = p.guardrails;
    console.log(`\n${p.id}  (${p.name}, ${p.environment})`);
    console.log(`  base URL      ${p.baseUrl}`);
    console.log(`  containment   flags=${p.containment.flagProvider} deploy=${p.containment.deployProvider}`);
    console.log(
      `  autonomy      ${g.autonomyEnabled ? "ENABLED" : "disabled"} — ` +
        `actions [${g.allowedActions.join(", ")}], blast ≤${g.maxBlastRadiusPct}%, ` +
        `≤${g.maxActionsPerHour}/hr, cooldown ${g.cooldownMinutes}m`,
    );
  }
  console.log();
}

async function cmdIngest(): Promise<void> {
  const file = process.argv[3];
  const raw = file
    ? (await import("node:fs")).readFileSync(file, "utf8")
    : await new Promise<string>((res) => {
        let buf = "";
        process.stdin.on("data", (c) => (buf += c));
        process.stdin.on("end", () => res(buf));
      });

  const result = ingest(JSON.parse(raw));
  console.log(`ingested ${result.accepted} signal(s), rejected ${result.rejected}`);
}

async function cmdIncidents(): Promise<void> {
  const p = project();
  const windowMs = Number(arg("window") ?? 60) * 60_000;
  const incidents = correlate(p.id, { windowMs });

  console.log(`\n${p.id} — ${readSignals(p.id, windowMs).length} signal(s) in the last ${Math.round(windowMs / 60000)}m\n`);
  if (incidents.length === 0) {
    console.log("  no incidents");
    return;
  }
  for (const incident of incidents) {
    console.log(`  ${describeIncident(incident)}`);
    for (const reason of incident.reasoning) console.log(`      ${reason}`);
    console.log();
  }
}

async function cmdHealth(): Promise<void> {
  const p = project();
  console.log(`Running synthetic journeys against ${p.baseUrl}…\n`);
  const { results, signals } = await runHealthChecks(p);
  for (const r of results) {
    console.log(
      `  ${r.ok ? "✓" : "✗"} ${r.journey} (${r.durationMs}ms)` +
        (r.ok ? "" : `\n      failed at '${r.failedStep}': ${r.reason}`),
    );
  }
  if (signals.length) console.log(`\n${signals.length} failure signal(s) recorded.`);
}

async function cmdHeal(): Promise<void> {
  const p = project();
  const windowMs = Number(arg("window") ?? 60) * 60_000;
  console.log(`\nTier 0 — contain  [${p.id}]${flag("dry-run") ? "  (dry run)" : ""}\n`);
  const report = await heal(p, { windowMs, dryRun: flag("dry-run") });
  const executed = report.outcomes.filter((o) => o.executed).length;
  const blocked = report.outcomes.filter((o) => !o.executed && o.blockedBy.length).length;
  console.log(
    `\n${report.incidentsConsidered} incident(s) considered — ${executed} contained, ${blocked} not acted on.`,
  );
}

async function cmdContainment(): Promise<void> {
  const p = project();
  const checks = verifyContainment(p);
  if (checks.length === 0) {
    console.log("No executed containments old enough to assess yet.");
    return;
  }
  for (const check of checks) {
    console.log(`  ${check.worked ? "✓" : "✗"} ${check.action} '${check.target}'`);
    console.log(`      ${check.note}`);
  }
}

async function cmdAudit(): Promise<void> {
  const p = project();
  const records = readAudit(p.id);
  if (records.length === 0) {
    console.log("No audit records — nothing autonomous has run for this project.");
    return;
  }
  console.log(`\n${records.length} audit record(s) for ${p.id}:\n`);
  for (const r of records.slice(-25)) {
    console.log(`  [${r.outcome.padEnd(8)}] ${r.at}  ${r.action}  (${r.actor})`);
    if (r.incidentId) console.log(`      incident: ${r.incidentId}`);
    const blocked = r.detail["blockedBy"];
    if (Array.isArray(blocked)) for (const b of blocked) console.log(`      blocked: ${b}`);
    const rationale = r.detail["rationale"];
    if (typeof rationale === "string") console.log(`      why: ${rationale}`);
  }
  console.log();
}

async function cmdDemo(): Promise<void> {
  console.log("Seeding a silent-breakage scenario…\n");
  seedScenario({ includeRollbackCase: true, includeLowConfidenceCase: true });

  const p = resolveProject(DEMO_PROJECT_ID);
  console.log(
    `A deploy 12 minutes ago shipped 'checkout-v2'. Its Place Order button\n` +
      `silently stopped firing. Nothing threw. No stack trace exists.\n` +
      `Conventional error tracking sees NOTHING.\n`,
  );

  console.log("── DETECT ─────────────────────────────────────────────");
  const incidents = correlate(p.id, { windowMs: 3600_000 });
  for (const incident of incidents) {
    console.log(`  ${describeIncident(incident)}`);
    for (const reason of incident.reasoning) console.log(`      ${reason}`);
  }

  console.log("\n── TIER 0: CONTAIN ────────────────────────────────────");
  await heal(p, { windowMs: 3600_000, onProgress: (l) => console.log(l) });

  console.log("\n── RESULT ─────────────────────────────────────────────");
  const directives = resolve(config.dataDir, "projects", DEMO_PROJECT_ID, "directives.json");
  const fs = await import("node:fs");
  if (fs.existsSync(directives)) {
    console.log(`  directives served to the SDK:`);
    console.log(
      fs
        .readFileSync(directives, "utf8")
        .split("\n")
        .map((l) => "    " + l)
        .join("\n"),
    );
    console.log(`  → Recursive.enabled("checkout-v2") now returns false in every browser.`);
    console.log(`  → No deploy. No code change. Reversible by one inverse operation.`);
  }
  console.log(`\n  Run \`npm run cli -- audit --project ${DEMO_PROJECT_ID}\` for the decision trail.`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "projects":
      return cmdProjects();
    case "ingest":
      return cmdIngest();
    case "incidents":
      return cmdIncidents();
    case "health":
      return cmdHealth();
    case "heal":
      return cmdHeal();
    case "containment":
      return cmdContainment();
    case "audit":
      return cmdAudit();
    case "demo":
      return cmdDemo();
    case "snapshot":
      return cmdSnapshot();
    case "diagnose":
      return cmdDiagnose();
    case "score":
      return cmdScore();
    case "fix":
      return cmdFix();
    case "verify":
      return cmdVerify();
    case "status":
      return cmdStatus();
    default:
      console.log(HELP);
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

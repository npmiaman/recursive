#!/usr/bin/env node
import { resolve } from "node:path";
import { config } from "./config.ts";
import { fetchInsights } from "./clarity/client.ts";
import type { Dimension } from "./clarity/types.ts";
import { analyzeCohorts, explainAnalysis } from "./cohort/analyze.ts";
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
import { describeEngines, resolveFixer } from "./agents/fixers/index.ts";
import { Retriever } from "./retrieve/index.ts";
import { describeProvider, resolveProvider } from "./llm/provider.ts";
import { Repo, derivedReleases } from "./repo/git.ts";
import { sweep } from "./sweep/sweep.ts";
import { stats as memoryStats } from "./memory/store.ts";
import { buildBaseMemory, baseMemoryStats } from "./memory/base.ts";
import { findSimilarCases } from "./memory/match.ts";
import { allLessons } from "./memory/recall.ts";
import { EXAMPLE_MANIFEST, loadFlows } from "./sweep/flows.ts";
import { repairFlow } from "./loop/repair.ts";
import { seedScenario, DEMO_PROJECT_ID } from "./demo.ts";

const HELP = `
Recursive, detect breakage (including the silent kind), contain it, repair it.

DETECT
 ingest [file]       Ingest a telemetry batch (JSON file, or stdin).
 health              Run synthetic journey checks, needs no live traffic.
 incidents           Correlate recent signals into incidents.
                        --project ID target project
                        --window N minutes to correlate (default 60)

TIER 0. CONTAIN (seconds, reversible, no human)
 heal                Evaluate incidents and contain what is safely containable.
                        --dry-run evaluate guardrails, execute nothing
 containment         Did containment actually work? Reverts trust if not.
 audit               Immutable log of every autonomous action and why.

TIER 1. REPAIR (minutes, always a PR)
 snapshot            Pull Clarity data into the local time series.
                        --dimensions A,B e.g. URL,Device (max 3, costs 1 call)
 cohorts             Find groups of users hit far harder than everyone else.
                        --dimension D     Device | Browser | OS | Source | Country/Region
 diagnose            Rank friction issues from the latest snapshot.
 score <index>       Measure one issue's page with the headless probe.
 fix [index]         Hill-climb a fix, then open a PR.
                        --top-issue pick the highest-severity issue
                        --max-iter N cap iterations (default ${config.maxIterations})
                        --dry-run commit to a branch, don't push
 verify              Re-sample Clarity to confirm shipped fixes worked.

SWEEP, browsing-agent regression runs (rhai)
 sweep init          Write a starter recursive.flows.json into the repo.
 sweep pr            Test only the flows a diff put at risk. Fast; gates a merge.
                        --base REF diff against (default HEAD~1)
 sweep daily         Test every core flow plus the highest-risk remainder.
                        --max N cap flows (default 12)
 sweep               Either mode: --dry-run to see the plan, --watch to see the browser.
                        --engine E        'internal' (fast, default) or 'rhai'
                        --concurrency N flows at once (default 3)
                        --repair fix what breaks, don't just report it

REPAIR. Tier 1: change the code until the flow actually passes
 config              Model config, once, for every project.
                        config nvidia <key>        free NVIDIA (40 RPM), for testing
                        config anthropic <key>     paid Claude, for launch
                        config proxy <url> <token>  a hosted proxy: no key on this laptop
 init                Set up Recursive in the current project (run this first).
 doctor              Check every subsystem works against a codebase.
                        --repo PATH       codebase to check
 repair FLOW_ID      Fix a failing flow, verifying after every change by
 re-running the real user journey AND checking the server.
                      Loops until it passes or it can honestly say it is stuck.
                        --repo PATH repo to edit
                        --cycles N max attempts (default 4)
                        --base REF branch to base off / target (default main)
                        --only PATHS comma-separated paths the agent may edit
                        --no-pr commit to the area branch, don't open a PR
                        --auto-merge      AUTO-PR: merge the PR too, not just open it
                        --merge-method M  squash (default) | merge | rebase
                        --dry-run diagnose and verify, change nothing

MEMORY, permanent, per-project, never deleted
 memory index        Build BASE memory: read every file, learn what it does.
                        --repo PATH repo to index
                        --enrich N cap on model summaries (default 1500 = all)
                        --no-enrich structural only, no model calls
                        --full re-index everything, not just changed files
 memory              What this project has learned: counts, lessons, hit rate.
 memory search "..." Find past failures similar to a description.

CODEBASE
 retrieve            Find the code relevant to a failure. Shows how it decided.
                        --message "..." error text or description
                        --stack-file F file containing a stack trace
                        --selector "..."  CSS selector implicated
                        --route /path where it happened
                        --at ISO when it first appeared (uses git history)
                        --repo PATH repo to search (default TARGET_REPO_PATH)
                        --expand translate the failure into code vocabulary first
                        --rerank have a model read the shortlist and reorder it
 history             What git knows: recent releases, churn, suspect commits.

GENERAL
 engines             Which code-edit engines are available, and their licences.
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

  // Up to three dimensions ride on ONE call. Pulling URL+Device together is how
  // cohort analysis stays inside the 10-calls-a-day budget.
  const dimensions = (arg("dimensions") ?? "URL")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean) as Dimension[];

  const snapshot = await fetchInsights({
    numOfDays: days as 1 | 2 | 3,
    dimensions,
    label: `cli-snapshot(${dimensions.join("+")})`,
  });
  store.append(snapshot);

  const metrics = snapshot.payload.map((b) => `${b.metricName}(${b.information.length})`);
  console.log(`✓ ${snapshot.source} snapshot stored, ${metrics.join(", ")}`);
  console.log(`  ${store.count()} snapshot(s) in local history.`);
  if (snapshot.source === "mock") {
    console.log("  (fixtures, set CLARITY_API_TOKEN for live data)");
  }
}

async function cmdDiagnose(): Promise<void> {
  const issues = await loadIssues();
  const top = Number(arg("top") ?? 10);

  if (issues.length === 0) {
    console.log("No friction issues cleared the thresholds. Try --min-sessions 0.");
    return;
  }

  console.log(
    `\n${issues.length} issue(s) found. Top ${Math.min(top, issues.length)} by severity:\n`,
  );
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
    `\nThe probe says this is better. Clarity hasn't voted yet, ` +
      `run \`npm run verify\` in ${config.verifyAfterDays} days.`,
  );
}

async function cmdVerify(): Promise<void> {
  await verify({ force: flag("force") });
}

/**
 * `recursive doctor`, a capability self-check.
 *
 * Answers one question: is every subsystem Recursive depends on actually
 * working, here, against this codebase? Each check runs the real code path (not
 * a mock) and reports pass, warn, or fail with a concrete detail. Run it after
 * pointing Recursive at a new repository, before trusting a sweep.
 */
async function cmdDoctor(): Promise<void> {
  const repoPath = arg("repo") ?? config.targetRepoPath ?? ".";
  const project = resolveProject(arg("project"));

  type Status = "pass" | "warn" | "fail";
  const results: { name: string; status: Status; detail: string }[] = [];
  const add = (name: string, status: Status, detail: string) => results.push({ name, status, detail });
  const run = async (name: string, fn: () => Promise<[Status, string]>) => {
    try {
      const [status, detail] = await fn();
      add(name, status, detail);
    } catch (error) {
      add(name, "fail", error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error));
    }
  };

  console.log(`\nRecursive doctor, checking ${repoPath} (project ${project.id})\n`);

  // 1. Reasoning model ACTUALLY WORKS.
  //
  // Not just preflight: a bad key routinely passes the shallow /models probe and
  // then 403s on a real completion. doctor exists to catch exactly that false
  // green, so it makes a real (tiny) call and reports what happened.
  await run("reasoning model", async () => {
    const { resolveProvider, describeProvider } = await import("./llm/provider.ts");
    const { z } = await import("zod");
    const d = describeProvider();
    try {
      await resolveProvider().structured(
        z.object({ ok: z.boolean() }),
        'Reply with exactly {"ok": true}.',
        { maxTokens: 500 },
      );
      return ["pass", `${d.name} - ${d.model} (verified with a live call)`];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An auth / quota / network failure means the model is unusable, and that
      // must be a FAIL, not a warning: every model-powered step will break.
      if (/401|403|forbidden|authorization|unauthorized|credential|api key|enotfound|econnrefused|no content|quota|429/i.test(message)) {
        return ["fail", `${d.model} configured but the live call failed: ${message.slice(0, 150)}`];
      }
      // Reached the model, but its output did not parse or validate. The key
      // works; the model is just messy. Usable, worth flagging.
      return ["warn", `${d.model} reachable but returned unexpected output: ${message.slice(0, 110)}`];
    }
  });

  // 2. Code-editing engine ready. The Claude engine only warns when its key is
  //    missing (login profiles also count), so check the credential explicitly
  //    rather than trusting a soft preflight.
  await run("fix engine", async () => {
    const { resolveFixer } = await import("./agents/fixers/index.ts");
    const fixer = resolveFixer();
    await fixer.preflight();
    if (
      fixer.name === "claude-agent-sdk" &&
      !process.env["ANTHROPIC_API_KEY"] &&
      !process.env["ANTHROPIC_AUTH_TOKEN"] &&
      !process.env["ANTHROPIC_PROFILE"]
    ) {
      return ["warn", "claude-agent-sdk selected but no Anthropic credential; set FIX_ENGINE=agentic to use your LLM_PROVIDER model"];
    }
    return ["pass", `${fixer.name} ready`];
  });

  // 3. Browser (the sweep's eyes).
  await run("headless browser", async () => {
    const { enginePreflight } = await import("./sweep/engine.ts");
    const r = await enginePreflight("internal");
    return r.ok ? ["pass", "Chromium launches"] : ["fail", r.reason ?? "unavailable"];
  });

  // 4. Target is a real git checkout (the change oracle).
  await run("git repository", async () => {
    const { Repo } = await import("./repo/git.ts");
    const repo = new Repo(repoPath);
    if (!repo.isRepo()) return ["fail", "not a git repository"];
    const dirty = repo.dirtyFiles().length;
    return dirty === 0
      ? ["pass", `clean at ${repo.currentBranch()}`]
      : ["warn", `${dirty} uncommitted file(s); the repair loop reverts by hard-reset`];
  });

  // 5. Flow manifest (what the sweep exercises).
  let manifest: import("./sweep/flows.ts").FlowManifest | undefined;
  await run("flow manifest", async () => {
    manifest = loadFlows(repoPath);
    if (!manifest) return ["warn", "no recursive.flows.json; run `sweep init` to create one"];
    const critical = manifest.flows.filter((f) => f.critical).length;
    return ["pass", `${manifest.flows.length} flow(s), ${critical} critical`];
  });

  // 6. Base memory (does it know this codebase yet).
  await run("base memory", async () => {
    const { baseMemoryStats } = await import("./memory/base.ts");
    const s = baseMemoryStats(project.id);
    if (s.files === 0) return ["warn", "not indexed; run `memory index`"];
    return ["pass", `${s.files} file(s), ${s.enriched} with model summaries`];
  });

  // 7. Retrieval builds an index over the repo.
  await run("retrieval", async () => {
    const { Retriever } = await import("./retrieve/index.ts");
    const r = new Retriever(repoPath, project.id);
    const stats = r.build();
    return stats.chunks > 0
      ? ["pass", `${stats.files} file(s) - ${stats.chunks} chunk(s)`]
      : ["fail", "indexed zero chunks"];
  });

  // 8. Memory store is writable and readable (append-only round-trip).
  await run("memory store", async () => {
    const { append } = await import("./memory/store.ts");
    const { recall } = await import("./memory/recall.ts");
    const probeId = `doctor-${project.id}`;
    const probe: import("./memory/types.ts").FailureRecord = {
      type: "failure",
      id: "",
      projectId: probeId,
      at: new Date().toISOString(),
      fingerprint: "doctor:probe",
      signalClass: "doctor",
      route: "/doctor",
      message: "doctor write probe",
      implicatedFiles: [],
    };
    append(probe);
    const back = recall({
      projectId: probeId,
      fingerprint: "doctor:probe",
      signalClass: "doctor",
      route: "/doctor",
      message: "doctor write probe",
      implicatedFiles: [],
    });
    return back.cases.length > 0 ? ["pass", "append and recall work"] : ["fail", "wrote but could not read back"];
  });

  // 9. Backend trace endpoint (how "did the backend really work" is answered).
  await run("backend trace", async () => {
    if (!manifest?.backendTraceUrl) return ["warn", "no backendTraceUrl in flows.json; backend checks limited to postconditions"];
    const token = manifest.backendTokenEnv ? process.env[manifest.backendTokenEnv] : undefined;
    const res = await fetch(manifest.backendTraceUrl, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000),
    }).catch((e) => {
      throw new Error(`unreachable: ${e instanceof Error ? e.message : e}`);
    });
    return res.ok ? ["pass", `reachable (${res.status})`] : ["fail", `returned ${res.status}`];
  });

  // ---- report ----
  const mark = (s: Status) => (s === "pass" ? "✓" : s === "warn" ? "!" : "✗");
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`  ${mark(r.status)} ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;
  console.log(
    `\n  ${results.length - fails - warns} passing, ${warns} warning(s), ${fails} failing.` +
      (fails ? " Fix the failing checks before running a sweep." : " Ready.") +
      "\n",
  );
  if (fails) process.exitCode = 1;
}

/**
 * `recursive config`, the global model configuration.
 *
 * This is what makes "set my key once, use it in every codebase" work. It reads
 * and writes `~/.recursive/.env`, which config.ts loads as a fallback beneath
 * each project's own .env. So you configure a model here once and every project
 * you point Recursive at inherits it, without a key ever being committed to any
 * repository.
 *
 *   recursive config                      show what is set (secrets masked)
 *   recursive config nvidia <nvapi-key>   set the whole free-NVIDIA bundle
 *   recursive config OPENAI_MODEL <name>  set any single variable
 */
async function cmdConfig(): Promise<void> {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const globalEnv = resolve(os.homedir(), ".recursive", ".env");

  const setVar = (key: string, value: string): void => {
    fs.mkdirSync(resolve(os.homedir(), ".recursive"), { recursive: true });
    const lines = fs.existsSync(globalEnv) ? fs.readFileSync(globalEnv, "utf8").split("\n") : [];
    const kept = lines.filter((l) => l.trim() && !l.startsWith(`${key}=`));
    kept.push(`${key}=${value}`);
    // 0600: this file holds a secret. It lives in ~/.recursive, never in a repo.
    fs.writeFileSync(globalEnv, kept.join("\n") + "\n", { mode: 0o600 });
  };

  const sub = process.argv[3];
  const value = process.argv[4];

  // Show.
  if (!sub) {
    console.log(`\nGlobal config: ${globalEnv}`);
    if (!fs.existsSync(globalEnv)) {
      console.log(`  (nothing set yet)\n\n  Set the free NVIDIA model in every project with:`);
      console.log(`    recursive config nvidia nvapi-...\n`);
      return;
    }
    for (const line of fs.readFileSync(globalEnv, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (!m) continue;
      const secret = /KEY|SECRET|TOKEN/.test(m[1]!) && m[2];
      const shown = secret && m[2]!.length > 10 ? `${m[2]!.slice(0, 6)}…${m[2]!.slice(-4)}` : m[2];
      console.log(`  ${m[1]}=${shown}`);
    }
    console.log(`\n  Used by Recursive in every project (a project's own .env overrides it).\n`);
    return;
  }

  // One-shot provider setups: the common cases. Each writes the whole bundle so
  // switching providers is a single command and never leaves a half-configured
  // state. NVIDIA is the free testing tier (40 RPM, paced); anthropic and openai
  // are the paid tiers to switch to at launch, where RPM pacing is turned off.
  if (sub === "nvidia") {
    if (!value || !value.startsWith("nvapi-")) {
      console.error("Usage: recursive config nvidia <nvapi-...key>   (free at build.nvidia.com)");
      process.exit(1);
    }
    setVar("LLM_PROVIDER", "openai");
    setVar("OPENAI_BASE_URL", "https://integrate.api.nvidia.com/v1");
    setVar("OPENAI_MODEL", "deepseek-ai/deepseek-v4-flash");
    setVar("OPENAI_API_KEY", value);
    setVar("OPENAI_RPM", "40");
    setVar("FIX_ENGINE", "agentic");
    console.log(`\n  ✓ NVIDIA free model configured globally (${globalEnv}).`);
    console.log(`  40 RPM, paced automatically. Every project will use it. Verify with:`);
    console.log(`    recursive doctor\n`);
    return;
  }

  if (sub === "anthropic") {
    if (!value || !value.startsWith("sk-ant-")) {
      console.error("Usage: recursive config anthropic <sk-ant-...key>");
      process.exit(1);
    }
    setVar("LLM_PROVIDER", "anthropic");
    setVar("ANTHROPIC_API_KEY", value);
    setVar("OPENAI_RPM", "0"); // paid: no free-tier pacing
    setVar("FIX_ENGINE", "claude-agent-sdk"); // best code-editing engine, needs this key
    console.log(`\n  ✓ Anthropic (paid) configured globally.`);
    console.log(`  No RPM pacing. Switched the fix engine to claude-agent-sdk. Verify with:`);
    console.log(`    recursive doctor\n`);
    return;
  }

  if (sub === "openai") {
    if (!value || !value.startsWith("sk-")) {
      console.error("Usage: recursive config openai <sk-...key> [model]   (default gpt-4o)");
      process.exit(1);
    }
    setVar("LLM_PROVIDER", "openai");
    setVar("OPENAI_BASE_URL", "https://api.openai.com/v1");
    setVar("OPENAI_MODEL", process.argv[5] ?? "gpt-4o");
    setVar("OPENAI_API_KEY", value);
    setVar("OPENAI_RPM", "0"); // paid: no free-tier pacing
    setVar("FIX_ENGINE", "agentic");
    console.log(`\n  ✓ OpenAI (paid) configured globally, model ${process.argv[5] ?? "gpt-4o"}.`);
    console.log(`  No RPM pacing. Verify with:  recursive doctor\n`);
    return;
  }

  // Point at a hosted proxy (apps/proxy) that holds the key server-side. This
  // is what lets a laptop use the model with NO key of its own: it presents the
  // shared proxy token, and the proxy swaps in the real key upstream.
  if (sub === "proxy") {
    if (!value) {
      console.error("Usage: recursive config proxy <https://your-proxy/v1> [token]");
      process.exit(1);
    }
    const token = process.argv[5];
    setVar("LLM_PROVIDER", "openai");
    setVar("OPENAI_BASE_URL", value.replace(/\/+$/, ""));
    setVar("OPENAI_MODEL", "deepseek-ai/deepseek-v4-flash");
    // The "key" a laptop holds is only the proxy token, not the upstream key.
    // If the proxy is open (no token), a placeholder satisfies the client's
    // "a key is present" check while the proxy ignores it.
    setVar("OPENAI_API_KEY", token ?? "via-proxy");
    setVar("OPENAI_RPM", "40");
    setVar("FIX_ENGINE", "agentic");
    console.log(`\n  ✓ Using the hosted proxy at ${value}. No model key stored on this machine.`);
    console.log(`  Verify with:  recursive doctor\n`);
    return;
  }

  // Set a single variable.
  if (!value) {
    console.error(`Usage: recursive config <NAME> <value>   e.g. recursive config OPENAI_MODEL deepseek-ai/deepseek-v4-pro`);
    process.exit(1);
  }
  setVar(sub, value);
  console.log(`Set ${sub} globally in ${globalEnv} (used by Recursive in every project).`);
}

/**
 * `recursive init`, onboard Recursive into the project it is run from.
 *
 * The first command a developer runs after installing. Registers the current
 * directory as a project, drops a starter flow manifest and a `.env` template,
 * and prints the two-step path to a first sweep. Everything lands in the
 * project, not in the global install: memory in `.recursive/`, the manifest and
 * env at the repo root.
 */
async function cmdInit(): Promise<void> {
  const fs = await import("node:fs");
  const { basename } = await import("node:path");
  const repoPath = arg("repo") ?? process.cwd();
  const id = (arg("project") ?? basename(resolve(repoPath))).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const baseUrl = arg("url") ?? "http://localhost:3000";

  console.log(`\nSetting up Recursive in ${repoPath}\n`);

  const repo = new Repo(repoPath);
  if (!repo.isRepo()) {
    console.error("This is not a git repository. Recursive reads git history, so run `git init` first.");
    process.exit(1);
  }

  // 1. Register the project.
  const { upsertProject } = await import("./tenant.ts");
  upsertProject({
    id,
    tenantId: "local",
    name: id,
    environment: "development",
    baseUrl,
    repoPath: resolve(repoPath),
    guardrails: { autonomyEnabled: false },
  } as never);
  console.log(`  ✓ registered project '${id}' -> ${baseUrl}`);

  // 2. Flow manifest.
  const manifest = resolve(repoPath, "recursive.flows.json");
  if (fs.existsSync(manifest) && !flag("force")) {
    console.log(`  · recursive.flows.json already exists (kept)`);
  } else {
    fs.writeFileSync(manifest, JSON.stringify({ ...EXAMPLE_MANIFEST, baseUrl }, null, 2) + "\n");
    console.log(`  ✓ wrote recursive.flows.json (edit it to describe your real user journeys)`);
  }

  // 3. Model config.
  //
  // If a model is already configured globally (`recursive config nvidia <key>`),
  // this project inherits it and needs no .env at all. Only write a template
  // when there is nothing to fall back on, so a user who set their key once is
  // never asked to set it again per project.
  const envPath = resolve(repoPath, ".env");
  if (process.env["OPENAI_API_KEY"] || process.env["ANTHROPIC_API_KEY"]) {
    console.log(`  ✓ using your global model config (recursive config to view)`);
  } else if (!fs.existsSync(envPath)) {
    fs.writeFileSync(
      envPath,
      [
        "# Recursive configuration. This file is secret; add it to .gitignore.",
        "# A free model powers indexing, diagnosis and code-writing.",
        "LLM_PROVIDER=openai",
        "OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1",
        "OPENAI_MODEL=deepseek-ai/deepseek-v4-flash",
        "# Paste your key below (free at build.nvidia.com, no card). Leave it",
        "# empty and `recursive doctor` will tell you the model is not working,",
        "# rather than pretending it is.",
        "OPENAI_API_KEY=",
        "OPENAI_RPM=40",
        "FIX_ENGINE=agentic",
        "",
      ].join("\n"),
    );
    console.log(`  ✓ wrote a .env template (add your model key, then add .env to .gitignore)`);
  } else {
    console.log(`  · .env already exists (kept)`);
  }

  console.log(`\nNext:`);
  console.log(`  1. put a model key in .env  (free: build.nvidia.com)`);
  console.log(`  2. recursive doctor         # confirm everything works`);
  console.log(`  3. recursive memory index   # learn this codebase`);
  console.log(`  4. recursive sweep daily    # test it in a browser`);
  console.log(`  5. recursive sweep daily --repair   # and fix what breaks\n`);
}

async function cmdStatus(): Promise<void> {
  const b = budget.state();
  console.log(`\nClarity API budget   ${b.remaining}/${b.limit} remaining today (${b.date} UTC)`);
  console.log(
    `Mode                 ${config.clarityMode}${config.clarityToken ? "" : " (no token, using fixtures)"}`,
  );
  console.log(`Snapshots stored     ${store.count()}`);
  console.log(`Target site          ${config.targetBaseUrl}`);
  console.log(`Target repo          ${config.targetRepoPath ?? "(unset, fix loop disabled)"}`);

  const shipped = readShipped();
  const verified = shipped.filter((f) => f.verification);
  console.log(`\nShipped fixes        ${shipped.length} (${verified.length} verified)`);
  for (const fix of shipped.slice(-8)) {
    const v = fix.verification;
    const mark = !v ? "pending" : v.verdict;
    console.log(
      `  [${mark.padEnd(12)}] ${fix.kind} on ${fix.url}${fix.prUrl ? `, ${fix.prUrl}` : ""}`,
    );
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
    console.log(` base URL      ${p.baseUrl}`);
    console.log(
      ` containment flags=${p.containment.flagProvider} deploy=${p.containment.deployProvider}`,
    );
    console.log(
      ` autonomy      ${g.autonomyEnabled ? "ENABLED" : "disabled"}, ` +
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

  console.log(
    `\n${p.id}, ${readSignals(p.id, windowMs).length} signal(s) in the last ${Math.round(windowMs / 60000)}m\n`,
  );
  if (incidents.length === 0) {
    console.log(" no incidents");
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
        (r.ok ? "" : `\n failed at '${r.failedStep}': ${r.reason}`),
    );
  }
  if (signals.length) console.log(`\n${signals.length} failure signal(s) recorded.`);
}

async function cmdHeal(): Promise<void> {
  const p = project();
  const windowMs = Number(arg("window") ?? 60) * 60_000;
  console.log(`\nTier 0, contain  [${p.id}]${flag("dry-run") ? "  (dry run)" : ""}\n`);
  const report = await heal(p, { windowMs, dryRun: flag("dry-run") });
  const executed = report.outcomes.filter((o) => o.executed).length;
  const blocked = report.outcomes.filter((o) => !o.executed && o.blockedBy.length).length;
  console.log(
    `\n${report.incidentsConsidered} incident(s) considered, ${executed} contained, ${blocked} not acted on.`,
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
    console.log("No audit records, nothing autonomous has run for this project.");
    return;
  }
  console.log(`\n${records.length} audit record(s) for ${p.id}:\n`);
  for (const r of records.slice(-25)) {
    console.log(`  [${r.outcome.padEnd(8)}] ${r.at}  ${r.action}  (${r.actor})`);
    if (r.incidentId) console.log(` incident: ${r.incidentId}`);
    const blocked = r.detail["blockedBy"];
    if (Array.isArray(blocked)) for (const b of blocked) console.log(` blocked: ${b}`);
    const rationale = r.detail["rationale"];
    if (typeof rationale === "string") console.log(` why: ${rationale}`);
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
    console.log(` directives served to the SDK:`);
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
  console.log(
    `\n  Run \`npm run cli -- audit --project ${DEMO_PROJECT_ID}\` for the decision trail.`,
  );
}

async function cmdSweep(): Promise<void> {
  const sub = process.argv[3];
  const repoPath = arg("repo") ?? config.targetRepoPath;
  if (!repoPath) {
    console.error("Set --repo or TARGET_REPO_PATH.");
    process.exit(1);
  }

  if (sub === "init") {
    const fs = await import("node:fs");
    const target = resolve(repoPath, "recursive.flows.json");
    if (fs.existsSync(target) && !flag("force")) {
      console.error(`${target} already exists. Pass --force to overwrite.`);
      process.exit(1);
    }
    fs.writeFileSync(target, JSON.stringify(EXAMPLE_MANIFEST, null, 2) + "\n");
    console.log(`Wrote ${target}`);
    console.log(`\nEdit it to describe your real flows, then:`);
    console.log(` npm run cli -- sweep daily --dry-run`);
    return;
  }

  const mode = sub === "pr" ? "pr" : "daily";
  const project = resolveProject(arg("project"));

  const result = await sweep({
    repoPath,
    projectId: project.id,
    mode,
    baseRef: arg("base"),
    maxFlows: arg("max") ? Number(arg("max")) : undefined,
    headless: !flag("watch"),
    dryRun: flag("dry-run"),
    engine: (arg("engine") as "rhai" | "internal") ?? "internal",
    concurrency: arg("concurrency") ? Number(arg("concurrency")) : undefined,
  });

  // A sweep that only reports is half the product. With --repair, every
  // confirmed break goes straight into the closed loop: change the code,
  // re-run the journey, check the server, repeat until it genuinely passes.
  //
  // Opt-in rather than default because it edits a repository and opens PRs,
  // and CI gating (the common case for `sweep pr`) should stay read-only.
  if (flag("repair") && result.confirmed.length > 0) {
    const manifest = loadFlows(repoPath);
    if (!manifest) {
      console.error("No recursive.flows.json, cannot repair without the manifest.");
      process.exitCode = 1;
      return;
    }

    console.log(`\n── TIER 1: REPAIR ─────────────────────────────────────`);
    for (const confirmed of result.confirmed) {
      console.log(`\n${confirmed.flow.name}`);
      try {
        const repair = await repairFlow({
          projectId: project.id,
          repoPath,
          flow: confirmed.flow,
          manifest,
          failureSummary: confirmed.results.at(-1)?.summary ?? "flow failed",
          transcript: confirmed.results.at(-1)?.transcript,
          backend: confirmed.backend,
          maxCycles: arg("cycles") ? Number(arg("cycles")) : undefined,
          engine: (arg("engine") as "rhai" | "internal") ?? "internal",
          headless: !flag("watch"),
          baseBranch: arg("base"),
          openPr: !flag("no-pr"),
          autoMerge: flag("auto-merge"),
          mergeMethod: (arg("merge-method") as "squash" | "merge" | "rebase") ?? undefined,
          dryRun: flag("dry-run"),
          onProgress: (l) => console.log(l),
        });
        // A verified repair clears the CI failure for that flow; an unresolved
        // one does not, and must keep the build red.
        if (!repair.loop.resolved) process.exitCode = 1;
      } catch (error) {
        console.error(` repair failed: ${error instanceof Error ? error.message : error}`);
        process.exitCode = 1;
      }
    }
    return;
  }

  if (result.confirmed.length > 0) process.exitCode = 1; // fail CI on a real break
}

/**
 * Repair one flow by name, without running a sweep first.
 *
 * The path a developer takes when they already know what is broken, and the
 * one that makes the closed loop testable on its own, rather than only as the
 * tail end of a twelve-minute sweep.
 */
async function cmdRepair(): Promise<void> {
  const flowId = process.argv[3];
  const repoPath = arg("repo") ?? config.targetRepoPath;

  if (!flowId || flowId.startsWith("--")) {
    console.error("Usage: repair FLOW_ID   (see `sweep init` for flow ids)");
    process.exit(1);
  }
  if (!repoPath) {
    console.error("Set --repo or TARGET_REPO_PATH.");
    process.exit(1);
  }

  const manifest = loadFlows(repoPath);
  if (!manifest) {
    console.error(`No recursive.flows.json in ${repoPath}. Run \`sweep init\` first.`);
    process.exit(1);
  }

  const flow = manifest.flows.find((f) => f.id === flowId);
  if (!flow) {
    console.error(
      `No flow '${flowId}'. Known flows: ${manifest.flows.map((f) => f.id).join(", ")}`,
    );
    process.exit(1);
  }

  const project = resolveProject(arg("project"));
  console.log(`\nRepairing '${flow.name}'${flag("dry-run") ? "  (dry run)" : ""}\n`);

  const result = await repairFlow({
    projectId: project.id,
    repoPath,
    flow,
    manifest,
    failureSummary: arg("because") ?? `${flow.name} is failing its expectation: ${flow.expect}`,
    maxCycles: arg("cycles") ? Number(arg("cycles")) : undefined,
    engine: (arg("engine") as "rhai" | "internal") ?? "internal",
    headless: !flag("watch"),
    baseBranch: arg("base"),
    repairOnlyPaths: arg("only")
      ?.split(",")
      .map((p) => p.trim())
      .filter(Boolean),
    openPr: !flag("no-pr"),
    autoMerge: flag("auto-merge"),
    mergeMethod: (arg("merge-method") as "squash" | "merge" | "rebase") ?? undefined,
    dryRun: flag("dry-run"),
    onProgress: (l) => console.log(l),
  });

  if (!result.loop.resolved) process.exitCode = 1;
}

async function cmdCohorts(): Promise<void> {
  const dimension = (arg("dimension") ?? "Device") as Dimension;

  // Prefer a snapshot that actually carries this dimension; the newest pull may
  // have been URL-only.
  const usable = store
    .readAll()
    .filter((s) => s.dimensions.includes(dimension) && s.dimensions.includes("URL"));
  const snapshot = usable[usable.length - 1];

  if (!snapshot) {
    console.error(
      `No snapshot with both URL and ${dimension}.\n` +
        `Pull one with: npm run cli -- snapshot --dimensions URL,${dimension}`,
    );
    process.exit(1);
  }

  const findings = analyzeCohorts(snapshot, dimension, {
    minSessions: arg("min-sessions") ? Number(arg("min-sessions")) : undefined,
    minLift: arg("min-lift") ? Number(arg("min-lift")) : undefined,
  });

  console.log(
    `\nCohort analysis, split by ${dimension}  (${snapshot.source} data, ${snapshot.fetchedAt.slice(0, 10)})\n`,
  );
  for (const line of explainAnalysis(snapshot, dimension, findings)) console.log(`  ${line}`);

  if (findings.length === 0) return;

  console.log(`\n${findings.length} cohort(s) significantly worse than everyone else:\n`);
  for (const finding of findings) {
    console.log(`  [${String(finding.severity).padStart(3)}] ${finding.summary}`);
    console.log(
      `        ${finding.cohortAffected}/${finding.cohortSessions} sessions vs ` +
        `${finding.baselineAffected}/${finding.baselineSessions} elsewhere · ` +
        `p=${finding.test.pValue < 1e-6 ? "<1e-6" : finding.test.pValue.toExponential(1)}`,
    );
    console.log();
  }
  console.log(`These flow into the same diagnose → fix → verify loop as everything else.`);
}

async function cmdMemory(): Promise<void> {
  const project = resolveProject(arg("project"));
  const sub = process.argv[3];

  if (sub === "index") {
    const repoPath = arg("repo") ?? config.targetRepoPath;
    if (!repoPath) {
      console.error("Set --repo or TARGET_REPO_PATH.");
      process.exit(1);
    }
    console.log(`\nBuilding base memory for ${project.id}…\n`);
    const result = await buildBaseMemory({
      projectId: project.id,
      repoPath,
      enrichBudget: flag("no-enrich") ? 0 : arg("enrich") ? Number(arg("enrich")) : undefined,
      incremental: !flag("full"),
      onProgress: (line) => console.log(`  ${line}`),
    });
    console.log(`\n  ${result.filesIndexed} file(s) indexed, ${result.filesSkipped} unchanged`);
    if (result.filesEnriched)
      console.log(`  ${result.filesEnriched} enriched with model summaries`);
    if (result.mostCentral.length) {
      console.log(`\n  Most depended-on files (a bug here hurts most):`);
      for (const file of result.mostCentral.slice(0, 6)) {
        console.log(`    ${String(file.importedBy).padStart(3)} dependents  ${file.path}`);
      }
    }
    const b = baseMemoryStats(project.id);
    console.log(`\n  Base memory now covers ${b.files} file(s), ${b.enriched} with summaries.`);
    console.log(
      `  Areas: ${Object.entries(b.areas)
        .map(([a, n]) => `${a}(${n})`)
        .join(", ")}\n`,
    );
    return;
  }

  if (sub === "search") {
    const query = process.argv[4];
    if (!query) {
      console.error('Usage: memory search "description of the failure"');
      process.exit(1);
    }
    const found = findSimilarCases({
      projectId: project.id,
      fingerprint: "",
      signalClass: arg("class") ?? "",
      route: arg("route") ?? "",
      message: query,
      implicatedFiles: (arg("files") ?? "").split(",").filter(Boolean),
    });

    if (found.length === 0) {
      console.log("Nothing similar in memory.");
      return;
    }
    console.log(`\n${found.length} similar past failure(s):\n`);
    for (const recalled of found) {
      console.log(
        `  ${(recalled.similarity * 100).toFixed(0)}%  ${recalled.failure.signalClass} on ${recalled.failure.route}` +
          `  (${recalled.failure.at.slice(0, 10)}, matched by ${recalled.matchedBy.join(" + ")})`,
      );
      for (const reason of recalled.reasoning.slice(0, 2)) console.log(`         ${reason}`);
      const kept = recalled.attempts.filter((a) => a.outcome === "kept");
      const failed = recalled.attempts.filter((a) => a.outcome === "reverted");
      if (kept.length) console.log(`         ✓ worked: ${kept.map((a) => a.approach).join("; ")}`);
      if (failed.length)
        console.log(`         ✗ failed: ${failed.map((a) => a.approach).join("; ")}`);
      console.log();
    }
    return;
  }

  const base = baseMemoryStats(project.id);
  const s = memoryStats(project.id);
  console.log(`\nMemory for ${project.id}${s.oldest ? `, since ${s.oldest.slice(0, 10)}` : ""}\n`);
  console.log(` code changes recorded   ${s.changes}`);
  console.log(` failures recorded       ${s.failures}`);
  console.log(` fix attempts            ${s.attempts}`);
  console.log(` outcomes verified       ${s.outcomes}`);
  console.log(` lessons learned         ${s.lessons}`);
  console.log(`\n base memory (codebase)  ${base.files} file(s), ${base.enriched} with summaries`);
  if (s.attemptSuccessRate !== null) {
    console.log(` attempt success rate    ${(s.attemptSuccessRate * 100).toFixed(0)}%`);
  }

  const learned = allLessons(project.id);
  if (learned.length) {
    console.log(`\nWhat it has learned (most trusted first):\n`);
    for (const lesson of learned.slice(0, 10)) {
      console.log(`  [${lesson.confidence.toFixed(2)}] ${lesson.lesson}`);
    }
  }
  console.log(`\nThis memory is append-only and is never deleted.\n`);
}

async function cmdRetrieve(): Promise<void> {
  const repoPath = arg("repo") ?? config.targetRepoPath;
  if (!repoPath) {
    console.error("Set --repo or TARGET_REPO_PATH.");
    process.exit(1);
  }

  const stackFile = arg("stack-file");
  const stack = stackFile ? (await import("node:fs")).readFileSync(stackFile, "utf8") : undefined;
  const at = arg("at");

  const retriever = new Retriever(repoPath, resolveProject(arg("project")).id);
  const started = Date.now();
  const stats = retriever.build();
  const indexMs = Date.now() - started;

  console.log(`\nIndexed ${stats.files} file(s) → ${stats.chunks} chunk(s) in ${indexMs}ms\n`);

  const context = await retriever.retrieve(
    {
      message: arg("message"),
      stack,
      selector: arg("selector"),
      route: arg("route"),
      failedAt: at ? new Date(at) : undefined,
    },
    { expandQuery: flag("expand"), rerank: flag("rerank") },
  );

  console.log("How it decided:");
  for (const line of context.reasoning) console.log(`  • ${line}`);

  if (context.suspectCommit) {
    console.log(
      `\nSuspect commit: ${context.suspectCommit.shortSha} "${context.suspectCommit.subject}" ` +
        `(${context.suspectCommit.author})`,
    );
    if (context.changedFiles.length) {
      console.log(` changed: ${context.changedFiles.join(", ")}`);
    }
  }

  console.log(`\nTop results (~${context.approxTokens} tokens):\n`);
  context.chunks.forEach((ranked, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}. ${ranked.chunk.path}:${ranked.chunk.startLine}-${ranked.chunk.endLine}` +
        (ranked.chunk.symbol ? `  [${ranked.chunk.symbol}]` : ""),
    );
    console.log(` score ${ranked.score.toFixed(4)} via ${ranked.signals.join(" + ")}`);
  });
  console.log();
}

async function cmdHistory(): Promise<void> {
  const repoPath = arg("repo") ?? config.targetRepoPath;
  if (!repoPath) {
    console.error("Set --repo or TARGET_REPO_PATH.");
    process.exit(1);
  }

  const repo = new Repo(repoPath);
  if (!repo.isRepo()) {
    console.error(`${repoPath} is not a git repository.`);
    process.exit(1);
  }

  console.log(`\n${repoPath}  (branch ${repo.currentBranch()}, HEAD ${repo.head().slice(0, 8)})\n`);

  const releases = derivedReleases(repo, 8);
  console.log(
    `Releases, derived from ${releases[0]?.tagged ? "git tags" : "commit history (no tags found)"}:`,
  );
  for (const release of releases.slice(0, 8)) {
    console.log(
      `  ${release.id.padEnd(14)} ${release.at.slice(0, 19)}  ${release.subject.slice(0, 60)}`,
    );
  }

  const churn = [...repo.churn(30)].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (churn.length) {
    console.log(`\nMost-changed files (last 30 days), a weak prior on where bugs live:`);
    for (const [path, count] of churn) {
      console.log(`  ${String(count).padStart(3)} changes  ${path}`);
    }
  }
  console.log();
}

async function cmdEngines(): Promise<void> {
  const provider = describeProvider();
  console.log(`\nReasoning model, query expansion, reranking, investigation.\n`);
  console.log(` provider   ${provider.name}`);
  console.log(` model      ${provider.model}`);
  console.log(
    ` egress     ${provider.selfHosted ? "none: runs inside your network" : "prompts reach the provider API"}`,
  );
  try {
    await resolveProvider().preflight();
    console.log(` status     ✓ reachable`);
  } catch (error) {
    console.log(` status     ✗ ${error instanceof Error ? error.message.split("\n")[0] : error}`);
  }

  console.log(`\nCode-edit engines, which agent modifies customer repositories.\n`);
  for (const engine of describeEngines()) {
    console.log(`  ${engine.active ? "▸" : " "} ${engine.name}`);
    console.log(` licence        ${engine.licence}`);
    console.log(
      ` zero-egress    ${engine.selfContained ? "yes: can run entirely inside a customer network" : "no: prompts reach the model API (source code does not)"}`,
    );
  }
  console.log(`\n  Active: ${config.fixEngine}   (set FIX_ENGINE to change)`);
  if (config.fixEngine === "openhands") {
    console.log(
      `  Model:  ${config.openHandsModel}${config.openHandsBaseUrl ? ` @ ${config.openHandsBaseUrl}` : ""}`,
    );
  }

  // Report real usability, not just what's configured, a customer who picked an
  // engine they haven't installed should find out here, not mid-hill-climb.
  console.log();
  for (const name of ["claude-agent-sdk", "openhands"] as const) {
    try {
      await resolveFixer(name).preflight();
      console.log(`  ✓ ${name} is ready`);
    } catch (error) {
      console.log(`  ✗ ${name}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    }
  }
  console.log();
}

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "repair":
      await cmdRepair();
      break;
    case "sweep":
      return cmdSweep();
    case "cohorts":
      return cmdCohorts();
    case "memory":
      return cmdMemory();
    case "retrieve":
      return cmdRetrieve();
    case "history":
      return cmdHistory();
    case "engines":
      return cmdEngines();
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
    case "config":
      await cmdConfig();
      break;
    case "init":
      await cmdInit();
      break;
    case "doctor":
      await cmdDoctor();
      break;
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

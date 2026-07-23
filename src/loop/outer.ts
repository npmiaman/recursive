import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.ts";
import { fetchInsights } from "../clarity/client.ts";
import * as store from "../clarity/store.ts";
import { extractIssues } from "../diagnose/signals.ts";
import { readShipped, writeShipped, type ShippedFix } from "./ship.ts";
import type { IssueKind } from "../diagnose/issues.ts";

/**
 * The outer loop — the slow, real one.
 *
 * The inner loop optimizes a proxy. Proxies drift, and an unchecked proxy is
 * how an automated system ends up confidently shipping changes that make the
 * product worse. This loop closes that gap: days after a fix ships, it re-samples
 * Clarity and asks whether the real metric actually moved.
 *
 * It then does something more valuable than pass/fail — it records whether the
 * proxy *predicted* the real outcome, per issue kind. That calibration record is
 * how the probe weights earn or lose trust over time.
 */

/** Real-world movement smaller than this is indistinguishable from traffic noise. */
const NOISE_FLOOR = 0.005;

export interface Calibration {
  kind: IssueKind;
  /** Times the probe improved and Clarity agreed. */
  confirmed: number;
  /** Times the probe improved and Clarity did not move. */
  falsePositive: number;
  /** Times the probe improved and Clarity got worse. */
  harmful: number;
  /** Suggested trust multiplier for this probe, 0..1. */
  trust: number;
}

function calibrationPath(): string {
  return resolve(config.dataDir, "calibration.json");
}

export function readCalibration(): Record<string, Calibration> {
  const path = calibrationPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, Calibration>;
  } catch {
    return {};
  }
}

function writeCalibration(data: Record<string, Calibration>): void {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(calibrationPath(), JSON.stringify(data, null, 2));
}

function updateCalibration(fix: ShippedFix, verdict: ShippedFix["verification"]): void {
  if (!verdict) return;
  const all = readCalibration();
  const kind = fix.kind as IssueKind;
  const entry: Calibration = all[kind] ?? {
    kind,
    confirmed: 0,
    falsePositive: 0,
    harmful: 0,
    trust: 1,
  };

  if (verdict.verdict === "confirmed") entry.confirmed++;
  else if (verdict.verdict === "no-change") entry.falsePositive++;
  else if (verdict.verdict === "regressed") entry.harmful++;

  const total = entry.confirmed + entry.falsePositive + entry.harmful;
  // Harmful outcomes cost double — a probe that leads to regressions is worse
  // than one that leads nowhere.
  entry.trust =
    total === 0 ? 1 : Math.max(0, (entry.confirmed - entry.harmful) / total);

  all[kind] = entry;
  writeCalibration(all);
}

export interface VerifyOptions {
  /** Verify even fixes younger than VERIFY_AFTER_DAYS. */
  force?: boolean;
  onProgress?: (line: string) => void;
}

export interface VerifyReport {
  checked: number;
  skipped: number;
  results: { fix: ShippedFix; verdict: NonNullable<ShippedFix["verification"]> }[];
}

/**
 * Re-sample Clarity and settle up on every shipped fix that has had time to
 * accumulate traffic.
 *
 * Spends from the reserved half of the daily budget — verification is the one
 * call the system must always be able to make, since an unverified fix is worse
 * than no fix.
 */
export async function verify(options: VerifyOptions = {}): Promise<VerifyReport> {
  const log = options.onProgress ?? ((l: string) => console.log(l));
  const all = readShipped();

  const pending = all.filter((fix) => {
    if (fix.verification) return false;
    if (options.force) return true;
    const ageDays = (Date.now() - Date.parse(fix.shippedAt)) / 86_400_000;
    return ageDays >= config.verifyAfterDays;
  });

  const tooYoung = all.filter((f) => !f.verification && !pending.includes(f)).length;

  if (pending.length === 0) {
    log(
      `Nothing to verify. ${tooYoung} fix(es) still accumulating traffic ` +
        `(need ${config.verifyAfterDays} days; pass --force to check anyway).`,
    );
    return { checked: 0, skipped: tooYoung, results: [] };
  }

  log(`Verifying ${pending.length} shipped fix(es) against fresh Clarity data…`);

  // One pull covers every pending fix — the response is already broken down by URL.
  const snapshot = await fetchInsights({
    numOfDays: 3,
    dimensions: ["URL"],
    label: "outer-loop-verification",
    priority: "reserved",
  });
  store.append(snapshot);

  const current = new Map(
    extractIssues(snapshot, { minSessions: 0, minRate: 0 }).map((i) => [i.id, i]),
  );

  const results: VerifyReport["results"] = [];

  for (const fix of pending) {
    const now = current.get(fix.issueId);

    let verdict: NonNullable<ShippedFix["verification"]>;

    if (!now) {
      // The issue vanished from the data entirely — either fully fixed or the
      // page stopped getting traffic. Both are plausible; don't overclaim.
      verdict = {
        verifiedAt: new Date().toISOString(),
        clarityRateAfter: 0,
        delta: -fix.clarityRateBefore,
        verdict: fix.clarityRateBefore > 0.02 ? "confirmed" : "inconclusive",
        note:
          "Issue no longer present in Clarity data. This is a clean result if the page " +
          "still has comparable traffic; confirm traffic did not simply drop.",
      };
    } else {
      const delta = now.rate - fix.clarityRateBefore;
      const kind =
        delta < -NOISE_FLOOR ? "confirmed" : delta > NOISE_FLOOR ? "regressed" : "no-change";

      verdict = {
        verifiedAt: new Date().toISOString(),
        clarityRateAfter: now.rate,
        delta,
        verdict: kind,
        note:
          kind === "confirmed"
            ? `Real ${fix.kind} rate fell ${(Math.abs(delta) * 100).toFixed(2)}pp. The proxy predicted correctly.`
            : kind === "no-change"
              ? `Probe score improved ${(fix.probeBefore - fix.probeAfter).toFixed(4)} but the real rate moved only ${(delta * 100).toFixed(2)}pp. The proxy is measuring something users don't experience here.`
              : `Real ${fix.kind} rate ROSE ${(delta * 100).toFixed(2)}pp after this shipped. Consider reverting ${fix.prUrl ?? fix.branch}.`,
      };
    }

    fix.verification = verdict;
    updateCalibration(fix, verdict);
    results.push({ fix, verdict });

    const symbol =
      verdict.verdict === "confirmed" ? "✓" : verdict.verdict === "regressed" ? "✗" : "~";
    log(`  ${symbol} ${fix.kind} on ${fix.url}`);
    log(`      probe ${fix.probeBefore.toFixed(4)} → ${fix.probeAfter.toFixed(4)}`);
    log(
      `      clarity ${(fix.clarityRateBefore * 100).toFixed(2)}% → ${(verdict.clarityRateAfter * 100).toFixed(2)}%  [${verdict.verdict}]`,
    );
    log(`      ${verdict.note}`);
  }

  writeShipped(all);

  const calibration = readCalibration();
  const untrusted = Object.values(calibration).filter((c) => c.trust < 0.5);
  if (untrusted.length) {
    log(`\n⚠ Probe calibration warning — these probes are not predicting reality well:`);
    for (const c of untrusted) {
      log(
        `    ${c.kind}: trust ${c.trust.toFixed(2)} ` +
          `(${c.confirmed} confirmed, ${c.falsePositive} no-change, ${c.harmful} harmful)`,
      );
    }
    log(`  Tighten the corresponding probe in src/score/probes.ts before shipping more of these.`);
  }

  return { checked: pending.length, skipped: tooYoung, results };
}

import { generateMockResponse } from "../src/clarity/mock.ts";
import { analyzeCohorts } from "../src/cohort/analyze.ts";
import { compareProportions, isSignificant } from "../src/cohort/stats.ts";
import type { Snapshot } from "../src/clarity/types.ts";

/**
 * Cohort analysis must find the real thing and reject everything else.
 *
 * The second half is the harder half. A cohort analyser that reports something
 * every day is worse than none at all, people stop reading it, and then miss
 * the one day it was right. These tests pin down the three ways it must say no:
 * small samples, weak effects, and problems that are bad for *everyone*.
 *
 * Run: node --experimental-strip-types test/cohort.test.ts
 */

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) console.log(`✓ ${name}, ${detail}`);
  else {
    failures++;
    console.error(`✗ ${name}, ${detail}`);
  }
}

function snapshotWith(dimensions: ("URL" | "Device")[]): Snapshot {
  return {
    fetchedAt: new Date().toISOString(),
    numOfDays: 3,
    dimensions,
    source: "mock",
    payload: generateMockResponse(dimensions),
  };
}

// ---- 1. finds the planted signal ----------------------------------------
{
  const findings = analyzeCohorts(snapshotWith(["URL", "Device"]), "Device");
  const mobileCheckout = findings.find(
    (f) => f.url === "/checkout" && f.cohort === "Mobile" && f.kind === "dead-click",
  );

  check(
    "finds the cohort that is genuinely much worse",
    Boolean(mobileCheckout),
    mobileCheckout
      ? `${mobileCheckout.test.lift.toFixed(1)}× worse on Mobile, ${mobileCheckout.test.excessSessions} excess sessions`
      : "missed it",
  );

  check(
    "ranks the worst cohort first",
    findings[0]?.cohort === "Mobile" && findings[0]?.url === "/checkout",
    findings[0] ? `top finding: ${findings[0].summary.slice(0, 70)}…` : "no findings",
  );
}

// ---- 2. does NOT report a page that is bad for everyone ------------------
{
  const findings = analyzeCohorts(snapshotWith(["URL", "Device"]), "Device");
  const pricing = findings.filter((f) => f.url === "/pricing");

  // /pricing has a 14.8% dead-click rate site-wide, genuinely bad, and it IS
  // reported by the normal diagnosis path. But it is bad uniformly, so it is
  // not a *cohort* finding, and reporting it here would be noise.
  check(
    "does not report a problem that affects every cohort equally",
    pricing.length === 0,
    pricing.length === 0
      ? "/pricing correctly excluded (bad for everyone, not a cohort effect)"
      : `wrongly reported ${pricing.length} /pricing cohort(s)`,
  );
}

// ---- 3. rejects small samples -------------------------------------------
{
  // 9 of 12 sessions affected: a 75% rate against a 5% baseline. Enormous lift,
  // and completely meaningless, this is the single most common false positive
  // in cohort analysis.
  const test = compareProportions(9, 12, 50, 1000);
  const verdict = isSignificant(test, 12, { comparisons: 1 });

  check(
    "rejects a tiny cohort however extreme the rate looks",
    !verdict.significant,
    `${(test.rate * 100).toFixed(0)}% vs ${(test.baselineRate * 100).toFixed(0)}% rejected: ${verdict.rejectedBecause}`,
  );
}

// ---- 4. rejects a real but trivial difference ----------------------------
{
  // 11% vs 10% across large samples: statistically significant, practically
  // irrelevant. Significance without effect size is how teams get flooded.
  const test = compareProportions(1100, 10_000, 1000, 10_000);
  const verdict = isSignificant(test, 10_000, { comparisons: 1 });

  check(
    "rejects a statistically real but trivially small difference",
    !verdict.significant,
    `lift ${test.lift.toFixed(2)}× (p=${test.pValue.toExponential(1)}) rejected: ${verdict.rejectedBecause}`,
  );
}

// ---- 5. multiple-comparison correction actually bites --------------------
{
  // Chosen so p lands BETWEEN the two thresholds: ~0.02, which clears α=0.05 on
  // its own but not α=0.05/200. That gap is the entire point of the correction, // a result this marginal appears by chance several times a day once you are
  // testing hundreds of cohorts.
  const test = compareProportions(200, 1000, 160, 1000);
  const alone = isSignificant(test, 1000, { comparisons: 1, minLift: 1.2, minExcessSessions: 5 });
  const amongMany = isSignificant(test, 1000, {
    comparisons: 200,
    minLift: 1.2,
    minExcessSessions: 5,
  });

  check(
    "the same result is accepted alone but rejected among many comparisons",
    alone.significant && !amongMany.significant,
    `p=${test.pValue.toExponential(2)}; α alone=${alone.correctedAlpha.toExponential(1)}, ` +
      `α corrected=${amongMany.correctedAlpha.toExponential(1)}`,
  );
}

// ---- 6. refuses to analyse a snapshot without the dimension -------------
{
  const findings = analyzeCohorts(snapshotWith(["URL"]), "Device");
  check(
    "returns nothing when the snapshot lacks the cohort dimension",
    findings.length === 0,
    "URL-only snapshot correctly produced no cohort findings",
  );
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
if (failures > 0) process.exitCode = 1;

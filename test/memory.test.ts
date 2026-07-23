import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../src/config.ts";
import { findSimilarCases, buildGuidance } from "../src/memory/match.ts";
import {
  deriveLesson,
  rememberAttempt,
  rememberFailure,
  rememberOutcome,
  renderRecollection,
} from "../src/memory/recall.ts";
import { stats } from "../src/memory/store.ts";

/**
 * Tests the behaviour that makes memory worth having:
 *
 *  1. The same defect returning is recognised as a RECURRENCE, not a new bug.
 *  2. A different symptom in the same code is still matched (file overlap).
 *  3. Approaches that already failed are surfaced so they aren't retried.
 *  4. An unrelated failure does NOT match, a memory that matches everything is
 * as useless as one that matches nothing.
 *
 * Run: node --experimental-strip-types test/memory.test.ts
 */

const PROJECT = "memory-test";
rmSync(resolve(config.dataDir, "memory", `${PROJECT}.db`), { force: true });
rmSync(resolve(config.dataDir, "memory", `${PROJECT}.db-wal`), { force: true });
rmSync(resolve(config.dataDir, "memory", `${PROJECT}.db-shm`), { force: true });

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) console.log(`✓ ${name}, ${detail}`);
  else {
    failures++;
    console.error(`✗ ${name}, ${detail}`);
  }
}

// ---- seed a past failure that was investigated, fixed, and verified ----
const past = rememberFailure({
  projectId: PROJECT,
  at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  fingerprint: "abc123",
  signalClass: "dead-click",
  route: "/checkout",
  message: "Click on button.place-order produced no response",
  implicatedFiles: ["src/components/CheckoutButton.tsx", "src/hooks/useOrder.ts"],
  affectedSessions: 340,
});

const failedAttempt = rememberAttempt({
  projectId: PROJECT,
  at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  failureId: past.id,
  attemptNumber: 1,
  hypothesis: "The click handler was removed during a refactor",
  approach: "Add an onClick handler to the existing div",
  rationale: "Restores the missing behaviour with a minimal change",
  filesChanged: ["src/components/CheckoutButton.tsx"],
  scoreBefore: 0.62,
  scoreAfter: 0.66,
  outcome: "reverted",
  whyItFailed: "the div still was not keyboard reachable and rage-clicks increased",
});
void failedAttempt;

const winning = rememberAttempt({
  projectId: PROJECT,
  at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  failureId: past.id,
  attemptNumber: 2,
  hypothesis: "The click handler was removed during a refactor",
  approach: "Convert the div back to a real <button> element",
  rationale: "Restores native semantics, keyboard access and the handler together",
  filesChanged: ["src/components/CheckoutButton.tsx"],
  scoreBefore: 0.62,
  scoreAfter: 0.08,
  outcome: "kept",
});

const outcome = rememberOutcome({
  projectId: PROJECT,
  at: new Date(Date.now() - 27 * 86_400_000).toISOString(),
  failureId: past.id,
  verdict: "confirmed",
  note: "Real dead-click rate fell from 13.6% to 0.4%",
});

deriveLesson({ projectId: PROJECT, failure: past, winningAttempt: winning, outcome });

// ---- 1. the same defect returns -----------------------------------------
{
  const cases = findSimilarCases({
    projectId: PROJECT,
    fingerprint: "abc123",
    signalClass: "dead-click",
    route: "/checkout",
    message: "Click on button.place-order produced no response",
    implicatedFiles: ["src/components/CheckoutButton.tsx"],
  });
  const guidance = buildGuidance(cases);

  check(
    "an identical defect is recognised as a recurrence",
    guidance.isRecurrence && cases.length > 0,
    cases.length
      ? `${(cases[0]!.similarity * 100).toFixed(0)}% similar, matched by ${cases[0]!.matchedBy.join(" + ")}`
      : "no match",
  );

  check(
    "the approach that failed before is surfaced as disproven",
    guidance.disproven.some((d) => /onClick handler/i.test(d.approach)),
    guidance.disproven.map((d) => d.approach).join("; ") || "none",
  );

  check(
    "the approach that worked is surfaced as proven and confirmed",
    guidance.proven.some((p) => /real <button>/i.test(p.approach) && p.confirmed),
    guidance.proven.map((p) => `${p.approach}${p.confirmed ? " (confirmed)" : ""}`).join("; ") ||
      "none",
  );

  const rendered = renderRecollection(cases, guidance);
  check(
    "the rendered prompt warns the agent off the failed approach",
    rendered.includes("do NOT repeat") && rendered.includes("onClick handler"),
    `${rendered.length} chars of guidance`,
  );
}

// ---- 2. different symptom, same code ------------------------------------
{
  const cases = findSimilarCases({
    projectId: PROJECT,
    fingerprint: "totally-different",
    signalClass: "rage-click",
    route: "/checkout",
    message: "Repeated clicks with no response",
    implicatedFiles: ["src/components/CheckoutButton.tsx"],
  });

  check(
    "a different symptom in the same file is still matched",
    cases.length > 0 && cases[0]!.matchedBy.includes("file-overlap"),
    cases.length ? `matched by ${cases[0]!.matchedBy.join(" + ")}` : "no match",
  );
}

// ---- 3. an unrelated failure must NOT match ------------------------------
{
  const cases = findSimilarCases({
    projectId: PROJECT,
    fingerprint: "unrelated",
    signalClass: "build-failure",
    route: "/ci/pipeline",
    message: "webpack could not resolve module sass-loader",
    implicatedFiles: ["webpack.config.js"],
  });

  check(
    "an unrelated failure does not match",
    cases.length === 0,
    cases.length ? `wrongly matched ${cases.length} case(s)` : "correctly returned nothing",
  );
}

// ---- 4. the store accumulates -------------------------------------------
{
  const s = stats(PROJECT);
  check(
    "memory accumulated all record types",
    s.failures === 1 && s.attempts === 2 && s.outcomes === 1 && s.lessons === 1,
    `${s.failures} failures, ${s.attempts} attempts, ${s.outcomes} outcomes, ${s.lessons} lessons`,
  );
  check(
    "attempt success rate is computed",
    s.attemptSuccessRate === 0.5,
    `${s.attemptSuccessRate !== null ? (s.attemptSuccessRate * 100).toFixed(0) : ", "}% (1 kept of 2)`,
  );
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
if (failures > 0) process.exitCode = 1;

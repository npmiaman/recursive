import { Retriever } from "../src/retrieve/index.ts";

/**
 * Retrieval evaluation harness.
 *
 * Written after tuning got stuck oscillating: each constant adjusted fixed one
 * query and broke another. The cause was the method, not the constants. I was
 * tuning against five queries with one "correct" answer each, which is far too
 * small and too strict to tune against, and several "failures" were files that
 * were genuinely relevant.
 *
 * So this measures what actually matters:
 *
 * recall@1 / @3 / @5, is an acceptable file in the top N?
 *   MRR, how high does the first acceptable file rank?
 *
 * Each case lists a SET of acceptable answers, because real failures usually
 * have several legitimate entry points (the implementation, its test, its
 * caller). Ranking any of them first is a success.
 *
 * Usage: node --experimental-strip-types test/retrieve-eval.ts <repo-path>
 * Point it at a checkout of this project.
 */

interface EvalCase {
  query: string;
  /** Any of these ranked highly counts as success. */
  acceptable: string[];
  note?: string;
}

const CASES: EvalCase[] = [
  {
    query: "the daily API budget ledger is not preventing requests when exhausted",
    acceptable: ["src/clarity/budget.ts"],
  },
  {
    query: "reciprocal rank fusion is combining the retrieval signals incorrectly",
    acceptable: ["src/retrieve/index.ts", "src/retrieve/bm25.ts"],
  },
  {
    query: "blast radius cap is not blocking the rollback action",
    acceptable: ["src/heal/guardrails.ts", "src/heal/tier0.ts"],
  },
  {
    query: "estimateFlagBlastRadius is returning the wrong percentage",
    acceptable: ["src/heal/tier0.ts"],
    note: "exact symbol name, should be a direct hit",
  },
  {
    query: "the PII scrubber is leaking authorization tokens into stored signals",
    acceptable: ["src/detect/ingest.ts", "packages/sdk/recursive.js", "test/scrub.test.ts"],
    note: "scrubbing exists in three legitimate places",
  },
  {
    query: "dead click detection is not firing in the browser agent",
    acceptable: ["packages/sdk/recursive.js", "src/score/instrument.ts", "src/score/probes.ts"],
    note: "dead-click logic legitimately exists in both the SDK and the probe",
  },
  {
    query: "area classification puts frontend files on the wrong branch",
    acceptable: ["src/repo/areas.ts", "src/repo/branch.ts"],
  },
  {
    query: "git suspect commit window is too narrow to catch the regression",
    acceptable: ["src/repo/git.ts", "src/retrieve/index.ts"],
  },
  {
    query: "incidents are not being correlated to the release that caused them",
    acceptable: ["src/detect/correlate.ts"],
  },
  {
    query: "the headless probe scores a fixed page as still broken",
    acceptable: ["src/score/index.ts", "src/score/probes.ts"],
  },
  {
    query: "chunking splits functions in half so the agent sees partial code",
    acceptable: ["src/retrieve/chunk.ts"],
  },
  {
    query: "hill climb keeps a change that made the score worse",
    acceptable: ["src/loop/inner.ts"],
  },
];

function rankOf(paths: string[], acceptable: string[]): number {
  for (let i = 0; i < paths.length; i++) {
    if (acceptable.some((a) => paths[i]!.endsWith(a))) return i + 1;
  }
  return 0; // not found
}

const repoPath = process.argv[2];
if (!repoPath) {
  console.error("Usage: node --experimental-strip-types test/retrieve-eval.ts <repo-path>");
  process.exit(1);
}

// Optional 2nd arg. Passing it turns on the base-memory signal, which is how
// we measure whether indexing the codebase actually improves retrieval.
const projectId = process.argv[3];
const retriever = new Retriever(repoPath, projectId);
if (projectId) console.log(`Base-memory signal ON (project ${projectId})`);
const stats = retriever.build();
console.log(`Indexed ${stats.files} files → ${stats.chunks} chunks\n`);

let hit1 = 0;
let hit3 = 0;
let hit5 = 0;
let reciprocalSum = 0;

for (const testCase of CASES) {
  const context = await retriever.retrieve({ message: testCase.query }, { maxChunks: 10 });
  // De-duplicate to file level, several chunks of one file is one answer.
  const files: string[] = [];
  for (const ranked of context.chunks) {
    // Exclude this harness. It contains every query verbatim, so if the repo
    // under test includes it, it ranks top for nearly everything and the whole
    // measurement becomes self-referential. This happened on the first run and
    // made the numbers ~25 points worse than reality.
    if (ranked.chunk.path.endsWith("retrieve-eval.ts")) continue;
    if (!files.includes(ranked.chunk.path)) files.push(ranked.chunk.path);
  }

  const rank = rankOf(files, testCase.acceptable);
  if (rank === 1) hit1++;
  if (rank > 0 && rank <= 3) hit3++;
  if (rank > 0 && rank <= 5) hit5++;
  if (rank > 0) reciprocalSum += 1 / rank;

  const mark = rank === 1 ? "✓" : rank > 0 && rank <= 3 ? "~" : "✗";
  console.log(`${mark} rank ${rank || ", "}  ${testCase.query.slice(0, 62)}`);
  if (rank !== 1) {
    console.log(` want: ${testCase.acceptable.join(" | ")}`);
    console.log(` got:  ${files.slice(0, 3).join(", ") || "(nothing)"}`);
  }
}

const n = CASES.length;
console.log(`
─────────────────────────────────────────
 recall@1   ${((hit1 / n) * 100).toFixed(0)}%   (${hit1}/${n})
 recall@3   ${((hit3 / n) * 100).toFixed(0)}%   (${hit3}/${n})
 recall@5   ${((hit5 / n) * 100).toFixed(0)}%   (${hit5}/${n})
  MRR        ${(reciprocalSum / n).toFixed(3)}
─────────────────────────────────────────

recall@3 is the number that matters: the fix agent is handed ~10 chunks, so an
acceptable file in the top 3 means it has what it needs. recall@1 is a stricter
bar than the system actually requires.`);

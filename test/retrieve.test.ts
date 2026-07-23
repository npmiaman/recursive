import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Retriever } from "../src/retrieve/index.ts";
import { tokenize } from "../src/retrieve/tokenize.ts";

/**
 * Retrieval regression tests.
 *
 * These pin down three failures found by measurement, each of which silently
 * returned plausible-but-wrong code:
 *
 *  1. BM25's textbook length normalization (b=0.75) punished long files, so the
 * file mentioning the query terms 34 times ranked 13th.
 *  2. Import-graph expansion promoted hub files (config, types) for every query,
 * because they sit one hop from everything.
 *  3. Pure RRF discarded score magnitude, flattening a decisive 1.8x BM25 win
 * into a near-tie that any weak second signal could reorder.
 *
 * Run: node --experimental-strip-types test/retrieve.test.ts
 */

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** A repo with a hub file, several specific modules, and a planted bug. */
function buildRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "recursive-retrieve-"));

  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.co"]);
  git(root, ["config", "user.name", "Test"]);

  // Hub: imported by everything. Must NOT dominate unrelated queries.
  write(root, "src/config.ts", `export const config = { retries: 3, timeout: 5000 };\n`);

  // The file a "rate limit budget" query should find.
  write(
    root,
    "src/budget.ts",
    `import { config } from "./config";
// Daily request budget ledger. Prevents spending beyond the quota.
export class BudgetLedger {
 private spent = 0;
 budgetRemaining() { return this.quota - this.spent; }
 spendBudget(n: number) {
 if (this.budgetRemaining() < n) throw new Error("budget exhausted");
 this.spent += n;
  }
 isBudgetExhausted() { return this.budgetRemaining() <= 0; }
 resetBudgetLedger() { this.spent = 0; }
 private quota = 10;
}
`,
  );

  // Distractors that mention "budget" once, so ranking must weigh breadth.
  write(
    root,
    "src/report.ts",
    `import { config } from "./config";\nexport function report(budget: number) { return budget; }\n`,
  );
  write(
    root,
    "src/cache.ts",
    `import { config } from "./config";\nexport function cache(key: string) { return key; }\n`,
  );

  write(
    root,
    "src/checkout.ts",
    `import { config } from "./config";\nexport function checkout() { return true; }\n`,
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "Initial"]);

  // A later commit touching one file, the git suspect signal.
  write(
    root,
    "src/checkout.ts",
    `import { config } from "./config";\n// regression: handler dropped\nexport function checkout() { return false; }\n`,
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "Refactor checkout"]);

  return root;
}

interface Check {
  name: string;
  run: (retriever: Retriever) => Promise<string>;
  expectTop: string;
}

const CHECKS: Check[] = [
  {
    name: "long file matching many query terms wins (BM25 length normalization)",
    expectTop: "src/budget.ts",
    run: async (r) =>
      (await r.retrieve({ message: "daily request budget ledger exhausted quota spend" })).chunks[0]
        ?.chunk.path ?? "",
  },
  {
    name: "hub file does not dominate an unrelated query (graph hub exclusion)",
    expectTop: "src/budget.ts",
    run: async (r) =>
      (await r.retrieve({ message: "budget ledger remaining quota" })).chunks[0]?.chunk.path ?? "",
  },
  {
    name: "git suspect commit surfaces the changed file",
    expectTop: "src/checkout.ts",
    run: async (r) =>
      (await r.retrieve({ message: "checkout returns the wrong value", failedAt: new Date() }))
        .chunks[0]?.chunk.path ?? "",
  },
];

const root = buildRepo();
let failures = 0;

try {
  const retriever = new Retriever(root);
  const stats = retriever.build();
  console.log(`indexed ${stats.files} files → ${stats.chunks} chunks\n`);

  for (const check of CHECKS) {
    const top = await check.run(retriever);
    if (top === check.expectTop) {
      console.log(`✓ ${check.name}`);
    } else {
      failures++;
      console.error(`✗ ${check.name}`);
      console.error(` expected top result: ${check.expectTop}`);
      console.error(` got:                 ${top || "(nothing)"}`);
    }
  }

  console.log(`\n${CHECKS.length - failures}/${CHECKS.length} passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

const tokenCheck = (name: string, ok: boolean, detail: string): void => {
  if (ok) {
    console.log(`\u2713 ${name}`);
  } else {
    stemFailures++;
    console.error(`\u2717 ${name}\n    ${detail}`);
  }
};
let stemFailures = 0;

// ---- stemming: prose bug reports vs identifier-shaped code ----------------
//
// Guards the exact failure this was added for. Each pair is a word as a HUMAN
// writes it in a bug report, and the word as it appears in CODE.
{
  const bridges: [string, string][] = [
    ["chunking", "chunk"],
    ["splits", "split"],
    ["retries", "retry"],
    ["queries", "query"],
    ["failed", "fail"],
    ["matches", "match"],
    ["dropped", "drop"],
    ["commits", "commit"],
  ];
  for (const [prose, code] of bridges) {
    tokenCheck(
      `stem bridges "${prose}" → "${code}"`,
      tokenize(prose).includes(code),
      `tokenize("${prose}") = ${tokenize(prose).join(",")}`,
    );
  }

  // The original must survive alongside the stem, or exact identifier matches
  // lose the precision that makes them the strongest lexical evidence.
  tokenCheck(
    "stemming keeps the original token too",
    tokenize("chunking").includes("chunking"),
    tokenize("chunking").join(","),
  );

  // Over-stemming is the failure mode that would quietly cost precision:
  // these must NOT be mangled.
  const mustNotChange: [string, string][] = [
    ["class", "clas"],
    ["status", "statu"],
    ["css", "cs"],
    ["this", "thi"],
  ];
  for (const [word, wrong] of mustNotChange) {
    tokenCheck(
      `does not over-stem "${word}"`,
      !tokenize(word).includes(wrong),
      `tokenize("${word}") = ${tokenize(word).join(",")}`,
    );
  }
}

if (failures + stemFailures > 0) process.exitCode = 1;

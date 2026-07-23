import { extractJson } from "../src/llm/provider.ts";

/**
 * extractJson regression tests.
 *
 * The last case is the one that mattered: sweeping a live app, deepseek-v4-flash
 * returned a stray token before the real object and the whole flow errored out.
 * The extractor must recover the valid object rather than give up on the first
 * failed parse.
 */
let failures = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) {
    failures++;
    console.error(`    got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
};

eq("plain object", extractJson('{"a":1,"b":"x"}'), { a: 1, b: "x" });
eq("fenced json", extractJson('```json\n{"a":1}\n```'), { a: 1 });
eq("prose before object", extractJson('sure, here: {"action":"done"}'), { action: "done" });
eq("stray brace before valid object", extractJson('{" then {"action":"click","index":5}'), { action: "click", index: 5 });
eq("nested braces", extractJson('{"a":{"b":2},"c":[1,2]}'), { a: { b: 2 }, c: [1, 2] });
eq("braces inside strings", extractJson('{"note":"use { and } carefully"}'), { note: "use { and } carefully" });
eq("nothing parseable", extractJson("no json here at all"), undefined);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} failed`);
if (failures > 0) process.exitCode = 1;

import { scrub } from "../src/detect/ingest.ts";

/**
 * Regression tests for PII scrubbing.
 *
 * These exist because the original scrubber leaked. `authorization: Bearer sk_live_x`
 * matched only as far as "Bearer", persisting the token in a field we store; and a
 * 16-digit card was labelled "<phone>" because the greedier pattern ran first.
 *
 * Ordering in SCRUBBERS is load-bearing, so any edit to that list must keep these
 * passing. Run with:  node --experimental-strip-types test/scrub.test.ts
 */

interface Case {
  name: string;
  input: string;
  /** Substrings that must NOT survive. */
  mustNotContain: string[];
  /** Substrings that must appear (i.e. the right label was applied). */
  mustContain?: string[];
}

const CASES: Case[] = [
  {
    name: "stripe key inside an Authorization header",
    input: "authorization: Bearer sk_live_zzzzzzzzzzzzzzzzzzzz",
    mustNotContain: ["sk_live_zzzz"],
  },
  {
    name: "github token in a key=value pair",
    input: "api_key=ghp_AAAABBBBCCCCDDDDEEEE",
    mustNotContain: ["ghp_AAAA"],
  },
  {
    name: "provider key with internal underscores, bare",
    input: "using sk_live_abcdefghij1234567890 for charges",
    mustNotContain: ["sk_live_abcdefghij"],
    mustContain: ["<token>"],
  },
  {
    name: "password in a key: value pair",
    input: "password: hunter2000",
    mustNotContain: ["hunter2000"],
  },
  {
    name: "JWT",
    input:
      "jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    mustNotContain: ["eyJhbGciOi"],
    mustContain: ["<jwt>"],
  },
  {
    name: "card number is labelled card, not phone",
    input: "card 4111111111111111 declined",
    mustNotContain: ["4111111111111111", "<phone>"],
    mustContain: ["<card>"],
  },
  {
    name: "email",
    input: "Payment failed for aman@example.com",
    mustNotContain: ["aman@example.com"],
    mustContain: ["<email>"],
  },
  {
    name: "Indian mobile number",
    input: "contact +91 98765 43210 for support",
    mustNotContain: ["98765", "43210"],
    mustContain: ["<phone>"],
  },
  {
    name: "US phone number",
    input: "call 555-123-4567 now",
    mustNotContain: ["555-123-4567"],
    mustContain: ["<phone>"],
  },
  {
    name: "ordinary stack frames survive (no over-scrubbing of code locations)",
    input: "Error: at pay (checkout.js:42)",
    mustNotContain: [],
    mustContain: ["checkout.js:42"],
  },
];

let failures = 0;

for (const testCase of CASES) {
  const output = scrub(testCase.input) ?? "";
  const leaked = testCase.mustNotContain.filter((needle) => output.includes(needle));
  const missing = (testCase.mustContain ?? []).filter((needle) => !output.includes(needle));

  if (leaked.length || missing.length) {
    failures++;
    console.error(`✗ ${testCase.name}`);
    console.error(`    in:  ${testCase.input}`);
    console.error(`    out: ${output}`);
    if (leaked.length) console.error(`    LEAKED: ${leaked.join(", ")}`);
    if (missing.length) console.error(`    missing label: ${missing.join(", ")}`);
  } else {
    console.log(`✓ ${testCase.name}`);
  }
}

console.log(`\n${CASES.length - failures}/${CASES.length} passed`);
if (failures > 0) process.exitCode = 1;

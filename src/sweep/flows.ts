import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Postcondition } from "./verify.ts";
import { filesForJourney } from "../memory/base.ts";

/**
 * Flow manifest, the user-facing features rhai should exercise.
 *
 * A flow is what a *person* does, written in the language rhai understands
 * (natural-language goals), not a selector script. That's the point of using a
 * browsing agent rather than Playwright specs: the test survives a redesign,
 * because "buy something" is still "buy something" after the button moves.
 *
 * `touches` is the load-bearing field. It maps a flow to the code that
 * implements it, which is what makes PR-scoped sweeps possible: a diff that
 * only touches checkout code shouldn't re-test the whole product.
 */

export interface Flow {
  id: string;
  name: string;
  /** Core to the business. Always tested in a daily sweep, regardless of risk. */
  critical: boolean;
  /** Path relative to the app's base URL where the flow starts. */
  url: string;
  /** Natural-language goal handed to rhai. Written as a user's intent. */
  goal: string;
  /** What success looks like. rhai reports against this. */
  expect: string;
  /**
   * Glob-ish path fragments this flow depends on. A PR touching any of them
   * puts this flow in the sweep. Substring match, keep them specific.
   */
  touches: string[];
  /** Optional: skip unless the environment matches. */
  environments?: ("production" | "staging" | "development")[];
  /** Longer setup notes passed to rhai via RHAI_TASK_CONTEXT. */
  context?: string;

  /**
   * Proof, from outside the UI, that the flow actually did what it claims.
   *
   * Without these a flow is only ever "the screen looked right", which is not
   * the same thing and routinely differs. See verify.ts.
   */
  verify?: Postcondition[];

  /**
   * Step budget. Most flows finish in well under 20 steps; a cap stops a
   * confused agent burning ten minutes and a lot of tokens wandering a page.
   */
  maxSteps?: number;

  /**
   * Model tier for the first attempt.
   * fast, cheap model, for short well-trodden flows
   * standard, the default
   * careful, strongest model, for flows that are long or historically flaky
   *
   * A `fast` flow that fails is retried at `standard` before being believed, so
   * the cheap model never costs correctness, only latency, and only on failure.
   */
  tier?: "fast" | "standard" | "careful";
}

export interface FlowManifest {
  baseUrl: string;
  flows: Flow[];
  /**
   * Where the server-side SDK exposes what the backend actually did.
   * With this set, every flow is checked against the server automatically, no
   * per-flow assertions required. See src/sweep/backend.ts.
   */
  backendTraceUrl?: string;
  /** Env var name holding the trace endpoint token. */
  backendTokenEnv?: string;
}

/**
 * Load flows.json from the target repo.
 *
 * Lives in the customer's repo, not ours, because the flows ARE the product
 * definition, they change when features change, and they belong under the same
 * review as the code they describe.
 */
export function loadFlows(repoPath: string): FlowManifest | undefined {
  for (const candidate of ["recursive.flows.json", ".recursive/flows.json"]) {
    const path = resolve(repoPath, candidate);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as FlowManifest;
      if (!Array.isArray(parsed.flows)) continue;
      return parsed;
    } catch (error) {
      throw new Error(
        `${candidate} is not valid JSON: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  return undefined;
}

/**
 * Does this file belong to this flow?
 *
 * The single answer to that question, because it used to have three
 * implementations, one here and two in the risk scorer, and only this one got
 * taught about base memory. The result was a flow whose code had moved being
 * correctly *selected* for a sweep while scoring as low-risk, so it ran last or
 * fell off the `--max` cutoff entirely.
 *
 * Two sources, deliberately additive:
 *   - `touches`, hand-maintained, lets a human assert a link the model missed
 *   - base memory, derived from what the code actually does, catches the links
 * a hand-maintained list loses as the code moves
 */
export function flowOwnsFile(flow: Flow, file: string, journeyFiles?: Set<string>): boolean {
  return (
    flow.touches.some((fragment) => file.includes(fragment)) || (journeyFiles?.has(file) ?? false)
  );
}

/**
 * Files base memory attributes to a flow. Empty when the project has not been
 * indexed, which degrades to `touches`-only rather than failing.
 */
export function journeyFilesFor(flow: Flow, projectId?: string): Set<string> {
  if (!projectId) return new Set();
  try {
    return new Set([
      ...filesForJourney(projectId, flow.id),
      ...filesForJourney(projectId, flow.name),
    ]);
  } catch {
    return new Set();
  }
}

/**
 * Which flows does a set of changed files put at risk?
 *
 * Direct ownership via `touches`, plus a shared-file rule: a change to
 * something many flows depend on (a design system, an API client) endangers all
 * of them, and testing only the "owning" flow would miss that entirely.
 */
export function flowsAffectedBy(
  manifest: FlowManifest,
  changedFiles: string[],
  options: { sharedFileThreshold?: number; projectId?: string } = {},
): { flow: Flow; reason: string }[] {
  const threshold = options.sharedFileThreshold ?? 3;
  const affected = new Map<string, { flow: Flow; reason: string }>();

  /**
   * Files base memory says belong to each journey.
   *
   * `touches` is a hand-maintained list of path fragments, and hand-maintained
   * lists rot: someone moves checkout into a new directory, nobody updates the
   * manifest, and the PR sweep quietly stops testing checkout, failing open, in
   * the worst possible way. Base memory derives the same mapping from what the
   * code actually does, and keeps deriving it as the code moves.
   */
  const journeyFiles = new Map<string, Set<string>>();
  for (const flow of manifest.flows) {
    const files = journeyFilesFor(flow, options.projectId);
    if (files.size) journeyFiles.set(flow.id, files);
  }

  for (const file of changedFiles) {
    const owners = manifest.flows.filter((flow) =>
      flowOwnsFile(flow, file, journeyFiles.get(flow.id)),
    );

    if (owners.length === 0) continue;

    // A file claimed by many flows is shared infrastructure, every flow that
    // depends on it is now suspect, not just the nearest one.
    if (owners.length >= threshold) {
      for (const flow of owners) {
        if (!affected.has(flow.id)) {
          affected.set(flow.id, {
            flow,
            reason: `shared file changed: ${file} (used by ${owners.length} flows)`,
          });
        }
      }
      continue;
    }

    for (const flow of owners) {
      if (!affected.has(flow.id)) {
        affected.set(flow.id, { flow, reason: `owns changed file: ${file}` });
      }
    }
  }

  return [...affected.values()];
}

/** A starter manifest, written into a repo by `recursive sweep init`. */
export const EXAMPLE_MANIFEST: FlowManifest = {
  baseUrl: "http://localhost:3000",
  flows: [
    {
      id: "signup",
      name: "New user can sign up",
      critical: true,
      url: "/signup",
      goal: "Create a new account using a fresh email address and a valid password, then confirm you land on the signed-in dashboard.",
      expect: "Account is created and the dashboard loads showing the new user as signed in.",
      touches: ["signup", "auth", "components/Auth"],
      tier: "standard",
      verify: [
        {
          name: "the account row actually exists",
          kind: "count-delta",
          url: "http://localhost:3000/api/test/accounts/count",
          countPath: "count",
          expectDelta: 1,
        },
      ],
    },
    {
      id: "checkout",
      name: "Customer can complete a purchase",
      critical: true,
      url: "/",
      goal: "Add any product to the cart, go to checkout, fill in the test card details, and place the order.",
      expect: "An order confirmation page appears with an order number.",
      touches: ["checkout", "cart", "orders", "payment"],
      context:
        "Use the test card 4242 4242 4242 4242, any future expiry, CVC 123. Do not use a real card.",
      tier: "careful",
      maxSteps: 40,
      // The screen saying "Order confirmed" is not evidence an order exists.
      // This is: the order count must actually go up by one.
      verify: [
        {
          name: "an order was really created",
          kind: "count-delta",
          url: "http://localhost:3000/api/test/orders/count",
          countPath: "count",
          expectDelta: 1,
        },
      ],
    },
    {
      id: "search",
      name: "Search returns relevant results",
      critical: false,
      url: "/",
      goal: "Search for a product you can see on the homepage and confirm it appears in the results.",
      expect: "The searched product appears in the result list.",
      touches: ["search", "components/Search"],
    },
  ],
};

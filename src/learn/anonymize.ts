import { createHash } from "node:crypto";
import { scrub } from "../detect/ingest.ts";

/**
 * Turn a failure-and-fix into a shareable LEARNING, with nothing private in it.
 *
 * This is the privacy boundary of the cross-user flywheel. What leaves a
 * machine is a PATTERN, never the code. Concretely, a learning carries:
 *
 *   - a fingerprint derived only from the signal class and a masked route,
 *   - a scrubbed, truncated one-line symptom,
 *   - a scrubbed, truncated description of the approach that worked,
 *   - whether it worked or was reverted.
 *
 * What it NEVER carries: source code, diffs, file contents, file paths, repo
 * names, stack traces, or anything the PII scrubber would flag. The symptom and
 * approach both run through the same two-pass scrubber the rest of the system
 * uses, then are hard-truncated, so even a leaked secret in a message cannot
 * ride along.
 *
 * The fingerprint is deliberately repo-independent: two different teams whose
 * checkout breaks on `/checkout` produce the SAME fingerprint, which is the
 * whole point, that is how one team's fix helps the next.
 */

export interface Learning {
  /** Repo-independent pattern id: same failure pattern, same fingerprint. */
  fingerprint: string;
  signalClass: string;
  /** Route with dynamic segments masked, e.g. /orders/:id. */
  routePattern: string;
  /** Scrubbed, truncated symptom. */
  symptom: string;
  /** Scrubbed, truncated description of what fixed it. */
  approach: string;
  outcome: "worked" | "reverted";
  area?: string;
  language?: string;
}

/** Replace id-like path segments so /orders/9f3c-... becomes /orders/:id. */
export function maskRoute(route: string): string {
  return (
    "/" +
    route
      .split("/")
      .filter(Boolean)
      .map((seg) => {
        if (/^\d+$/.test(seg)) return ":id"; // numeric id
        if (/[0-9a-f]{8}-?[0-9a-f]{4}/i.test(seg)) return ":id"; // uuid-ish
        if (/^[0-9a-f]{16,}$/i.test(seg)) return ":id"; // long hex token
        if (seg.length > 24) return ":id"; // suspiciously long, likely an id
        return seg.toLowerCase();
      })
      .join("/")
  ).replace(/\/+$/, "") || "/";
}

function clean(text: string | undefined, max: number): string {
  const scrubbed = scrub(text) ?? "";
  // Collapse whitespace and hard-truncate. Truncation is a privacy control, not
  // just cosmetics: it caps how much of any message can escape.
  return scrubbed.replace(/\s+/g, " ").trim().slice(0, max);
}

export function anonymizeLearning(input: {
  signalClass: string;
  route: string;
  symptom: string;
  approach: string;
  outcome: "worked" | "reverted";
  area?: string;
  language?: string;
}): Learning {
  const routePattern = maskRoute(input.route);
  // Fingerprint on the PATTERN only, so it matches across repos and users.
  const fingerprint = createHash("sha256")
    .update(`${input.signalClass}|${routePattern}`)
    .digest("hex")
    .slice(0, 32);

  return {
    fingerprint,
    signalClass: input.signalClass.slice(0, 40),
    routePattern,
    symptom: clean(input.symptom, 200),
    approach: clean(input.approach, 240),
    outcome: input.outcome,
    area: input.area?.slice(0, 20),
    language: input.language?.slice(0, 20),
  };
}

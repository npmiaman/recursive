import type { Issue } from "../diagnose/issues.ts";
import { KIND_MEANING } from "../diagnose/issues.ts";
import { askText } from "./claude.ts";
import type { Investigation } from "./investigate.ts";

/**
 * External research stage — invoked only when the investigator flags it.
 *
 * This exists because a meaningful share of real friction is not the site's own
 * bug: a known regression in a component library, a documented mobile Safari
 * quirk, a framework hydration gotcha. Searching first is much cheaper than
 * letting the hill-climb burn a dozen iterations rediscovering it.
 */

const SYSTEM = `You are a frontend researcher. You will be given a UX defect and a
working hypothesis. Search the web for information that materially changes how the
defect should be fixed.

Prioritise, in order:
1. Known bugs, regressions, or documented gotchas in the libraries/frameworks involved.
2. Platform-specific behaviour (iOS Safari touch handling, Android Chrome, etc.).
3. Established interaction and accessibility guidance from primary sources (WAI-ARIA
   Authoring Practices, MDN, WCAG) that prescribes the correct pattern.

Be concise and concrete. If your search finds nothing that changes the fix, say so
plainly in one line rather than padding with generic UX advice — a null result is a
useful result here. Cite the URLs you relied on.`;

export async function research(
  issue: Issue,
  investigation: Investigation,
): Promise<string> {
  const prompt = `## Defect

${issue.kind} on ${issue.url} — affecting ${issue.affectedSessions.toLocaleString()} sessions (${(issue.rate * 100).toFixed(1)}%).

Symptom meaning: ${KIND_MEANING[issue.kind]}

## Working hypothesis

${investigation.hypothesis}

## Proposed fix directions

${investigation.directions.map((d, i) => `${i + 1}. ${d.title} — ${d.rationale}`).join("\n")}

## Task

Search for anything that would change how this should be fixed: known library bugs,
platform quirks, or the canonical accessible pattern for this control. Report only
findings that affect the implementation.`;

  return askText(prompt, { system: SYSTEM, effort: "high", webSearch: true });
}

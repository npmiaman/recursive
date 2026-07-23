import type { Project } from "../tenant.ts";
import { readAudit } from "../detect/store.ts";
import type { Incident } from "../detect/types.ts";

/**
 * Guardrails.
 *
 * This file is the product. Anyone can call a model and flip a flag; the reason
 * a customer would let software touch their production is that the blast radius
 * is bounded *before* it is calculated, by rules the agent cannot alter.
 *
 * Every check here is a veto. An action runs only if all of them pass, and the
 * default answer to anything unrecognised is no.
 */

export type ActionKind = "flag-off" | "rollback";

/**
 * Actions are permitted only if they are reversible by a single inverse
 * operation (ARCHITECTURE.md §4). This map IS that constraint — adding an entry
 * here is the deliberate act of asserting reversibility.
 */
export const INVERSE: Record<ActionKind, string> = {
  "flag-off": "flag-on",
  rollback: "roll-forward",
};

export interface ProposedAction {
  kind: ActionKind;
  incident: Incident;
  /** Flag name for flag-off; release id for rollback. */
  target: string;
  /** Estimated share of traffic affected, 0..100. */
  blastRadiusPct: number;
  rationale: string;
}

export interface Verdict {
  allowed: boolean;
  /** Every check that failed. Surfaced to humans and written to the audit log. */
  blockedBy: string[];
  /** Checks that passed, for the audit trail. */
  passed: string[];
}

const HOUR_MS = 3600_000;

export function evaluate(project: Project, action: ProposedAction): Verdict {
  const blockedBy: string[] = [];
  const passed: string[] = [];
  const g = project.guardrails;

  // 1. Master switch. A project that never explicitly opted in has not consented.
  if (!g.autonomyEnabled) {
    blockedBy.push("Autonomy is disabled for this project.");
  } else {
    passed.push("autonomy enabled");
  }

  // 2. Action allowlist — an explicit list of verbs, not a denylist.
  if (!g.allowedActions.includes(action.kind)) {
    blockedBy.push(
      `Action '${action.kind}' is not in this project's allowlist (${g.allowedActions.join(", ") || "none"}).`,
    );
  } else {
    passed.push(`action '${action.kind}' allowlisted`);
  }

  // 3. Reversibility. Structural: if there's no inverse, it isn't a Tier 0 action.
  if (!INVERSE[action.kind]) {
    blockedBy.push(`Action '${action.kind}' has no defined inverse and is not reversible.`);
  } else {
    passed.push(`reversible via '${INVERSE[action.kind]}'`);
  }

  // 4. Confidence floor.
  //    high    → act.
  //    medium  → act only if containment is narrow (a single flag), because a
  //              flag flip affects one feature while a rollback affects everything.
  //    low     → never. Nothing recent to revert means any action is a guess.
  if (action.incident.confidence === "low") {
    blockedBy.push("Incident confidence is low — cause is not attributable, so containment would be a guess.");
  } else if (action.incident.confidence === "medium" && action.kind !== "flag-off") {
    blockedBy.push("Medium confidence permits only flag-scoped containment, not a rollback.");
  } else {
    passed.push(`confidence '${action.incident.confidence}' sufficient for '${action.kind}'`);
  }

  // 5. Blast radius cap.
  if (action.blastRadiusPct > g.maxBlastRadiusPct) {
    blockedBy.push(
      `Blast radius ${action.blastRadiusPct.toFixed(0)}% exceeds the cap of ${g.maxBlastRadiusPct}%.`,
    );
  } else {
    passed.push(`blast radius ${action.blastRadiusPct.toFixed(0)}% within ${g.maxBlastRadiusPct}% cap`);
  }

  const auditLog = readAudit(project.id);

  // 6. Rate limit. Bounds the damage from a detector that starts crying wolf.
  const recentActions = auditLog.filter(
    (r) => r.actor === "autonomous" && r.outcome === "executed" && Date.now() - Date.parse(r.at) < HOUR_MS,
  );
  if (recentActions.length >= g.maxActionsPerHour) {
    blockedBy.push(
      `Rate limit reached: ${recentActions.length}/${g.maxActionsPerHour} autonomous actions in the last hour.`,
    );
  } else {
    passed.push(`rate limit ${recentActions.length}/${g.maxActionsPerHour}`);
  }

  // 7. Per-incident cooldown. Prevents flapping — heal, re-break, heal.
  const lastForIncident = auditLog
    .filter((r) => r.incidentId === action.incident.id && r.outcome === "executed")
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  if (lastForIncident) {
    const sinceMin = (Date.now() - Date.parse(lastForIncident.at)) / 60_000;
    if (sinceMin < g.cooldownMinutes) {
      blockedBy.push(
        `Cooldown active: acted on this incident ${sinceMin.toFixed(0)}m ago (cooldown ${g.cooldownMinutes}m). ` +
          `Repeated failure to contain should escalate to a human, not retry.`,
      );
    } else {
      passed.push(`cooldown clear (${sinceMin.toFixed(0)}m since last action)`);
    }
  } else {
    passed.push("no prior action on this incident");
  }

  // 8. Target sanity — never act on an empty or wildcard target.
  if (!action.target || action.target === "*") {
    blockedBy.push("Action target is empty or a wildcard.");
  } else {
    passed.push(`target '${action.target}' is specific`);
  }

  return { allowed: blockedBy.length === 0, blockedBy, passed };
}

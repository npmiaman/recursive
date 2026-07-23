import type { Project } from "../tenant.ts";
import { correlate, describeIncident } from "../detect/correlate.ts";
import { audit, readSignals, readReleases, upsertIncident, readAudit } from "../detect/store.ts";
import type { Incident } from "../detect/types.ts";
import { evaluate, INVERSE, type ActionKind, type ProposedAction } from "./guardrails.ts";
import { deployProviderFor, flagProviderFor } from "./providers.ts";

/**
 * Tier 0, contain.
 *
 * Turn the broken thing off. No AI, no code written, reversible by a single
 * inverse operation, seconds not minutes. This is where most of the value of
 * "self-healing" actually lives, and it is the part a customer will trust first.
 *
 * The loop refuses to act far more often than it acts. That is the intended
 * behaviour: an autonomous system that touches production should have to clear a
 * high bar every single time, and should say plainly why it didn't.
 */

/** Incidents below this severity are logged but not acted on. */
const ACTION_SEVERITY_FLOOR = 25;

export interface HealOutcome {
  incident: Incident;
  action?: ProposedAction;
  executed: boolean;
  blockedBy: string[];
  error?: string;
}

export interface HealReport {
  projectId: string;
  incidentsConsidered: number;
  outcomes: HealOutcome[];
}

/**
 * Estimate the share of traffic a flag-off would affect, from the signals
 * themselves: what fraction of recent sessions reported this flag active?
 *
 * Measured rather than assumed, because the blast-radius cap is only meaningful
 * if the number it compares against is real.
 */
function estimateFlagBlastRadius(projectId: string, flag: string, windowMs: number): number {
  const signals = readSignals(projectId, windowMs);
  if (signals.length === 0) return 100;
  const total = signals.reduce((sum, s) => sum + s.sessions, 0);
  const withFlag = signals.filter((s) => s.flag === flag).reduce((sum, s) => sum + s.sessions, 0);
  if (total === 0) return 100;
  return Math.min(100, (withFlag / total) * 100);
}

/**
 * Choose the containment for an incident, or none.
 *
 * Preference order is deliberate: a flag flip is narrower than a rollback, so we
 * always prefer it when a flag is implicated, even when a rollback would also work.
 */
function proposeAction(
  project: Project,
  incident: Incident,
  windowMs: number,
): ProposedAction | undefined {
  // Core paths are repair-only.
  //
  // Containment assumes a fallback exists. For core functionality it usually
  // doesn't, switching off checkout is not a milder form of broken checkout,
  // it's the same outage with a different cause. Repair is the ONLY acceptable
  // response on these paths, so don't waste a guardrail slot proposing one.
  const repairOnly = project.guardrails.repairOnlyPaths.some((prefix) =>
    incident.route.startsWith(prefix),
  );
  if (repairOnly) return undefined;

  // Narrowest containment: one feature off.
  if (incident.flag) {
    return {
      kind: "flag-off",
      incident,
      target: incident.flag,
      blastRadiusPct: estimateFlagBlastRadius(project.id, incident.flag, windowMs),
      rationale:
        `All signals for this incident report flag '${incident.flag}' active. ` +
        `Disabling it removes the failing code path without a deploy.`,
    };
  }

  // Broader containment: undo the change that introduced it.
  if (incident.releaseCorrelated && incident.release) {
    const releases = readReleases(project.id);
    const index = releases.findIndex((r) => r.id === incident.release);
    const previous = index > 0 ? releases[index - 1] : undefined;
    if (!previous) return undefined;

    return {
      kind: "rollback",
      incident,
      target: previous.id,
      // A rollback affects everyone. Never estimated as less.
      blastRadiusPct: 100,
      rationale:
        `Novel failure appeared within 30 minutes of release '${incident.release}' and was ` +
        `absent before it. Rolling back to '${previous.id}' removes the change that introduced it.`,
    };
  }

  // Nothing recent and nothing flag-scoped, there is no safe containment.
  // This is a Tier 1 case: diagnose and propose a fix for a human.
  return undefined;
}

async function execute(project: Project, action: ProposedAction): Promise<void> {
  if (action.kind === "flag-off") {
    await flagProviderFor(project).disable(action.target);
    return;
  }
  if (action.kind === "rollback") {
    const provider = deployProviderFor(project);
    const releases = readReleases(project.id);
    const target = releases.find((r) => r.id === action.target);
    if (!target) throw new Error(`Rollback target '${action.target}' not found.`);
    await provider.rollbackTo(target);
    return;
  }
  throw new Error(`Unknown action kind '${action.kind as string}'.`);
}

export interface HealOptions {
  /** Correlation window. Defaults to the last hour. */
  windowMs?: number;
  /** Evaluate and log, but never execute. */
  dryRun?: boolean;
  onProgress?: (line: string) => void;
}

export async function heal(project: Project, options: HealOptions = {}): Promise<HealReport> {
  const windowMs = options.windowMs ?? 3600_000;
  const log = options.onProgress ?? ((l: string) => console.log(l));

  const incidents = correlate(project.id, { windowMs });
  const outcomes: HealOutcome[] = [];

  if (incidents.length === 0) {
    log("No incidents in the correlation window.");
    return { projectId: project.id, incidentsConsidered: 0, outcomes };
  }

  log(`${incidents.length} incident(s) in the last ${Math.round(windowMs / 60000)}m:\n`);

  /**
   * Containment targets already acted on in this pass.
   *
   * One root cause routinely produces several incidents, a broken button emits
   * both dead-click and rage-click signals, which fingerprint separately. They
   * resolve to the SAME containment. Without this, the second incident re-fires
   * the same flag-off: a duplicate audit entry, a wasted slot against the
   * hourly rate limit, and a log that misrepresents what happened. The
   * per-incident cooldown does not catch it, because these are different incidents.
   */
  const containedTargets = new Set<string>();

  for (const incident of incidents) {
    log(`  ${describeIncident(incident)}`);
    upsertIncident(project.id, incident);

    if (incident.status === "contained" || incident.status === "resolved") {
      log(` already ${incident.status}, skipping`);
      continue;
    }

    if (incident.severity < ACTION_SEVERITY_FLOOR) {
      log(` severity below action floor (${ACTION_SEVERITY_FLOOR}), monitoring only`);
      continue;
    }

    const action = proposeAction(project, incident, windowMs);

    if (!action) {
      const repairOnly = project.guardrails.repairOnlyPaths.some((p) =>
        incident.route.startsWith(p),
      );
      const reason = repairOnly
        ? `'${incident.route}' is a repair-only path, switching core functionality off is not a fix.`
        : "No flag implicated and no release correlation, nothing reversible to contain.";

      log(
        `    ${repairOnly ? "repair-only path" : "no safe containment"}, routing to repair (diagnose + fix + PR)`,
      );
      upsertIncident(project.id, { ...incident, status: "repairing" });
      audit({
        at: new Date().toISOString(),
        projectId: project.id,
        action: "route-to-repair",
        incidentId: incident.id,
        actor: "system",
        detail: { reason, reasoning: incident.reasoning },
        outcome: "executed",
      });
      outcomes.push({ incident, executed: false, blockedBy: ["no containment available"] });
      continue;
    }

    log(
      ` proposed: ${action.kind} → '${action.target}' (blast radius ${action.blastRadiusPct.toFixed(0)}%)`,
    );

    const targetKey = `${action.kind}:${action.target}`;
    if (containedTargets.has(targetKey)) {
      log(`    ↳ already contained by an earlier incident in this pass, no second action`);
      upsertIncident(project.id, { ...incident, status: "contained" });
      outcomes.push({
        incident,
        action,
        executed: false,
        blockedBy: ["already contained this pass"],
      });
      continue;
    }

    const verdict = evaluate(project, action);

    if (!verdict.allowed) {
      for (const reason of verdict.blockedBy) log(`    ✗ blocked: ${reason}`);
      audit({
        at: new Date().toISOString(),
        projectId: project.id,
        action: action.kind,
        incidentId: incident.id,
        actor: "autonomous",
        detail: {
          target: action.target,
          blastRadiusPct: action.blastRadiusPct,
          rationale: action.rationale,
          blockedBy: verdict.blockedBy,
          passed: verdict.passed,
          evidence: incident.reasoning,
        },
        outcome: "blocked",
      });
      upsertIncident(project.id, { ...incident, status: "escalated" });
      outcomes.push({ incident, action, executed: false, blockedBy: verdict.blockedBy });
      continue;
    }

    if (options.dryRun) {
      // Mark it too, so a dry run reports the same dedup behaviour a real run
      // would, otherwise the preview overstates how many actions would fire.
      containedTargets.add(targetKey);
      log(`    ✓ would execute (dry run), all ${verdict.passed.length} guardrail checks passed`);
      outcomes.push({ incident, action, executed: false, blockedBy: [] });
      continue;
    }

    try {
      await execute(project, action);
      containedTargets.add(targetKey);
      log(
        `    ✓ EXECUTED ${action.kind} on '${action.target}', reversible via ${INVERSE[action.kind]}`,
      );
      audit({
        at: new Date().toISOString(),
        projectId: project.id,
        action: action.kind,
        incidentId: incident.id,
        actor: "autonomous",
        detail: {
          target: action.target,
          blastRadiusPct: action.blastRadiusPct,
          rationale: action.rationale,
          inverse: INVERSE[action.kind],
          passed: verdict.passed,
          evidence: incident.reasoning,
        },
        outcome: "executed",
      });
      upsertIncident(project.id, { ...incident, status: "contained" });
      outcomes.push({ incident, action, executed: true, blockedBy: [] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`    ! failed: ${message}`);
      audit({
        at: new Date().toISOString(),
        projectId: project.id,
        action: action.kind,
        incidentId: incident.id,
        actor: "autonomous",
        detail: { target: action.target, error: message },
        outcome: "failed",
      });
      upsertIncident(project.id, { ...incident, status: "escalated" });
      outcomes.push({ incident, action, executed: false, blockedBy: [], error: message });
    }
  }

  return { projectId: project.id, incidentsConsidered: incidents.length, outcomes };
}

/**
 * Did containment actually work?
 *
 * An autonomous system that cannot tell whether it helped is not safe to run
 * (ARCHITECTURE.md §7). For every executed action, check whether the incident's
 * signal rate fell after we acted. If it didn't, the containment was wrong, say
 * so, and escalate rather than quietly leaving the feature off.
 */
export interface ContainmentCheck {
  incidentId: string;
  action: string;
  target: string;
  before: number;
  after: number;
  worked: boolean;
  note: string;
}

export function verifyContainment(project: Project, windowMs = 1800_000): ContainmentCheck[] {
  const executed = readAudit(project.id).filter(
    (r) => r.outcome === "executed" && r.actor === "autonomous" && r.incidentId,
  );

  const checks: ContainmentCheck[] = [];
  const signals = readSignals(project.id);

  for (const record of executed) {
    const actedAt = Date.parse(record.at);
    // Only assess once enough time has passed to accumulate a post-action sample.
    if (Date.now() - actedAt < windowMs) continue;

    const fingerprintOf = record.incidentId!.split(":")[1];
    const relevant = signals.filter((s) => s.fingerprint === fingerprintOf);

    const before = relevant
      .filter((s) => {
        const t = Date.parse(s.at);
        return t < actedAt && t >= actedAt - windowMs;
      })
      .reduce((sum, s) => sum + s.sessions, 0);

    const after = relevant
      .filter((s) => {
        const t = Date.parse(s.at);
        return t >= actedAt && t < actedAt + windowMs;
      })
      .reduce((sum, s) => sum + s.sessions, 0);

    // Containment worked if the signal essentially stopped.
    const worked = after === 0 || after < before * 0.2;

    checks.push({
      incidentId: record.incidentId!,
      action: record.action,
      target: String(record.detail["target"] ?? ""),
      before,
      after,
      worked,
      note: worked
        ? `Signal fell from ${before} to ${after} sessions after containment. Working as intended.`
        : `Signal did NOT fall (${before} → ${after}) after ${record.action}. The containment did not address ` +
          `the cause, the action should be reverted and the incident escalated to a human.`,
    });

    if (!worked) {
      const incidents = correlate(project.id, { windowMs });
      const incident = incidents.find((i) => i.id === record.incidentId);
      if (incident) upsertIncident(project.id, { ...incident, status: "escalated" });
    }
  }

  return checks;
}

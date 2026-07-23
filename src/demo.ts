import { randomUUID } from "node:crypto";
import { appendSignals, recordRelease, writeIncidents } from "./detect/store.ts";
import { fingerprint, type Signal } from "./detect/types.ts";
import { upsertProject, ProjectSchema, type Project } from "./tenant.ts";

/**
 * Seeds a realistic breakage scenario so the whole Tier 0 path can be exercised
 * without waiting for a real outage.
 *
 * The scenario is the canonical one Recursive exists for: a deploy ships a
 * feature behind a flag, the feature's primary button silently stops working,
 * nothing throws, nobody files a ticket, and revenue quietly drops. Conventional
 * error tracking sees nothing at all.
 */

const PROJECT_ID = "demo-shop";

export function seedProject(): Project {
  const project = ProjectSchema.parse({
    id: PROJECT_ID,
    tenantId: "demo",
    name: "Demo Shop",
    environment: "production",
    baseUrl: "http://localhost:4173",
    containment: { flagProvider: "local", deployProvider: "local" },
    guardrails: {
      autonomyEnabled: true,
      allowedActions: ["flag-off"],
      maxBlastRadiusPct: 60,
      maxActionsPerHour: 3,
      cooldownMinutes: 30,
    },
  });
  upsertProject(project);
  return project;
}

export interface SeedOptions {
  /** Also emit a rollback-shaped incident (release-correlated, no flag). */
  includeRollbackCase?: boolean;
  /** Emit an old, diffuse incident that should NOT be acted on. */
  includeLowConfidenceCase?: boolean;
}

export function seedScenario(options: SeedOptions = {}): Project {
  const project = seedProject();
  const now = Date.now();

  // Wipe any prior incident state so repeated seeding is deterministic.
  writeIncidents(PROJECT_ID, []);

  // --- releases -----------------------------------------------------------
  recordRelease({
    id: "2026.07.23-a1b2c3",
    projectId: PROJECT_ID,
    at: new Date(now - 6 * 3600_000).toISOString(),
    sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    note: "Known-good baseline",
  });
  recordRelease({
    id: "2026.07.23-f9e8d7",
    projectId: PROJECT_ID,
    at: new Date(now - 12 * 60_000).toISOString(),
    sha: "f9e8d7c6b5a4938271605f4e3d2c1b0a99887766",
    previous: "2026.07.23-a1b2c3",
    note: "Ship checkout-v2 behind a flag",
  });

  const signals: Signal[] = [];

  function signal(input: {
    cls: Signal["class"];
    route: string;
    message: string;
    minutesAgo: number;
    flag?: string;
    selector?: string;
    release?: string;
    sessions?: number;
  }): void {
    signals.push({
      id: randomUUID(),
      projectId: PROJECT_ID,
      class: input.cls,
      source: "sdk",
      at: new Date(now - input.minutesAgo * 60_000).toISOString(),
      route: input.route,
      release: input.release,
      cohort: { browser: "Chrome", os: "macOS", device: "desktop", locale: "en-US" },
      fingerprint: fingerprint({
        class: input.cls,
        route: input.route,
        message: input.message,
        selector: input.selector,
      }),
      message: input.message,
      selector: input.selector,
      flag: input.flag,
      count: 1,
      sessions: input.sessions ?? 1,
    });
  }

  // --- THE SILENT BREAKAGE -------------------------------------------------
  // checkout-v2 shipped 12 minutes ago. Its "Place order" button no longer
  // fires. Nothing throws. No stack trace exists. Error tracking is silent.
  for (let i = 0; i < 34; i++) {
    signal({
      cls: "dead-click",
      route: "/checkout",
      message: "Click on button.place-order produced no response",
      selector: "button.place-order",
      minutesAgo: 10 - (i % 10),
      flag: "checkout-v2",
      release: "2026.07.23-f9e8d7",
    });
  }
  // Users escalate, they click it repeatedly before giving up.
  for (let i = 0; i < 12; i++) {
    signal({
      cls: "rage-click",
      route: "/checkout",
      message: "Repeated clicks on button.place-order with no response",
      selector: "button.place-order",
      minutesAgo: 9 - (i % 9),
      flag: "checkout-v2",
      release: "2026.07.23-f9e8d7",
    });
  }

  // --- a rollback-shaped incident: release-correlated, no flag -------------
  if (options.includeRollbackCase) {
    for (let i = 0; i < 20; i++) {
      signal({
        cls: "exception",
        route: "/account",
        message: "TypeError: Cannot read properties of undefined (reading 'preferences')",
        minutesAgo: 8 - (i % 8),
        release: "2026.07.23-f9e8d7",
      });
    }
  }

  // --- a low-confidence case that must NOT be auto-contained --------------
  // Long-standing, diffuse, no release correlation. There is nothing recent to
  // revert, so any containment would be a guess. Tier 1 territory.
  if (options.includeLowConfidenceCase) {
    for (let i = 0; i < 30; i++) {
      signal({
        cls: "dead-click",
        route: "/pricing",
        message: "Click on div.tier-card produced no response",
        selector: "div.tier-card",
        // Half recent, half spread over the preceding days, but INSIDE the
        // 14-day novelty lookback, so the fingerprint has history and the
        // incident is correctly judged neither novel nor release-correlated.
        minutesAgo: i < 15 ? 5 + i : 60 * 24 * (1 + (i % 10)),
      });
    }
  }

  appendSignals(PROJECT_ID, signals);
  return project;
}

export const DEMO_PROJECT_ID = PROJECT_ID;

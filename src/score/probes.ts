import type { Page } from "playwright";
import type { IssueKind } from "../diagnose/issues.ts";
import type { Candidate, Layout, PageError } from "./instrument.ts";

/**
 * A probe returns a penalty in [0,1] where **lower is better** — the direct
 * analog of AutoResearch's `val_bpb`. Every probe must be deterministic for a
 * given page state, because the hill-climb's keep/revert decision is only
 * meaningful if an unchanged page scores identically twice.
 */
export interface ProbeResult {
  score: number;
  detail: string;
  evidence: Record<string, unknown>;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

async function candidates(page: Page): Promise<Candidate[]> {
  return page.evaluate(() =>
    (window as unknown as { __uxProbe: { candidates: () => Candidate[] } }).__uxProbe.candidates(),
  );
}

async function errors(page: Page): Promise<PageError[]> {
  return page.evaluate(() =>
    (window as unknown as { __uxProbe: { errors: () => PageError[] } }).__uxProbe.errors(),
  );
}

async function layout(page: Page): Promise<Layout> {
  return page.evaluate(() =>
    (window as unknown as { __uxProbe: { layout: () => Layout } }).__uxProbe.layout(),
  );
}

async function counters(page: Page): Promise<{ mutations: number; requests: number }> {
  return page.evaluate(() =>
    (window as unknown as { __uxProbe: { counters: () => { mutations: number; requests: number } } })
      .__uxProbe.counters(),
  );
}

async function resetCounters(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { __uxProbe: { resetCounters: () => void } }).__uxProbe.resetCounters(),
  );
}

/**
 * DEAD CLICK — the fraction of elements that present as interactive
 * (cursor:pointer, button-like class, onclick attr) but have neither native
 * semantics nor a registered click listener. This is the mechanical form of
 * "user clicked it and nothing happened".
 */
export async function probeDeadClick(page: Page): Promise<ProbeResult> {
  const found = await candidates(page);
  if (found.length === 0) {
    return { score: 0, detail: "No interactive-looking elements found.", evidence: {} };
  }
  const dead = found.filter((c) => !c.actionable);
  const score = clamp01(dead.length / found.length);
  return {
    score,
    detail: `${dead.length}/${found.length} interactive-looking elements have no click affordance.`,
    evidence: {
      deadSelectors: dead.slice(0, 10).map((d) => ({ selector: d.selector, text: d.text })),
      totalCandidates: found.length,
    },
  };
}

/**
 * RAGE CLICK — click each genuinely-actionable candidate and check whether
 * *anything* observably happens within a short window (DOM mutation, network
 * request, or navigation). A control that responds to nothing is what users
 * escalate against.
 *
 * Capped at 12 elements to keep an iteration in the seconds range; the loop's
 * value depends on staying fast.
 */
export async function probeRageClick(page: Page): Promise<ProbeResult> {
  const found = (await candidates(page)).filter((c) => c.actionable).slice(0, 12);
  if (found.length === 0) {
    return { score: 0, detail: "No actionable elements to test.", evidence: {} };
  }

  const unresponsive: { selector: string; text: string }[] = [];

  for (const candidate of found) {
    try {
      const locator = page.locator(candidate.selector).first();
      if (!(await locator.isVisible().catch(() => false))) continue;

      await resetCounters(page);
      const before = page.url();
      await locator.click({ timeout: 1500, trial: false, force: true }).catch(() => {});
      await page.waitForTimeout(350);

      const after = page.url();
      const { mutations, requests } = await counters(page);
      const responded = mutations > 0 || requests > 0 || after !== before;
      if (!responded) unresponsive.push({ selector: candidate.selector, text: candidate.text });

      // Navigation invalidates the rest of the sample; re-scoring a different
      // page would make the metric non-deterministic.
      if (after !== before) break;
    } catch {
      /* an element that can't be driven isn't evidence either way */
    }
  }

  const score = clamp01(unresponsive.length / found.length);
  return {
    score,
    detail: `${unresponsive.length}/${found.length} actionable controls produced no observable response within 350ms.`,
    evidence: { unresponsive: unresponsive.slice(0, 10) },
  };
}

/** SCRIPT ERROR — uncaught errors and rejections during load and interaction. */
export async function probeScriptError(page: Page): Promise<ProbeResult> {
  const collected = await errors(page);
  // Three or more distinct errors is treated as fully broken; the curve is
  // steep because any uncaught error means something is silently not working.
  const distinct = new Set(collected.map((e) => e.message)).size;
  const score = clamp01(distinct / 3);
  return {
    score,
    detail: `${distinct} distinct uncaught error(s) during load and interaction.`,
    evidence: { errors: collected.slice(0, 10) },
  };
}

/** ERROR CLICK — clicking a control that then throws. */
export async function probeErrorClick(page: Page): Promise<ProbeResult> {
  const before = new Set((await errors(page)).map((e) => e.message));
  const found = (await candidates(page)).filter((c) => c.actionable).slice(0, 10);

  const offenders: { selector: string; message: string }[] = [];
  for (const candidate of found) {
    try {
      const locator = page.locator(candidate.selector).first();
      if (!(await locator.isVisible().catch(() => false))) continue;
      const startUrl = page.url();
      await locator.click({ timeout: 1500, force: true }).catch(() => {});
      await page.waitForTimeout(200);
      for (const err of await errors(page)) {
        if (!before.has(err.message)) {
          offenders.push({ selector: candidate.selector, message: err.message });
          before.add(err.message);
        }
      }
      if (page.url() !== startUrl) break;
    } catch {
      /* ignore undrivable elements */
    }
  }

  const score = found.length ? clamp01(offenders.length / found.length) : 0;
  return {
    score,
    detail: `${offenders.length}/${found.length} clicks triggered a new uncaught error.`,
    evidence: { offenders: offenders.slice(0, 10) },
  };
}

/**
 * EXCESSIVE SCROLL — how far the user must travel to reach the primary action,
 * plus raw page length relative to the viewport. A CTA below three viewports is
 * treated as fully buried.
 */
export async function probeExcessiveScroll(page: Page): Promise<ProbeResult> {
  const { height, viewport, ctaY } = await layout(page);
  const viewports = viewport > 0 ? height / viewport : 1;

  // Length alone is not a defect — a long article is fine. Weight it lightly.
  const lengthPenalty = clamp01((viewports - 4) / 8);
  // CTA depth is the real signal.
  const ctaPenalty = ctaY === null ? 0.6 : clamp01(ctaY / (viewport * 3));

  const score = clamp01(0.7 * ctaPenalty + 0.3 * lengthPenalty);
  return {
    score,
    detail:
      ctaY === null
        ? `No recognizable primary CTA found; page is ${viewports.toFixed(1)} viewports tall.`
        : `Primary CTA sits ${(ctaY / viewport).toFixed(1)} viewports down; page is ${viewports.toFixed(1)} viewports tall.`,
    evidence: { height, viewport, ctaY, viewports: Number(viewports.toFixed(2)) },
  };
}

/**
 * QUICKBACK — users bouncing straight back. Proxied by how long the page takes
 * to present something useful, plus whether there is meaningful above-fold
 * content at all.
 */
export async function probeQuickback(page: Page): Promise<ProbeResult> {
  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    const paints = performance.getEntriesByType("paint");
    const fcp = paints.find((p) => p.name === "first-contentful-paint");
    const aboveFold = Array.from(document.querySelectorAll("h1,h2,p,img,video"))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top < window.innerHeight && rect.height > 0 && rect.width > 0;
      }).length;
    return {
      fcp: fcp ? fcp.startTime : null,
      domContentLoaded: nav ? nav.domContentLoadedEventEnd : null,
      aboveFold,
    };
  });

  // 2.5s FCP is the commonly used "needs improvement" threshold; treat 4s+ as bad.
  const fcpPenalty = timing.fcp === null ? 0.3 : clamp01((timing.fcp - 1000) / 3000);
  const emptinessPenalty = clamp01((3 - timing.aboveFold) / 3);

  const score = clamp01(0.65 * fcpPenalty + 0.35 * emptinessPenalty);
  return {
    score,
    detail: `FCP ${timing.fcp === null ? "unknown" : Math.round(timing.fcp) + "ms"}; ${timing.aboveFold} meaningful element(s) above the fold.`,
    evidence: timing,
  };
}

export const PROBES: Record<IssueKind, (page: Page) => Promise<ProbeResult>> = {
  "dead-click": probeDeadClick,
  "rage-click": probeRageClick,
  "script-error": probeScriptError,
  "error-click": probeErrorClick,
  "excessive-scroll": probeExcessiveScroll,
  quickback: probeQuickback,
};

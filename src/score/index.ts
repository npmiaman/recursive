import { chromium, type Browser, type Page } from "playwright";
import { config } from "../config.ts";
import type { Issue, IssueKind } from "../diagnose/issues.ts";
import { INSTRUMENTATION } from "./instrument.ts";
import { PROBES, type ProbeResult } from "./probes.ts";

/**
 * The scorer. This is the piece that makes an AutoResearch-style loop possible
 * at all: it converts "is this page better?" into a single number the agent can
 * hill-climb in seconds, offline, without waiting on real traffic.
 *
 * Lower is better, matching AutoResearch's val_bpb convention.
 */

export interface Score {
  /** Composite 0..1, lower is better. This is the number the loop optimizes. */
  total: number;
  /** The probe matching the issue's own kind. */
  primary: ProbeResult & { kind: IssueKind };
  /** Every other probe, used as a regression guard. */
  regression: Record<string, ProbeResult>;
  url: string;
  measuredAt: string;
}

/** Probes that mutate page state and therefore need their own fresh load. */
const DESTRUCTIVE: IssueKind[] = ["rage-click", "error-click"];

const READ_ONLY: IssueKind[] = [
  "dead-click",
  "excessive-scroll",
  "quickback",
  "script-error",
];

export class Scorer {
  private browser?: Browser;

  async open(): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.launch({ headless: true });
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
  }

  private async newPage(url: string): Promise<Page> {
    if (!this.browser) throw new Error("Scorer not opened. Call open() first.");
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      // A fixed UA and locale keeps runs comparable across machines.
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 clarity-autoresearch/0.1",
      locale: "en-US",
    });
    const page = await context.newPage();

    // Must run before any site script so the addEventListener wrapper sees every
    // handler registration. The `{ content }` form is explicit that this is raw
    // source rather than a serialized function.
    await page.addInitScript({ content: INSTRUMENTATION });

    await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 }).catch(async () => {
      // networkidle never settles on pages with long-polling or open sockets.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    });

    // Let late hydration register its listeners before we inspect.
    await page.waitForTimeout(500);

    // Fallback: if the init script didn't take (CSP, an early navigation, a
    // Playwright behaviour change), inject now. Listener detection degrades —
    // handlers registered before this point are missed — so say so loudly
    // rather than silently reporting inflated dead-click numbers.
    const present = await page.evaluate(
      () => typeof (window as unknown as { __uxProbe?: unknown }).__uxProbe !== "undefined",
    );
    if (!present) {
      console.warn(
        "[scorer] instrumentation did not run at document-start; injecting late. " +
          "Click-listener detection is unreliable for this page.",
      );
      await page.evaluate(INSTRUMENTATION);
    }

    return page;
  }

  private async runProbe(kind: IssueKind, url: string): Promise<ProbeResult> {
    const page = await this.newPage(url);
    try {
      return await PROBES[kind](page);
    } finally {
      await page.context().close();
    }
  }

  /**
   * Score one issue's page.
   *
   * The composite deliberately blends the issue's own probe with every other
   * probe. Without that regression term the agent could "fix" dead clicks by
   * deleting the element, or fix excessive scroll by removing content — the
   * primary metric would improve while the page got worse. The 30% guard makes
   * collateral damage cost more than the fix is worth.
   */
  async score(issue: Issue): Promise<Score> {
    const url = new URL(issue.url, config.targetBaseUrl).toString();

    // Read-only probes share a single page load; destructive ones get their own.
    const results = new Map<IssueKind, ProbeResult>();

    const sharedPage = await this.newPage(url);
    try {
      for (const kind of READ_ONLY) {
        results.set(kind, await PROBES[kind](sharedPage));
      }
    } finally {
      await sharedPage.context().close();
    }

    for (const kind of DESTRUCTIVE) {
      results.set(kind, await this.runProbe(kind, url));
    }

    const primary = results.get(issue.kind)!;
    const regression: Record<string, ProbeResult> = {};
    let regressionSum = 0;
    let regressionCount = 0;
    let regressionMax = 0;
    for (const [kind, result] of results) {
      if (kind === issue.kind) continue;
      regression[kind] = result;
      regressionSum += result.score;
      regressionMax = Math.max(regressionMax, result.score);
      regressionCount++;
    }
    const regressionMean = regressionCount ? regressionSum / regressionCount : 0;

    // Weighted toward the WORST guard, not the average. Averaging across five
    // guards dilutes a single catastrophic regression into near-invisibility —
    // measured in testing, converting dead <div>s into <button>s that still had
    // no handler sent rage-click from 0.00 to 0.80 while moving the averaged
    // composite by only ~0.05. Trading one defect for another should not read as
    // a clean win.
    const regressionTerm = 0.4 * regressionMean + 0.6 * regressionMax;

    return {
      total: 0.7 * primary.score + 0.3 * regressionTerm,
      primary: { ...primary, kind: issue.kind },
      regression,
      url,
      measuredAt: new Date().toISOString(),
    };
  }
}

/** Convenience wrapper for one-off scoring. */
export async function scoreOnce(issue: Issue): Promise<Score> {
  const scorer = new Scorer();
  await scorer.open();
  try {
    return await scorer.score(issue);
  } finally {
    await scorer.close();
  }
}

export function formatScore(score: Score): string {
  const lines = [
    `score ${score.total.toFixed(4)}  (lower is better)  ${score.url}`,
    `  primary  ${score.primary.kind.padEnd(17)} ${score.primary.score.toFixed(4)}  ${score.primary.detail}`,
  ];
  for (const [kind, result] of Object.entries(score.regression)) {
    lines.push(`  guard    ${kind.padEnd(17)} ${result.score.toFixed(4)}  ${result.detail}`);
  }
  return lines.join("\n");
}

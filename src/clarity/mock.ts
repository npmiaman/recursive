import type { ClarityResponse, Dimension } from "./types.ts";

/**
 * Deterministic fixtures shaped exactly like the real Data Export API response,
 * so every layer can be built and tested before a token exists.
 *
 * The numbers encode a story the analysis should independently rediscover:
 *
 *  - /pricing has heavy dead clicks (a styled <div> that looks like a button)
 *  - /checkout has rage clicks and script errors (a failing submit handler)
 *  - /features has excessive scrolling (the CTA sits far below the fold)
 *
 * And, when split by Device, a story an average would completely hide:
 *
 *  - /checkout dead clicks are ~15× worse on Mobile than Desktop. Site-wide the
 * rate looks unremarkable; the cohort split is the only way to see it.
 *  - /pricing is uniformly bad across devices, a genuine problem, but NOT a
 * cohort finding. Included deliberately so the analysis has to tell the
 * difference between "bad" and "bad for a specific group".
 */

interface PageStats {
  url: string;
  sessions: number;
  dead: number;
  rage: number;
  scroll: number;
  quick: number;
  script: number;
  errClick: number;
}

const PAGES: PageStats[] = [
  {
    url: "/checkout",
    sessions: 4200,
    dead: 310,
    rage: 540,
    scroll: 90,
    quick: 260,
    script: 480,
    errClick: 120,
  },
  {
    url: "/pricing",
    sessions: 9100,
    dead: 1240,
    rage: 180,
    scroll: 210,
    quick: 340,
    script: 20,
    errClick: 15,
  },
  {
    url: "/features",
    sessions: 6800,
    dead: 90,
    rage: 40,
    scroll: 1450,
    quick: 180,
    script: 5,
    errClick: 2,
  },
  {
    url: "/",
    sessions: 24000,
    dead: 220,
    rage: 60,
    scroll: 300,
    quick: 410,
    script: 12,
    errClick: 8,
  },
  {
    url: "/docs/getting-started",
    sessions: 3100,
    dead: 45,
    rage: 12,
    scroll: 190,
    quick: 60,
    script: 0,
    errClick: 1,
  },
];

const DEVICES = ["Desktop", "Mobile", "Tablet"] as const;
/** Share of each page's traffic per device. */
const DEVICE_SHARE: Record<(typeof DEVICES)[number], number> = {
  Desktop: 0.55,
  Mobile: 0.4,
  Tablet: 0.05,
};

/**
 * How much worse each device is for a given page and metric.
 * 1.0 = same as the page average.
 */
function deviceMultiplier(url: string, device: string, metric: string): number {
  // The planted signal: checkout dead-clicks are catastrophic on mobile.
  if (url === "/checkout" && metric === "DeadClickCount") {
    if (device === "Mobile") return 8.5;
    if (device === "Tablet") return 2.0;
    return 0.18;
  }
  // Rage clicks on checkout follow the same cause, less extremely.
  if (url === "/checkout" && metric === "RageClickCount") {
    if (device === "Mobile") return 3.2;
    return 0.5;
  }
  // Everything else is roughly uniform, the analysis must NOT report these.
  return 1.0;
}

function makeRow(
  page: PageStats,
  count: number,
  metric: string,
  dimensions: Dimension[],
  device?: string,
): Record<string, unknown> {
  const share = device ? DEVICE_SHARE[device as (typeof DEVICES)[number]] : 1;
  const sessions = Math.round(page.sessions * share);
  const scaled = Math.round(count * share * deviceMultiplier(page.url, device ?? "", metric));

  const row: Record<string, unknown> = {
    sessionsCount: String(Math.min(scaled, sessions)),
    subTotal: String(Math.min(scaled, sessions)),
    sessionsWithMetricPercentage: Number(((scaled / Math.max(1, sessions)) * 100).toFixed(2)),
  };

  for (const dimension of dimensions) {
    if (dimension === "URL") row["URL"] = page.url;
    else if (dimension === "Device") row["Device"] = device ?? "Desktop";
    else if (dimension === "Browser") row["Browser"] = device === "Mobile" ? "Safari" : "Chrome";
    else if (dimension === "OS") row["OS"] = device === "Mobile" ? "iOS" : "Windows";
    else row[dimension] = "Other";
  }
  return row;
}

function metricRows(
  pick: (page: PageStats) => number,
  metric: string,
  dimensions: Dimension[],
): Record<string, unknown>[] {
  const splitByDevice =
    dimensions.includes("Device") || dimensions.includes("Browser") || dimensions.includes("OS");
  if (!splitByDevice) return PAGES.map((page) => makeRow(page, pick(page), metric, dimensions));

  return PAGES.flatMap((page) =>
    DEVICES.map((device) => makeRow(page, pick(page), metric, dimensions, device)),
  );
}

function trafficRows(dimensions: Dimension[]): Record<string, unknown>[] {
  const splitByDevice =
    dimensions.includes("Device") || dimensions.includes("Browser") || dimensions.includes("OS");

  const build = (page: PageStats, device?: string): Record<string, unknown> => {
    const share = device ? DEVICE_SHARE[device as (typeof DEVICES)[number]] : 1;
    const sessions = Math.round(page.sessions * share);
    const row: Record<string, unknown> = {
      totalSessionCount: String(sessions),
      totalBotSessionCount: String(Math.round(sessions * 0.08)),
      distantUserCount: String(Math.round(sessions * 0.72)),
      PagesPerSessionPercentage: 1.84,
    };
    for (const dimension of dimensions) {
      if (dimension === "URL") row["URL"] = page.url;
      else if (dimension === "Device") row["Device"] = device ?? "Desktop";
      else if (dimension === "Browser") row["Browser"] = device === "Mobile" ? "Safari" : "Chrome";
      else if (dimension === "OS") row["OS"] = device === "Mobile" ? "iOS" : "Windows";
      else row[dimension] = "Other";
    }
    return row;
  };

  if (!splitByDevice) return PAGES.map((page) => build(page));
  return PAGES.flatMap((page) => DEVICES.map((device) => build(page, device)));
}

export function generateMockResponse(dimensions: Dimension[] = ["URL"]): ClarityResponse {
  return [
    { metricName: "Traffic", information: trafficRows(dimensions) },
    {
      metricName: "DeadClickCount",
      information: metricRows((p) => p.dead, "DeadClickCount", dimensions),
    },
    {
      metricName: "RageClickCount",
      information: metricRows((p) => p.rage, "RageClickCount", dimensions),
    },
    {
      metricName: "ExcessiveScroll",
      information: metricRows((p) => p.scroll, "ExcessiveScroll", dimensions),
    },
    {
      metricName: "QuickbackClick",
      information: metricRows((p) => p.quick, "QuickbackClick", dimensions),
    },
    {
      metricName: "ScriptErrorCount",
      information: metricRows((p) => p.script, "ScriptErrorCount", dimensions),
    },
    {
      metricName: "ErrorClickCount",
      information: metricRows((p) => p.errClick, "ErrorClickCount", dimensions),
    },
  ];
}

import type { ClarityResponse, Dimension } from "./types.ts";

/**
 * Deterministic fixtures shaped exactly like the real Data Export API response,
 * so every layer downstream can be built and tested before a token exists.
 *
 * The numbers encode a plausible story a real project would show:
 *  - /pricing has heavy dead clicks (a styled <div> that looks like a button)
 *  - /checkout has rage clicks + script errors (a failing submit handler)
 *  - /features has excessive scroll (the CTA sits far below the fold)
 * The diagnosis layer should independently rediscover that ranking.
 */

const PAGES = [
  { url: "/checkout", sessions: 4200, dead: 310, rage: 540, scroll: 90, quick: 260, script: 480, errClick: 120 },
  { url: "/pricing", sessions: 9100, dead: 1240, rage: 180, scroll: 210, quick: 340, script: 20, errClick: 15 },
  { url: "/features", sessions: 6800, dead: 90, rage: 40, scroll: 1450, quick: 180, script: 5, errClick: 2 },
  { url: "/", sessions: 24000, dead: 220, rage: 60, scroll: 300, quick: 410, script: 12, errClick: 8 },
  { url: "/docs/getting-started", sessions: 3100, dead: 45, rage: 12, scroll: 190, quick: 60, script: 0, errClick: 1 },
] as const;

function rows(
  pick: (p: (typeof PAGES)[number]) => number,
  dimensions: Dimension[],
) {
  return PAGES.map((page) => {
    const row: Record<string, unknown> = {
      sessionsCount: String(pick(page)),
      subTotal: String(pick(page)),
      sessionsWithMetricPercentage: Number(
        ((pick(page) / page.sessions) * 100).toFixed(2),
      ),
    };
    // Echo back whichever dimensions were requested, as the API does.
    for (const dim of dimensions) {
      if (dim === "URL") row["URL"] = page.url;
      else if (dim === "Device") row["Device"] = "Mobile";
      else if (dim === "Browser") row["Browser"] = "Chrome";
      else if (dim === "OS") row["OS"] = "Android";
      else row[dim] = "Other";
    }
    return row;
  });
}

export function generateMockResponse(
  dimensions: Dimension[] = ["URL"],
): ClarityResponse {
  return [
    {
      metricName: "Traffic",
      information: PAGES.map((page) => {
        const row: Record<string, unknown> = {
          totalSessionCount: String(page.sessions),
          totalBotSessionCount: String(Math.round(page.sessions * 0.08)),
          distantUserCount: String(Math.round(page.sessions * 0.72)),
          PagesPerSessionPercentage: 1.84,
        };
        for (const dim of dimensions) {
          if (dim === "URL") row["URL"] = page.url;
          else row[dim] = "Other";
        }
        return row;
      }),
    },
    { metricName: "DeadClickCount", information: rows((p) => p.dead, dimensions) },
    { metricName: "RageClickCount", information: rows((p) => p.rage, dimensions) },
    { metricName: "ExcessiveScroll", information: rows((p) => p.scroll, dimensions) },
    { metricName: "QuickbackClick", information: rows((p) => p.quick, dimensions) },
    { metricName: "ScriptErrorCount", information: rows((p) => p.script, dimensions) },
    { metricName: "ErrorClickCount", information: rows((p) => p.errClick, dimensions) },
  ];
}

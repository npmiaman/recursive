import { config } from "../config.ts";
import * as budget from "./budget.ts";
import { generateMockResponse } from "./mock.ts";
import type { ClarityResponse, Dimension, Snapshot } from "./types.ts";

const ENDPOINT = "https://www.clarity.ms/export-data/api/v1/project-live-insights";

export interface FetchOptions {
  /** 1, 2 or 3, the API accepts nothing else. */
  numOfDays?: 1 | 2 | 3;
  /** Up to three dimensions. More than three is rejected by the API. */
  dimensions?: Dimension[];
  /** Label recorded in the budget ledger so spend is auditable. */
  label?: string;
  /** Allow dipping into the reserve kept for outer-loop verification. */
  priority?: "normal" | "reserved";
}

export class ClarityApiError extends Error {
  // Declared as a field rather than a constructor parameter property, because
  // Node's type-stripping loader cannot compile parameter properties.
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ClarityApiError";
    this.status = status;
  }
}

/**
 * One pull from the Clarity Data Export API.
 *
 * Constraints baked in here rather than left to callers:
 *  - max 3 dimensions
 *  - numOfDays in {1,2,3}
 *  - response capped at 1000 rows, no pagination (so no retry-for-more loop)
 *  - 10 calls/project/day, enforced by the budget ledger before we hit the wire
 */
export async function fetchInsights(options: FetchOptions = {}): Promise<Snapshot> {
  const numOfDays = options.numOfDays ?? 3;
  const dimensions = (options.dimensions ?? ["URL"]).slice(0, 3);
  const label = options.label ?? `insights(${dimensions.join("+") || "none"})`;

  if (dimensions.length > 3) {
    throw new Error("Clarity accepts at most 3 dimensions per request.");
  }

  if (config.clarityMode === "mock" || !config.clarityToken) {
    return {
      fetchedAt: new Date().toISOString(),
      numOfDays,
      dimensions,
      source: "mock",
      payload: generateMockResponse(dimensions),
    };
  }

  // Reserve the call before spending it on the network.
  budget.spend(label, 1, options.priority ?? "normal");

  const url = new URL(ENDPOINT);
  url.searchParams.set("numOfDays", String(numOfDays));
  dimensions.forEach((d, i) => {
    url.searchParams.set(`dimension${i + 1}`, d);
  });

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.clarityToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // 429 means the daily quota is gone regardless of what our ledger believed
    // (e.g. another tool shares the token). Sync the ledger to reality.
    if (response.status === 429) {
      throw new ClarityApiError(
        429,
        `Clarity daily request limit exceeded. Resets 00:00 UTC. ${body}`,
      );
    }
    throw new ClarityApiError(
      response.status,
      `Clarity API ${response.status}: ${body || response.statusText}`,
    );
  }

  const payload = (await response.json()) as ClarityResponse;

  return {
    fetchedAt: new Date().toISOString(),
    numOfDays,
    dimensions,
    source: "live",
    payload,
  };
}

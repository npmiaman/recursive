import { loadCredentials } from "../auth/store.ts";
import type { Learning } from "./anonymize.ts";

/**
 * The cross-user learning pool, over the dashboard.
 *
 * Upload is how a fix that worked here helps the next person; search is how this
 * machine benefits from everyone else's fixes. Both are best-effort and go
 * through the account you are logged in to, so learnings attribute to a team
 * without any code leaving the machine (see anonymize.ts for what actually
 * travels).
 *
 * Sharing is on when you are logged in to a dashboard, because a team dashboard
 * is a shared space by construction. Set RECURSIVE_NO_SHARE=1 to opt out: then
 * nothing is uploaded and nothing is fetched.
 */

function sharingEnabled(): boolean {
  return !process.env["RECURSIVE_NO_SHARE"];
}

export async function uploadLearning(learning: Learning): Promise<boolean> {
  if (!sharingEnabled()) return false;
  const creds = loadCredentials();
  if (!creds) return false;
  try {
    const res = await fetch(`${creds.apiUrl}/api/learnings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.token}` },
      body: JSON.stringify(learning),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false; // never let telemetry break the loop
  }
}

export interface PooledLearning {
  approach: string;
  symptom: string;
  outcome: "worked" | "reverted";
  /** How many times this approach was seen for this pattern. */
  count: number;
}

/**
 * What has worked elsewhere for a pattern.
 *
 * Returns approaches that fixed this same fingerprint across all accounts,
 * most-proven first, so the diagnosis can lead with "N teams fixed this by X".
 */
export async function searchLearnings(query: {
  fingerprint: string;
  signalClass: string;
  routePattern: string;
}): Promise<PooledLearning[]> {
  if (!sharingEnabled()) return [];
  const creds = loadCredentials();
  if (!creds) return [];
  try {
    const res = await fetch(`${creds.apiUrl}/api/learnings/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.token}` },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { learnings?: PooledLearning[] };
    return data.learnings ?? [];
  } catch {
    return [];
  }
}

/** Render pooled learnings for the diagnosis prompt / logs. */
export function renderPooledLearnings(learnings: PooledLearning[]): string {
  if (learnings.length === 0) return "";
  const lines = learnings
    .filter((l) => l.outcome === "worked")
    .slice(0, 5)
    .map((l) => `- (${l.count}x) ${l.approach}`);
  if (lines.length === 0) return "";
  return `## What worked for this pattern elsewhere\n\nOther teams hitting the same pattern fixed it by:\n${lines.join("\n")}\n`;
}

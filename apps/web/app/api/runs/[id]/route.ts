import { NextResponse } from "next/server";
import { insertRun, getRun, getRunEvents } from "@/lib/db";
import { accountFromAuthHeader } from "@/lib/session";

/**
 * A single run, live.
 *
 * This is what makes a cloud run watchable from a terminal. The runner POSTs
 * events here AS THEY HAPPEN (not just at the end), and `recursive watch` GETs
 * with `?since=<seq>` on a short poll, so you see the agent work in real time
 * from any machine — your laptop can be closed; the run is on GitHub's servers.
 */

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const account = await accountFromAuthHeader(request.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const run = await getRun(account.id, id);
  if (!run) return NextResponse.json({ error: "No such run" }, { status: 404 });

  // `since` lets the poller ask only for events it hasn't seen, so a long run
  // doesn't re-send its whole history every 1.5s.
  const since = Number(new URL(request.url).searchParams.get("since") ?? -1);
  const events = (await getRunEvents(id)).filter((e) => e.seq > since);

  return NextResponse.json({ run, events });
}

/**
 * Live event append. The runner calls this per event while the run is going.
 * `insertRun` already upserts by id and ignores duplicate (run_id, seq) pairs,
 * so re-sends and the final flush are both idempotent — nothing is doubled.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const account = await accountFromAuthHeader(request.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await request.json()) as {
    run?: Record<string, unknown>;
    events?: Record<string, unknown>[];
  };
  // The run row must exist for events to hang off it; the runner sends a
  // lightweight run snapshot with every push so the first event can create it.
  const run = body.run ?? { id, kind: "sweep", status: "running", startedAt: new Date().toISOString() };
  run["id"] = id;

  await insertRun(account.id, run, body.events ?? []);
  return NextResponse.json({ ok: true });
}

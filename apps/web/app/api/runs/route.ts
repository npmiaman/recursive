import { NextResponse } from "next/server";
import { insertRun } from "@/lib/db";
import { accountFromAuthHeader } from "@/lib/session";

/** Run ingestion. The CLI uploads finished runs here. */
export async function POST(request: Request) {
  const account = await accountFromAuthHeader(request.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json()) as {
    run?: Record<string, unknown>;
    events?: Record<string, unknown>[];
  };
  if (!body.run?.["id"]) return NextResponse.json({ error: "Missing run" }, { status: 400 });

  // Scoped to the authenticated account, a token can never write another
  // account's runs, whatever the payload claims.
  await insertRun(account.id, body.run, body.events ?? []);
  return NextResponse.json({ ok: true, runId: body.run["id"] });
}

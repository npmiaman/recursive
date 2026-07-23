import { NextResponse } from "next/server";
import { currentAccount } from "@/lib/session";
import { revokeCliSession } from "@/lib/db";

/** Revoke a connected terminal from the dashboard. */
export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = (await request.json()) as { id?: string };
  if (!body.id) return NextResponse.json({ error: "Missing terminal id." }, { status: 400 });
  const revoked = await revokeCliSession(account.id, body.id);
  return NextResponse.json({ ok: revoked });
}

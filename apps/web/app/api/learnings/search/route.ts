import { NextResponse } from "next/server";
import { accountFromAuthHeader } from "@/lib/session";
import { searchLearnings } from "@/lib/db";

/** What worked for a pattern, pooled across every account. */
export async function POST(request: Request) {
  const account = await accountFromAuthHeader(request.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { fingerprint } = (await request.json()) as { fingerprint?: string };
  if (!fingerprint) return NextResponse.json({ learnings: [] });
  const learnings = await searchLearnings(fingerprint);
  return NextResponse.json({ learnings });
}

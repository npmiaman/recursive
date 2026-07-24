import { NextResponse } from "next/server";
import { accountFromAuthHeader } from "@/lib/session";
import { recordLearning } from "@/lib/db";

/** Ingest one anonymized learning from a logged-in terminal. */
export async function POST(request: Request) {
  const account = await accountFromAuthHeader(request.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const l = (await request.json()) as Record<string, string>;
  if (!l.fingerprint || !l.signalClass || !l.approach) {
    return NextResponse.json({ error: "Malformed learning." }, { status: 400 });
  }
  await recordLearning(account.id, {
    fingerprint: l.fingerprint,
    signalClass: l.signalClass,
    routePattern: l.routePattern ?? "/",
    symptom: l.symptom ?? "",
    approach: l.approach,
    outcome: l.outcome ?? "worked",
    area: l.area,
    language: l.language,
  });
  return NextResponse.json({ ok: true });
}

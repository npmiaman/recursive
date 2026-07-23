import { NextResponse } from "next/server";
import { issueToken, verifyPassword } from "@/lib/db";
import { setSessionCookie } from "@/lib/session";

export async function POST(request: Request) {
  const body = (await request.json()) as { email?: string; password?: string };
  const account = verifyPassword(body.email ?? "", body.password ?? "");
  if (!account) {
    // One message for both cases, distinguishing them tells an attacker which
    // emails have accounts.
    return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });
  }
  await setSessionCookie(issueToken(account.id, "web"));
  return NextResponse.json({ account: { id: account.id, email: account.email } });
}

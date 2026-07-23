import { NextResponse } from "next/server";
import { createAccount, findAccountByEmail, issueToken } from "@/lib/db";
import { setSessionCookie } from "@/lib/session";

export async function POST(request: Request) {
  const body = (await request.json()) as { email?: string; password?: string; name?: string };
  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  // 12 chars, no composition rules, length beats character classes, and
  // arbitrary rules push people toward predictable substitutions.
  if (password.length < 12) {
    return NextResponse.json(
      { error: "Password must be at least 12 characters." },
      { status: 400 },
    );
  }
  if (findAccountByEmail(email)) {
    return NextResponse.json(
      { error: "An account with that email already exists." },
      { status: 409 },
    );
  }

  const account = createAccount(email, password, body.name);
  await setSessionCookie(issueToken(account.id, "web"));
  return NextResponse.json({ account: { id: account.id, email: account.email } });
}

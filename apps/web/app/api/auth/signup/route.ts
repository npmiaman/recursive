import { NextResponse } from "next/server";
import { createAccount, findAccountByEmail, issueToken } from "@/lib/db";
import { setSessionCookie } from "@/lib/session";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    email?: string;
    password?: string;
    name?: string;
    code?: string;
  };

  // Signup gate. The dashboard lends out a shared model key, so an open signup
  // on a public URL means anyone can burn it. When SIGNUP_CODE is set, a new
  // account must present it; share the code only with your team. Leave it unset
  // for a private/local instance.
  const required = process.env.SIGNUP_CODE;
  if (required && body.code !== required) {
    return NextResponse.json(
      { error: "This dashboard is invite-only. Ask the owner for the signup code." },
      { status: 403 },
    );
  }

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
  if (await findAccountByEmail(email)) {
    return NextResponse.json(
      { error: "An account with that email already exists." },
      { status: 409 },
    );
  }

  const account = await createAccount(email, password, body.name);
  await setSessionCookie(await issueToken(account.id, "web"));
  return NextResponse.json({ account: { id: account.id, email: account.email } });
}

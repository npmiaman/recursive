import { NextResponse } from "next/server";
import { currentAccount } from "@/lib/session";
import { verifyPassword, updatePassword } from "@/lib/db";

/** Change the signed-in account's password (requires the current one). */
export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await request.json()) as { currentPassword?: string; newPassword?: string };
  if (!body.currentPassword || !body.newPassword) {
    return NextResponse.json({ error: "Both current and new password are required." }, { status: 400 });
  }
  if (body.newPassword.length < 12) {
    return NextResponse.json({ error: "New password must be at least 12 characters." }, { status: 400 });
  }
  // Re-verify the current password, so a stolen session can't silently change it.
  const ok = await verifyPassword(account.email, body.currentPassword);
  if (!ok) return NextResponse.json({ error: "Current password is incorrect." }, { status: 403 });

  await updatePassword(account.id, body.newPassword);
  return NextResponse.json({ ok: true });
}

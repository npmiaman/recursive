import { NextResponse } from "next/server";
import { revokeToken } from "@/lib/db";
import { clearSessionCookie, currentSessionToken } from "@/lib/session";

/**
 * Sign out.
 *
 * Two steps, and both matter: revoke the session row so the token is dead
 * everywhere, then clear the cookie so this browser stops presenting it.
 * Clearing the cookie alone would leave a working token behind.
 *
 * POST rather than GET because a GET would let any page log you out with an
 * <img src="/api/auth/logout">, and because browsers pre-fetch GETs.
 *
 * Always returns ok, including when there was no session, "sign me out" has
 * no meaningful failure case, and reporting one just leaves the UI stuck on a
 * page it should already have left.
 */
export async function POST() {
  const token = await currentSessionToken();
  if (token) revokeToken(token);
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}

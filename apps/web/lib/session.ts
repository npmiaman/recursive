import { cookies } from "next/headers";
import { resolveToken, type Account } from "./db";

/**
 * Web session handling.
 *
 * The browser session token lives in an httpOnly cookie so page JavaScript
 * cannot read it, that's the difference between an XSS bug leaking a rendering
 * glitch and leaking every user's account.
 */

const COOKIE = "recursive_session";

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}

export async function currentAccount(): Promise<Account | undefined> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return undefined;
  return resolveToken(token);
}

/**
 * The raw session token, for signing out.
 *
 * Needed because signing out must REVOKE the session server-side, not merely
 * delete the cookie. Deleting the cookie only stops this browser from sending
 * the token, the token itself stays valid, so a copy taken from a shared
 * machine or a proxy log still works. Revoking makes it dead everywhere.
 */
export async function currentSessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(COOKIE)?.value;
}

/** Bearer-token auth for the CLI's API calls. */
export async function accountFromAuthHeader(header: string | null): Promise<Account | undefined> {
  if (!header?.startsWith("Bearer ")) return undefined;
  return resolveToken(header.slice(7).trim());
}

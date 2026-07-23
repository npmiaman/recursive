import { NextResponse } from "next/server";
import { health } from "@/lib/db";

/**
 * Liveness + database keep-alive.
 *
 * A Vercel cron hits this daily so the free-tier Postgres never sits idle long
 * enough to be paused (Supabase pauses after ~7 days of inactivity, which would
 * silently take the whole dashboard down). It runs a trivial query, so the ping
 * is also a real database health check, not just an HTTP 200.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ok = await health();
    return NextResponse.json({ ok, db: ok ? "up" : "down" }, { status: ok ? 200 : 503 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 503 });
  }
}

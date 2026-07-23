import { NextResponse } from "next/server";
import { pollDeviceCode } from "@/lib/db";

/** Step 3: the CLI polls until the browser approves. */
export async function POST(request: Request) {
  const body = (await request.json()) as { deviceCode?: string };
  if (!body.deviceCode) return NextResponse.json({ status: "expired" });
  return NextResponse.json(pollDeviceCode(body.deviceCode));
}

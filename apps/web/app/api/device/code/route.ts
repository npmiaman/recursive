import { NextResponse } from "next/server";
import { createDeviceCode } from "@/lib/db";

/** Step 1 of the device flow: the CLI asks for a code. No auth required yet. */
export async function POST() {
  const { deviceCode, userCode } = await createDeviceCode();
  return NextResponse.json({
    deviceCode,
    userCode,
    verificationUrl: "/device",
    interval: 3,
    expiresIn: 600,
  });
}

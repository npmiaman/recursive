import { NextResponse } from "next/server";
import { approveDeviceCode, denyDeviceCode } from "@/lib/db";
import { currentAccount } from "@/lib/session";

/** Step 2: the signed-in browser approves or denies the code the CLI showed. */
export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body = (await request.json()) as { userCode?: string; action?: "approve" | "deny" };
  if (!body.userCode) return NextResponse.json({ error: "Missing code." }, { status: 400 });

  if (body.action === "deny") {
    denyDeviceCode(body.userCode);
    return NextResponse.json({ ok: true, status: "denied" });
  }
  const ok = approveDeviceCode(body.userCode, account.id);
  if (!ok) {
    return NextResponse.json({ error: "That code is invalid or has expired." }, { status: 400 });
  }
  return NextResponse.json({ ok: true, status: "approved" });
}

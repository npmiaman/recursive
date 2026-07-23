import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentAccount } from "@/lib/session";
import { DeviceApproval } from "@/components/device-approval";

/**
 * Where `recursive login` sends you.
 *
 * Signing in is required first, and `next` carries you back here afterwards, so
 * the terminal's instruction ("open this URL and enter the code") stays true
 * whether or not you already had a session.
 */
export default async function DevicePage() {
  const account = await currentAccount();
  if (!account) redirect("/login?next=%2Fdevice");

  return (
    <Suspense>
      <DeviceApproval email={account.email} />
    </Suspense>
  );
}

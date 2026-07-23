import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAccount } from "@/lib/session";
import { SignOutButton } from "@/components/sign-out-button";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const account = await currentAccount();
  // Every dashboard route is gated here rather than page by page, so adding a
  // page cannot accidentally ship unauthenticated.
  if (!account) redirect("/login?next=%2Fdashboard");

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="font-semibold tracking-tight">
              Recursive
            </Link>
            <nav className="flex items-center gap-4 text-sm text-muted-foreground">
              <Link href="/dashboard" className="hover:text-foreground">
                Runs
              </Link>
              <Link href="/dashboard/insights" className="hover:text-foreground">
                Insights
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{account.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}

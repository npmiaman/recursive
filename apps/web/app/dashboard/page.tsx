import Link from "next/link";
import { headers } from "next/headers";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, StatTile } from "@/components/ui";
import { StatusBadge } from "@/components/status-badge";
import { TerminalList } from "@/components/terminal-list";
import { formatWhen } from "@/lib/format";
import { currentAccount } from "@/lib/session";
import { listRuns, listCliTokens, usageForAccount, isOwner, usageAllAccounts } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Overview, the page that makes the dashboard concrete.
 *
 * The old dashboard was vague because it showed run rows and nothing else. This
 * answers the three questions someone actually opens it for:
 *
 *   1. Is my terminal connected, and if not, exactly how do I connect it?
 *   2. How much of the shared model am I (and my team) using right now?
 *   3. What has Recursive been doing?
 *
 * Everything here is real: usage is metered by the model gateway on every call,
 * so these numbers move the moment a connected terminal runs anything.
 */
export default async function OverviewPage() {
  const account = (await currentAccount())!;
  const host = (await headers()).get("host") ?? "your-dashboard";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const dashboardUrl = `${proto}://${host}`;

  const terminals = await listCliTokens(account.id);
  const usage = await usageForAccount(account.id);
  const runs = await listRuns(account.id, 5);
  const owner = await isOwner(account.id);
  const team = owner ? await usageAllAccounts() : null;

  const connected = terminals.length > 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Signed in as {account.email}
          {owner ? <Badge variant="secondary" className="ml-2 align-middle">owner</Badge> : null}
        </p>
      </div>

      {/* 1. Connection state, the first thing that matters. */}
      {connected ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <span className="text-success">●</span> Terminal connected
            </CardTitle>
            <CardDescription>
              {terminals.length} terminal{terminals.length === 1 ? "" : "s"} signed in to this
              account. Model calls from them route through this dashboard and count toward your
              usage below.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TerminalList terminals={terminals} />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connect a terminal</CardTitle>
            <CardDescription>
              Install Recursive in any project and sign in with this account. No model key needed
              on your machine, it uses the shared one through this dashboard.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-4 text-xs leading-relaxed">
              npm install -g github:npmiaman/recursive{"\n"}
              cd your-project{"\n"}
              recursive login {dashboardUrl}
            </pre>
            <p className="mt-3 text-xs text-muted-foreground">
              `recursive login` shows a code; approve it at{" "}
              <Link href="/device" className="underline underline-offset-4">
                {dashboardUrl}/device
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      )}

      {/* 2. Usage, the real, live numbers. */}
      <div>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Your usage
          </h2>
          <Link href="/dashboard/usage" className="text-xs underline underline-offset-4">
            details
          </Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          <StatTile label="Model calls" value={usage.calls.toLocaleString()} />
          <StatTile label="Tokens used" value={compact(usage.totalTokens)} hint="prompt + completion" />
          <StatTile
            label="Right now"
            value={`${usage.callsLastMinute}/min`}
            tone={usage.callsLastMinute >= 40 ? "bad" : usage.callsLastMinute >= 30 ? "warn" : "default"}
            hint="shared limit is 40/min"
          />
          <StatTile
            label="Failed calls"
            value={usage.failedCalls.toLocaleString()}
            tone={usage.failedCalls > 0 ? "warn" : "good"}
          />
        </div>
      </div>

      {/* 3. Team usage, owner only, the "who is using how much" the owner asked for. */}
      {team ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Team usage</CardTitle>
            <CardDescription>
              Every account on this dashboard and how much of the shared model it has used.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-medium">Account</th>
                  <th className="px-5 py-3 text-right font-medium">Calls</th>
                  <th className="px-5 py-3 text-right font-medium">Tokens</th>
                  <th className="px-5 py-3 text-right font-medium">Last used</th>
                </tr>
              </thead>
              <tbody>
                {team.perAccount.map((a) => (
                  <tr key={a.accountId} className="border-b last:border-0">
                    <td className="px-5 py-3">
                      {a.email}
                      {a.accountId === account.id ? (
                        <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">{a.calls.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{compact(a.totalTokens)}</td>
                    <td className="px-5 py-3 text-right text-muted-foreground">
                      {a.lastUsedAt ? formatWhen(a.lastUsedAt) : "never"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}

      {/* 4. Recent activity. */}
      <div>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Recent runs
          </h2>
          <Link href="/dashboard/runs" className="text-xs underline underline-offset-4">
            all runs
          </Link>
        </div>
        {runs.length === 0 ? (
          <Card>
            <CardContent className="p-5 text-sm text-muted-foreground">
              No runs yet. Once a connected terminal runs `recursive sweep` or `repair`, what it did
              shows up here, successes and failures alike.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="px-5 py-3">
                        <Link
                          href={`/dashboard/runs/${run.id}`}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {run.kind}
                        </Link>
                        <span className="ml-2 text-xs text-muted-foreground">{run.projectId}</span>
                      </td>
                      <td className="px-5 py-3 text-right text-muted-foreground">
                        {formatWhen(run.startedAt)}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <StatusBadge status={run.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

/** 1234 -> 1.2k, for token counts that get large fast. */
function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

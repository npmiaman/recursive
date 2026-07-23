import { Card, CardContent, CardDescription, CardHeader, CardTitle, StatTile } from "@/components/ui";
import { formatWhen } from "@/lib/format";
import { currentAccount } from "@/lib/session";
import { usageForAccount, isOwner, usageAllAccounts, type UsageSummary } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Usage, in full.
 *
 * The point of routing every model call through the dashboard is that usage is
 * measurable per account. This page is that measurement: your own totals and a
 * simple daily trend, and, for the owner, the same broken down across everyone
 * sharing the key.
 */
export default async function UsagePage() {
  const account = (await currentAccount())!;
  const mine = usageForAccount(account.id);
  const owner = isOwner(account.id);
  const team = owner ? usageAllAccounts() : null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Model calls routed through this dashboard on the shared key.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <StatTile label="Your calls" value={mine.calls.toLocaleString()} />
        <StatTile label="Prompt tokens" value={compact(mine.promptTokens)} />
        <StatTile label="Completion tokens" value={compact(mine.completionTokens)} />
        <StatTile label="Total tokens" value={compact(mine.totalTokens)} />
      </div>

      <DailyTrend title="Your last 14 days" summary={mine} />

      {team ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatTile label="Team calls" value={team.total.calls.toLocaleString()} />
            <StatTile label="Team tokens" value={compact(team.total.totalTokens)} />
            <StatTile
              label="Team, right now"
              value={`${team.total.callsLastMinute}/min`}
              tone={team.total.callsLastMinute >= 40 ? "bad" : "default"}
              hint="shared limit is 40/min"
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">By account</CardTitle>
              <CardDescription>Who is using how much of the shared key.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-5 py-3 font-medium">Account</th>
                    <th className="px-5 py-3 text-right font-medium">Calls</th>
                    <th className="px-5 py-3 text-right font-medium">Tokens</th>
                    <th className="px-5 py-3 text-right font-medium">Share</th>
                    <th className="px-5 py-3 text-right font-medium">Last used</th>
                  </tr>
                </thead>
                <tbody>
                  {team.perAccount.map((a) => {
                    const share = team.total.totalTokens
                      ? Math.round((a.totalTokens / team.total.totalTokens) * 100)
                      : 0;
                    return (
                      <tr key={a.accountId} className="border-b last:border-0">
                        <td className="px-5 py-3">
                          {a.email}
                          {a.accountId === account.id ? (
                            <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                          ) : null}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums">{a.calls.toLocaleString()}</td>
                        <td className="px-5 py-3 text-right tabular-nums">{compact(a.totalTokens)}</td>
                        <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">{share}%</td>
                        <td className="px-5 py-3 text-right text-muted-foreground">
                          {a.lastUsedAt ? formatWhen(a.lastUsedAt) : "never"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function DailyTrend({ title, summary }: { title: string; summary: UsageSummary }) {
  const max = Math.max(1, ...summary.daily.map((d) => d.tokens));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {summary.daily.length === 0 ? (
          <p className="text-sm text-muted-foreground">No usage yet.</p>
        ) : (
          <div className="flex items-end gap-1" style={{ height: 120 }}>
            {summary.daily.map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className="w-full rounded-t bg-primary/70"
                  style={{ height: `${Math.max(2, (d.tokens / max) * 100)}%` }}
                  title={`${d.day}: ${d.calls} calls, ${d.tokens} tokens`}
                />
                <span className="text-[10px] text-muted-foreground">{d.day.slice(5)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

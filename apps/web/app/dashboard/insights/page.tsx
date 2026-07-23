import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  StatTile,
} from "@/components/ui";
import { computeInsights } from "@/lib/db";
import { currentAccount } from "@/lib/session";
import { formatDuration, formatWhen } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Is Recursive actually working?
 *
 * Measured on this account's real runs, not on a benchmark whose answers we
 * wrote. Two rules govern this page:
 *
 *   1. A rate with no sample size is a lie waiting to happen, so every
 * percentage carries its denominator.
 *   2. "Not enough data yet" is shown as itself rather than as 0%, because a
 * confident zero reads as a failure when it means silence.
 */
export default async function InsightsPage() {
  const account = (await currentAccount())!;
  const insights = computeInsights(account.id);

  if (insights.totalRuns === 0) {
    return (
      <Card>
        <CardContent className="p-8">
          <h1 className="text-xl font-semibold tracking-tight">Nothing measured yet</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Insights appear once Recursive has run against a repository.{" "}
            <Link href="/dashboard" className="underline underline-offset-4">
              Set one up
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    );
  }

  const pct = (rate: number | null): string =>
    rate === null ? ", " : `${Math.round(rate * 100)}%`;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Insights</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Measured across {insights.totalRuns} run{insights.totalRuns === 1 ? "" : "s"} on your
          projects.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Fix acceptance"
          value={pct(insights.fixAcceptanceRate)}
          tone={rateTone(insights.fixAcceptanceRate, 0.4, 0.15)}
          hint={
            insights.attemptsTried === 0
              ? "No fix attempts yet"
              : `${insights.attemptsKept} kept of ${insights.attemptsTried} tried`
          }
        />
        <StatTile
          label="Retrieval hit rate"
          value={pct(insights.retrievalHitRate)}
          tone={rateTone(insights.retrievalHitRate, 0.85, 0.6)}
          hint={
            insights.retrievalSamples === 0
              ? "No repairs to measure against"
              : `Found the edited file in ${insights.retrievalSamples} repair${insights.retrievalSamples === 1 ? "" : "s"}`
          }
        />
        <StatTile
          label="Retrieval ranked #1"
          value={pct(insights.retrievalTop1Rate)}
          tone={rateTone(insights.retrievalTop1Rate, 0.6, 0.35)}
          hint="Right file at the top, not just in the list"
        />
        <StatTile
          label="Actions blocked"
          value={pct(insights.containmentBlockedRate)}
          hint="Guardrails stopping a proposed action, not a failure"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By run type</CardTitle>
            <CardDescription>Where time goes, and what breaks.</CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Kind</th>
                  <th className="pb-2 text-right font-medium">Runs</th>
                  <th className="pb-2 text-right font-medium">Failed</th>
                  <th className="pb-2 text-right font-medium">Median</th>
                </tr>
              </thead>
              <tbody>
                {insights.runsByKind.map((row) => (
                  <tr key={row.kind} className="border-t">
                    <td className="py-2">{row.kind}</td>
                    <td className="py-2 text-right tabular-nums">{row.count}</td>
                    <td
                      className={`py-2 text-right tabular-nums ${row.failed > 0 ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {row.failed}
                    </td>
                    <td className="py-2 text-right tabular-nums text-muted-foreground">
                      {formatDuration(insights.medianDurationMs[row.kind] ?? null)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent failures</CardTitle>
            <CardDescription>What went wrong most recently, and where to look.</CardDescription>
          </CardHeader>
          <CardContent>
            {insights.recentFailures.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing has failed.</p>
            ) : (
              <ul className="space-y-3">
                {insights.recentFailures.map((failure) => (
                  <li key={failure.id} className="text-sm">
                    <Link
                      href={`/dashboard/runs/${failure.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {failure.kind}
                    </Link>
                    <span className="text-muted-foreground"> · {formatWhen(failure.at)}</span>
                    <p className="mt-0.5 text-muted-foreground">{failure.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * Colour a rate against thresholds, staying neutral when there is no data.
 *
 * A null rate must NOT render as red, "we have not measured this" and "this is
 * bad" are different statements, and conflating them makes a new account look
 * broken on its first day.
 */
function rateTone(
  rate: number | null,
  good: number,
  bad: number,
): "default" | "good" | "bad" | "warn" {
  if (rate === null) return "default";
  if (rate >= good) return "good";
  if (rate < bad) return "bad";
  return "warn";
}

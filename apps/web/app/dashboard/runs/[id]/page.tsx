import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardContent, CardHeader, CardTitle, Separator } from "@/components/ui";
import { getRun, getRunEvents } from "@/lib/db";
import { currentAccount } from "@/lib/session";
import { StatusBadge } from "@/components/status-badge";
import { formatDuration, formatWhen } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * One run, in full.
 *
 * The timeline is the point. When Recursive says it fixed something, this page
 * has to be enough to check that claim without trusting it: which files it
 * retrieved, what it believed was wrong, what it changed, and, the part that
 * actually settles it, what happened when the user journey was re-run
 * afterwards. Runs that failed get the same treatment; a system that only
 * shows its wins is not auditable.
 */
export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = (await currentAccount())!;

  // Scoped by account inside the query, not filtered after, this is the only
  // thing standing between one customer's runs and another's.
  const run = await getRun(account.id, id);
  if (!run) notFound();

  const events = await getRunEvents(run.id);
  const outcome = (run.payload["outcome"] ?? {}) as Record<string, unknown>;

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/dashboard"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← All runs
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{run.kind}</h1>
          <StatusBadge status={run.status} />
          <Badge variant="outline">{run.trigger}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {run.projectId} · started {formatWhen(run.startedAt)} · took{" "}
          {formatDuration(run.durationMs)} · <span className="font-mono">{run.id}</span>
        </p>
      </div>

      {Object.keys(outcome).length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Outcome</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              {Object.entries(outcome).map(([key, value]) => (
                <div key={key} className="flex items-baseline justify-between gap-4">
                  <dt className="text-sm text-muted-foreground">{humanize(key)}</dt>
                  <dd className="text-right text-sm font-medium tabular-nums">
                    {formatValue(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">This run recorded no step-level events.</p>
          ) : (
            <ol className="space-y-0">
              {events.map((event, index) => (
                <li key={event.seq}>
                  {index > 0 ? <Separator className="my-3" /> : null}
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotFor(event.type)}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-3">
                        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {event.stage}
                        </span>
                        {event.durationMs !== null ? (
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {formatDuration(event.durationMs)}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-sm">{event.message}</p>
                      {event.data ? (
                        <pre className="mt-2 overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
                          {JSON.stringify(event.data, null, 2)}
                        </pre>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function dotFor(type: string): string {
  if (type === "error" || type === "failed") return "bg-destructive";
  if (type === "warning") return "bg-warning";
  if (type === "success" || type === "verified") return "bg-success";
  return "bg-muted-foreground";
}

/** camelCase key → readable label, so new payload fields need no UI change. */
function humanize(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return ", ";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length ? value.join(", ") : ", ";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

import Link from "next/link";
import { Card, CardContent, StatTile } from "@/components/ui";
import { StatusBadge } from "@/components/status-badge";
import { formatDuration, formatWhen } from "@/lib/format";
import { listRuns } from "@/lib/db";
import { currentAccount } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Every Recursive session, newest first.
 *
 * The run list is the product's memory of itself: what it did, whether it
 * worked, and how long it took. It exists so nobody has to take a claim of
 * "self-healing" on trust, a failed run is as visible as a successful one, and
 * deliberately so.
 */
export default async function RunsPage() {
  const account = (await currentAccount())!;
  const runs = listRuns(account.id, 100);

  if (runs.length === 0) return <EmptyState />;

  const failed = runs.filter((r) => r.status === "failed").length;
  const last24h = runs.filter((r) => Date.now() - Date.parse(r.startedAt) < 86_400_000).length;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything Recursive has done on your projects.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="Total runs" value={String(runs.length)} />
        <StatTile label="Last 24 hours" value={String(last24h)} />
        <StatTile
          label="Failed"
          value={String(failed)}
          tone={failed > 0 ? "bad" : "good"}
          hint={failed > 0 ? "Open one to see why" : "Nothing failed"}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-5 py-3 font-medium">Run</th>
                <th className="px-5 py-3 font-medium">Project</th>
                <th className="px-5 py-3 font-medium">Trigger</th>
                <th className="px-5 py-3 font-medium">Started</th>
                <th className="px-5 py-3 text-right font-medium">Duration</th>
                <th className="px-5 py-3 text-right font-medium">Status</th>
              </tr>
            </thead>
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
                    <div className="font-mono text-xs text-muted-foreground">
                      {run.id.slice(0, 8)}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">{run.projectId}</td>
                  <td className="px-5 py-3 text-muted-foreground">{run.trigger}</td>
                  <td className="px-5 py-3 text-muted-foreground">{formatWhen(run.startedAt)}</td>
                  <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                    {formatDuration(run.durationMs)}
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
    </div>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="space-y-4 p-8">
        <h1 className="text-xl font-semibold tracking-tight">No runs yet</h1>
        <p className="text-sm text-muted-foreground">
          Connect a repository and Recursive will start recording everything it does here.
        </p>
        <pre className="rounded-md border bg-muted/40 p-4 text-xs leading-relaxed text-muted-foreground">
          npm install -g recursive{"\n"}
          recursive login{"\n"}
          recursive memory index --repo .{"\n"}
          recursive sweep daily
        </pre>
      </CardContent>
    </Card>
  );
}

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { formatWhen } from "@/lib/format";

type Terminal = { id: string; label: string | null; createdAt: string; lastUsedAt: string | null };

/**
 * Connected terminals, each revocable.
 *
 * A lost or decommissioned laptop should not keep access to the shared key.
 * Revoking deletes that session server-side, so its token is dead immediately.
 */
export function TerminalList({ terminals }: { terminals: Terminal[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string>();

  async function revoke(id: string) {
    setBusy(id);
    try {
      await fetch("/api/terminals/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      router.refresh();
    } finally {
      setBusy(undefined);
    }
  }

  if (terminals.length === 0) return null;
  return (
    <ul className="space-y-1.5 text-sm">
      {terminals.map((t) => (
        <li key={t.id} className="flex items-center justify-between gap-3">
          <span>{t.label ?? "terminal"}</span>
          <span className="flex items-center gap-3">
            <span className="text-muted-foreground">
              {t.lastUsedAt ? `active ${formatWhen(t.lastUsedAt)}` : `connected ${formatWhen(t.createdAt)}`}
            </span>
            <Button variant="ghost" size="sm" disabled={busy === t.id} onClick={() => revoke(t.id)}>
              {busy === t.id ? "…" : "Revoke"}
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}

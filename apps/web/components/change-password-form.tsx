"use client";

import * as React from "react";
import { Button, Input, Label } from "@/components/ui";

export function ChangePasswordForm() {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [msg, setMsg] = React.useState<{ ok?: boolean; text: string }>();
  const [pending, setPending] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setMsg(undefined);
    try {
      const r = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const d = (await r.json()) as { error?: string };
      setMsg(r.ok ? { ok: true, text: "Password changed." } : { text: d.error ?? "Failed." });
      if (r.ok) {
        setCurrent("");
        setNext("");
      }
    } catch {
      setMsg({ text: "Could not reach the server." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-sm space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="current">Current password</Label>
        <Input id="current" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="next">New password</Label>
        <Input id="next" type="password" value={next} onChange={(e) => setNext(e.target.value)} required />
        <p className="text-xs text-muted-foreground">At least 12 characters.</p>
      </div>
      {msg ? (
        <p className={`text-sm ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.text}</p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "…" : "Change password"}
      </Button>
    </form>
  );
}

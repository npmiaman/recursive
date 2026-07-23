"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@/components/ui";

/**
 * Approving a terminal.
 *
 * The security property that matters: approval happens HERE, in an
 * authenticated browser session, not in the terminal. The CLI never sees a
 * password and never handles one, it polls with a device code and receives a
 * token only after a human who is already signed in says yes.
 *
 * The deny button is not decoration. If a code appears that you did not
 * generate, that is someone else trying to attach a machine to your account,
 * and the useful response is to kill it rather than to close the tab.
 */
export function DeviceApproval({ email }: { email: string }) {
  const params = useSearchParams();
  // Prefilled when the CLI printed a full URL, typed by hand otherwise.
  const [code, setCode] = React.useState((params.get("code") ?? "").toUpperCase());
  const [state, setState] = React.useState<"idle" | "pending" | "approved" | "denied">("idle");
  const [error, setError] = React.useState<string>();

  async function act(action: "approve" | "deny") {
    setState("pending");
    setError(undefined);
    try {
      const response = await fetch("/api/device/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode: code.trim().toUpperCase(), action }),
      });
      const data = (await response.json()) as { error?: string; status?: string };
      if (!response.ok) {
        setError(data.error ?? "That code could not be approved.");
        setState("idle");
        return;
      }
      setState(action === "deny" ? "denied" : "approved");
    } catch {
      setError("Could not reach the server.");
      setState("idle");
    }
  }

  if (state === "approved") {
    return (
      <Shell>
        <CardHeader>
          <CardTitle className="text-success">Terminal connected</CardTitle>
          <CardDescription>
            Your terminal is signed in as {email}. You can close this tab and go back to it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            recursive memory index --repo .{"\n"}recursive sweep daily
          </pre>
        </CardContent>
      </Shell>
    );
  }

  if (state === "denied") {
    return (
      <Shell>
        <CardHeader>
          <CardTitle>Request denied</CardTitle>
          <CardDescription>
            That code was rejected and cannot be used. If you did not start it, nothing was
            connected to your account.
          </CardDescription>
        </CardHeader>
      </Shell>
    );
  }

  return (
    <Shell>
      <CardHeader>
        <CardTitle>Connect a terminal</CardTitle>
        <CardDescription>
          Enter the code shown by <code className="text-foreground">recursive login</code>. Signed
          in as {email}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act("approve");
          }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="code">Device code</Label>
            <Input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX"
              autoComplete="off"
              className="text-center font-mono text-lg tracking-[0.3em]"
              required
            />
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button type="submit" className="flex-1" disabled={state === "pending" || !code.trim()}>
              {state === "pending" ? "…" : "Approve"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={state === "pending" || !code.trim()}
              onClick={() => void act("deny")}
            >
              Deny
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            Approving grants this terminal access to your account until you revoke it. If you did
            not start this, deny it.
          </p>
        </form>
      </CardContent>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">{children}</Card>
    </main>
  );
}

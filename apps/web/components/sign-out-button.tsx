"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  async function signOut() {
    setPending(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Leaving is not worth blocking on. If the request failed the cookie may
      // survive, but the redirect below hits a gated route, which bounces
      // straight back to /login, so the user still ends up signed out.
    }
    router.push("/login");
    // Without refresh() the server components stay in the router cache and the
    // dashboard briefly re-renders with the old session still shown.
    router.refresh();
  }

  return (
    <Button variant="ghost" size="sm" onClick={signOut} disabled={pending}>
      {pending ? "Signing out…" : "Sign out"}
    </Button>
  );
}

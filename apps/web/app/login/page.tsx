import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { currentAccount } from "@/lib/session";

export default async function LoginPage() {
  if (await currentAccount()) redirect("/dashboard");
  // Suspense because AuthForm reads search params, which opts it into CSR
  // bailout; without the boundary the whole route de-opts to client rendering.
  return (
    <Suspense>
      <AuthForm mode="login" />
    </Suspense>
  );
}

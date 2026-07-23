import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { currentAccount } from "@/lib/session";

export default async function SignupPage() {
  if (await currentAccount()) redirect("/dashboard");
  return (
    <Suspense>
      <AuthForm mode="signup" />
    </Suspense>
  );
}

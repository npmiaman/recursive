import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { currentAccount } from "@/lib/session";
import { listCliTokens } from "@/lib/db";
import { TerminalList } from "@/components/terminal-list";
import { ChangePasswordForm } from "@/components/change-password-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const account = (await currentAccount())!;
  const terminals = await listCliTokens(account.id);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">{account.email}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connected terminals</CardTitle>
          <CardDescription>
            Machines signed in to this account. Revoke any you no longer trust; its access to the
            shared key stops immediately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {terminals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No terminals connected.</p>
          ) : (
            <TerminalList terminals={terminals} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Change password</CardTitle>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>
    </div>
  );
}

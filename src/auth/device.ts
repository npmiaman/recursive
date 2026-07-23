import { spawn } from "node:child_process";
import { saveCredentials, type Credentials } from "./store.ts";

/**
 * Device authorization flow, `recursive login`.
 *
 * The same shape as `gh auth login` and `vercel login`, chosen for one reason:
 * **the terminal never handles the password.** The CLI gets a short code, the
 * browser does the authenticating, and the CLI polls until approved. A user
 * typing credentials into a terminal that a coding agent also runs in is a bad
 * idea, and this avoids it entirely.
 */

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  /** Seconds between polls, set by the server. */
  interval: number;
  expiresIn: number;
}

type TokenResponse =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "approved"; token: string; accountId: string; email: string };

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(command, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Headless or locked-down machine, the printed URL is the fallback.
  }
}

export interface LoginOptions {
  apiUrl: string;
  /** Don't try to open a browser (CI, SSH, containers). */
  noBrowser?: boolean;
  onProgress?: (line: string) => void;
}

export async function login(options: LoginOptions): Promise<Credentials> {
  const log = options.onProgress ?? ((l: string) => console.log(l));
  const apiUrl = options.apiUrl.replace(/\/+$/, "");

  const startResponse = await fetch(`${apiUrl}/api/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientName: "recursive-cli" }),
  });

  if (!startResponse.ok) {
    throw new Error(
      `Could not start login against ${apiUrl} (${startResponse.status}). ` +
        `Is the dashboard running? Set RECURSIVE_API_URL if it's elsewhere.`,
    );
  }

  const device = (await startResponse.json()) as DeviceCodeResponse;
  const verifyUrl = `${apiUrl}${device.verificationUrl}`;

  log("");
  log(`  Your code:  ${device.userCode}`);
  log("");
  log(`  Approve at: ${verifyUrl}`);
  log("");

  if (!options.noBrowser) {
    openBrowser(`${verifyUrl}?code=${encodeURIComponent(device.userCode)}`);
    log("  (opening your browser…)");
  }
  log("  Waiting for approval…");

  const deadline = Date.now() + device.expiresIn * 1000;
  // Server-provided interval, floored, polling faster than asked is how you
  // get rate limited by your own backend.
  const intervalMs = Math.max(2000, device.interval * 1000);

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));

    let result: TokenResponse;
    try {
      const response = await fetch(`${apiUrl}/api/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode: device.deviceCode }),
      });
      result = (await response.json()) as TokenResponse;
    } catch {
      continue; // transient network trouble; keep waiting
    }

    if (result.status === "approved") {
      const credentials: Credentials = {
        accountId: result.accountId,
        email: result.email,
        token: result.token,
        apiUrl,
        createdAt: new Date().toISOString(),
      };
      saveCredentials(credentials);
      return credentials;
    }
    if (result.status === "denied") throw new Error("Login was denied in the browser.");
    if (result.status === "expired") break;
  }

  throw new Error("Login timed out. Run `recursive login` again.");
}

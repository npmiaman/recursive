import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Credential storage for the CLI.
 *
 * Stored under the user's home directory rather than the project, so a token is
 * never picked up by `git add -A` and never travels in a repo. Written 0600,
 * on a shared build machine a world-readable token is a real exposure, not a
 * theoretical one.
 */

export interface Credentials {
  accountId: string;
  email: string;
  token: string;
  apiUrl: string;
  createdAt: string;
}

function credentialsDir(): string {
  const dir = resolve(homedir(), ".recursive");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function credentialsPath(): string {
  return resolve(credentialsDir(), "credentials.json");
}

export function saveCredentials(credentials: Credentials): void {
  const path = credentialsPath();
  writeFileSync(path, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  try {
    // writeFileSync's mode is ignored if the file already existed.
    chmodSync(path, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
}

export function loadCredentials(): Credentials | undefined {
  // An env var wins, so CI can authenticate without an interactive login.
  const envToken = process.env["RECURSIVE_TOKEN"];
  if (envToken) {
    return {
      accountId: process.env["RECURSIVE_ACCOUNT_ID"] ?? "env",
      email: "",
      token: envToken,
      apiUrl: process.env["RECURSIVE_API_URL"] ?? "http://localhost:4400",
      createdAt: new Date().toISOString(),
    };
  }

  const path = credentialsPath();
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Credentials;
  } catch {
    return undefined;
  }
}

export function clearCredentials(): void {
  const path = credentialsPath();
  if (existsSync(path)) unlinkSync(path);
}

export function isLoggedIn(): boolean {
  return loadCredentials() !== undefined;
}

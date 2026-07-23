import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Minimal .env loader. Deliberately dependency-free — this runs before anything
 * else and a broken dotenv shouldn't be able to take the CLI down.
 * Real environment variables always win over the file.
 */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value !== "") process.env[key] = value;
  }
}

loadEnvFile(resolve(ROOT, ".env"));

const Schema = z.object({
  anthropicApiKey: z.string().optional(),
  clarityToken: z.string().optional(),
  clarityMode: z.enum(["mock", "live"]).default("mock"),
  targetBaseUrl: z.string().url().default("http://localhost:3000"),
  targetRepoPath: z.string().optional(),
  prBaseBranch: z.string().default("main"),
  maxIterations: z.number().int().positive().default(12),
  verifyAfterDays: z.number().int().positive().default(3),
});

export type Config = z.infer<typeof Schema> & {
  dataDir: string;
  model: string;
};

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

const parsed = Schema.parse({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
  clarityToken: process.env.CLARITY_API_TOKEN || undefined,
  // A live mode with no token is a configuration error waiting to happen at the
  // worst moment (mid-loop). Degrade to mock loudly instead.
  clarityMode: process.env.CLARITY_API_TOKEN
    ? (process.env.CLARITY_MODE as "mock" | "live") || "live"
    : "mock",
  targetBaseUrl: process.env.TARGET_BASE_URL || "http://localhost:3000",
  targetRepoPath: process.env.TARGET_REPO_PATH || undefined,
  prBaseBranch: process.env.PR_BASE_BRANCH || "main",
  maxIterations: num(process.env.MAX_ITERATIONS, 12),
  verifyAfterDays: num(process.env.VERIFY_AFTER_DAYS, 3),
});

export const config: Config = {
  ...parsed,
  dataDir: resolve(ROOT, "data"),
  // Opus 4.8 for every reasoning stage. Diagnosis quality is the whole product;
  // this is not the place to save tokens.
  model: "claude-opus-4-8",
};

if (process.env.CLARITY_MODE === "live" && !config.clarityToken) {
  console.warn(
    "[config] CLARITY_MODE=live but CLARITY_API_TOKEN is empty — falling back to mock fixtures.",
  );
}

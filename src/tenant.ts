import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { config } from "./config.ts";

/**
 * Tenant → Project → Environment.
 *
 * Recursive runs inside other people's products, so isolation is structural
 * rather than conventional: every signal, incident, action and audit record is
 * scoped to a project id, and there is no code path that reads across projects.
 *
 * Credentials live here as *references*, never as values. Recursive acts on a
 * customer's production through mechanisms they already control and can revoke,
 * so what we store is "which flag provider, under which key name", not the key.
 */

export const ProjectSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  environment: z.enum(["production", "staging", "development"]).default("production"),

  /** Origin the synthetic checks and the proxy scorer drive. */
  baseUrl: z.string().url(),

  /** Clarity project token env var name, if the customer connected Clarity. */
  clarityTokenEnv: z.string().optional(),

  /** Repo for the Tier 1 fix stage. Absent = detection and Tier 0 only. */
  repoPath: z.string().optional(),

  /** Which mechanisms Tier 0 may use. Empty = containment disabled. */
  containment: z
    .object({
      flagProvider: z.enum(["none", "local", "launchdarkly", "statsig", "custom"]).default("none"),
      flagProviderKeyEnv: z.string().optional(),
      deployProvider: z.enum(["none", "local", "vercel", "custom"]).default("none"),
      deployProviderKeyEnv: z.string().optional(),
    })
    .default({ flagProvider: "none", deployProvider: "none" }),

  /**
   * Customer-set caps. Enforced by us; the agent cannot raise them.
   * See ARCHITECTURE.md §4, blast radius is capped before it is calculated.
   */
  guardrails: z
    .object({
      /** Max share of traffic a single Tier 0 action may affect. */
      maxBlastRadiusPct: z.number().min(0).max(100).default(100),
      /** Max autonomous actions per hour, across the whole project. */
      maxActionsPerHour: z.number().int().min(0).default(3),
      /** Minutes before the same incident may be acted on again. */
      cooldownMinutes: z.number().int().min(0).default(30),
      /** Signal classes Tier 0 may act on. Anything else escalates to a human. */
      allowedActions: z.array(z.enum(["flag-off", "rollback"])).default(["flag-off"]),
      /**
       * Paths where switching things OFF is not an acceptable response.
       *
       * Containment assumes there is something to fall back to. For core
       * functionality there often isn't, disabling checkout is not a milder
       * form of broken checkout, it is the same outage with a different cause.
       * Failures matching these prefixes skip containment entirely and go
       * straight to repair.
       */
      repairOnlyPaths: z.array(z.string()).default([]),
      /** Master off switch, customer-controlled. */
      autonomyEnabled: z.boolean().default(false),
    })
    // Spelled out rather than `{}`, these are the safety values a project gets
    // when it configures nothing, so they should be readable at a glance.
    // Autonomy off by default: never configured means never consented.
    .default({
      maxBlastRadiusPct: 100,
      maxActionsPerHour: 3,
      cooldownMinutes: 30,
      allowedActions: ["flag-off"],
      repairOnlyPaths: [],
      autonomyEnabled: false,
    }),
});

export type Project = z.infer<typeof ProjectSchema>;

function registryPath(): string {
  return resolve(config.dataDir, "projects.json");
}

export function listProjects(): Project[] {
  const path = registryPath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown[];
    return raw.flatMap((entry) => {
      const parsed = ProjectSchema.safeParse(entry);
      if (!parsed.success) {
        console.warn("[tenant] skipping malformed project entry");
        return [];
      }
      return [parsed.data];
    });
  } catch {
    console.warn("[tenant] project registry unreadable");
    return [];
  }
}

export function getProject(id: string): Project | undefined {
  return listProjects().find((p) => p.id === id);
}

export function upsertProject(project: Project): void {
  const all = listProjects().filter((p) => p.id !== project.id);
  all.push(ProjectSchema.parse(project));
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(registryPath(), JSON.stringify(all, null, 2));
}

/**
 * The single-project fallback, so the CLI works before any tenant is configured.
 * Autonomy is off, a project that was never explicitly configured has never
 * consented to autonomous action.
 */
export function defaultProject(): Project {
  return ProjectSchema.parse({
    id: "default",
    tenantId: "local",
    name: "Local project",
    environment: "development",
    baseUrl: config.targetBaseUrl,
    repoPath: config.targetRepoPath,
    guardrails: { autonomyEnabled: false },
  });
}

export function resolveProject(id?: string): Project {
  if (!id) return listProjects()[0] ?? defaultProject();
  const found = getProject(id);
  if (!found) throw new Error(`Unknown project '${id}'. Run \`cli projects\` to list.`);
  return found;
}

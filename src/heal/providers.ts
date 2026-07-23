import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.ts";
import type { Project } from "../tenant.ts";
import { latestRelease, readReleases, type Release } from "../detect/store.ts";

/**
 * Containment providers.
 *
 * Recursive never holds standing write access to a customer's production. It acts
 * *through* mechanisms the customer already controls, their flag service, their
 * deploy tool, using credentials they scope and can revoke (ARCHITECTURE.md §4).
 *
 * These interfaces are the seam. The local implementations make the loop
 * demonstrable end to end; the hosted ones (LaunchDarkly, Statsig, Vercel) are
 * thin adapters over the same shape.
 */

export interface FlagProvider {
  readonly name: string;
  /** Turn a flag off, the containment action. */
  disable(flag: string): Promise<void>;
  /** The inverse, for revert. */
  enable(flag: string): Promise<void>;
  state(): Promise<Record<string, boolean>>;
}

export interface DeployProvider {
  readonly name: string;
  current(): Promise<Release | undefined>;
  /** Roll back to a specific prior release. */
  rollbackTo(release: Release): Promise<void>;
}

// ------------------------------------------------------------ local flags

function directivesPath(projectId: string): string {
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = resolve(config.dataDir, "projects", safe);
  mkdirSync(dir, { recursive: true });
  return resolve(dir, "directives.json");
}

/**
 * Local flag provider, writes the directives document the SDK polls.
 *
 * This closes the loop without any third-party dependency: Recursive writes
 * `{flags: {"checkout-v2": false}}`, the SDK fetches it, and
 * `Recursive.enabled("checkout-v2")` starts returning false in the customer's
 * browser within a minute. No deploy, no code change.
 */
export class LocalFlagProvider implements FlagProvider {
  readonly name = "local";
  // Explicit field + assignment, not a constructor parameter property. Node's
  // type-stripping loader cannot compile the latter, and tsc won't warn you.
  private readonly projectId: string;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  private read(): Record<string, boolean> {
    const path = directivesPath(this.projectId);
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { flags?: Record<string, boolean> };
      return parsed.flags ?? {};
    } catch {
      return {};
    }
  }

  private write(flags: Record<string, boolean>): void {
    writeFileSync(directivesPath(this.projectId), JSON.stringify({ flags }, null, 2));
  }

  async disable(flag: string): Promise<void> {
    const flags = this.read();
    flags[flag] = false;
    this.write(flags);
  }

  async enable(flag: string): Promise<void> {
    const flags = this.read();
    flags[flag] = true;
    this.write(flags);
  }

  async state(): Promise<Record<string, boolean>> {
    return this.read();
  }
}

/** Explicit no-op, so "not configured" is a distinct, visible state. */
export class NoopFlagProvider implements FlagProvider {
  readonly name = "none";
  async disable(): Promise<void> {
    throw new Error("No flag provider is configured for this project, nothing to contain with.");
  }
  async enable(): Promise<void> {
    throw new Error("No flag provider is configured for this project.");
  }
  async state(): Promise<Record<string, boolean>> {
    return {};
  }
}

// ------------------------------------------------------------ local deploys

/**
 * Local deploy provider, records rollback *intent* without performing one.
 *
 * Deliberately inert. A rollback is the highest-blast-radius action Tier 0 can
 * take, and wiring it to a real deploy system is a decision a customer makes
 * explicitly, per project, with their own credentials. Until then this records
 * what would have happened so the decision path can be reviewed and tested.
 */
export class LocalDeployProvider implements DeployProvider {
  readonly name = "local";
  private readonly projectId: string;

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  async current(): Promise<Release | undefined> {
    return latestRelease(this.projectId);
  }

  async rollbackTo(release: Release): Promise<void> {
    const known = readReleases(this.projectId).some((r) => r.id === release.id);
    if (!known) {
      throw new Error(`Refusing to roll back to unknown release '${release.id}'.`);
    }
    console.log(
      `[deploy:local] would roll back to ${release.id}${release.sha ? ` (${release.sha.slice(0, 8)})` : ""}, ` +
        `no deploy provider is wired, so this is recorded intent only.`,
    );
  }
}

export class NoopDeployProvider implements DeployProvider {
  readonly name = "none";
  async current(): Promise<Release | undefined> {
    return undefined;
  }
  async rollbackTo(): Promise<void> {
    throw new Error("No deploy provider is configured for this project.");
  }
}

// ------------------------------------------------------------ resolution

export function flagProviderFor(project: Project): FlagProvider {
  switch (project.containment.flagProvider) {
    case "local":
      return new LocalFlagProvider(project.id);
    case "launchdarkly":
    case "statsig":
    case "custom":
      // Intentionally unimplemented rather than silently degrading, a customer
      // who configured LaunchDarkly must not have their incident quietly
      // contained by a local file the SDK may not even be reading.
      throw new Error(
        `Flag provider '${project.containment.flagProvider}' is not implemented yet. ` +
          `Configure 'local', or implement the FlagProvider adapter.`,
      );
    default:
      return new NoopFlagProvider();
  }
}

export function deployProviderFor(project: Project): DeployProvider {
  switch (project.containment.deployProvider) {
    case "local":
      return new LocalDeployProvider(project.id);
    case "vercel":
    case "custom":
      throw new Error(
        `Deploy provider '${project.containment.deployProvider}' is not implemented yet.`,
      );
    default:
      return new NoopDeployProvider();
  }
}

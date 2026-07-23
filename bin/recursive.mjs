#!/usr/bin/env node
/**
 * The `recursive` command.
 *
 * Recursive is installed into a project and run from that project's directory.
 * This launcher makes that work regardless of where the package itself lives:
 *
 *   - it points the tool at the current directory as the target repo,
 *   - it keeps Recursive's data (memory, projects) in `.recursive/` inside that
 *     project, not inside the shared global install,
 *   - it runs the TypeScript entrypoint directly (Node strips types), matching
 *     how the project is developed, so there is no build step to go stale.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = resolve(packageRoot, "src", "cli.ts");

const env = { ...process.env };
// Default the target repo and data location to the project we are run from,
// unless the user has set them explicitly.
env.TARGET_REPO_PATH ??= process.cwd();
env.RECURSIVE_DATA_DIR ??= resolve(process.cwd(), ".recursive");

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--no-warnings", cliEntry, ...process.argv.slice(2)],
  { stdio: "inherit", env },
);

process.exit(result.status ?? 1);

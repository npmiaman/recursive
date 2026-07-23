import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./config.ts";

/**
 * Loads program.md — the human-authored steering file.
 *
 * This mirrors autoresearch's core idea: the human's job is not to write the
 * loop, it's to write the research directions. Everything in program.md is
 * injected into the investigation and fix prompts, so editing that file is how
 * you change the agent's behaviour without touching any code.
 */

let cached: string | null | undefined;

export function loadProgram(): string | null {
  if (cached !== undefined) return cached;
  const path = resolve(ROOT, "program.md");
  if (!existsSync(path)) {
    cached = null;
    return cached;
  }
  const raw = readFileSync(path, "utf8").trim();
  // Strip HTML comments — they're authoring hints for the human, not the model.
  cached = raw.replace(/<!--[\s\S]*?-->/g, "").trim() || null;
  return cached;
}

/** Formatted for injection into a prompt, or empty string if absent. */
export function programSection(): string {
  const program = loadProgram();
  if (!program) return "";
  return `\n## Product context and constraints (program.md — authored by the team, treat as binding)\n\n${program}\n`;
}

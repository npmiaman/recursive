import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { resolveProvider } from "../../llm/provider.ts";
import { buildFixPrompt, FIX_SYSTEM } from "./prompt.ts";
import type { FixAttempt, Fixer, FixRequest } from "./types.ts";

/**
 * Native code-editing engine, driven by whatever LLM_PROVIDER is configured.
 *
 * Why this exists alongside the Claude Agent SDK and OpenHands engines: those
 * two are the right answer for their cases (best quality, and hard zero-egress
 * respectively), but each carries a dependency the other jobs in Recursive do
 * not. The Claude engine needs an Anthropic key; OpenHands needs a Python SDK
 * and a bridge process. This engine needs neither. It reuses the exact provider
 * the reasoning stages already use, so if you have pointed Recursive at any
 * OpenAI-compatible endpoint (a NVIDIA free-tier model, a local Ollama, OpenAI
 * proper) it can write code with zero additional setup.
 *
 * The trade-off is honest: this is SINGLE-SHOT, not agentic. It cannot grep the
 * repo, run the tests, and iterate the way the Agent SDK can within one call. It
 * is handed the retrieved files and asked to return complete rewrites. That is
 * enough for the large class of localised fixes (a broken handler, a wrong
 * comparison, a missing field) and it is deliberately paired with the closed
 * loop, which re-runs the real user journey after every edit, so a single-shot
 * miss is caught and fed back as a new attempt rather than shipped.
 */

const EditSet = z.object({
  couldNotLocate: z
    .boolean()
    .describe(
      "True if you cannot confidently identify the code to change from what you were given. If true, return no files. A truthful 'not found' beats a plausible edit to the wrong file.",
    ),
  files: z
    .array(
      z.object({
        path: z.string().describe("Repo-relative path of a file to create or overwrite."),
        content: z
          .string()
          .describe(
            "The COMPLETE new contents of the file, top to bottom. Not a diff, not a fragment, not an ellipsis. The file is overwritten verbatim with this.",
          ),
      }),
    )
    .describe("Every file to write, each with its full new contents. Keep the set minimal."),
  summary: z
    .string()
    .describe("One paragraph naming each file changed and what changed in it."),
});

/** Read the files retrieval surfaced, so the model edits from source, not memory. */
function gatherSourceFiles(request: FixRequest): { path: string; content: string }[] {
  const paths = new Set<string>();
  for (const ranked of request.context?.chunks ?? []) paths.add(ranked.chunk.path);

  const files: { path: string; content: string }[] = [];
  for (const path of paths) {
    if (files.length >= 8) break; // token budget; retrieval already ranked these
    try {
      const content = readFileSync(resolve(request.repoPath, path), "utf8");
      if (content.length > 40_000) continue; // a fix rarely rewrites a huge file
      files.push({ path, content });
    } catch {
      /* deleted or unreadable; skip */
    }
  }
  return files;
}

export class NativeProviderFixer implements Fixer {
  readonly name = "native";
  readonly licence =
    "Uses the configured LLM_PROVIDER. Self-contained only if that provider is self-hosted.";
  readonly selfContained: boolean;

  constructor() {
    // Egress follows the provider: a self-hosted model means no code leaves the
    // network, a hosted API (NVIDIA, OpenAI) means prompts do.
    this.selfContained = resolveProvider().selfHosted;
  }

  async preflight(): Promise<void> {
    await resolveProvider().preflight();
  }

  async apply(request: FixRequest): Promise<FixAttempt> {
    const sources = gatherSourceFiles(request);

    const prompt = [
      buildFixPrompt(request),
      "",
      "## The current source of the files most likely involved",
      "",
      "Edit these by returning their COMPLETE new contents. You may also return a",
      "new file if the fix genuinely requires one. Do not return a file you did",
      "not change.",
      "",
      ...sources.map((f) => `### ${f.path}\n\n\`\`\`\n${f.content}\n\`\`\``),
    ].join("\n");

    const result = await resolveProvider().structured(EditSet, prompt, {
      system: FIX_SYSTEM,
      // Full-file rewrites are large; a small cap would truncate a file and
      // silently corrupt it. This is the one place generosity is correct.
      maxTokens: 16384,
    });

    if (result.couldNotLocate || result.files.length === 0) {
      return {
        summary: result.summary || "Could not locate the responsible code with confidence.",
        edited: false,
        turns: 1,
        engine: this.name,
      };
    }

    let written = 0;
    for (const file of result.files) {
      // Never write outside the repo. A model returning "../../etc/hosts" is a
      // path-traversal write, and this loop runs with the process's own
      // permissions, so the guard is not optional.
      const target = resolve(request.repoPath, file.path);
      const rel = relative(request.repoPath, target);
      if (rel.startsWith("..") || isAbsolute(rel)) continue;

      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, "utf8");
      written++;
    }

    return {
      summary: result.summary,
      edited: written > 0,
      turns: 1,
      engine: this.name,
    };
  }
}

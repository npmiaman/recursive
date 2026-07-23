import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { classifyFile, type Area } from "../repo/areas.ts";
import { Repo } from "../repo/git.ts";
import { isIndexable } from "../retrieve/chunk.ts";
import { ImportGraph } from "../retrieve/graph.ts";
import { SymbolIndex } from "../retrieve/symbols.ts";
import { resolveProvider } from "../llm/provider.ts";
import { append, searchText } from "./store.ts";

/**
 * Base memory, what Recursive knows about the codebase itself.
 *
 * Everything else in memory records EVENTS: this broke, we tried that, it
 * worked. Base memory records STRUCTURE: what each file is for, what depends on
 * it, and what would break if it changed.
 *
 * This exists to fix a specific measured weakness. Retrieval leans heavily on
 * git recency, "what changed just before this broke", which makes it strong on
 * fresh regressions and weak on anything that has been quietly broken for
 * months. Base memory gives it a foundation that does not decay: a file that
 * handles checkout still handles checkout whether or not anyone touched it this
 * quarter.
 *
 * TWO TIERS, and the second one is the point:
 *
 *   Tier 1. STRUCTURAL. Free, exhaustive, every file. Exports, imports,
 * symbols, size, area, and how many other files depend on it.
 *   Tier 2. SEMANTIC. A model reads the file and says what it is FOR, in
 * domain language. ON BY DEFAULT.
 *
 * Tier 1 alone does not solve the problem this module exists for. A bug report
 * says "the buy button does nothing"; the file is called `CheckoutButton.tsx`
 * and contains `submitOrder` and `useOrderMutation`. Structural data, exports,
 * imports, line counts, shares no vocabulary with that report and cannot bridge
 * it. Only a summary written in domain terms can.
 *
 * The cost is smaller than it feels. A cheap model at ~2k in / 300 out per file
 * is roughly $0.20-0.60 for a 500-file repo, paid ONCE, after that only changed
 * files are re-read. The budget cap exists for genuine monorepos (tens of
 * thousands of files), not as a default posture, and enrichment runs in parallel
 * because 500 serial model calls would take an hour for no reason.
 *
 * Append-only, like the rest of memory. A changed file gets a NEW record; the
 * old one stays, so "what did this file used to do?" remains answerable.
 */

export interface FileKnowledge {
  type: "file-knowledge";
  id: string;
  projectId: string;
  at: string;

  path: string;
  /** Supersedes an older record for the same path when this differs. */
  contentHash: string;

  // ---- Tier 1: structural, always present -----------------------------
  language: string;
  area: Area;
  lines: number;
  exports: string[];
  imports: string[];
  symbols: string[];
  /** How many files import this one, the blast radius if it breaks. */
  importedBy: number;
  /** 0..1, how central this file is to the codebase. */
  centrality: number;

  // ---- Tier 2: semantic, only for files worth the spend ---------------
  /** One or two sentences on what this file is for. */
  summary?: string;
  /** Domain concepts this file deals with, the vocabulary bridge. */
  concepts?: string[];
  /** What breaks if this file is wrong. */
  impact?: string;
  /** URL paths this file serves. Replaces guessing criticality from URL spelling. */
  routes?: string[];
  /** A bug here costs money or blocks access. Judged from code, not path names. */
  businessCritical?: boolean;
  /** User journeys this participates in. Replaces hand-maintained `touches` lists. */
  userJourneys?: string[];
  /** Area as judged by the model; overrides the path-regex guess when present. */
  modelArea?: Area;
}

function languageOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    go: "go",
    rs: "rust",
    java: "java",
    rb: "ruby",
    php: "php",
    vue: "vue",
    svelte: "svelte",
    css: "css",
    scss: "css",
    html: "html",
  };
  return map[ext] ?? ext ?? "unknown";
}

/** Exported names, the file's public surface, and what other code can depend on. */
function extractExports(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g,
    /export\s+(?:abstract\s+)?class\s+(\w+)/g,
    /export\s+(?:const|let|var)\s+(\w+)/g,
    /export\s+(?:type|interface|enum)\s+(\w+)/g,
    /export\s*\{([^}]+)\}/g,
    /module\.exports\.(\w+)/g,
    /^\s*def\s+(\w+)/gm,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      for (const name of (match[1] ?? "").split(",")) {
        const clean = name
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (clean && /^\w+$/.test(clean)) found.add(clean);
      }
    }
  }
  return [...found].slice(0, 40);
}

function extractImports(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /import\s+(?:[\w*{},\s]+\s+from\s+)?["']([^"']+)["']/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*from\s+([\w.]+)\s+import/gm,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found].slice(0, 40);
}

const Enrichment = z.object({
  summary: z.string().describe("One or two sentences: what this file is for, in domain terms."),
  concepts: z
    .array(z.string())
    .describe("Domain concepts it deals with, e.g. 'checkout', 'authentication', 'rate limiting'."),
  impact: z.string().describe("What breaks if this file is wrong. Be concrete."),

  // The fields below replace hardcoded heuristics elsewhere in the system. The
  // model is already reading this file, so answering them costs nothing extra, // and it answers them from the actual code rather than from guesses about
  // naming conventions.
  // All optional with defaults. If a model returns a good summary but flubs one
  // of these, a strict schema would reject the WHOLE response and we would lose
  // the summary too, the most valuable field, over a secondary one. Partial
  // knowledge is worth keeping.
  area: z
    .enum(["frontend", "backend", "ml", "data", "infra", "tests", "docs", "shared"])
    .optional()
    .describe("Which part of the system this belongs to, judged from the code, not the path."),
  routes: z
    .array(z.string())
    .default([])
    .describe("URL paths this file serves or renders, if any. Empty for non-routing files."),
  businessCritical: z
    .boolean()
    .default(false)
    .describe(
      "True if a bug here directly costs money or blocks access: payments, checkout, auth, signup, core data writes.",
    ),
  userJourneys: z
    .array(z.string())
    .default([])
    .describe("User-facing journeys this participates in, e.g. 'checkout', 'signup', 'search'."),
});

/**
 * Ask a model what a file is actually FOR.
 *
 * The value is the vocabulary bridge: a failure described as "the buy button
 * does nothing" shares no words with a file full of `submitOrder` and
 * `useCheckoutMutation`. A summary written in domain terms connects them, which
 * is exactly the gap keyword search cannot cross.
 */
async function enrich(
  path: string,
  source: string,
  structural: { exports: string[]; importedBy: number },
): Promise<Partial<FileKnowledge>> {
  const excerpt = source.split("\n").slice(0, 150).join("\n").slice(0, 6000);

  const prompt = `Summarise this source file for a system that will later use the summary to find
the right code when something breaks.

## File
\`${path}\`
Exports: ${structural.exports.join(", ") || "(none detected)"}
Imported by ${structural.importedBy} other file(s).

\`\`\`
${excerpt}
\`\`\`

Write for someone who will read a bug report, "users can't complete checkout", and needs to decide whether this file is relevant. Use domain language, not a
restatement of the code.

Also judge, FROM THE CODE rather than from the file path:
- which part of the system this belongs to
- which URL routes it serves, if any
- whether a bug here would directly cost money or block access
- which user journeys it takes part in

Path names lie. A file under /components can be the payment processor, and a file
called checkout.ts can be a stylesheet. Judge by what the code does.`;

  try {
    const result = await resolveProvider().structured(Enrichment, prompt, {
      system:
        "You summarise code for retrieval. Be concrete and domain-focused. " +
        "Never restate syntax; explain purpose and consequence.",
      effort: "low",
      maxTokens: 700,
    });
    return {
      summary: result.summary,
      concepts: result.concepts,
      impact: result.impact,
      routes: result.routes,
      businessCritical: result.businessCritical,
      userJourneys: result.userJourneys,
      modelArea: result.area as Area,
    };
  } catch {
    // Enrichment is optional, the structural tier still works without it.
    return {};
  }
}

export interface IndexOptions {
  projectId: string;
  repoPath: string;
  /**
   * Cap on model summaries. Defaults to DEFAULT_ENRICH_CAP, high enough that
   * ordinary repos are fully enriched, and only genuine monorepos hit it.
   * Set 0 to skip enrichment entirely (structural tier only).
   */
  enrichBudget?: number;
  /** Parallel model calls. Serial enrichment of 500 files takes an hour. */
  concurrency?: number;
  /** Only re-index files whose content changed since the last pass. */
  incremental?: boolean;
  onProgress?: (line: string) => void;
}

/**
 * Enrich up to this many files by default.
 *
 * Chosen so a normal repository is enriched completely, the cap is a guard
 * against a 40,000-file monorepo silently costing hundreds of dollars, not a
 * statement that summaries are optional. They are the most valuable part.
 */
export const DEFAULT_ENRICH_CAP = 1500;

export interface IndexResult {
  filesIndexed: number;
  filesEnriched: number;
  filesSkipped: number;
  /** Files ranked most central, where a bug hurts most. */
  mostCentral: { path: string; importedBy: number }[];
}

/**
 * Build (or update) base memory.
 *
 * The first run is the expensive one. Later runs are incremental: only files
 * whose content hash changed are re-read, and they get NEW records rather than
 * overwriting the old ones.
 */
export async function buildBaseMemory(options: IndexOptions): Promise<IndexResult> {
  const log = options.onProgress ?? (() => {});
  const repo = new Repo(options.repoPath);
  const files = repo.listFiles().filter(isIndexable);

  log(`indexing ${files.length} file(s)…`);

  // Import graph first, centrality is needed to decide where to spend the
  // enrichment budget, so it has to be computed before any model call.
  const graph = new ImportGraph(files);
  const symbols = new SymbolIndex();
  const sources = new Map<string, string>();

  for (const file of files) {
    try {
      const source = readFileSync(resolve(repo.path, file), "utf8");
      if (source.length > 400_000) continue; // generated or minified
      sources.set(file, source);
      graph.addFile(file, source);
      symbols.addFile(file, source);
    } catch {
      /* unreadable or binary */
    }
  }

  const known = existingHashes(options.projectId);

  const structural = [...sources.entries()].map(([path, source]) => {
    const contentHash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const importedBy = graph.inDegree(path);
    return {
      path,
      source,
      contentHash,
      importedBy,
      unchanged: options.incremental !== false && known.get(path) === contentHash,
    };
  });

  const maxDegree = Math.max(1, ...structural.map((f) => f.importedBy));
  const changed = structural.filter((f) => !f.unchanged);

  log(`${changed.length} file(s) new or changed; ${structural.length - changed.length} unchanged`);

  // Enrich everything, up to the cap. When the cap does bite, spend it on the
  // most-depended-on files first, a bug in something forty files import is
  // worth understanding properly before a leaf component is.
  const enrichBudget = options.enrichBudget ?? DEFAULT_ENRICH_CAP;
  const ordered = [...changed].sort((a, b) => b.importedBy - a.importedBy);
  const toEnrich = new Set(ordered.slice(0, enrichBudget).map((f) => f.path));

  if (enrichBudget > 0 && changed.length > 0) {
    log(
      `enriching ${Math.min(enrichBudget, changed.length)} file(s) with model summaries` +
        (changed.length > enrichBudget
          ? ` (capped, ${changed.length - enrichBudget} will be structural-only)`
          : ""),
    );
  }

  let enriched = 0;
  let enrichmentFailed = 0;

  // Build the structural record for every file first, then enrich in parallel.
  const prepared = changed.map((file) => ({
    file,
    exports: extractExports(file.source),
    imports: extractImports(file.source),
  }));

  const concurrency = Math.max(1, options.concurrency ?? 6);
  const semanticByPath = new Map<string, Partial<FileKnowledge>>();

  const queue = prepared.filter((p) => toEnrich.has(p.file.path));
  let cursor = 0;
  let reported = 0;

  async function worker(): Promise<void> {
    while (cursor < queue.length) {
      const item = queue[cursor++]!;
      const semantic = await enrich(item.file.path, item.file.source, {
        exports: item.exports,
        importedBy: item.file.importedBy,
      });
      if (semantic.summary) {
        semanticByPath.set(item.file.path, semantic);
        enriched++;
      } else {
        enrichmentFailed++;
      }
      reported++;
      if (reported % 25 === 0) log(`  …${reported}/${queue.length} summarised`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  // A model that is unreachable should say so once, loudly, rather than leaving
  // a silently half-built memory that looks complete.
  if (enrichmentFailed > 0 && enriched === 0 && queue.length > 0) {
    log(
      `⚠ every summary failed, is a model provider configured? ` +
        `Base memory will work structurally but will not bridge domain vocabulary.`,
    );
  }

  for (const { file, exports, imports } of prepared) {
    append<FileKnowledge>({
      type: "file-knowledge",
      projectId: options.projectId,
      at: new Date().toISOString(),
      path: file.path,
      contentHash: file.contentHash,
      language: languageOf(file.path),
      area: classifyFile(file.path),
      lines: file.source.split("\n").length,
      exports,
      imports,
      symbols: symbols
        .findMentioned(exports.join(" "))
        .map((s) => s.name)
        .slice(0, 20),
      importedBy: file.importedBy,
      centrality: file.importedBy / maxDegree,
      ...(semanticByPath.get(file.path) ?? {}),
    });
  }

  const mostCentral = [...structural]
    .sort((a, b) => b.importedBy - a.importedBy)
    .slice(0, 10)
    .map((f) => ({ path: f.path, importedBy: f.importedBy }));

  return {
    filesIndexed: changed.length,
    filesEnriched: enriched,
    filesSkipped: structural.length - changed.length,
    mostCentral,
  };
}

// ------------------------------------------------------------ reads

import { DatabaseSync } from "node:sqlite";
import { config } from "../config.ts";
import { mkdirSync } from "node:fs";

function db(projectId: string): DatabaseSync {
  const dir = resolve(config.dataDir, "memory");
  mkdirSync(dir, { recursive: true });
  return new DatabaseSync(resolve(dir, `${projectId.replace(/[^a-zA-Z0-9_-]/g, "_")}.db`));
}

/** Latest known content hash per file, so incremental passes skip unchanged work. */
function existingHashes(projectId: string): Map<string, string> {
  const hashes = new Map<string, string>();
  try {
    const rows = db(projectId)
      .prepare(`SELECT payload FROM records WHERE type = 'file-knowledge' ORDER BY at ASC`)
      .all();
    for (const row of rows) {
      const record = JSON.parse(
        String((row as Record<string, unknown>)["payload"]),
      ) as FileKnowledge;
      // Later records win, this is how supersession works without deletion.
      hashes.set(record.path, record.contentHash);
    }
  } catch {
    /* table not created yet, first run */
  }
  return hashes;
}

/** Current knowledge for a file (the newest record). */
export function knowledgeFor(projectId: string, path: string): FileKnowledge | undefined {
  try {
    // Exact match on the indexed path column. A LIKE over the JSON payload also
    // matched records that merely import this file, returning another file's data.
    const row = db(projectId)
      .prepare(
        `SELECT payload FROM records WHERE type = 'file-knowledge' AND path = ? ORDER BY at DESC LIMIT 1`,
      )
      .get(path);
    return row
      ? (JSON.parse(String((row as Record<string, unknown>)["payload"])) as FileKnowledge)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Current knowledge for every file, newest record per path.
 * The basis for every model-informed lookup below.
 */
function currentKnowledge(projectId: string): FileKnowledge[] {
  const seen = new Set<string>();
  const out: FileKnowledge[] = [];
  try {
    const rows = db(projectId)
      .prepare(`SELECT payload FROM records WHERE type = 'file-knowledge' ORDER BY at DESC`)
      .all();
    for (const row of rows) {
      const record = JSON.parse(
        String((row as Record<string, unknown>)["payload"]),
      ) as FileKnowledge;
      if (seen.has(record.path)) continue;
      seen.add(record.path);
      out.push(record);
    }
  } catch {
    /* not indexed yet */
  }
  return out;
}

/**
 * Routes the model judged business-critical.
 *
 * Replaces a hardcoded list of URL prefixes (/checkout, /cart, …) that assumed
 * English naming and an e-commerce shape. This is derived from what the code
 * actually does.
 */
export function criticalRoutes(projectId: string): Set<string> {
  const routes = new Set<string>();
  for (const file of currentKnowledge(projectId)) {
    if (!file.businessCritical) continue;
    for (const route of file.routes ?? []) routes.add(route);
  }
  return routes;
}

/** Area as judged by the model, when base memory has an opinion. */
export function areaFor(projectId: string, path: string): Area | undefined {
  return currentKnowledge(projectId).find((f) => f.path === path)?.modelArea;
}

/**
 * Files that take part in a named user journey.
 *
 * Replaces the hand-maintained `touches` list on each flow, a list nobody
 * updates, which silently stops matching as the codebase moves.
 */
export function filesForJourney(projectId: string, journey: string): string[] {
  const needle = journey.toLowerCase();
  return currentKnowledge(projectId)
    .filter(
      (file) =>
        file.userJourneys?.some((j) => j.toLowerCase().includes(needle)) ||
        file.concepts?.some((c) => c.toLowerCase().includes(needle)),
    )
    .map((file) => file.path);
}

/**
 * Search base memory by meaning.
 *
 * This is the signal that fixes retrieval on OLD bugs. Every other retrieval
 * signal decays: git recency is useless once the cause is months old, and
 * keyword search fails when the bug report and the code share no vocabulary.
 * A file's summary is written in domain language precisely so a report saying
 * "the buy button does nothing" can reach `CheckoutButton.tsx`.
 *
 * Returns file paths in relevance order.
 */
export function searchKnowledge(projectId: string, query: string, limit = 15): string[] {
  const hits = searchText(projectId, query, limit * 3);
  if (hits.length === 0) return [];

  const paths: string[] = [];
  const seen = new Set<string>();

  for (const hit of hits) {
    try {
      const row = db(projectId).prepare(`SELECT payload FROM records WHERE id = ?`).get(hit.id);
      if (!row) continue;
      const record = JSON.parse(String((row as Record<string, unknown>)["payload"])) as {
        type: string;
        path?: string;
      };
      // Only file-knowledge records name a file; failures and attempts do not.
      if (record.type !== "file-knowledge" || !record.path) continue;
      if (seen.has(record.path)) continue;
      seen.add(record.path);
      paths.push(record.path);
      if (paths.length >= limit) break;
    } catch {
      /* skip unreadable rows */
    }
  }
  return paths;
}

export function baseMemoryStats(projectId: string): {
  files: number;
  enriched: number;
  areas: Record<string, number>;
} {
  const areas: Record<string, number> = {};
  let files = 0;
  let enriched = 0;
  const seen = new Set<string>();

  try {
    const rows = db(projectId)
      .prepare(`SELECT payload FROM records WHERE type = 'file-knowledge' ORDER BY at DESC`)
      .all();
    for (const row of rows) {
      const record = JSON.parse(
        String((row as Record<string, unknown>)["payload"]),
      ) as FileKnowledge;
      if (seen.has(record.path)) continue; // count current state, not history
      seen.add(record.path);
      files++;
      if (record.summary) enriched++;
      areas[record.area] = (areas[record.area] ?? 0) + 1;
    }
  } catch {
    /* nothing indexed yet */
  }

  return { files, enriched, areas };
}

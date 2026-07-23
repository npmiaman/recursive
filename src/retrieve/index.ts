import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Repo, type GitCommit } from "../repo/git.ts";
import { BM25Index } from "./bm25.ts";
import { chunkFile, isIndexable, type Chunk } from "./chunk.ts";
import { ImportGraph } from "./graph.ts";
import { expandQuery, rerank } from "./rerank.ts";
import { applicationFrames, parseStack } from "./stack.ts";
import { searchKnowledge } from "../memory/base.ts";
import { SymbolIndex } from "./symbols.ts";
import { buildQuery, tokenize } from "./tokenize.ts";

export type { Chunk } from "./chunk.ts";
export { parseStack, applicationFrames } from "./stack.ts";

/**
 * The retrieval engine, "find the code that matters for this failure".
 *
 * No single signal is reliable on its own:
 *   - Stack traces are precise but often absent (silent failures have none).
 *   - Git tells you what changed but not which change is to blame.
 *   - Text search finds vocabulary matches, and misses fixes that live one
 * import away from anything the failure mentions.
 *
 * So we run five independent retrievers and fuse their rankings with
 * **Reciprocal Rank Fusion**. RRF is the right choice here specifically because
 * it combines *ranks*, not scores. BM25 scores, git churn counts, and graph
 * hop-distances live on wildly different scales and cannot be added together
 * meaningfully. RRF sidesteps that entirely, needs no training data and no
 * per-signal calibration, and degrades gracefully when a signal is missing:
 * a failure with no stack trace simply loses one voter.
 */

/** RRF's rank-smoothing constant. 60 is the standard value from the literature. */
const RRF_K = 60;

/**
 * How loudly each signal votes.
 * Stack frames dominate because they're close to fact rather than inference.
 */
const WEIGHTS = {
  stack: 3.0,
  // An identifier from the failure resolving to a definition in this repo is an
  // address, not a guess, second only to a stack frame.
  symbol: 2.5,
  gitChanged: 2.0,
  /**
   * What base memory says a file is FOR, the only signal that works when the
   * bug report and the code share no vocabulary, and the only one that does not
   * decay as a bug ages.
   *
   * Deliberately WEAK, and that was a measured correction. The first cut
   * weighted it at 1.4, above lexical, on the reasoning that a semantic
   * understanding of a file beats keyword overlap. On the benchmark that traded
   * recall@3 92% -> 75%: it was displacing correct lexical hits with plausible
   * ones. This signal is *inference about purpose*, not evidence of a match, so
   * it must not outvote a real hit, its job is to break ties and to rescue
   * queries where lexical finds nothing at all.
   *
   * Sweeping the weight: 0.2-0.4 all score recall@1 83% / recall@3 92%; 0.5+
   * degrades. 0.3 is the centre of that plateau rather than the argmax, because
   * 12 queries cannot distinguish a real peak from noise.
   */
  baseMemory: 0.3,
  lexical: 1.0,
  semantic: 1.0,
  // Deliberately low. Graph adjacency is the weakest evidence here, being
  // imported by a suspect file is a hint, not a finding, and at 0.6 it was
  // strong enough to let two weak votes outrank one decisive lexical hit.
  graph: 0.25,
} as const;

export interface RetrievalQuery {
  /** Error message or failure description. */
  message?: string;
  /** Raw stack trace, if the failure produced one. */
  stack?: string;
  /** CSS selector implicated, for interaction failures. */
  selector?: string;
  /** Route/path where it happened. */
  route?: string;
  /** Identifiers the investigator wants searched. */
  terms?: string[];
  /** When the failure first appeared, anchors the git suspect window. */
  failedAt?: Date;
}

export interface RankedChunk {
  chunk: Chunk;
  score: number;
  /** Which retrievers voted for this, for explainability. */
  signals: string[];
}

export interface RetrievedContext {
  chunks: RankedChunk[];
  suspectCommit?: GitCommit;
  /** Files the suspect commit touched. */
  changedFiles: string[];
  /** Human-readable account of how this set was chosen. */
  reasoning: string[];
  approxTokens: number;
}

/**
 * Optional semantic retriever. Deliberately an interface, not an implementation:
 * embeddings need a model provider, and a customer running fully on-premises may
 * not have one. The system must work without it, lexical + git + graph is a
 * complete pipeline on its own, and get better with it.
 */
export interface SemanticIndex {
  search(
    query: string,
    limit: number,
  ): Promise<{ path: string; startLine: number; score: number }[]>;
}

interface RankList {
  name: keyof typeof WEIGHTS;
  /** Chunk keys in rank order, best first. */
  ranked: string[];
  /**
   * Raw scores parallel to `ranked`, when the signal produces meaningful ones.
   * Rank-only signals (stack frames, changed files, graph hops) omit this,
   * their "score" is just position, and inventing one would be noise.
   */
  scores?: number[];
}

/**
 * How much of a scored signal's contribution comes from its magnitude rather
 * than its rank. See `fuse()` for why pure RRF was not enough on its own.
 */
const MAGNITUDE_SHARE = 0.5;

function chunkKey(chunk: Chunk): string {
  return `${chunk.path}:${chunk.startLine}`;
}

export class Retriever {
  private repo: Repo;
  /** Set to consult base memory. Without it, that signal is simply absent. */
  private projectId?: string;
  private index = new BM25Index();
  private graph: ImportGraph;
  private symbols = new SymbolIndex();
  private chunksByKey = new Map<string, Chunk>();
  private churn = new Map<string, number>();
  private built = false;

  constructor(repoPath: string, projectId?: string) {
    this.repo = new Repo(repoPath);
    this.graph = new ImportGraph([]);
    this.projectId = projectId;
  }

  /**
   * Index the repository. Uses `git ls-files`, so .gitignore is respected for
   * free and build output never pollutes the index.
   */
  build(): { files: number; chunks: number } {
    const files = this.repo.listFiles().filter(isIndexable);
    this.graph = new ImportGraph(files);

    let chunkCount = 0;
    for (const file of files) {
      let source: string;
      try {
        source = readFileSync(resolve(this.repo.path, file), "utf8");
      } catch {
        continue; // deleted, unreadable, or binary
      }
      // Minified bundles and huge generated files poison both the index and the
      // token budget, and are never where a human would make the fix.
      if (source.length > 400_000) continue;

      const chunks = chunkFile(file, source);
      for (const chunk of chunks) this.chunksByKey.set(chunkKey(chunk), chunk);
      this.index.add(chunks);
      this.graph.addFile(file, source);
      this.symbols.addFile(file, source);
      chunkCount += chunks.length;
    }

    this.churn = this.repo.churn(30);
    this.built = true;
    return { files: files.length, chunks: chunkCount };
  }

  /**
   * Reciprocal Rank Fusion.
   *
   * score(d) = Σ_signals weight_s / (K + rank_s(d))
   *
   * A chunk ranked #1 by one retriever and unranked by the rest still surfaces;
   * a chunk ranked middling by several outranks it. That agreement-across-
   * signals property is exactly what we want, because the signals fail in
   * uncorrelated ways.
   */
  private fuse(lists: RankList[]): Map<string, { score: number; signals: string[] }> {
    const fused = new Map<string, { score: number; signals: string[] }>();

    // The unit a rank-1 hit is worth, used to put the magnitude term on the
    // same scale as the rank term.
    const topRankValue = 1 / (RRF_K + 1);

    for (const list of lists) {
      const weight = WEIGHTS[list.name];
      const maxScore = list.scores?.length ? Math.max(...list.scores) : 0;

      list.ranked.forEach((key, index) => {
        const entry = fused.get(key) ?? { score: 0, signals: [] };
        const rankTerm = 1 / (RRF_K + index + 1);

        if (list.scores && maxScore > 0) {
          // Blend rank with normalized magnitude.
          //
          // Pure RRF flattens a decisive win into a near-tie: BM25 scoring the
          // right chunk 143 against 78 and 22 becomes ranks 1, 2, 6 → values
          // within 8% of each other, so any weak second signal reorders them.
          // Measured on this repo, that let hub files outrank the correct file.
          // Keeping half the weight on normalized score preserves "this one is
          // *much* better" while retaining RRF's robustness to scale mismatch.
          const magnitude = (list.scores[index] ?? 0) / maxScore;
          entry.score +=
            weight *
            ((1 - MAGNITUDE_SHARE) * rankTerm + MAGNITUDE_SHARE * magnitude * topRankValue);
        } else {
          entry.score += weight * rankTerm;
        }

        if (!entry.signals.includes(list.name)) entry.signals.push(list.name);
        fused.set(key, entry);
      });
    }

    return fused;
  }

  /** Chunks in a file overlapping a line, or the whole file if no line given. */
  private chunksAt(path: string, line?: number): Chunk[] {
    const all = this.index.chunksFor(path);
    if (line === undefined) return all;
    const hit = all.filter((c) => line >= c.startLine && line <= c.endLine);
    return hit.length ? hit : all.slice(0, 1);
  }

  async retrieve(
    query: RetrievalQuery,
    options: {
      maxChunks?: number;
      tokenBudget?: number;
      semantic?: SemanticIndex;
      /** Translate the failure into code vocabulary before searching. One model call. */
      expandQuery?: boolean;
      /** Have a model read the shortlist and reorder it. One model call. */
      rerank?: boolean;
    } = {},
  ): Promise<RetrievedContext> {
    if (!this.built) this.build();

    const maxChunks = options.maxChunks ?? 14;
    const tokenBudget = options.tokenBudget ?? 24_000;
    const reasoning: string[] = [];
    const lists: RankList[] = [];
    const seedFiles = new Set<string>();

    // ---- Signal 1: stack frames (highest precision) --------------------
    if (query.stack) {
      const frames = applicationFrames(parseStack(query.stack, this.repo.path));
      const ranked: string[] = [];
      for (const frame of frames) {
        // Traces carry build paths; match on suffix so dist/ or _next/ prefixes
        // don't prevent a match against the source file.
        const candidates = this.index
          .allPaths()
          .filter(
            (p) => p === frame.path || p.endsWith("/" + frame.path) || frame.path.endsWith(p),
          );
        for (const path of candidates) {
          seedFiles.add(path);
          for (const chunk of this.chunksAt(path, frame.line)) ranked.push(chunkKey(chunk));
        }
      }
      if (ranked.length) {
        lists.push({ name: "stack", ranked });
        reasoning.push(
          `Stack trace named ${frames.length} application frame(s); seeded ${ranked.length} chunk(s) directly.`,
        );
      } else if (frames.length) {
        reasoning.push(
          `Stack trace had ${frames.length} frame(s) but none matched an indexed file, ` +
            `likely a bundled path with no source map.`,
        );
      }
    }

    // ---- Signal 2: what the suspect commit changed ----------------------
    let suspectCommit: GitCommit | undefined;
    let changedFiles: string[] = [];
    if (query.failedAt) {
      suspectCommit = this.repo.suspectCommit(query.failedAt);
      if (suspectCommit) {
        const changes = this.repo
          .changedFiles(suspectCommit.sha)
          .filter((c) => isIndexable(c.path))
          // Bigger edits are likelier culprits than one-line tweaks.
          .sort((a, b) => b.added + b.removed - (a.added + a.removed));
        changedFiles = changes.map((c) => c.path);

        const ranked: string[] = [];
        for (const change of changes) {
          seedFiles.add(change.path);
          for (const chunk of this.index.chunksFor(change.path)) ranked.push(chunkKey(chunk));
        }
        if (ranked.length) {
          lists.push({ name: "gitChanged", ranked });
          reasoning.push(
            `Failure first seen ${query.failedAt.toISOString()}; nearest preceding commit ` +
              `${suspectCommit.shortSha} ("${suspectCommit.subject}") touched ${changes.length} indexed file(s).`,
          );
        }
      } else {
        reasoning.push(
          "No commit landed in the 24h before this failure, unlikely to be a recent regression.",
        );
      }
    }

    // ---- Signal 2.5: symbols named in the failure ----------------------
    // An identifier from the failure that resolves to a definition here is an
    // address, not a scoring guess. Runs before lexical so its seeds feed the
    // graph expansion too.
    const symbolText = [query.message, query.selector, ...(query.terms ?? [])]
      .filter(Boolean)
      .join(" ");
    if (symbolText) {
      const definitions = this.symbols.findMentioned(symbolText).slice(0, 12);
      const ranked: string[] = [];
      for (const definition of definitions) {
        seedFiles.add(definition.path);
        for (const chunk of this.chunksAt(definition.path, definition.line)) {
          ranked.push(chunkKey(chunk));
        }
      }
      if (ranked.length) {
        lists.push({ name: "symbol", ranked });
        reasoning.push(
          `Failure text named ${definitions.length} symbol(s) defined in this repo ` +
            `(${definitions
              .slice(0, 4)
              .map((d) => `${d.name} @ ${d.path}:${d.line}`)
              .join(", ")}).`,
        );
      }
    }

    // ---- Signal 2.75: base memory (what files are FOR) ------------------
    if (this.projectId && query.message) {
      try {
        const paths = searchKnowledge(this.projectId, query.message, 15);
        const ranked: string[] = [];
        for (const path of paths) {
          seedFiles.add(path);
          for (const chunk of this.index.chunksFor(path)) ranked.push(chunkKey(chunk));
        }
        if (ranked.length) {
          lists.push({ name: "baseMemory", ranked });
          reasoning.push(
            `Base memory matched ${paths.length} file(s) by purpose: ${paths.slice(0, 4).join(", ")}.`,
          );
        }
      } catch {
        reasoning.push("Base memory not indexed for this project, run `memory index`.");
      }
    }

    // ---- Signal 3: lexical (BM25), with optional query expansion -------
    let expandedTerms: string[] = [];
    if (options.expandQuery && query.message) {
      const expansion = await expandQuery({
        description: query.message,
        route: query.route,
        selector: query.selector,
        samplePaths: this.index.allPaths(),
      });
      if (expansion) {
        expandedTerms = [...expansion.identifiers, ...expansion.filenames, ...expansion.concepts];
        // Expansion also feeds the symbol index, a predicted identifier that
        // actually exists here is a direct hit.
        for (const identifier of expansion.identifiers) {
          for (const definition of this.symbols.lookup(identifier)) {
            seedFiles.add(definition.path);
          }
        }
        reasoning.push(
          `Query expanded to code vocabulary: ${expandedTerms.slice(0, 8).join(", ")}${expandedTerms.length > 8 ? "…" : ""}`,
        );
      }
    }

    const queryTokens = [
      ...buildQuery(query),
      // Expanded terms weighted ×2, predicted, so weighty but not decisive.
      ...expandedTerms.flatMap((t) => [...tokenize(t), ...tokenize(t)]),
    ];
    if (queryTokens.length) {
      const hits = this.index.search(queryTokens, 60);
      if (hits.length) {
        lists.push({
          name: "lexical",
          ranked: hits.map((h) => chunkKey(h.chunk)),
          scores: hits.map((h) => h.score),
        });
        reasoning.push(
          `Lexical search over ${this.index.size} chunks returned ${hits.length} match(es).`,
        );
        for (const hit of hits.slice(0, 5)) seedFiles.add(hit.chunk.path);
      }
    }

    // ---- Signal 4: semantic (optional) ---------------------------------
    if (options.semantic && query.message) {
      try {
        const hits = await options.semantic.search(query.message, 40);
        const ranked = hits
          .map((h) => `${h.path}:${h.startLine}`)
          .filter((key) => this.chunksByKey.has(key));
        if (ranked.length) {
          lists.push({ name: "semantic", ranked });
          reasoning.push(`Semantic search contributed ${ranked.length} match(es).`);
        }
      } catch (error) {
        // Never let an optional retriever take down retrieval.
        reasoning.push(
          `Semantic search unavailable (${error instanceof Error ? error.message : error}); continuing without it.`,
        );
      }
    }

    // ---- Signal 5: import-graph expansion ------------------------------
    if (seedFiles.size) {
      const neighbourhood = this.graph.neighbourhood([...seedFiles], 1, 40);
      const ranked: string[] = [];
      for (const [path, distance] of [...neighbourhood].sort((a, b) => a[1] - b[1])) {
        if (seedFiles.has(path)) continue; // already voted for directly
        if (distance === 0) continue;
        for (const chunk of this.index.chunksFor(path)) ranked.push(chunkKey(chunk));
      }
      if (ranked.length) {
        lists.push({ name: "graph", ranked });
        reasoning.push(
          `Expanded one import hop from ${seedFiles.size} seed file(s), adding ${ranked.length} chunk(s).`,
        );
      }
    }

    if (lists.length === 0) {
      return {
        chunks: [],
        changedFiles,
        reasoning: ["No retrieval signal produced any candidate."],
        approxTokens: 0,
      };
    }

    // ---- Fuse, then apply churn as a tie-breaker -----------------------
    const fused = this.fuse(lists);

    const ranked: RankedChunk[] = [];
    for (const [key, entry] of fused) {
      const chunk = this.chunksByKey.get(key);
      if (!chunk) continue;

      // Churn is a weak prior, code that changes often breaks often, so it
      // only nudges. Applied as a multiplier capped at +15%, never enough to
      // promote an otherwise-unsupported chunk.
      const changes = this.churn.get(chunk.path) ?? 0;
      const churnBoost = 1 + Math.min(0.15, changes / 100);

      ranked.push({ chunk, score: entry.score * churnBoost, signals: entry.signals });
    }

    // ---- File-level aggregation ----------------------------------------
    //
    // Evidence for one file is often split across several chunks, and ranking
    // chunks independently lets a file with one lucky match beat a file that
    // matched five times in five places. So aggregate to file level, then let a
    // file's total standing lift its own chunks.
    //
    // Only the best THREE chunks per file count. An unbounded discounted sum
    // still lets file size win: a large file accumulates enough weak chunks to
    // out-total a small precise one. Measured here, summing every chunk made a
    // 200-line orchestration file the top hit for two unrelated queries purely
    // because it had more chunks to add up.
    const perFileChunks = new Map<string, number[]>();
    for (const candidate of ranked) {
      const list = perFileChunks.get(candidate.chunk.path) ?? [];
      list.push(candidate.score);
      perFileChunks.set(candidate.chunk.path, list);
    }

    const fileScores = new Map<string, number>();
    for (const [path, scores] of perFileChunks) {
      const top = scores.sort((a, b) => b - a).slice(0, 3);
      // Best chunk, plus a discounted contribution from at most two more.
      fileScores.set(path, (top[0] ?? 0) + 0.35 * ((top[1] ?? 0) + (top[2] ?? 0)));
    }
    const maxFileScore = Math.max(...fileScores.values(), 1e-9);
    for (const candidate of ranked) {
      const fileStanding = (fileScores.get(candidate.chunk.path) ?? 0) / maxFileScore;
      candidate.score *= 1 + 0.5 * fileStanding;
    }

    ranked.sort((a, b) => b.score - a.score);

    // ---- Rerank: have a model read the shortlist ------------------------
    //
    // Cheap retrieval has good recall and mediocre precision, the answer is
    // usually in the top 30, rarely reliably at #1. No scoring formula fixes
    // that, because ranking by word statistics cannot tell relevance from
    // coincidence. A model that actually reads the candidates can.
    if (options.rerank && ranked.length > 3) {
      const description = [query.message, query.selector, query.route].filter(Boolean).join(" | ");
      const judgement = await rerank(
        description,
        ranked.map((r) => r.chunk),
        30,
      );
      if (judgement && judgement.order.length) {
        const promoted: RankedChunk[] = [];
        const seen = new Set<number>();
        for (const index of judgement.order) {
          const candidate = ranked[index];
          if (!candidate) continue;
          seen.add(index);
          promoted.push({
            ...candidate,
            signals: [...candidate.signals, "reranked"],
          });
        }
        // Anything the model didn't pick is demoted, not discarded, a wrong
        // call should cost ordering, not the answer.
        ranked.forEach((candidate, index) => {
          if (!seen.has(index)) promoted.push(candidate);
        });
        ranked.length = 0;
        ranked.push(...promoted);
        reasoning.push(
          `Reranked by model: ${judgement.order.length} of ${Math.min(30, promoted.length)} candidates judged relevant.`,
        );
      }
    }

    // ---- Pack to budget ------------------------------------------------
    const selected: RankedChunk[] = [];
    let tokens = 0;
    for (const candidate of ranked) {
      if (selected.length >= maxChunks) break;
      const cost = Math.ceil(candidate.chunk.text.length / 4); // ~4 chars/token
      if (tokens + cost > tokenBudget) continue; // skip, don't stop, a later chunk may fit
      selected.push(candidate);
      tokens += cost;
    }

    reasoning.push(
      `Fused ${lists.length} signal(s) with RRF over ${fused.size} candidate chunk(s); ` +
        `selected ${selected.length} within a ${tokenBudget}-token budget.`,
    );

    return { chunks: selected, suspectCommit, changedFiles, reasoning, approxTokens: tokens };
  }
}

/** Render retrieved context for a prompt. */
export function formatContext(context: RetrievedContext): string {
  if (context.chunks.length === 0) return "";

  const parts: string[] = ["## Relevant code (retrieved automatically)\n"];

  if (context.suspectCommit) {
    parts.push(
      `Most likely responsible commit: \`${context.suspectCommit.shortSha}\`, ` +
        `"${context.suspectCommit.subject}" by ${context.suspectCommit.author} ` +
        `(${context.suspectCommit.at}).\n`,
    );
  }
  if (context.changedFiles.length) {
    parts.push(`That commit changed: ${context.changedFiles.map((f) => `\`${f}\``).join(", ")}\n`);
  }

  for (const { chunk, signals } of context.chunks) {
    parts.push(
      `### \`${chunk.path}\` lines ${chunk.startLine}-${chunk.endLine}` +
        (chunk.symbol ? `, \`${chunk.symbol}\`` : "") +
        `  _(matched by: ${signals.join(", ")})_\n`,
    );
    parts.push("```\n" + chunk.text + "\n```\n");
  }

  return parts.join("\n");
}

import type { Chunk } from "./chunk.ts";
import { tokenize } from "./tokenize.ts";

/**
 * BM25 over code chunks.
 *
 * BM25 rather than embeddings as the primary lexical signal, for a specific
 * reason: identifiers are *rare tokens*, and BM25's inverse-document-frequency
 * term rewards rare-term matches heavily. A query containing `placeOrder` will
 * strongly prefer the two chunks that actually mention it. Embeddings tend to
 * blur exactly that distinction, returning things that are "about checkout"
 * rather than the one function named in the stack trace.
 *
 * Embeddings still help when vocabulary doesn't overlap at all, see the
 * `SemanticIndex` interface in index.ts, which is where that plugs in.
 *
 * No dependency, no service, no index server: it runs on a few thousand chunks
 * in milliseconds, which is what makes it usable inside a hill-climb.
 */

const K1 = 1.2; // term-frequency saturation

/**
 * Length normalization, tuned DOWN from the textbook 0.75.
 *
 * 0.75 comes from prose retrieval, where a long document is usually padded and
 * deserves a penalty. Code is not like that: a 120-line module that mentions
 * "budget" and "ledger" thirty times is *the* answer, not a diluted one.
 *
 * Measured on this repo: with b=0.75 the correct file for "the daily API budget
 * ledger is not preventing requests when exhausted" ranked **13th**, behind
 * short chunks that mentioned "budget" once or twice. Lowering b fixes it.
 */
const B = 0.4;

/**
 * How much to reward matching many *distinct* query terms rather than one term
 * repeatedly. A chunk hitting eight different query terms is far more likely to
 * be the answer than one hitting a single term eight times, and plain BM25,
 * which sums independently per term, does not capture that.
 */
const COVERAGE_WEIGHT = 0.6;

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

export class BM25Index {
  private chunks: Chunk[] = [];
  private termFreqs: Map<string, number>[] = [];
  private lengths: number[] = [];
  private docFreq = new Map<string, number>();
  private averageLength = 0;

  add(chunks: Chunk[]): void {
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.text);
      const freqs = new Map<string, number>();
      for (const token of tokens) freqs.set(token, (freqs.get(token) ?? 0) + 1);

      for (const term of freqs.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }

      this.chunks.push(chunk);
      this.termFreqs.push(freqs);
      this.lengths.push(tokens.length);
    }

    const total = this.lengths.reduce((sum, n) => sum + n, 0);
    this.averageLength = this.lengths.length ? total / this.lengths.length : 0;
  }

  get size(): number {
    return this.chunks.length;
  }

  /** Standard BM25 with the usual IDF smoothing. Returns the top `limit`. */
  search(queryTokens: string[], limit = 40): ScoredChunk[] {
    if (this.chunks.length === 0 || queryTokens.length === 0) return [];

    const N = this.chunks.length;

    // Collapse the query so a term repeated for weighting is scored once with
    // that weight, rather than re-running the whole IDF calculation per copy.
    const queryWeights = new Map<string, number>();
    for (const token of queryTokens) {
      queryWeights.set(token, (queryWeights.get(token) ?? 0) + 1);
    }

    const scores = new Float64Array(N);
    // Distinct query terms each chunk matched, for the coverage bonus.
    const matched = new Int32Array(N);

    for (const [term, weight] of queryWeights) {
      const df = this.docFreq.get(term);
      if (!df) continue;

      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      for (let i = 0; i < N; i++) {
        const tf = this.termFreqs[i]!.get(term);
        if (!tf) continue;
        const norm = 1 - B + B * (this.lengths[i]! / (this.averageLength || 1));
        scores[i] = scores[i]! + weight * idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
        matched[i] = matched[i]! + 1;
      }
    }

    const distinctQueryTerms = queryWeights.size;
    const ranked: ScoredChunk[] = [];
    for (let i = 0; i < N; i++) {
      if (scores[i]! <= 0) continue;
      // Breadth of match, not just depth: a chunk covering more of the query is
      // more likely to be what the query was actually about.
      const coverage = distinctQueryTerms ? matched[i]! / distinctQueryTerms : 0;
      ranked.push({
        chunk: this.chunks[i]!,
        score: scores[i]! * (1 + COVERAGE_WEIGHT * coverage),
      });
    }

    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit);
  }

  /** Every chunk belonging to a file, used to expand from seed files. */
  chunksFor(path: string): Chunk[] {
    return this.chunks.filter((c) => c.path === path);
  }

  allPaths(): string[] {
    return [...new Set(this.chunks.map((c) => c.path))];
  }
}

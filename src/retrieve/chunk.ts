/**
 * Code chunking.
 *
 * Retrieval returns chunks, not whole files, because a 2,000-line file dumped
 * into a prompt buries the ten relevant lines. But chunks split at arbitrary
 * line offsets are worse than useless, half a function has no meaning and the
 * agent can't act on it.
 *
 * So we split at structural boundaries (function/class/method declarations) and
 * only fall back to fixed windows when no boundary is found.
 */

export interface Chunk {
  /** Repo-relative path. */
  path: string;
  /** 1-indexed, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
  /** Declaration name if we could identify one, shown to the agent for orientation. */
  symbol?: string;
}

/** Lines that plausibly begin a new top-level unit, across common languages. */
const BOUNDARY = new RegExp(
  [
    // JS/TS: function, class, const X = (…) =>, export …, method shorthand
    String.raw`^\s*(export\s+)?(default\s+)?(async\s+)?function\s+\w+`,
    String.raw`^\s*(export\s+)?(abstract\s+)?class\s+\w+`,
    String.raw`^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>`,
    String.raw`^\s*(public|private|protected|static|\s)*\w+\s*\([^)]*\)\s*(:\s*[\w<>\[\]|\s]+)?\s*\{`,
    // Python
    String.raw`^\s*(async\s+)?def\s+\w+`,
    String.raw`^\s*class\s+\w+`,
    // Go / Rust / Java-ish
    String.raw`^\s*func\s+`,
    String.raw`^\s*(pub\s+)?fn\s+\w+`,
  ].join("|"),
);

const NAME =
  /(?:function|class|def|func|fn|const|let|var)\s+(\w+)|^\s*(?:public|private|protected|static|\s)*(\w+)\s*\(/;

/** Chunks larger than this are split; smaller adjacent ones are merged. */
const MAX_LINES = 120;
const MIN_LINES = 8;

export function chunkFile(path: string, source: string): Chunk[] {
  const lines = source.split("\n");
  if (lines.length === 0) return [];

  // Very small files stay whole, splitting them loses more than it gains.
  if (lines.length <= MAX_LINES) {
    return [{ path, startLine: 1, endLine: lines.length, text: source }];
  }

  const boundaries: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (BOUNDARY.test(lines[i]!)) boundaries.push(i);
  }

  // No structure detected (config, data, minified), fixed windows with overlap
  // so a match near a seam is still recoverable.
  if (boundaries.length === 0) {
    const chunks: Chunk[] = [];
    const stride = MAX_LINES - 20;
    for (let start = 0; start < lines.length; start += stride) {
      const end = Math.min(start + MAX_LINES, lines.length);
      chunks.push({
        path,
        startLine: start + 1,
        endLine: end,
        text: lines.slice(start, end).join("\n"),
      });
      if (end >= lines.length) break;
    }
    return chunks;
  }

  if (boundaries[0] !== 0) boundaries.unshift(0);

  const chunks: Chunk[] = [];
  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b]!;
    let end = b + 1 < boundaries.length ? boundaries[b + 1]! : lines.length;

    // Merge runs of tiny declarations so each chunk carries real context.
    while (end - start < MIN_LINES && b + 1 < boundaries.length) {
      b++;
      end = b + 1 < boundaries.length ? boundaries[b + 1]! : lines.length;
    }

    // Split anything still oversized.
    for (let s = start; s < end; s += MAX_LINES) {
      const e = Math.min(s + MAX_LINES, end);
      const text = lines.slice(s, e).join("\n");
      if (!text.trim()) continue;

      const match = lines[s]!.match(NAME);
      chunks.push({
        path,
        startLine: s + 1,
        endLine: e,
        text,
        symbol: match ? (match[1] ?? match[2]) : undefined,
      });
    }
  }

  return chunks;
}

/** Source files worth indexing. Excludes build output and vendored code. */
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|vue|svelte|css|scss|html)$/i;
const EXCLUDE =
  /(^|\/)(node_modules|dist|build|out|\.next|vendor|target|__pycache__|coverage|\.git)(\/|$)/;

export function isIndexable(path: string): boolean {
  return SOURCE_EXT.test(path) && !EXCLUDE.test(path);
}

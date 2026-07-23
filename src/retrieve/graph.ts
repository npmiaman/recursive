import { dirname, join, normalize } from "node:path";

/**
 * Import graph.
 *
 * Retrieval seeds are rarely where the fix goes. A stack trace points at the
 * component that threw; the actual bug is often one hop away, in the hook it
 * calls, the util it imports, or the parent that renders it with the wrong
 * props. Text search alone won't find those, because they may share no
 * vocabulary with the failure at all.
 *
 * So after seeding, we walk the import edges outward a bounded number of hops.
 * Bounded because two hops from a shared util reaches most of the codebase, and
 * a retrieval set that large is the same as no retrieval at all.
 */

const IMPORT_PATTERNS = [
  /import\s+(?:[\w*{},\s]+\s+from\s+)?["']([^"']+)["']/g, // ES import
  /require\(\s*["']([^"']+)["']\s*\)/g, // CommonJS
  /from\s+["']([^"']+)["']/g, // re-export
  /^\s*from\s+([\w.]+)\s+import/gm, // Python
  /^\s*import\s+([\w.]+)/gm, // Python plain
];

const RESOLVE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".py",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];

export class ImportGraph {
  /** file → files it imports */
  private out = new Map<string, Set<string>>();
  /** file → files that import it */
  private in = new Map<string, Set<string>>();
  private known = new Set<string>();

  constructor(files: string[]) {
    for (const file of files) this.known.add(normalize(file));
  }

  /**
   * Resolve an import specifier to a repo file, or undefined for a package.
   * Only relative specifiers are resolvable without reading tsconfig paths,
   * bare specifiers are third-party and not our bug to fix.
   */
  private resolve(fromFile: string, specifier: string): string | undefined {
    if (!specifier.startsWith(".")) return undefined;

    const base = normalize(join(dirname(fromFile), specifier));
    for (const extension of RESOLVE_EXTENSIONS) {
      const candidate = normalize(base + extension);
      if (this.known.has(candidate)) return candidate;
    }

    // TypeScript source imported with a .js extension, very common in ESM.
    const swapped = base.replace(/\.js$/, ".ts");
    if (this.known.has(swapped)) return swapped;

    return undefined;
  }

  addFile(path: string, source: string): void {
    const file = normalize(path);
    const targets = new Set<string>();

    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        const resolved = this.resolve(file, match[1] ?? "");
        if (resolved && resolved !== file) targets.add(resolved);
      }
    }

    this.out.set(file, targets);
    for (const target of targets) {
      const incoming = this.in.get(target) ?? new Set<string>();
      incoming.add(file);
      this.in.set(target, incoming);
    }
  }

  /** How many files import this one. High = a hub, low = specific. */
  inDegree(file: string): number {
    return this.in.get(normalize(file))?.size ?? 0;
  }

  /**
   * Files within `hops` of any seed, following imports in both directions.
   *
   * Both directions matters: downstream finds the util that's actually broken;
   * upstream finds the caller passing bad input. Which one holds the bug isn't
   * knowable in advance, so we take both and let ranking sort it out.
   *
   * HUBS ARE EXCLUDED. A file imported by most of the codebase, `config.ts`,
   * a shared `types.ts`, is one hop from nearly every seed, so it gets promoted
   * for *every* query regardless of relevance. Measured on this repo: hub files
   * collected votes from both the lexical and graph signals and outranked the
   * genuinely correct file, which had only lexical support. Graph adjacency to a
   * hub carries essentially no information, so hubs don't get a vote.
   */
  neighbourhood(seeds: string[], hops = 1, cap = 60, hubThreshold = 4): Map<string, number> {
    const distance = new Map<string, number>();
    let frontier = seeds.map((s) => normalize(s)).filter((s) => this.known.has(s));

    for (const seed of frontier) distance.set(seed, 0);

    for (let hop = 1; hop <= hops; hop++) {
      const next: string[] = [];
      for (const file of frontier) {
        const neighbours = [...(this.out.get(file) ?? []), ...(this.in.get(file) ?? [])];
        for (const neighbour of neighbours) {
          if (distance.has(neighbour)) continue;
          // Skip hubs, adjacency to something everything imports says nothing
          // about relevance. Seeds themselves are exempt (handled above).
          if (this.inDegree(neighbour) >= hubThreshold) continue;
          distance.set(neighbour, hop);
          next.push(neighbour);
          if (distance.size >= cap) return distance;
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }

    return distance;
  }
}

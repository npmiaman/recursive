/**
 * Area classification.
 *
 * Real teams don't open a fresh branch for every one-line fix, they work on a
 * branch that belongs to an area of the system, and the reviewer for the
 * frontend branch is not the reviewer for the ML branch. Recursive should behave
 * the same way: accumulate related fixes on a long-lived area branch so a human
 * reviews one coherent PR per area, rather than drowning in a PR per bug.
 *
 * Classification is by file path, because that's what git gives us and it's
 * stable. It's deliberately overridable, every codebase lays itself out
 * differently, and guessing wrong means fixes land on the wrong branch in front
 * of the wrong reviewer.
 */

import { areaFor } from "../memory/base.ts";

export type Area = "frontend" | "backend" | "ml" | "data" | "infra" | "tests" | "docs" | "shared";

export interface AreaRule {
  area: Area;
  /** Matched against the repo-relative path. First match wins. */
  pattern: RegExp;
}

/**
 * Default rules, most specific first.
 *
 * Order matters: `src/components/Chart.test.tsx` is a test, not frontend, so
 * test patterns are checked before framework patterns.
 */
export const DEFAULT_RULES: AreaRule[] = [
  // Tests and docs first, they cut across every other area.
  {
    area: "tests",
    pattern: /(^|\/)(test|tests|__tests__|spec|e2e|cypress)(\/|$)|\.(test|spec)\.[jt]sx?$/i,
  },
  { area: "docs", pattern: /(^|\/)(docs?|documentation)(\/|$)|\.mdx?$/i },

  // Infrastructure and pipelines.
  {
    area: "infra",
    pattern:
      /(^|\/)(\.github|\.gitlab|ci|deploy|terraform|infra|k8s|kubernetes|helm|ansible)(\/|$)|(^|\/)(Dockerfile|docker-compose|Makefile|\.dockerignore)/i,
  },

  // Machine learning.
  {
    area: "ml",
    pattern:
      /(^|\/)(ml|models?|training|inference|notebooks?|experiments?|embeddings?|prompts?)(\/|$)|\.(ipynb|onnx|pkl|pt|h5|safetensors)$/i,
  },

  // Data layer.
  {
    area: "data",
    pattern: /(^|\/)(migrations?|schema|seeds?|fixtures?|db|database|sql)(\/|$)|\.(sql|prisma)$/i,
  },

  // Backend.
  {
    area: "backend",
    pattern:
      /(^|\/)(api|server|backend|services?|routes?|controllers?|handlers?|middleware|workers?|jobs?|graphql)(\/|$)|\.(go|rb|php|java|cs)$/i,
  },

  // Frontend.
  {
    area: "frontend",
    pattern:
      /(^|\/)(components?|pages?|views?|screens?|app|ui|client|frontend|web|styles?|assets?|public|hooks?|layouts?)(\/|$)|\.(tsx|jsx|vue|svelte|css|scss|sass|less|html)$/i,
  },
];

export interface AreaConfig {
  /** When set, base memory's model-judged area is preferred over the patterns. */
  projectId?: string;
  /** Extra rules, checked BEFORE the defaults so a project can override them. */
  rules?: AreaRule[];
  /** Used when nothing matches. */
  fallback?: Area;
}

export function classifyFile(path: string, config: AreaConfig = {}): Area {
  const normalized = path.replace(/\\/g, "/");

  // Base memory first, when it has read this file. Path regexes are a guess
  // about naming conventions; the model actually read the code. A payment
  // processor living under /components is classified correctly by one and
  // wrongly by the other.
  if (config.projectId) {
    try {
      const judged = areaFor(config.projectId, normalized);
      if (judged) return judged;
    } catch {
      /* not indexed yet, fall through to the patterns */
    }
  }

  for (const rule of [...(config.rules ?? []), ...DEFAULT_RULES]) {
    if (rule.pattern.test(normalized)) return rule.area;
  }
  return config.fallback ?? "shared";
}

export interface AreaBreakdown {
  /** The area with the most changed files, where this fix belongs. */
  primary: Area;
  /** Every area touched, with file counts. */
  counts: Map<Area, number>;
  /** True if the change spans areas, a signal it may need broader review. */
  crossCutting: boolean;
}

/**
 * Classify a set of changed files.
 *
 * The primary area is where the branch goes. A change spanning several areas is
 * flagged rather than silently filed under whichever happened to have one more
 * file, cross-cutting changes are exactly the ones a human should look at
 * hardest.
 */
export function classifyChange(paths: string[], config: AreaConfig = {}): AreaBreakdown {
  const counts = new Map<Area, number>();
  for (const path of paths) {
    const area = classifyFile(path, config);
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }

  let primary: Area = config.fallback ?? "shared";
  let best = 0;
  for (const [area, count] of counts) {
    if (count > best) {
      best = count;
      primary = area;
    }
  }

  // "Cross-cutting" means a second area holds a real share of the change, not
  // one incidental file, a component fix that also touches its stylesheet is
  // still a frontend change.
  const total = paths.length || 1;
  const significant = [...counts.values()].filter((n) => n / total >= 0.25).length;

  return { primary, counts, crossCutting: significant > 1 };
}

/** Human-readable summary for PR bodies and logs. */
export function describeBreakdown(breakdown: AreaBreakdown): string {
  const parts = [...breakdown.counts]
    .sort((a, b) => b[1] - a[1])
    .map(([area, count]) => `${area} (${count})`);
  return parts.join(", ") + (breakdown.crossCutting ? ", cross-cutting" : "");
}

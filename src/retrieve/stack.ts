/**
 * Stack-trace parsing.
 *
 * When a failure carries a stack trace, this is by far the highest-precision
 * signal available, it names the file and line outright. Everything else in
 * the retrieval pipeline is inference; this is close to fact, so parsed frames
 * are seeded at the top of the ranking and never have to compete for a slot.
 */

export interface StackFrame {
  /** Raw path as it appeared in the trace. */
  rawPath: string;
  /** Best-effort repo-relative path. */
  path: string;
  line?: number;
  column?: number;
  functionName?: string;
  /** False for node_modules, framework internals, bundled runtime. */
  isApplicationCode: boolean;
}

const PATTERNS = [
  // V8: at fnName (/abs/path/file.ts:12:34)   | at /abs/path/file.ts:12:34
  /at\s+(?:(?<fn>[\w$.<>[\]\s]+?)\s+\()?(?<path>[^\s()]+?):(?<line>\d+):(?<col>\d+)\)?/,
  // Firefox/Safari: fnName@/path/file.js:12:34
  /(?<fn>[\w$.<>]+)?@(?<path>[^\s]+?):(?<line>\d+):(?<col>\d+)/,
  // Python:  File "/path/file.py", line 12, in fnName
  /File\s+"(?<path>[^"]+)",\s+line\s+(?<line>\d+)(?:,\s+in\s+(?<fn>\S+))?/,
  // Go / generic:  /path/file.go:12
  /(?<path>[\w./\\-]+\.\w+):(?<line>\d+)/,
];

const VENDOR =
  /(node_modules|webpack|vite\/|\.next\/|chunk-|runtime~|<anonymous>|native code|internal\/)/;

/** Strip protocol, origin, query and known build prefixes to get a repo path. */
function normalizePath(raw: string, repoRoot?: string): string {
  let path = raw;

  try {
    if (/^https?:\/\//.test(path)) path = new URL(path).pathname;
  } catch {
    /* leave as-is */
  }

  path = path.replace(/[?#].*$/, "");
  path = path.replace(/^webpack-internal:\/\/\//, "");
  path = path.replace(/^(webpack|file):\/\//, "");
  path = path.replace(/^\/_next\/(static\/chunks\/)?/, "");

  if (repoRoot && path.startsWith(repoRoot)) {
    path = path.slice(repoRoot.length);
  }
  return path.replace(/^\/+/, "");
}

export function parseStack(stack: string, repoRoot?: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const seen = new Set<string>();

  for (const line of stack.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    for (const pattern of PATTERNS) {
      const match = trimmed.match(pattern);
      if (!match?.groups) continue;

      const rawPath = match.groups["path"] ?? "";
      if (!rawPath) continue;

      const path = normalizePath(rawPath, repoRoot);
      const key = `${path}:${match.groups["line"] ?? ""}`;
      if (seen.has(key)) break;
      seen.add(key);

      frames.push({
        rawPath,
        path,
        line: match.groups["line"] ? Number(match.groups["line"]) : undefined,
        column: match.groups["col"] ? Number(match.groups["col"]) : undefined,
        functionName: match.groups["fn"]?.trim() || undefined,
        isApplicationCode: !VENDOR.test(rawPath),
      });
      break;
    }
  }

  return frames;
}

/**
 * Application frames only, in trace order.
 *
 * The first application frame is usually the culprit: frames above it are
 * library internals reporting a problem someone else caused.
 */
export function applicationFrames(frames: StackFrame[]): StackFrame[] {
  return frames.filter((f) => f.isApplicationCode);
}

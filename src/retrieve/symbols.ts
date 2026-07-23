/**
 * Symbol index, identifier → where it's defined.
 *
 * The single highest-precision signal available without a stack trace. When a
 * failure mentions `submitOrder`, we shouldn't be *searching* for it and hoping
 * word-frequency scoring floats it up, we should jump straight to the line that
 * defines it.
 *
 * This is what the earlier design was missing. Word search treats "submitOrder"
 * as one more token to weigh; a symbol index treats it as an address. That is a
 * categorically different kind of evidence, and it is why the previous ranking
 * needed so much tuning to behave.
 */

export interface SymbolDefinition {
  name: string;
  path: string;
  line: number;
  kind: "function" | "class" | "const" | "type" | "method" | "component";
}

/** Declaration patterns per kind. Capture group 1 is always the name. */
const PATTERNS: { kind: SymbolDefinition["kind"]; re: RegExp }[] = [
  { kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/ },
  { kind: "class", re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/ },
  { kind: "type", re: /^\s*(?:export\s+)?(?:type|interface|enum)\s+(\w+)/ },
  // const x = …, only EXPORTED or top-level (≤2 spaces of indent).
  // An indented `const` is a local variable, not a symbol anyone can reference,
  // and indexing locals is what let the ordinary English word "signals" resolve
  // to five different files and hijack unrelated queries.
  { kind: "const", re: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/ },
  { kind: "const", re: /^\s{1,2}(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/ },
  // Python / Go / Rust
  { kind: "function", re: /^\s*(?:async\s+)?def\s+(\w+)/ },
  { kind: "function", re: /^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/ },
  { kind: "function", re: /^\s*(?:pub\s+)?fn\s+(\w+)/ },
  { kind: "class", re: /^\s*class\s+(\w+)/ },
  // Class methods: indented `name(args) {`, excluding control keywords.
  {
    kind: "method",
    re: /^\s{2,}(?:(?:public|private|protected|static|async)\s+)*(\w+)\s*\([^)]*\)\s*[:{]/,
  },
];

const NOT_A_SYMBOL = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "constructor",
  "class",
  "else",
  "do",
  "try",
  "with",
]);

export class SymbolIndex {
  private byName = new Map<string, SymbolDefinition[]>();

  addFile(path: string, source: string): void {
    const lines = source.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Cheap early-out: declarations are short-ish and never deeply indented
      // beyond a class body.
      if (line.length > 300) continue;

      for (const { kind, re } of PATTERNS) {
        const match = line.match(re);
        if (!match?.[1]) continue;

        const name = match[1];
        if (NOT_A_SYMBOL.has(name) || name.length < 3) continue;

        // A capitalised const in a .tsx/.jsx file is almost always a component.
        const resolved: SymbolDefinition["kind"] =
          kind === "const" && /^[A-Z]/.test(name) && /\.(tsx|jsx)$/.test(path) ? "component" : kind;

        const list = this.byName.get(name) ?? [];
        list.push({ name, path, line: i + 1, kind: resolved });
        this.byName.set(name, list);
        break; // one declaration per line
      }
    }
  }

  /** Exact lookup. */
  lookup(name: string): SymbolDefinition[] {
    return this.byName.get(name) ?? [];
  }

  /**
   * Find definitions for any identifier appearing in free text.
   *
   * Scans the text for candidate identifiers and returns those that are actually
   * defined in this repo. That's the trick: a failure description mentioning
   * `handleCheckout` yields an exact file and line, with no scoring involved.
   */
  findMentioned(text: string): SymbolDefinition[] {
    const found: SymbolDefinition[] = [];
    const seen = new Set<string>();

    for (const candidate of text.match(/\b[A-Za-z_$][\w$]{2,}\b/g) ?? []) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);

      const definitions = this.lookup(candidate);
      if (definitions.length === 0) continue;

      // A name defined in several places is a common name, not an address.
      // `signals`, `config`, `result` are defined everywhere and carry no
      // information, treating each definition as evidence is how an ordinary
      // English word in a failure description ends up outranking the real cause.
      if (definitions.length > 2) continue;

      // Single all-lowercase words are ambiguous with plain English. Require a
      // distinctive shape, camelCase, PascalCase, or snake_case, unless the
      // name is both long and defined exactly once.
      const distinctive =
        /[A-Z]/.test(candidate) || candidate.includes("_") || candidate.includes("$");
      if (!distinctive && !(candidate.length >= 8 && definitions.length === 1)) continue;

      found.push(...definitions);
    }

    // Definitions of rarer symbols first, a name defined in one place is far
    // more informative than one defined in twenty.
    found.sort((a, b) => this.lookup(a.name).length - this.lookup(b.name).length);
    return found;
  }

  get size(): number {
    return this.byName.size;
  }
}

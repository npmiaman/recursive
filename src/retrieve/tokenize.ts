/**
 * Code-aware tokenization.
 *
 * Standard text tokenizers do badly on source because the meaning lives inside
 * compound identifiers. `handleSubmitOrder` must be findable by searching for
 * "submit" or "order"; `place_order_btn` by "order". Splitting only on
 * whitespace and punctuation loses all of that.
 *
 * So every identifier is emitted three ways: whole, split into sub-words, and
 * lowercased. The whole form keeps exact matches ranking highest (an exact
 * identifier hit is a very strong signal in code), while the sub-words give
 * recall when the failure description and the code use different vocabulary.
 */

/** Words too common in code to carry signal. Kept deliberately short. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "if",
  "else",
  "for",
  "while",
  "return",
  "this",
  "that",
  "is",
  "in",
  "of",
  "to",
  "on",
  "at",
  "it",
  "be",
  "as",
  "by",
  "with",
  "const",
  "let",
  "var",
  "function",
  "class",
  "import",
  "export",
  "from",
  "default",
  "new",
  "async",
  "await",
  "type",
  "interface",
  "public",
  "private",
  "def",
  "self",
  "not",
  "none",
  "true",
  "false",
  "null",
  "undefined",
]);

/** Split camelCase / PascalCase / snake_case / kebab-case into parts. */
export function splitIdentifier(identifier: string): string[] {
  return (
    identifier
      // camelCase and PascalCase → insert a break before each capital run
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      // ACRONYMWord → ACRONYM Word
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
  );
}

/**
 * Reduce a word to a crude stem.
 *
 * This exists because of a measured failure. Bug reports are written in prose
 * and code is written in identifiers, and English inflection sits between them:
 * a report says "chunking splits functions in half", the file is `chunk.ts` and
 * defines `chunkFile`, and the two share *zero* tokens. On the 12-query
 * benchmark that single mismatch was enough to push `chunk.ts` out of the top
 * ten entirely.
 *
 * Deliberately NOT Porter. Porter is tuned for English documents and mangles
 * code vocabulary in ways that hurt here, it stems "matches" to "match" (good)
 * but also "routes" to "rout" and "caching" to "cach", so identifiers stop
 * matching themselves. These five suffix rules cover the inflections that
 * actually appear in bug reports (plural, gerund, past tense) and nothing else.
 *
 * The caller emits BOTH the original token and the stem, so this can only add
 * recall, an exact identifier match still scores its full weight, and BM25's
 * IDF term automatically discounts the stem because it appears in more
 * documents. There is no precision to lose.
 */
function stem(word: string): string | undefined {
  // Short words are mostly acronyms and identifiers where suffix stripping is
  // noise: "css" must not become "cs", "ids" must not become "id".
  if (word.length < 5) return undefined;

  //  -ies → -y     : "queries" → "query", "retries" → "retry"
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;

  //  -ing          : "chunking" → "chunk", "splitting" → "split"
  if (word.endsWith("ing") && word.length >= 6) {
    const base = word.slice(0, -3);
    // Undo consonant doubling: "splitting" → "splitt" → "split".
    const doubled = /([bdfglmnprt])\1$/.test(base) ? base.slice(0, -1) : base;
    return doubled.length >= 3 ? doubled : undefined;
  }

  //  -ed           : "failed" → "fail", "dropped" → "drop"
  if (word.endsWith("ed") && word.length >= 6) {
    const base = word.slice(0, -2);
    const doubled = /([bdfglmnprt])\1$/.test(base) ? base.slice(0, -1) : base;
    return doubled.length >= 3 ? doubled : undefined;
  }

  //  -es after a sibilant : "matches" → "match", "passes" → "pass"
  if (word.endsWith("es") && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);

  //  -s plural     : "chunks" → "chunk", "commits" → "commit".
  //  Excludes -ss ("class"), -us ("status"), -is ("this"), and -s after a
  // consonant cluster that is really part of the word.
  if (word.endsWith("s") && !/(ss|us|is|as)$/.test(word)) return word.slice(0, -1);

  return undefined;
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];

  /** Push a token and, when it inflects, its stem alongside it. */
  const emit = (token: string): void => {
    if (token.length <= 1 || STOPWORDS.has(token)) return;
    tokens.push(token);
    const stemmed = stem(token);
    if (stemmed && stemmed !== token && !STOPWORDS.has(stemmed)) tokens.push(stemmed);
  };

  for (const raw of text.split(/[^A-Za-z0-9_$-]+/)) {
    if (!raw) continue;

    emit(raw.toLowerCase());

    // Sub-words, when the identifier is actually compound.
    const parts = splitIdentifier(raw);
    if (parts.length > 1) {
      for (const part of parts) emit(part.toLowerCase());
    }
  }

  return tokens;
}

/**
 * Build a query from a failure.
 *
 * Weighting is expressed by repetition, a term repeated three times counts
 * three times in the BM25 scoring, which is a simple and effective way to say
 * "this part of the failure matters more" without a separate weighting scheme.
 */
export function buildQuery(parts: {
  /** Error message or failure description. Highest weight. */
  message?: string;
  /** CSS selector implicated, if any. */
  selector?: string;
  /** Route/path where it happened. */
  route?: string;
  /** Extra identifiers pulled out by the investigator. */
  terms?: string[];
}): string[] {
  const query: string[] = [];

  if (parts.message) {
    const t = tokenize(parts.message);
    query.push(...t, ...t, ...t); // ×3
  }
  if (parts.selector) {
    const t = tokenize(parts.selector);
    query.push(...t, ...t); // ×2, class names often appear verbatim in source
  }
  if (parts.terms?.length) {
    for (const term of parts.terms) {
      const t = tokenize(term);
      query.push(...t, ...t); // ×2, deliberately chosen by the investigator
    }
  }
  if (parts.route) {
    // Routes map to files by convention in most frameworks, so path segments
    // are useful, but they're also generic, so single weight.
    query.push(...tokenize(parts.route));
  }

  return query;
}

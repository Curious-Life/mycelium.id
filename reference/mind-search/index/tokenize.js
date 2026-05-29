/**
 * Text tokenizer for the BM25 inverted index.
 *
 * Design choices, explicit:
 *
 *   • Lowercase, Unicode-aware. The regex `/[\p{L}\p{N}'\-]+/gu` matches
 *     runs of letters, digits, apostrophes and hyphens. This covers Latin,
 *     Cyrillic, Greek, CJK ideographs, accented characters — no language
 *     hard-codes. We do not segment CJK by character (would explode the
 *     index for Mandarin/Japanese without language detection); CJK runs
 *     stay as single tokens. That's a known limitation; revisit if a
 *     non-Latin user shows up at scale.
 *
 *   • No stemming. The historical FTS5 setup used PostgreSQL `'english'`
 *     which stems aggressively (run/running/runs → run). We deliberately
 *     do NOT stem because:
 *       (a) The semantic side (Nomic embedding) handles morphology
 *           implicitly — keyword search complements rather than duplicates.
 *       (b) Stemming hurts proper-noun search and code identifiers,
 *           which appear frequently in Mycelium's corpus.
 *       (c) No-deps constraint: a quality stemmer (e.g., Snowball) is a
 *           dependency we're not adding.
 *
 *   • Stop-words filtered. ~80 English stop-words drop noise and slim the
 *     index by ~30%. Filter is conservative — only true function words.
 *
 *   • Length bounds. Tokens shorter than 2 chars (after stop-word filter:
 *     mostly "a", "i") are dropped. Tokens longer than 50 chars are
 *     dropped (URLs, base64 garbage, hashes — useless for keyword search).
 *
 *   • Position tracking. Returned with each token for future phrase-search
 *     support. PR 5's BM25 ignores positions; the field is reserved.
 *
 * Per CLAUDE.md §1, no log call ever passes the input text or output
 * tokens — they ARE the message content.
 */

const MIN_TOKEN_LEN = 2;
const MAX_TOKEN_LEN = 50;

// English stop-words, shipped inline. Set is faster than Array.includes().
// Conservative — only true function words. Past participles like 'done'
// and content-bearing modals are deliberately NOT here; recall over
// aggressive filtering.
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but',
  'by', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he',
  'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'me', 'my',
  'myself', 'no', 'nor', 'not', 'of', 'off', 'on', 'or', 'our',
  'ours', 'ourselves', 'out', 'over', 's', 'same', 'she', 'should',
  'so', 'some', 'such', 't', 'than', 'that', 'the', 'their', 'theirs',
  'them', 'themselves', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'to', 'too', 'until', 'up', 'very', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom',
  'why', 'with', 'would', 'you', 'your', 'yours', 'yourself',
  'yourselves',
]);

// Word-boundary regex. `u` flag enables \p{} Unicode property classes;
// `g` flag is required for matchAll(). Includes apostrophes, hyphens,
// and underscores so contractions ("don't"), hyphenated compounds
// ("state-of-the-art"), and snake_case identifiers ("MIND_SEARCH_BACKEND")
// stay as single tokens.
const WORD_RE = /[\p{L}\p{N}'_\-]+/gu;

/**
 * Tokenize text into a positioned, lowercased, stop-filtered token stream.
 *
 * @param {string|null|undefined} text
 * @param {object} [opts]
 * @param {boolean} [opts.includeStopWords=false]   debug aid; default drops them
 * @returns {Array<{ token: string, position: number }>}
 */
export function tokenize(text, opts = {}) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const includeStopWords = opts.includeStopWords === true;

  const out = [];
  let position = 0;
  for (const match of text.matchAll(WORD_RE)) {
    // Lowercase via Unicode-aware toLowerCase (handles Turkish dotless I,
    // German ß, accented Latin, etc.).
    let raw = match[0].toLowerCase();
    // Trim leading/trailing apostrophes and hyphens — these appear from
    // patterns like 'word and word-, where they're delimiters not glyphs.
    raw = raw.replace(/^['\-]+|['\-]+$/g, '');
    if (raw.length < MIN_TOKEN_LEN || raw.length > MAX_TOKEN_LEN) continue;
    if (!includeStopWords && STOP_WORDS.has(raw)) continue;
    out.push({ token: raw, position });
    position++;
  }
  return out;
}

/**
 * Convenience: tokenize and return only the token strings.
 * Useful for callers that don't need positions (most of PR 5).
 *
 * @param {string|null|undefined} text
 * @param {object} [opts]
 * @returns {string[]}
 */
export function tokenizeStrings(text, opts = {}) {
  return tokenize(text, opts).map((t) => t.token);
}

/**
 * Whether a token is in the stop-word set.
 * Exported for testing and for callers building their own pipelines.
 */
export function isStopWord(token) {
  return STOP_WORDS.has(token);
}

/**
 * Read-only view of the stop-word set, for tests and tools.
 */
export function getStopWords() {
  return new Set(STOP_WORDS);
}

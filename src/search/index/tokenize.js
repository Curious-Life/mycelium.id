/**
 * Text tokenizer for the BM25 inverted index.
 *
 * Ported verbatim from reference/mind-search/index/tokenize.js.
 *
 *   - Lowercase, Unicode-aware (/[\p{L}\p{N}'_\-]+/gu).
 *   - No stemming (the semantic side handles morphology; stemming hurts
 *     proper nouns + code identifiers; no-deps constraint).
 *   - ~80 English stop-words filtered.
 *   - Tokens < 2 or > 50 chars dropped.
 *
 * Per CLAUDE.md §1, no log call ever passes the input text or output tokens —
 * they ARE the message content.
 */

const MIN_TOKEN_LEN = 2;
const MAX_TOKEN_LEN = 50;

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

const WORD_RE = /[\p{L}\p{N}'_\-]+/gu;

/**
 * Tokenize text into a positioned, lowercased, stop-filtered token stream.
 * @param {string|null|undefined} text
 * @param {object} [opts]
 * @param {boolean} [opts.includeStopWords=false]
 * @returns {Array<{ token: string, position: number }>}
 */
export function tokenize(text, opts = {}) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const includeStopWords = opts.includeStopWords === true;

  const out = [];
  let position = 0;
  for (const match of text.matchAll(WORD_RE)) {
    let raw = match[0].toLowerCase();
    raw = raw.replace(/^['\-]+|['\-]+$/g, '');
    if (raw.length < MIN_TOKEN_LEN || raw.length > MAX_TOKEN_LEN) continue;
    if (!includeStopWords && STOP_WORDS.has(raw)) continue;
    out.push({ token: raw, position });
    position++;
  }
  return out;
}

/** Tokenize and return only the token strings. */
export function tokenizeStrings(text, opts = {}) {
  return tokenize(text, opts).map((t) => t.token);
}

export function isStopWord(token) {
  return STOP_WORDS.has(token);
}

export function getStopWords() {
  return new Set(STOP_WORDS);
}

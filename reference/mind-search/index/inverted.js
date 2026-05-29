/**
 * In-memory inverted index for the BM25 keyword path.
 *
 * Data layout:
 *
 *   postings  : Map<token, Posting[]>           // term → docs containing it
 *   documents : Map<id, { ts, length }>         // doc → metadata
 *
 *   Posting   = { id: string, tf: number }      // doc id and term frequency
 *
 * The split lets BM25 do per-token IDF and per-doc length normalization
 * cheaply: scoring iterates query tokens, looks up each posting list once,
 * and looks up `documents.get(id).length` once per scored doc.
 *
 * The index lives entirely in the agent process. Per CLAUDE.md §1 it never
 * touches disk in plaintext form. PR 6 adds encrypted persistence using
 * `crypto-local.js` envelopes.
 *
 * Boundedness:
 *   • `maxTokens` caps the unique-token count. When exceeded after add(),
 *     the highest-document-frequency tokens are evicted first. This is a
 *     "noise-first" eviction: in BM25 the tokens with the largest df
 *     contribute near-zero IDF, so dropping them costs little recall.
 *   • Document count is unbounded (callers manage retention).
 *   • There is no time-based eviction in PR 5; PR 6+ may add age-based
 *     trimming if a 500K+ corpus VPS hits the RSS ceiling.
 *
 * Serialization (PR 5: JSON; can switch to a compact binary format in PR 6):
 *   serialize()                → Buffer
 *   InvertedIndex.deserialize(buf) → InvertedIndex
 *
 *   Identity property (test-enforced):
 *     deserialize(serialize(idx)) yields an index that returns identical
 *     results from lookup(), size(), and all queries.
 *
 * Concurrency: Node single-threaded, no locks needed within one process.
 * Callers that share an index across async work paths must serialize
 * mutations themselves (we don't reentrancy-guard).
 */

const SCHEMA_VERSION = 1;

/**
 * @typedef {object} Posting
 * @property {string} id   document id (typically UUID)
 * @property {number} tf   term frequency in this doc (positive int)
 *
 * @typedef {object} DocumentMeta
 * @property {number} ts      unix-seconds (used by temporal boost in PR 7)
 * @property {number} length  total token count of the doc (BM25 dl)
 *
 * @typedef {object} IndexSizeReport
 * @property {number} tokens         unique token count
 * @property {number} documents      doc count
 * @property {number} totalPostings  sum of posting-list lengths
 */

export class InvertedIndex {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxTokens=200000]   eviction threshold for unique tokens
   */
  constructor(opts = {}) {
    this.maxTokens = opts.maxTokens ?? 200_000;
    if (!Number.isInteger(this.maxTokens) || this.maxTokens < 1) {
      throw new TypeError('InvertedIndex: maxTokens must be a positive integer');
    }

    /** @type {Map<string, Posting[]>} */
    this.postings = new Map();
    /** @type {Map<string, DocumentMeta>} */
    this.documents = new Map();

    // Aggregates kept incrementally so size() / avgdl() / IDF stay O(1).
    this._totalLength = 0;
  }

  /**
   * Insert a document. If the id is already present, the existing
   * postings + metadata are removed first (idempotent overwrite).
   *
   * @param {string} id              stable document id
   * @param {Iterable<string>} tokens  tokens (already lowercased + filtered)
   * @param {number} ts              unix-seconds
   */
  add(id, tokens, ts) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('InvertedIndex.add: id must be a non-empty string');
    }
    if (!Number.isFinite(ts)) {
      throw new TypeError('InvertedIndex.add: ts must be a finite number');
    }

    if (this.documents.has(id)) this.remove(id);

    // Count term frequencies for this document in one pass.
    /** @type {Map<string, number>} */
    const tfs = new Map();
    let length = 0;
    for (const token of tokens) {
      if (typeof token !== 'string' || token.length === 0) continue;
      tfs.set(token, (tfs.get(token) || 0) + 1);
      length++;
    }

    // Append postings.
    for (const [token, tf] of tfs) {
      let list = this.postings.get(token);
      if (!list) {
        list = [];
        this.postings.set(token, list);
      }
      list.push({ id, tf });
    }

    this.documents.set(id, { ts, length });
    this._totalLength += length;

    // Eviction is rare (only when token count crosses threshold). Run
    // outside the hot path; cost amortizes across many adds.
    if (this.postings.size > this.maxTokens) {
      this._evictHighestDf();
    }
  }

  /**
   * Remove a document and all its postings. Inverse of add(): after
   * `add(id, ts, T) ; remove(id)` the index is structurally identical
   * to its pre-add state (verified by property test).
   */
  remove(id) {
    const meta = this.documents.get(id);
    if (!meta) return;

    // Linear walk through every posting list isn't ideal for huge corpora,
    // but keeping a doc→tokens reverse map doubles memory. At 100K docs
    // this is ~50K token map iterations × array filters; bench-acceptable.
    // Revisit if remove() becomes hot.
    for (const [token, list] of this.postings) {
      const filtered = list.filter((p) => p.id !== id);
      if (filtered.length === 0) {
        this.postings.delete(token);
      } else if (filtered.length !== list.length) {
        this.postings.set(token, filtered);
      }
    }

    this._totalLength -= meta.length;
    this.documents.delete(id);
  }

  /**
   * Whether the index contains a document with this id.
   */
  has(id) {
    return this.documents.has(id);
  }

  /**
   * Posting list for a token. Returns an empty array if the token is
   * unknown — never null. Callers must NOT mutate the returned array.
   *
   * @param {string} token
   * @returns {Posting[]}
   */
  lookup(token) {
    return this.postings.get(token) || [];
  }

  /**
   * Document length (in tokens) for BM25 normalization.
   * @returns {number} length, or 0 if unknown
   */
  documentLength(id) {
    const meta = this.documents.get(id);
    return meta ? meta.length : 0;
  }

  /**
   * Document timestamp (unix-seconds), used by the temporal boost layer.
   * @returns {number|null}
   */
  documentTs(id) {
    const meta = this.documents.get(id);
    return meta ? meta.ts : null;
  }

  /**
   * Total document count.
   */
  totalDocs() {
    return this.documents.size;
  }

  /**
   * Average document length (BM25 avgdl). 0 when the index is empty —
   * callers must guard against the empty-index case.
   */
  avgDocumentLength() {
    return this.documents.size === 0 ? 0 : this._totalLength / this.documents.size;
  }

  /**
   * Document frequency for a token: how many documents contain it.
   */
  documentFrequency(token) {
    const list = this.postings.get(token);
    return list ? list.length : 0;
  }

  /**
   * @returns {IndexSizeReport}
   */
  size() {
    let totalPostings = 0;
    for (const list of this.postings.values()) totalPostings += list.length;
    return {
      tokens: this.postings.size,
      documents: this.documents.size,
      totalPostings,
    };
  }

  /**
   * Serialize the index to a Buffer. Round-trips through deserialize()
   * to an index with identical query results (property-tested).
   *
   * Format (v1, JSON-encoded):
   *
   *   {
   *     v:        1,                       schema version
   *     tokens:   [[token, [[id, tf], ...]], ...],
   *     docs:     [[id, ts, length], ...],
   *     maxTokens: number,
   *   }
   *
   * @returns {Buffer}
   */
  serialize() {
    const tokens = new Array(this.postings.size);
    let i = 0;
    for (const [token, list] of this.postings) {
      const compact = new Array(list.length);
      for (let j = 0; j < list.length; j++) {
        const p = list[j];
        compact[j] = [p.id, p.tf];
      }
      tokens[i++] = [token, compact];
    }
    const docs = new Array(this.documents.size);
    let k = 0;
    for (const [id, meta] of this.documents) {
      docs[k++] = [id, meta.ts, meta.length];
    }
    return Buffer.from(JSON.stringify({
      v: SCHEMA_VERSION,
      tokens,
      docs,
      maxTokens: this.maxTokens,
    }));
  }

  /**
   * Reconstitute an index from serialize() output.
   *
   * @param {Buffer|Uint8Array|string} buf
   * @returns {InvertedIndex}
   */
  static deserialize(buf) {
    let str;
    if (typeof buf === 'string') str = buf;
    else if (Buffer.isBuffer(buf)) str = buf.toString('utf8');
    else if (buf instanceof Uint8Array) str = Buffer.from(buf).toString('utf8');
    else throw new TypeError('InvertedIndex.deserialize: buf must be Buffer, Uint8Array, or string');

    let data;
    try {
      data = JSON.parse(str);
    } catch (cause) {
      const e = new Error('InvertedIndex.deserialize: malformed JSON payload');
      e.cause = cause;
      throw e;
    }
    if (!data || data.v !== SCHEMA_VERSION) {
      throw new Error(`InvertedIndex.deserialize: unsupported schema version ${data?.v}`);
    }
    if (!Array.isArray(data.tokens) || !Array.isArray(data.docs)) {
      throw new Error('InvertedIndex.deserialize: malformed payload (missing tokens or docs)');
    }

    const idx = new InvertedIndex({ maxTokens: data.maxTokens ?? 200_000 });

    // Rebuild postings.
    for (const [token, compact] of data.tokens) {
      const list = new Array(compact.length);
      for (let j = 0; j < compact.length; j++) {
        const [id, tf] = compact[j];
        list[j] = { id, tf };
      }
      idx.postings.set(token, list);
    }

    // Rebuild documents + recompute totals.
    let total = 0;
    for (const [id, ts, length] of data.docs) {
      idx.documents.set(id, { ts, length });
      total += length;
    }
    idx._totalLength = total;

    return idx;
  }

  /**
   * Evict the highest-DF tokens until under maxTokens. High-DF tokens
   * have IDF ≈ 0 in BM25 (they appear everywhere), so dropping them
   * costs minimal recall and trims the noise tail of the vocabulary.
   *
   * Called from add() when the threshold is crossed. Visible to tests.
   */
  _evictHighestDf() {
    if (this.postings.size <= this.maxTokens) return;
    // Build (token, df) pairs, sort by df DESC, drop the top excess.
    const pairs = new Array(this.postings.size);
    let i = 0;
    for (const [token, list] of this.postings) {
      pairs[i++] = [token, list.length];
    }
    pairs.sort((a, b) => b[1] - a[1]);
    const excess = this.postings.size - this.maxTokens;
    for (let j = 0; j < excess; j++) {
      this.postings.delete(pairs[j][0]);
    }
  }
}

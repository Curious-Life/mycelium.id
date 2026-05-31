/**
 * In-memory inverted index for the BM25 keyword path.
 *
 * Ported verbatim from reference/mind-search/index/inverted.js.
 *
 *   postings  : Map<token, Posting[]>      term → docs containing it
 *   documents : Map<id, { ts, length }>    doc → metadata
 *   Posting   = { id, tf }
 *
 * High-DF tokens are evicted first when maxTokens is exceeded (their IDF ≈ 0).
 * Single-process, no locks. Per CLAUDE.md §1 it never touches disk in plaintext.
 */

const SCHEMA_VERSION = 1;

export class InvertedIndex {
  constructor(opts = {}) {
    this.maxTokens = opts.maxTokens ?? 200_000;
    if (!Number.isInteger(this.maxTokens) || this.maxTokens < 1) {
      throw new TypeError('InvertedIndex: maxTokens must be a positive integer');
    }
    /** @type {Map<string, Array<{id:string, tf:number}>>} */
    this.postings = new Map();
    /** @type {Map<string, {ts:number, length:number}>} */
    this.documents = new Map();
    this._totalLength = 0;
  }

  add(id, tokens, ts) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('InvertedIndex.add: id must be a non-empty string');
    }
    if (!Number.isFinite(ts)) {
      throw new TypeError('InvertedIndex.add: ts must be a finite number');
    }
    if (this.documents.has(id)) this.remove(id);

    const tfs = new Map();
    let length = 0;
    for (const token of tokens) {
      if (typeof token !== 'string' || token.length === 0) continue;
      tfs.set(token, (tfs.get(token) || 0) + 1);
      length++;
    }
    for (const [token, tf] of tfs) {
      let list = this.postings.get(token);
      if (!list) { list = []; this.postings.set(token, list); }
      list.push({ id, tf });
    }
    this.documents.set(id, { ts, length });
    this._totalLength += length;

    if (this.postings.size > this.maxTokens) this._evictHighestDf();
  }

  remove(id) {
    const meta = this.documents.get(id);
    if (!meta) return;
    for (const [token, list] of this.postings) {
      const filtered = list.filter((p) => p.id !== id);
      if (filtered.length === 0) this.postings.delete(token);
      else if (filtered.length !== list.length) this.postings.set(token, filtered);
    }
    this._totalLength -= meta.length;
    this.documents.delete(id);
  }

  has(id) { return this.documents.has(id); }

  lookup(token) { return this.postings.get(token) || []; }

  documentLength(id) {
    const meta = this.documents.get(id);
    return meta ? meta.length : 0;
  }

  documentTs(id) {
    const meta = this.documents.get(id);
    return meta ? meta.ts : null;
  }

  totalDocs() { return this.documents.size; }

  avgDocumentLength() {
    return this.documents.size === 0 ? 0 : this._totalLength / this.documents.size;
  }

  documentFrequency(token) {
    const list = this.postings.get(token);
    return list ? list.length : 0;
  }

  size() {
    let totalPostings = 0;
    for (const list of this.postings.values()) totalPostings += list.length;
    return { tokens: this.postings.size, documents: this.documents.size, totalPostings };
  }

  serialize() {
    const tokens = new Array(this.postings.size);
    let i = 0;
    for (const [token, list] of this.postings) {
      const compact = new Array(list.length);
      for (let j = 0; j < list.length; j++) compact[j] = [list[j].id, list[j].tf];
      tokens[i++] = [token, compact];
    }
    const docs = new Array(this.documents.size);
    let k = 0;
    for (const [id, meta] of this.documents) docs[k++] = [id, meta.ts, meta.length];
    return Buffer.from(JSON.stringify({ v: SCHEMA_VERSION, tokens, docs, maxTokens: this.maxTokens }));
  }

  static deserialize(buf) {
    let str;
    if (typeof buf === 'string') str = buf;
    else if (Buffer.isBuffer(buf)) str = buf.toString('utf8');
    else if (buf instanceof Uint8Array) str = Buffer.from(buf).toString('utf8');
    else throw new TypeError('InvertedIndex.deserialize: buf must be Buffer, Uint8Array, or string');

    let data;
    try { data = JSON.parse(str); }
    catch (cause) { const e = new Error('InvertedIndex.deserialize: malformed JSON payload'); e.cause = cause; throw e; }
    if (!data || data.v !== SCHEMA_VERSION) {
      throw new Error(`InvertedIndex.deserialize: unsupported schema version ${data?.v}`);
    }
    if (!Array.isArray(data.tokens) || !Array.isArray(data.docs)) {
      throw new Error('InvertedIndex.deserialize: malformed payload (missing tokens or docs)');
    }
    const idx = new InvertedIndex({ maxTokens: data.maxTokens ?? 200_000 });
    for (const [token, compact] of data.tokens) {
      const list = new Array(compact.length);
      for (let j = 0; j < compact.length; j++) {
        const [id, tf] = compact[j];
        list[j] = { id, tf };
      }
      idx.postings.set(token, list);
    }
    let total = 0;
    for (const [id, ts, length] of data.docs) {
      idx.documents.set(id, { ts, length });
      total += length;
    }
    idx._totalLength = total;
    return idx;
  }

  _evictHighestDf() {
    if (this.postings.size <= this.maxTokens) return;
    const pairs = new Array(this.postings.size);
    let i = 0;
    for (const [token, list] of this.postings) pairs[i++] = [token, list.length];
    pairs.sort((a, b) => b[1] - a[1]);
    const excess = this.postings.size - this.maxTokens;
    for (let j = 0; j < excess; j++) this.postings.delete(pairs[j][0]);
  }
}

// D7 enrichment service — the embed-on-write half.
//
// Consumes the work queue the ingestion choke-point fills: every captured
// message lands with nlp_processed = 0. This service drains that backlog,
// computes the Nomic v1.5 768-d embedding for each message's plaintext, wraps
// it as a per-scope wrapped-DEK envelope (encryptVector), and writes it to
// embedding_768 — the column the mind-search ANN read path consumes.
//
// State machine: 0 pending → 2 embedded, or -1 on a per-row failure. A poison
// row is isolated (error recorded in nlp_error, drain continues) so one bad
// message never stalls the queue.
//
// Pure + injectable: deps are { messages, embed, getMasterKey }. No HTTP, no
// transport — the /enrich-all listener (the enqueue nudge target) is a thin
// Tier-2 wrapper over drainOnce. Tier-1 verifies drainOnce directly with a
// deterministic stub embedder, no embed-service required.
//
// Crypto note: encryptVector is called WITHOUT a userId. encrypt() derives a
// per-user key when given userId, but the canonical mind-search read path
// (decryptVector) passes no userId and decrypts master-key-direct — so writing
// with a userId would produce envelopes that never decrypt back. The no-userId
// path keeps write and read on the same key derivation.
//
// NLP entity/tag extraction (the other half of D7) is NOT here yet — this
// skeleton ships embed-on-write only; nlp_processed = 2 means "embedded". The
// tag/entity pass will advance its own marker when built.

import { encryptVector } from '../search/ann/decode.js';
import { EMBED_DIM } from '../embed/client.js';
import { extract } from './extract.js';

export function createEnrichmentService(deps) {
  if (!deps) throw new TypeError('createEnrichmentService: deps required');
  const { messages, embed, getMasterKey } = deps;
  if (!messages
      || typeof messages.selectPendingEnrichment !== 'function'
      || typeof messages.updateEnrichment !== 'function'
      || typeof messages.selectPendingNlp !== 'function'
      || typeof messages.updateNlp !== 'function') {
    throw new TypeError(
      'createEnrichmentService: messages namespace with selectPendingEnrichment + updateEnrichment + selectPendingNlp + updateNlp required',
    );
  }
  if (!embed || typeof embed.embed !== 'function') {
    throw new TypeError('createEnrichmentService: embed client with .embed() required');
  }
  if (typeof getMasterKey !== 'function') {
    throw new TypeError('createEnrichmentService: getMasterKey() required');
  }

  /**
   * Drain one batch of pending messages for a user. Fail-closed on the vault:
   * if the master key is unavailable (locked / no tmpfs) it refuses the whole
   * batch rather than mark rows processed with no embedding. Per-row failures
   * are isolated and never abort the batch.
   *
   * @param {{userId: string, batchSize?: number}} opts
   * @returns {Promise<{scanned: number, embedded: number, failed: number}>}
   */
  async function drainOnce({ userId, batchSize = 50 } = {}) {
    if (!userId) throw new TypeError('drainOnce: userId required');

    // Fail closed (CLAUDE.md §3): missing key → refuse to write. Resolve once
    // per batch, not per row.
    const masterKey = await getMasterKey();
    if (!masterKey) {
      throw new Error('enrichment: master key unavailable — vault locked, refusing to write');
    }

    const rows = await messages.selectPendingEnrichment(userId, { limit: batchSize });
    let embedded = 0;
    let failed = 0;

    // Embed in BOUNDED CHUNKS. A whole 50-row batch of long messages takes >60s
    // on the CPU model, but the embed client aborts at 30s → the request fails
    // and the WHOLE batch would be marked failed (and never retried). Chunking
    // keeps every embedBatch call well under the timeout. Each chunk falls back
    // to per-row embed() so one poison row — or a stub embedder without
    // embedBatch — can't sink the rest.
    const EMBED_CHUNK = 12;
    for (let start = 0; start < rows.length; start += EMBED_CHUNK) {
      const chunk = rows.slice(start, start + EMBED_CHUNK);
      let vectors;
      try {
        vectors = typeof embed.embedBatch === 'function'
          ? await embed.embedBatch(chunk.map((r) => r.content), 'document')
          : await Promise.all(chunk.map((r) => embed.embed(r.content, 'document')));
      } catch {
        // Whole-chunk embed failed — retry per row so one bad/slow row can't sink
        // the others; a row that still fails gets a null vector → marked -1 below.
        vectors = [];
        for (const r of chunk) {
          try { vectors.push(await embed.embed(r.content, 'document')); }
          catch { vectors.push(null); }
        }
      }

      for (let i = 0; i < chunk.length; i++) {
        const row = chunk[i];
        try {
          const vec = vectors[i];
          if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
            throw new Error(
              `embed returned ${Array.isArray(vec) ? vec.length : typeof vec} dims, expected ${EMBED_DIM}`,
            );
          }
          const scope = row.scope || 'org';
          // No userId — match the decryptVector read path's key derivation.
          const envelope = await encryptVector(Float32Array.from(vec), scope, masterKey);
          await messages.updateEnrichment(row.id, userId, { embedding768: envelope, nlpProcessed: 2 });
          embedded++;
        } catch (err) {
          // Isolate the poison row. Never log row.content (CLAUDE.md §1 — zero
          // plaintext leakage); the message text alone is sensitive.
          await messages.updateEnrichment(row.id, userId, {
            nlpProcessed: -1,
            nlpError: String(err?.message || err).slice(0, 500),
          });
          failed++;
        }
      }
    }

    return { scanned: rows.length, embedded, failed };
  }

  /**
   * Stage 2: the deterministic NLP rules pass. Drains embedded-but-not-enriched
   * rows (nlp_processed=2), extracts entities/tags/summary from plaintext, and
   * advances them to enriched (1). No master key needed here — the db adapter
   * already holds the unlock()-derived key and encrypts the written fields. A
   * poison row is isolated (→ -1 + nlp_error) and never stalls the batch.
   *
   * @param {{userId: string, batchSize?: number}} opts
   * @returns {Promise<{scanned: number, enriched: number, failed: number}>}
   */
  async function enrichNlpOnce({ userId, batchSize = 50 } = {}) {
    if (!userId) throw new TypeError('enrichNlpOnce: userId required');
    const rows = await messages.selectPendingNlp(userId, { limit: batchSize });
    let enriched = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const { entities, tags, entitySummary } = extract(row.content);
        await messages.updateNlp(row.id, userId, {
          entities: JSON.stringify(entities),
          tags: JSON.stringify(tags),
          entitySummary,
          nlpProcessed: 1,
        });
        enriched++;
      } catch (err) {
        // Never log row.content (CLAUDE.md §1 — zero plaintext leakage).
        await messages.updateNlp(row.id, userId, {
          nlpProcessed: -1,
          nlpError: String(err?.message || err).slice(0, 500),
        });
        failed++;
      }
    }

    return { scanned: rows.length, enriched, failed };
  }

  return { drainOnce, enrichNlpOnce };
}

export default createEnrichmentService;

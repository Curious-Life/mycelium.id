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
import { TAXONOMY_VERSION } from './categories-prompt.js';
import { getMindSearch } from '../search/registry.js';
import { extract } from './extract.js';

export function createEnrichmentService(deps) {
  if (!deps) throw new TypeError('createEnrichmentService: deps required');
  const { messages, embed, getMasterKey, classify } = deps;
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
    let skipped = 0;

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
        const vec = vectors[i];
        // Empty/blank content can't embed — TERMINAL SKIP (nlp_processed=1) so it
        // leaves the backlog for good. Was: stuck at nlp_processed=0 forever,
        // keeping enrichmentPending > 0 and starving the "settled → generate" gate.
        if (!row.content || !String(row.content).trim()) {
          await messages.updateEnrichment(row.id, userId, { nlpProcessed: 1 });
          skipped++;
          continue;
        }
        // TRANSIENT embed failure: vec is null/undefined (a service timeout/outage
        // during this chunk, not a model error). Leave the row PENDING (no write) so
        // the drainer retries it next healthy cycle. NEVER permanent-poison it — the
        // old code threw "embed returned object dims, expected 768" (typeof null ===
        // 'object'), which the drainer's self-heal skips forever, stranding valid msgs.
        if (vec == null) { continue; }
        try {
          // GENUINE dimension mismatch (a real wrong-size array) → permanent poison.
          if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
            throw new Error(`embed returned ${vec.length} dims, expected ${EMBED_DIM}`);
          }
          const scope = row.scope || 'org';
          // No userId — match the decryptVector read path's key derivation.
          const envelope = await encryptVector(Float32Array.from(vec), scope, masterKey);
          await messages.updateEnrichment(row.id, userId, { embedding768: envelope, nlpProcessed: 2 });
          // Incremental search maintenance (§8): hand the just-computed vector to
          // the on-disk index (NO-OP for the in-RAM backend; never decrypts again;
          // best-effort, never blocks enrichment). @see src/search/index.js noteVector.
          try { getMindSearch()?.noteVector?.(row.id, vec); } catch { /* best-effort */ }
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

    return { scanned: rows.length, embedded, failed, skipped };
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
  // Stage 3 (Context Engine L1): per-message domain + register labels via the injected
  // classifier. Independent of the nlp_processed machine (its own categories_processed flag).
  // Fail-soft: a transient classify failure (model down) STOPS the batch and leaves the row
  // pending (0) for the next cycle — never poisons a row, never logs content (§1). A model that
  // replies with garbage yields null labels (still marked attempted, not retried forever).
  async function enrichCategoriesOnce({ userId, batchSize = 25 } = {}) {
    if (!userId) throw new TypeError('enrichCategoriesOnce: userId required');
    if (typeof classify !== 'function') return { scanned: 0, enriched: 0, failed: 0, skipped: 'no-classifier' };
    const rows = await messages.selectPendingCategories(userId, { limit: batchSize });
    let enriched = 0;
    let failed = 0;
    for (const row of rows) {
      const content = (row.content || '').trim();
      if (!content) { // nothing to classify — mark attempted so it isn't re-selected
        await messages.updateCategories(row.id, userId, { categoriesProcessed: 1, taxonomyVersion: TAXONOMY_VERSION });
        continue;
      }
      let labels;
      try { labels = await classify(content); }
      catch { failed++; break; } // transient (model down) → leave pending, stop the batch
      await messages.updateCategories(row.id, userId, {
        domain: labels.domain,
        register: labels.register,
        subregister: labels.subregister,
        taxonomyVersion: TAXONOMY_VERSION,
        categoriesProcessed: 1,
      });
      enriched++;
    }
    return { scanned: rows.length, enriched, failed };
  }

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

  return { drainOnce, enrichNlpOnce, enrichCategoriesOnce };
}

export default createEnrichmentService;

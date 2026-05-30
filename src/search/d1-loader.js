/**
 * D1 → mind-search rehydrate.
 *
 * The mind-search snapshot persists only the inverted index, not the
 * vector cache (vectors at scale balloon the snapshot file; D1 is the
 * canonical home). At every agent restart, the vector cache must be
 * repopulated from D1 before tier 1 (ANN) queries can return hits.
 *
 * This module provides the rehydrate path. It is run fire-and-forget
 * after bootstrapMindSearch resolves: the agent serves immediately;
 * matchMessages falls through to its Vectorize fallback for any query
 * that arrives during the rehydrate window. Once rehydrate completes,
 * mind-search owns the read path.
 *
 * Per CLAUDE.md §1, this module never logs message text, ids, vectors,
 * or any decrypted bytes. It logs counters and (optionally) batch
 * progress hashes.
 */

const NOMIC_DIM = 768;
const DEFAULT_BATCH_SIZE = 200;

/**
 * Rehydrate a mind-search backend from D1 messages.
 *
 * @param {object} deps
 * @param {{ add: (req: object) => Promise<void> }} deps.backend  the LocalBackend
 * @param {{ messages: { streamForRehydrate: Function } }} deps.db  db-d1 root
 * @param {(envelope: string) => Promise<Float32Array>} deps.decryptVector
 * @param {(ciphertext: string) => Promise<string>} deps.decryptContent
 * @param {(cipher: string) => boolean} deps.isEncrypted
 * @param {string} deps.userId
 * @param {string} [deps.scope]            optional SQL-side scope filter
 * @param {number} [deps.batchSize]        D1 page size (default 200)
 * @param {{ info?: Function, warn?: Function }} [deps.logger]
 * @returns {Promise<{ added: number, skipped: number, decryptVectorFailed: number, decryptContentFailed: number, batches: number, elapsedMs: number }>}
 */
export async function rehydrateFromD1(deps) {
  const {
    backend,
    db,
    decryptVector,
    decryptContent,
    isEncrypted,
    userId,
    scope,
    batchSize = DEFAULT_BATCH_SIZE,
    logger = null,
  } = deps;

  if (!backend || typeof backend.add !== 'function') {
    throw new TypeError('rehydrateFromD1: deps.backend with add() required');
  }
  if (!db?.messages?.streamForRehydrate) {
    throw new TypeError('rehydrateFromD1: deps.db.messages.streamForRehydrate required');
  }
  if (typeof decryptVector !== 'function' || typeof decryptContent !== 'function') {
    throw new TypeError('rehydrateFromD1: decryptVector + decryptContent required');
  }
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('rehydrateFromD1: userId required');
  }

  const startedAt = Date.now();
  let cursor = '';
  let added = 0;
  let skipped = 0;
  let decryptVectorFailed = 0;
  let decryptContentFailed = 0;
  let batches = 0;

  while (true) {
    const rows = await db.messages.streamForRehydrate(userId, {
      batchSize, cursor, scope,
    });
    if (rows.length === 0) break;
    batches += 1;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      // No vector envelope on the row → nothing to rehydrate. Skip
      // silently; the streamForRehydrate filter already requires
      // embedding_768 IS NOT NULL, so this branch should be rare
      // (race between Wave 2 backfill and rehydrate).
      if (typeof row.embedding_768 !== 'string' || row.embedding_768.length === 0) {
        skipped += 1;
        continue;
      }

      // Decrypt the vector envelope first — cheaper than content and
      // its failure mode (scope mismatch, bad envelope) is the one we
      // care about catching before doing extra work.
      let vec;
      try {
        vec = await decryptVector(row.embedding_768);
      } catch {
        decryptVectorFailed += 1;
        continue;
      }
      if (!(vec instanceof Float32Array) || vec.length !== NOMIC_DIM) {
        decryptVectorFailed += 1;
        continue;
      }

      // Content may already be plaintext for older rows or rows that
      // skipped the auto-encrypt path. isEncrypted gates the decrypt.
      let text = row.content;
      if (typeof text === 'string' && isEncrypted && isEncrypted(text)) {
        try {
          text = await decryptContent(text);
        } catch {
          decryptContentFailed += 1;
          // Still rehydrate the vector — BM25 over empty text is a
          // missed token contribution but ANN still works.
          text = '';
        }
      }

      const ts = Math.floor(new Date(row.created_at).getTime() / 1000);
      if (!Number.isFinite(ts)) {
        skipped += 1;
        continue;
      }

      try {
        await backend.add({ id: row.id, text, embedding: vec, ts });
        added += 1;
      } catch {
        skipped += 1;
      }
    }

    if (logger?.info) {
      // Counters only — no ids, no text, no vector data.
      logger.info('mind-search.rehydrate.batch', {
        batch: batches,
        added,
        skipped,
        decryptVectorFailed,
        decryptContentFailed,
      });
    }
  }

  return {
    added,
    skipped,
    decryptVectorFailed,
    decryptContentFailed,
    batches,
    elapsedMs: Date.now() - startedAt,
  };
}

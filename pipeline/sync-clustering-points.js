#!/usr/bin/env node
/**
 * Sync new content → clustering_points.
 *
 * Selects messages that carry a search-side 768D Nomic embedding
 * (`embedding_768`, an encrypted envelope), decrypts + base64-decodes it,
 * slices the matryoshka 256D prefix, L2-normalizes, and upserts a
 * clustering_points row carrying the 256D vector as an ENCRYPTED wrapped-DEK
 * envelope in `nomic_embedding` (the same caller-encrypts scheme embedding_768
 * uses — see decode.js encryptVector). cluster.py's fetch_all_embeddings()
 * decrypts it via crypto_local.decrypt_vector (model 'nomic-v1.5-256d',
 * NOMIC_DIM=256 floats). nomic_embedding is in NEVER_AUTO_DECRYPT (not
 * ENCRYPTED_FIELDS), so the db adapter passes the envelope through verbatim.
 *
 * This is the fresh, small "Step 1" the slim orchestrator owns: it does NOT
 * recompute embeddings, it derives the 256D clustering vector from the 768D
 * search vector that the embed/enrichment side already wrote.
 *
 * V1 single-user: reads/writes the local encrypted vault via the in-process
 * db adapter; scope is always 'personal'. Messages with no embedding_768 are
 * skipped (cluster.py's ONNX path would re-embed them if the model is present,
 * but that is a separate concern — sync only mirrors what already exists).
 *
 * Usage:
 *   USER_MASTER=<hex> SYSTEM_KEY=<hex> MYCELIUM_DB=./data/vault.db \
 *     node pipeline/sync-clustering-points.js [--dry-run]
 */

import { boot } from '../src/index.js';
import * as cryptoLocal from '../src/crypto/crypto-local.js';
import { decryptVector, encryptVector } from '../src/search/ann/decode.js';

const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
const DB_PATH = process.env.MYCELIUM_DB || './data/vault.db';
const USER_MASTER = process.env.USER_MASTER;
const SYSTEM_KEY = process.env.SYSTEM_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

const NOMIC_DIM = 256; // matryoshka truncation 768 → 256
// Scope tag for the nomic_embedding envelope. Single-user vault → fixed scope;
// decrypt is scope-agnostic (allowedScopes=null), so this only needs to match
// what cluster.py's ONNX-fallback writer uses (it does — crypto_local default).
const NOMIC_SCOPE = 'personal';

if (!USER_MASTER || !SYSTEM_KEY) {
  console.error('Missing: USER_MASTER and SYSTEM_KEY (64-char hex each)');
  process.exit(1);
}

/**
 * Decode an encrypted 768D embedding envelope into a normalized 256D Float32Array.
 * Mirrors cluster.py's derive phase: decrypt → base64-decode → float32 →
 * slice[:256] → L2-normalize. Returns null on any failure (skip the point).
 */
async function decode256(envelope, masterKey) {
  try {
    // Decrypt the 768D vector via the CANONICAL path — the same encryptVector /
    // decryptVector scheme enrich + mind-search use. The prior bespoke
    // decryptBytes + base64 path could not parse the scoped-DEK envelope that
    // encryptVector writes, so EVERY row was skipped as "undecryptable" and the
    // clustering pipeline produced zero points. `null` allowedScopes = decrypt
    // regardless of the envelope's scope (single-user local vault).
    const full = await decryptVector(envelope, masterKey, null, 768);
    if (!full || full.length < NOMIC_DIM) return null;
    // Matryoshka-truncate 768 → 256 and L2-normalize (cluster.py's derive phase).
    const out = new Float32Array(NOMIC_DIM);
    let norm = 0;
    for (let i = 0; i < NOMIC_DIM; i++) {
      out[i] = full[i];
      norm += full[i] * full[i];
    }
    norm = Math.sqrt(norm);
    if (!(norm > 1e-8) || !Number.isFinite(norm)) return null;
    for (let i = 0; i < NOMIC_DIM; i++) out[i] /= norm;
    return out;
  } catch {
    return null;
  }
}

async function run() {
  // boot() (NOT getDb-with-hex): keys the at-rest vault (resolveDbKeyHex) + unlock→CryptoKeys; getDb-with-hex opened UNKEYED → SQLITE_NOTADB on an encrypted vault.
  const { db, close } = await boot({ dbPath: DB_PATH, userHex: USER_MASTER, systemHex: SYSTEM_KEY, userId: USER_ID, embedder: null });
  const query = (sql, params = []) => db.rawQuery(sql, params).then(r => (Array.isArray(r) ? r : r.results || []));

  try {
    console.log(`[sync] Syncing messages → clustering_points for user=${USER_ID}${DRY_RUN ? ' (dry-run)' : ''}`);

    // Messages with a 768D embedding that aren't already in clustering_points.
    const rows = await query(
      `SELECT m.id AS source_id, m.created_at, m.embedding_768
       FROM messages m
       WHERE m.user_id = ? AND m.embedding_768 IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM clustering_points cp
           WHERE cp.user_id = m.user_id AND cp.source_type = 'message' AND cp.source_id = m.id
         )
       ORDER BY m.created_at`,
      [USER_ID],
    );

    console.log(`[sync] ${rows.length} new messages with embedding_768`);

    // NB: do NOT early-return when rows.length === 0 — the backfill pass below
    // still needs to run (existing point rows may be unembedded even when there
    // are no NEW messages to insert; that is the exact case this fix addresses).

    // Resolve the vector master key the same way enrich/search do. boot() wires
    // ENCRYPTION_MASTER_KEY = USER_MASTER hex; this is a standalone process, so
    // set it before getMasterKey() reads it. (decryptVector takes this CryptoKey.)
    if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = USER_MASTER;
    const masterKey = await cryptoLocal.getMasterKey();
    if (!masterKey) {
      console.error('[sync] Fatal: could not resolve the vector master key — cannot decrypt embeddings');
      close();
      process.exit(1);
    }

    let inserted = 0;
    let skipped = 0;
    for (const r of rows) {
      const vec = await decode256(r.embedding_768, masterKey);
      if (!vec) { skipped++; continue; }

      if (DRY_RUN) { inserted++; continue; }

      const id = `${USER_ID}:cp:message:${r.source_id}`;
      try {
        // Encrypt the 256D clustering vector at rest. Bound as a TEXT param (the
        // envelope is base64 ASCII) — NOT the old raw X'<hex>' BLOB. Stored in a
        // BLOB-affinity column; SQLite keeps the value's own (TEXT) type.
        const envelope = await encryptVector(vec, NOMIC_SCOPE, masterKey);
        await query(
          `INSERT INTO clustering_points
             (id, user_id, source_type, source_id, nomic_embedding, embedding_model, created_at, updated_at)
           VALUES (?, ?, 'message', ?, ?, 'nomic-v1.5-256d', ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             nomic_embedding = excluded.nomic_embedding,
             embedding_model = excluded.embedding_model,
             updated_at = datetime('now')`,
          [id, USER_ID, r.source_id, envelope, r.created_at],
        );
        inserted++;
      } catch (err) {
        console.error(`[sync] insert failed for ${r.source_id}:`, err.message);
        skipped++;
      }
    }

    // Backfill: existing point rows whose message is NOW embedded but whose
    // nomic_embedding is still NULL. The insert loop above can't fix these — the
    // SELECT's NOT EXISTS excludes any message that already HAS a point row, and
    // even if it didn't, those rows carry the import's UUID id (not this script's
    // `…:cp:message:…` scheme), so the INSERT's ON CONFLICT(id) would never match
    // and would create a DUPLICATE point. So update IN PLACE by the existing
    // row's id (found via JOIN). Root cause of stale clustering coverage after an
    // embed-backlog clear: a point created while its message was unembedded was
    // never re-filled once the message got its embedding_768.
    let backfilled = 0;
    if (!DRY_RUN) {
      const stale = await query(
        `SELECT cp.id AS cp_id, m.embedding_768 AS e
           FROM clustering_points cp
           JOIN messages m ON m.id = cp.source_id AND m.user_id = cp.user_id
          WHERE cp.user_id = ? AND cp.source_type = 'message'
            AND cp.nomic_embedding IS NULL AND m.embedding_768 IS NOT NULL`,
        [USER_ID],
      );
      for (const r of stale) {
        const vec = await decode256(r.e, masterKey);
        if (!vec) { skipped++; continue; }
        try {
          const envelope = await encryptVector(vec, NOMIC_SCOPE, masterKey);
          await query(
            `UPDATE clustering_points
                SET nomic_embedding = ?, embedding_model = 'nomic-v1.5-256d', updated_at = datetime('now')
              WHERE id = ?`,
            [envelope, r.cp_id],
          );
          backfilled++;
        } catch (err) {
          console.error(`[sync] backfill failed for ${r.cp_id}:`, err.message);
          skipped++;
        }
      }
    }

    console.log(`[sync] Done: ${inserted} inserted, ${backfilled} backfilled, ${skipped} skipped (no/undecryptable embedding)`);
  } finally {
    close();
  }
}

run().catch(err => { console.error('[sync] Fatal:', err); process.exit(1); });

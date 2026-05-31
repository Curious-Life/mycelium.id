#!/usr/bin/env node
/**
 * Sync new content → clustering_points.
 *
 * Selects messages that carry a search-side 768D Nomic embedding
 * (`embedding_768`, an encrypted envelope), decrypts + base64-decodes it,
 * slices the matryoshka 256D prefix, L2-normalizes, and upserts a
 * clustering_points row carrying the 256D vector as a hex BLOB in
 * `nomic_embedding` — exactly the shape cluster.py's fetch_all_embeddings()
 * expects (NOMIC_DIM*4 = 1024 bytes, model 'nomic-v1.5-256d').
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

import { getDb } from '../src/db/index.js';
import * as cryptoLocal from '../src/crypto/crypto-local.js';

// Resolve the byte-decrypt primitive defensively — the canonical module has
// exposed it as both `decryptBytes` and `decrypt_bytes` across vintages. Sync
// is a Tier-2 step (only runs against seeded rows), so we fail-soft if the
// primitive name drifts rather than crashing the whole pipeline import.
const decryptBytes =
  cryptoLocal.decryptBytes ||
  cryptoLocal.decrypt_bytes ||
  cryptoLocal.decryptSafe ||
  cryptoLocal.decrypt_safe ||
  null;

const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
const DB_PATH = process.env.MYCELIUM_DB || './data/vault.db';
const USER_MASTER = process.env.USER_MASTER;
const SYSTEM_KEY = process.env.SYSTEM_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

const NOMIC_DIM = 256; // matryoshka truncation 768 → 256

if (!USER_MASTER || !SYSTEM_KEY) {
  console.error('Missing: USER_MASTER and SYSTEM_KEY (64-char hex each)');
  process.exit(1);
}

/**
 * Decode an encrypted 768D embedding envelope into a normalized 256D Float32Array.
 * Mirrors cluster.py's derive phase: decrypt → base64-decode → float32 →
 * slice[:256] → L2-normalize. Returns null on any failure (skip the point).
 */
function decode256(envelope, key) {
  if (!decryptBytes) return null;
  try {
    // crypto-local.decryptBytes returns the plaintext bytes. The 768D vector
    // was stored as base64-of-float32-bytes (encodeVector), so the plaintext
    // is base64 ASCII; decode that to the raw float buffer.
    const pt = decryptBytes(envelope, key);
    const ascii = Buffer.isBuffer(pt) ? pt.toString('latin1') : String(pt);
    const raw = Buffer.from(ascii, 'base64');
    if (raw.length < 768 * 4) return null;
    const f32 = new Float32Array(raw.buffer, raw.byteOffset, 768);
    const out = new Float32Array(NOMIC_DIM);
    let norm = 0;
    for (let i = 0; i < NOMIC_DIM; i++) { out[i] = f32[i]; norm += f32[i] * f32[i]; }
    norm = Math.sqrt(norm);
    if (!(norm > 1e-8) || !Number.isFinite(norm)) return null;
    for (let i = 0; i < NOMIC_DIM; i++) out[i] /= norm;
    return out;
  } catch {
    return null;
  }
}

function toHexBlob(f32) {
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('hex');
}

async function run() {
  const { db, close } = getDb({ dbPath: DB_PATH, userKey: USER_MASTER, systemKey: SYSTEM_KEY, scope: 'personal' });
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

    if (rows.length === 0) {
      console.log('[sync] Nothing to sync. Exiting.');
      return;
    }

    let inserted = 0;
    let skipped = 0;
    for (const r of rows) {
      const vec = decode256(r.embedding_768, USER_MASTER);
      if (!vec) { skipped++; continue; }

      if (DRY_RUN) { inserted++; continue; }

      const id = `${USER_ID}:cp:message:${r.source_id}`;
      try {
        await query(
          `INSERT INTO clustering_points
             (id, user_id, source_type, source_id, nomic_embedding, embedding_model, created_at, updated_at)
           VALUES (?, ?, 'message', ?, X'${toHexBlob(vec)}', 'nomic-v1.5-256d', ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             nomic_embedding = excluded.nomic_embedding,
             embedding_model = excluded.embedding_model,
             updated_at = datetime('now')`,
          [id, USER_ID, r.source_id, r.created_at],
        );
        inserted++;
      } catch (err) {
        console.error(`[sync] insert failed for ${r.source_id}:`, err.message);
        skipped++;
      }
    }

    console.log(`[sync] Done: ${inserted} clustering_points upserted, ${skipped} skipped (no/undecryptable embedding)`);
  } finally {
    close();
  }
}

run().catch(err => { console.error('[sync] Fatal:', err); process.exit(1); });

#!/usr/bin/env node
/**
 * ONE-TIME recovery — restore the mindscape from a decrypted mycelium-full-export
 * after the 2026-06-15 half-finished re-cluster left the live map 96% blank.
 *
 * What it does (and ONLY this): for the clustering/mindscape tables, DELETE the
 * user's rows then re-import them from the export's db/<table>.ndjson — a clean
 * overwrite back to the pristine imported state (the importer is INSERT OR IGNORE,
 * so DELETE-first is required). 256-d / 768-d vectors are decoded from the
 * embeddings/ files and re-encrypted under THIS vault's key. Messages, people,
 * attachments, health, wealth, documents — UNTOUCHED.
 *
 * Mirrors src/ingest/full-export-import.js (restoreTable + vectorPass) but is
 * self-contained so it runs on `main` (where restoreTable isn't exported).
 *
 * Safety: caller MUST stop the app + snapshot the DB first. Defers foreign_keys
 * during the restore and re-enables in finally (shared connection). --dry-run
 * shows the plan + counts without writing.
 *
 * Usage:
 *   MYCELIUM_KEY_SOURCE=keychain MYCELIUM_DB=<path> RECOVER_DIR=<decrypted export root> \
 *     node scripts/recover-mindscape.mjs [--dry-run]
 */
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { getDb } from '../src/db/index.js';
import { loadKey } from '../src/crypto/keys.js';
import { resolveKeys } from '../src/crypto/key-source.js';
import { encryptVector } from '../src/search/ann/decode.js';

const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
const DB_PATH = process.env.MYCELIUM_DB;
const DIR = process.env.RECOVER_DIR;
const DRY = process.argv.includes('--dry-run');
// The canonical export carries 3 user scopes (3 separate clustering runs that
// can't coherently share territory ids). Restore ONLY the primary scope,
// remapped to USER_ID — single source user ⇒ no id collisions ⇒ no chronicle
// loss (merging all 3 made INSERT OR IGNORE keep arbitrary first-wins rows,
// e.g. a dissolved row over the active chronicled one). Override via env.
const SOURCE_USER = process.env.RECOVER_SOURCE_USER || 'f7de8ffd-4369-40a2-8bf6-ac0396f7d65f';
const BATCH = 500;
const MAX_ROWS_PER_TABLE = 5_000_000;

if (!DB_PATH) { console.error('Set MYCELIUM_DB to the target vault db.'); process.exit(1); }
if (!DIR) { console.error('Set RECOVER_DIR to the decrypted mycelium-full-export root.'); process.exit(1); }

// The clustering/mindscape family — the ONLY tables this restore touches. Order
// is parent→child but FKs are deferred anyway. (theme_cards is empty at source;
// included for completeness/idempotence.)
const MINDSCAPE_TABLES = [
  'realms', 'semantic_themes', 'territory_profiles', 'clustering_points',
  'cluster_events', 'theme_cards', 'realm_neighbors', 'territory_cofire',
  'territory_neighbors', 'territory_lineage', 'territory_pass_notes',
  'territory_seen_points', 'time_seen_points', 'territory_vitality',
];

// Encrypted vector files → column re-encrypt. (messages/documents 768d are NOT
// touched here — those rows aren't part of the mindscape restore.)
const VECTOR_PASSES = [
  ['embeddings/clustering_points.256d.ndjson', 'clustering_points', 'nomic_embedding', 256],
  ['embeddings/territory_profiles.768d.ndjson', 'territory_profiles', 'embedding_768', 768],
  ['embeddings/realms.768d.ndjson', 'realms', 'embedding_768', 768],
  ['embeddings/semantic_themes.768d.ndjson', 'semantic_themes', 'embedding_768', 768],
];

function resolveRoot(dir) {
  if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
  for (const name of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
    const sub = path.join(dir, name);
    try { if (fs.statSync(sub).isDirectory() && fs.existsSync(path.join(sub, 'manifest.json'))) return sub; } catch { /* */ }
  }
  return dir;
}

async function forEachNdjson(file, cb) {
  if (!fs.existsSync(file)) return 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    const s = line.trim(); if (!s) continue;
    let row; try { row = JSON.parse(s); } catch { continue; }
    await cb(row); n++;
  }
  return n;
}

function decodeVector(row) {
  const b = row.vector_b64 ? Buffer.from(row.vector_b64, 'base64')
    : (row.vector_hex ? Buffer.from(row.vector_hex, 'hex') : null);
  if (!b || b.length === 0 || b.length % 4 !== 0) return null;
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
}

const normalizeValue = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return null; } }
  return v;
};

async function tableColumns(db, table) {
  try {
    const res = await db.rawQuery(`PRAGMA table_info(${table})`);
    return new Set((res?.results || res || []).map((r) => r.name));
  } catch { return new Set(); }
}

async function restoreRows(db, table, cols, rows) {
  const out = { attempted: 0, inserted: 0, deduped: 0, failed: 0 };
  for (const row of rows) {
    if (out.attempted >= MAX_ROWS_PER_TABLE) break;
    out.attempted++;
    if (!row || typeof row !== 'object') { out.failed++; continue; }
    try {
      const r = { ...row };
      if (cols.has('user_id')) r.user_id = USER_ID;
      if (cols.has('scope')) r.scope = 'personal';
      if (cols.has('embedding_768')) r.embedding_768 = null;   // re-set by vector pass
      if (cols.has('nomic_embedding')) r.nomic_embedding = null;
      const keys = Object.keys(r).filter((k) => cols.has(k) && r[k] !== undefined);
      if (keys.length === 0) { out.failed++; continue; }
      const res = await db.rawQuery(
        `INSERT OR IGNORE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
        keys.map((k) => normalizeValue(r[k])),
      );
      if ((res?.meta?.changes ?? 0) > 0) out.inserted++; else out.deduped++;
    } catch (e) { out.failed++; if (out.failed <= 3) console.error(`  [${table}] row failed: ${e.message}`); }
  }
  return out;
}

async function liveCount(db, table) {
  try {
    const r = await db.rawQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, [USER_ID]);
    return (r?.results || r || [])[0]?.n ?? 0;
  } catch { return -1; }
}

async function run() {
  const { userHex, systemHex } = resolveKeys();
  const userKey = await loadKey(userHex);
  const systemKey = await loadKey(systemHex);
  const { db, close } = getDb({ dbPath: DB_PATH, userKey, systemKey, scope: 'personal' });
  const masterKey = userKey;
  const root = resolveRoot(DIR);
  const dbDir = path.join(root, 'db');
  if (!fs.existsSync(path.join(root, 'manifest.json'))) { console.error(`No manifest.json under ${root}`); process.exit(1); }

  console.log(`\n=== Mindscape recovery ${DRY ? '(DRY RUN)' : ''} ===`);
  console.log(`  DB:  ${DB_PATH}`);
  console.log(`  SRC: ${root}\n`);

  const report = {};
  await db.rawQuery('PRAGMA foreign_keys = OFF').catch(() => {});
  try {
    for (const table of MINDSCAPE_TABLES) {
      const file = path.join(dbDir, `${table}.ndjson`);
      const cols = await tableColumns(db, table);
      if (cols.size === 0) { report[table] = { tableMissing: true }; console.log(`  ${table}: (not in live schema — skip)`); continue; }
      // export line count (PRIMARY scope only)
      let exportN = 0;
      if (fs.existsSync(file)) await forEachNdjson(file, (row) => { if (row && row.user_id === SOURCE_USER) exportN++; });
      const before = await liveCount(db, table);
      if (DRY) {
        report[table] = { export: exportN, liveBefore: before, wouldDelete: before };
        console.log(`  ${table}: live ${before} → would DELETE then import ${exportN}`);
        continue;
      }
      // DELETE then re-import
      if (cols.has('user_id')) await db.rawQuery(`DELETE FROM ${table} WHERE user_id = ?`, [USER_ID]).catch((e) => console.error(`  [${table}] delete: ${e.message}`));
      else await db.rawQuery(`DELETE FROM ${table}`).catch((e) => console.error(`  [${table}] delete: ${e.message}`));
      const agg = { attempted: 0, inserted: 0, deduped: 0, failed: 0 };
      let batch = [];
      const flush = async () => { if (!batch.length) return; const r = await restoreRows(db, table, cols, batch); for (const k of Object.keys(agg)) agg[k] += r[k]; batch = []; };
      if (fs.existsSync(file)) await forEachNdjson(file, async (row) => { if (!row || row.user_id !== SOURCE_USER) return; batch.push(row); if (batch.length >= BATCH) await flush(); });
      await flush();
      const after = await liveCount(db, table);
      report[table] = { export: exportN, liveBefore: before, liveAfter: after, ...agg };
      console.log(`  ${table}: ${before} → ${after}  (export ${exportN}, inserted ${agg.inserted}, deduped ${agg.deduped}, failed ${agg.failed})`);
    }

    // Vectors
    console.log('\n  -- vectors --');
    for (const [rel, table, col, dim] of VECTOR_PASSES) {
      const f = path.join(root, rel);
      if (!fs.existsSync(f)) { console.log(`  ${table}.${col}: (no ${rel})`); continue; }
      if (DRY) { const n = await forEachNdjson(f, () => {}); console.log(`  ${table}.${col}: would re-encrypt ${n} vectors`); continue; }
      let updated = 0, bad = 0;
      await forEachNdjson(f, async (row) => {
        const id = row.id; const vec = decodeVector(row);
        if (!id || !vec || vec.length !== dim) { bad++; return; }
        try {
          const env = await encryptVector(vec, 'personal', masterKey);
          const res = await db.rawQuery(`UPDATE ${table} SET ${col} = ? WHERE id = ? AND user_id = ?`, [env, id, USER_ID]);
          if ((res?.meta?.changes ?? 0) > 0) updated++; else bad++;
        } catch (e) { bad++; if (bad <= 3) console.error(`  [${table}.${col}] ${e.message}`); }
      });
      report[`${table}.${col}`] = { updated, bad };
      console.log(`  ${table}.${col}: updated ${updated}, bad/unmatched ${bad}`);
    }

    // Reconciliation verdict
    console.log('\n=== reconciliation ===');
    let mismatch = 0;
    for (const table of MINDSCAPE_TABLES) {
      const r = report[table]; if (!r || r.tableMissing) continue;
      const exp = r.export ?? 0, live = DRY ? r.liveBefore : (r.liveAfter ?? 0);
      const ok = DRY ? true : (live === exp);
      if (!ok) mismatch++;
      console.log(`  ${ok ? '[✓]' : '[✗]'} ${table}: export ${exp} · live ${live}`);
    }
    console.log(DRY ? '\n(dry run — nothing written)' : (mismatch === 0 ? '\nVERDICT: GO — all restored tables match the export.' : `\nVERDICT: REVIEW — ${mismatch} table(s) differ from export.`));
  } finally {
    await db.rawQuery('PRAGMA foreign_keys = ON').catch(() => {});
    close();
  }
}

run().catch((e) => { console.error('Fatal:', e); process.exit(1); });

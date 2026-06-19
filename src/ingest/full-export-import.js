// Importer for the canonical "mycelium-full-export" bundle (scripts/
// export-everything.js): a DECRYPTED directory — NOT the inline-manifest
// `mycelium-vault-export` zip. Layout (see the bundle's README.txt):
//   manifest.json                      { format:'mycelium-full-export', tables{}, … }
//   db/<table>.ndjson                  every D1 table, decrypted, one JSON row/line
//                                      (embedding_768 / nomic_embedding dropped here)
//   embeddings/<table>.768d.ndjson     { id, vector_b64 }  decoded 768-d search vectors
//   embeddings/clustering_points.256d.ndjson { id, vector_hex }  256-d nomic vectors
//   attachments/<id>/<filename>        every media object, decrypted bytes
//   agents/<agentId>/...               on-disk agent files (mind/*.md decrypted)
//
// WHY PATH-BASED (not upload): these bundles run to GBs (58k messages + 2.6k media
// + 214MB of vectors). Streaming each NDJSON line-by-line and each attachment
// file-by-file off disk keeps memory flat — a browser upload + in-memory unzip
// would OOM. The route is loopback-only (the decrypted bundle is the user's own
// plaintext on their own machine — same trust boundary as the Obsidian folder import).
//
// HOW IT LANDS: every row goes through the shared restoreTable() (vault-import.js)
// — column-intersected against the live V1 schema, user_id forced, scope forced
// 'personal', INSERT OR IGNORE on the preserved id ⇒ idempotent re-import,
// re-encrypted under THIS vault's key at the adapter boundary. 768-d/256-d vectors
// are decoded, re-encrypted with encryptVector, and written back so search +
// clustering work WITHOUT re-embedding 58k messages locally (V1 search rehydrates
// embedding_768 from the column — src/search/d1-loader.js:119).
import fs from 'node:fs';
import readline from 'node:readline';
import crypto from 'node:crypto';
import path from 'node:path';
import { restoreTable } from './vault-import.js';
import { putBlob } from './blob-store.js';
import { getMasterKey } from '../crypto/crypto-local.js';
import { encodeVectorRaw } from '../search/ann/decode.js';

const MAX_ATTACHMENT_BYTES = Number(process.env.MYCELIUM_IMPORT_ATTACHMENT_LIMIT_BYTES) || 100 * 1024 * 1024;
const MAX_AGENT_FILE_BYTES = 5 * 1024 * 1024;
const BATCH = 500;

// Operational / platform / shadow tables: NEVER import (cross-tenant data,
// session/credential material, or FTS shadow tables maintained by triggers).
const DENY = new Set([
  'audit_log', 'background_jobs', 'batch_jobs', 'import_jobs', 'sessions', 'oauth_states',
  'email_otp_challenges', 'registration_tokens', 'passkey_credentials', 'agent_tokens',
  'secrets', 'federation_keys', 'fleet_attest_keys', 'fleet_registry', 'fleet_health_reports',
  'step_up_tokens', 'stripe_events', 'subscriptions', 'crypto_payments', 'waitlist',
  'handle_reservations', 'deployment_log', 'provisioning_jobs', 'visitor_sessions',
  'telegram_widget_sessions', 'federation_log', 'deletion_records', 'deletion_ledger',
  'outbound_envelope_dedup', 'public_presence', 'topology_audit_findings', 'topology_audit_snapshots',
  'documents_fts', 'documents_fts_data', 'documents_fts_idx', 'documents_fts_docsize', 'documents_fts_config',
]);
// Reset enrichment products on imported messages; the 768-d pass flips
// nlp_processed→1 for any message whose vector we re-encrypt (search works now).
const MESSAGE_OVERRIDES = { nlp_processed: 0, nlp_processed_at: null, nlp_error: null, entities: null, relations: null, entity_summary: null };

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv']);
const AGENT_SKIP = /(^|\/)(node_modules|\.next|\.git|dist|build|\.cache|\.turbo|coverage)(\/|$)/;

/** Resolve the bundle root: the dir holding manifest.json (handles the common
 *  `mycelium-full-export-<date>/` wrapper subdir). */
function resolveRoot(dirPath) {
  if (fs.existsSync(path.join(dirPath, 'manifest.json'))) return dirPath;
  for (const name of fs.existsSync(dirPath) ? fs.readdirSync(dirPath) : []) {
    const sub = path.join(dirPath, name);
    try { if (fs.statSync(sub).isDirectory() && fs.existsSync(path.join(sub, 'manifest.json'))) return sub; } catch { /* */ }
  }
  return dirPath;
}

/** Stream an NDJSON file, invoking cb(parsedRow) per valid line. Bounded memory. */
async function forEachNdjson(file, cb) {
  if (!fs.existsSync(file)) return { rows: 0, malformed: 0 };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0, malformed = 0;
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    // A corrupt line is a DROPPED row — count it (FAIL-LOUD) so the
    // reconciliation report surfaces it instead of silently losing data.
    let row; try { row = JSON.parse(s); } catch { malformed++; continue; }
    await cb(row); n++;
  }
  return { rows: n, malformed };
}

/** Decode {vector_b64} / {vector_hex} → Float32Array (or null). */
function decodeVector(row) {
  const b = row.vector_b64 ? Buffer.from(row.vector_b64, 'base64')
    : (row.vector_hex ? Buffer.from(row.vector_hex, 'hex') : null);
  if (!b || b.length === 0 || b.length % 4 !== 0) return null;
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
}

/**
 * Import a decrypted mycelium-full-export directory into the open V1 vault.
 * @param {{ db, userId, dirPath, enqueueEnrichment? }} deps
 */
export async function importFullExport({ db, userId, dirPath, enqueueEnrichment = null }) {
  if (!db?.rawQuery) throw new Error('importFullExport: db.rawQuery required');
  if (!userId) throw new Error('importFullExport: userId required');
  const root = resolveRoot(dirPath);
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { const e = new Error('no manifest.json — not a mycelium-full-export bundle'); e.code = 'invalid_bundle'; throw e; }
  let manifest; try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { manifest = {}; }
  if (manifest.format !== 'mycelium-full-export') { const e = new Error(`unexpected bundle format: ${manifest.format}`); e.code = 'invalid_bundle'; throw e; }

  const masterKey = await getMasterKey();
  const stats = {};
  const dbDir = path.join(root, 'db');

  // A full-vault restore writes tables in readdir (alphabetical) order, so a
  // child lands before its parent (contact_territories before people,
  // document_versions before documents, identity_channels before users) — with
  // foreign_keys=ON every such row is rejected. The bundle is internally
  // consistent (parents ARE present), so defer FK enforcement for the restore
  // and re-enable it after. The `finally` is mandatory: the app's db connection
  // is long-lived and SHARED — leaving FKs off would weaken every later write.
  await db.rawQuery('PRAGMA foreign_keys = OFF').catch(() => {});
  try {

  // ── 1. Tables: every db/<table>.ndjson, allowlisted by the live V1 schema ──
  // restoreTable column-intersects + reports tableMissing for tables V1 lacks;
  // DENY blocks operational/cross-tenant/FTS tables outright.
  const tableFiles = fs.existsSync(dbDir) ? fs.readdirSync(dbDir).filter((f) => f.endsWith('.ndjson')) : [];
  for (const file of tableFiles) {
    const table = file.replace(/\.ndjson$/, '');
    if (DENY.has(table)) { stats[table] = { skipped: 'denied' }; continue; }
    // attachments are owned by the blob pass (§3): it INSERTs the row WITH
    // local_path. Importing it here first would win the INSERT and leave
    // local_path null (the blob-pass INSERT OR IGNORE would then dedupe).
    if (table === 'attachments') continue;
    const overrides = table === 'messages' ? MESSAGE_OVERRIDES : {};
    const agg = { attempted: 0, inserted: 0, deduped: 0, failed: 0, malformed: 0, tableMissing: false };
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const r = await restoreTable(db, table, batch, { userId, overrides });
      agg.attempted += r.attempted; agg.inserted += r.inserted; agg.deduped += r.deduped; agg.failed += r.failed;
      if (r.tableMissing) agg.tableMissing = true;
      batch = [];
    };
    try {
      const nd = await forEachNdjson(path.join(dbDir, file), async (row) => { batch.push(row); if (batch.length >= BATCH) await flush(); });
      await flush();
      agg.malformed = nd.malformed; // FAIL-LOUD: corrupt NDJSON lines, surfaced not swallowed
    } catch (e) { agg.error = String(e?.message || e).slice(0, 120); }
    stats[table] = agg;
    if (agg.tableMissing) { /* V1 has no such table — reported, not imported */ }
  }

  // ── 2. Embeddings → re-encrypted, written back (search/clustering work now) ──
  const embDir = path.join(root, 'embeddings');
  const vectorPass = async (file, table, col, dim, flipNlp) => {
    const f = path.join(embDir, file);
    if (!fs.existsSync(f)) return;
    let updated = 0, bad = 0;
    await forEachNdjson(f, async (row) => {
      const id = row.id; const vec = decodeVector(row);
      if (!id || !vec || vec.length !== dim) { bad++; return; }
      try {
        // Stage A: write the vector as RAW LE-f32 BLOB bytes (no envelope). These
        // columns are NEVER_AUTO_DECRYPT, so the adapter binds the Buffer verbatim.
        const raw = encodeVectorRaw(vec);
        const extra = flipNlp ? ', nlp_processed = 1' : '';
        const res = await db.rawQuery(`UPDATE ${table} SET ${col} = ?${extra} WHERE id = ? AND user_id = ?`, [raw, id, userId]);
        if ((res?.meta?.changes ?? 0) > 0) updated++;
      } catch { bad++; }
    });
    stats[`${table}.${col}`] = { updated, bad };
  };
  await vectorPass('clustering_points.256d.ndjson', 'clustering_points', 'nomic_embedding', 256, false);
  await vectorPass('messages.768d.ndjson', 'messages', 'embedding_768', 768, true);
  await vectorPass('documents.768d.ndjson', 'documents', 'embedding_768', 768, false);
  await vectorPass('territory_profiles.768d.ndjson', 'territory_profiles', 'embedding_768', 768, false);
  await vectorPass('realms.768d.ndjson', 'realms', 'embedding_768', 768, false);
  await vectorPass('semantic_themes.768d.ndjson', 'semantic_themes', 'embedding_768', 768, false);

  // ── 3. Attachments: row + decrypted bytes on disk → encrypted blob ──────────
  // Byte-identical files share ONE blob (sha256 in metadata) — same convention as
  // the vault-import + obsidian paths. Per-file, bounded memory.
  const attDir = path.join(root, 'attachments');
  const attStats = { inserted: 0, deduped: 0, failed: 0, blobs: 0, blobsReused: 0, blobMissing: 0 };
  const blobByHash = new Map();
  await forEachNdjson(path.join(dbDir, 'attachments.ndjson'), async (att) => {
    if (!att || typeof att !== 'object') { attStats.failed++; return; }
    try {
      let localPath = null, sha = null;
      const adir = att.id ? path.join(attDir, String(att.id)) : null;
      const fname = adir && fs.existsSync(adir) ? (fs.readdirSync(adir)[0] || null) : null;
      if (fname) {
        const abs = path.join(adir, fname);
        const sz = fs.statSync(abs).size;
        if (sz > 0 && sz <= MAX_ATTACHMENT_BYTES) {
          const buf = fs.readFileSync(abs);
          sha = crypto.createHash('sha256').update(buf).digest('hex');
          const reuse = blobByHash.get(sha);
          if (reuse) { localPath = reuse; attStats.blobsReused++; }
          else { const { path: stored } = await putBlob(buf, { userId, ext: path.extname(fname) }); localPath = stored; blobByHash.set(sha, stored); attStats.blobs++; }
        }
      }
      if (!localPath) attStats.blobMissing++;
      let meta = null; try { meta = typeof att.metadata === 'string' ? JSON.parse(att.metadata) : (att.metadata ?? null); } catch { meta = null; }
      const metadata = sha ? { ...(meta && typeof meta === 'object' ? meta : {}), sha256: sha } : att.metadata;
      const r = await restoreTable(db, 'attachments', [{ ...att, metadata, local_path: localPath, r2_key: null, stream_uid: null }], { userId });
      attStats.inserted += r.inserted; attStats.deduped += r.deduped; attStats.failed += r.failed;
    } catch { attStats.failed++; }
  });
  stats.attachments = { ...(stats.attachments || {}), ...attStats };

  // ── 4. Agent mind files → documents (filtered; build-junk excluded) ─────────
  const agentsDir = path.join(root, 'agents');
  const agentStats = { inserted: 0, deduped: 0, failed: 0, skippedBinary: 0, skippedJunk: 0 };
  const importAgentDocs = async (dir, rel = '') => {
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (AGENT_SKIP.test(`/${r}`)) { if (!ent.isDirectory()) agentStats.skippedJunk++; continue; }
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { await importAgentDocs(abs, r); continue; }
      if (!TEXT_EXT.has(path.extname(ent.name).toLowerCase())) { agentStats.skippedBinary++; continue; }
      try {
        const st = fs.statSync(abs);
        if (st.size === 0 || st.size > MAX_AGENT_FILE_BYTES) { agentStats.skippedBinary++; continue; }
        const content = fs.readFileSync(abs, 'utf8');
        const id = crypto.createHash('sha256').update(`full-export:agents:${r}`).digest('hex').slice(0, 32);
        // created_at from the file's mtime — WITHOUT this, restoreTable omits the
        // column and documents.created_at defaults to now(), stamping every agent
        // mind-file with the IMPORT date (the 2026-06-15 canonical import did this
        // to 754 docs). mtime is deterministic, so re-imports are stable.
        // PROPER FIX is exporter-side: the canonical `mycelium-vault-export` tool
        // should record each agent file's ORIGINAL mtime in the bundle (the
        // decrypted bundle's file mtimes are the export's own write times, not the
        // file's true authored date) so import can restore the authoritative value.
        const createdAt = new Date(st.mtimeMs).toISOString();
        const rr = await restoreTable(db, 'documents', [{ id, path: `agents/${r}`, title: path.basename(r), content, created_at: createdAt, created_by: 'full-export', embedding_768: null }], { userId });
        agentStats.inserted += rr.inserted; agentStats.deduped += rr.deduped; agentStats.failed += rr.failed;
      } catch { agentStats.failed++; }
    }
  };
  if (fs.existsSync(agentsDir)) await importAgentDocs(agentsDir);
  stats.agent_files = agentStats;

  // ── 5. Reconciliation report → encrypted in-vault document ──────────────────
  let imported = 0, deduped = 0, failed = 0, malformed = 0;
  for (const s of Object.values(stats)) { imported += s.inserted || 0; deduped += s.deduped || 0; failed += s.failed || 0; malformed += s.malformed || 0; }
  const report = {
    v: 1, kind: 'mycelium-full-export', importedAt: new Date().toISOString(),
    exportedAt: manifest.exportedAt ?? null, totals: { imported, deduped, failed, malformed },
    perTable: stats, skipped: Array.from(DENY),
  };
  try {
    const rid = crypto.createHash('sha256').update(`full-export-report:${manifest.exportedAt ?? 'x'}`).digest('hex').slice(0, 32);
    await db.rawQuery('INSERT OR REPLACE INTO documents (id, user_id, path, title, content, created_by, scope) VALUES (?,?,?,?,?,?,?)',
      [rid, userId, `imports/full-export-report-${String(manifest.exportedAt || report.importedAt).slice(0, 10)}.json`, 'Full export import report', JSON.stringify(report, null, 2), 'full-export', 'personal']);
  } catch { /* response still carries it */ }

  // Nudge the drainer: any message WITHOUT an imported 768-d vector is at
  // nlp_processed=0 and will re-embed locally; vectored ones are searchable now.
  try { if (typeof enqueueEnrichment === 'function') { const m = await db.rawQuery('SELECT id FROM messages WHERE nlp_processed = 0 AND user_id = ? LIMIT 1', [userId]); const id = m?.results?.[0]?.id; if (id) enqueueEnrichment(id); } } catch { /* */ }

    return { imported, deduped, failed, malformed, stats, reportPath: report && `imports/full-export-report-${String(manifest.exportedAt || report.importedAt).slice(0, 10)}.json`, exportedAt: manifest.exportedAt ?? null };
  } finally {
    await db.rawQuery('PRAGMA foreign_keys = ON').catch(() => {});
  }
}

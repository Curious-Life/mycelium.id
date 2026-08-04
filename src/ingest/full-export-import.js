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
import { putBlob, isUserNamespacedBlobPath } from './blob-store.js';
import { getMasterKey } from '../crypto/crypto-local.js';
import { encodeVectorRaw } from '../search/ann/decode.js';
import { POLICY_DENY_TABLES, isImportAllowed } from './import-credential-policy.js';
import { acquireImportQuiesce } from '../db/import-quiesce.js';

const MAX_ATTACHMENT_BYTES = Number(process.env.MYCELIUM_IMPORT_ATTACHMENT_LIMIT_BYTES) || 100 * 1024 * 1024;
const MAX_AGENT_FILE_BYTES = 5 * 1024 * 1024;
const BATCH = 500;

// Operational / platform / shadow tables: NEVER import (cross-tenant data,
// session/credential material, or FTS shadow tables maintained by triggers).
//
// ⚠️ THIS LIST IS NO LONGER THE SECURITY BOUNDARY — it is the EXPLICIT half of a
// deny-by-DEFAULT decision. The import gate below is:
//
//     import <table>  IFF  isImportAllowed(<table>)   (an explicit `allow` verdict
//                                                      in import-credential-policy.js)
//
// so a table that is in neither this literal nor the policy is refused anyway
// (`skipped:'not-classified'`), and `verify:import-credential-deny` RED-fails until
// someone classifies it. That inversion exists because the previous shape —
// a DENY list whose completeness was policed by a credential-shaped REGEX — was
// fail-closed only within the regex's reach: a table named
// `device_login_blobs(id, user_id, data)` matched nothing, was classified by
// nothing, and imported silently.
//
// The list rotted once already: `device_tokens` (migration 0052) was never added,
// so a bundle's `db/device_tokens.ndjson` landed an attacker-chosen token_hash as a
// LIVE owner-authority device token (restoreTable forces user_id to the importing
// owner; foreign_keys are OFF during the restore). The credential half is now
// composed from POLICY_DENY_TABLES — add tables to the POLICY, not to this
// literal, which is operational/platform only.
const DENY = new Set([
  ...POLICY_DENY_TABLES,
  'audit_log', 'background_jobs', 'batch_jobs', 'import_jobs', 'sessions', 'oauth_states',
  'email_otp_challenges', 'registration_tokens', 'passkey_credentials', 'agent_tokens',
  'secrets', 'federation_keys', 'fleet_attest_keys', 'fleet_registry', 'fleet_health_reports',
  'step_up_tokens', 'stripe_events', 'subscriptions', 'crypto_payments', 'waitlist',
  'handle_reservations', 'deployment_log', 'provisioning_jobs', 'visitor_sessions',
  'telegram_widget_sessions', 'federation_log', 'deletion_records', 'deletion_ledger',
  'outbound_envelope_dedup', 'public_presence', 'topology_audit_findings', 'topology_audit_snapshots',
  'documents_fts', 'documents_fts_data', 'documents_fts_idx', 'documents_fts_docsize', 'documents_fts_config',
  // The migration ledger is THIS vault's own provenance — never a bundle's. It is the
  // table whose entire purpose is that "a vault that cannot say what shaped it cannot be
  // trusted or diagnosed" (migration-ledger.js:11), so a bundle writing it forges the
  // audit trail: inserting a foreign filename makes inspectLineage report `foreign:` —
  // manufacturing the exact evidence of the incident the ledger exists to detect (and
  // refusing boot under MYCELIUM_STRICT_LINEAGE=1).
  // It is also load-bearing SECURITY now: migration 0050's one-shot legacy backfill keys
  // off this table, so a bundle inserting {filename:'0050_provider_status_backfill.sql'}
  // into a vault that hasn't run it yet permanently suppresses the backfill and leaves the
  // user's own legacy providers dead. (A bundle cannot ARM anything this way — restoreTable
  // only INSERT OR IGNOREs, so it can neither delete the 0050 row nor rewrite a sha.)
  'schema_migrations',
]);
// Exported for verify:provider-import: the DENY comparison assumes every entry is already
// normalized (the incoming name is trim+lowercased before matching), so a mis-cased entry
// here would silently never match. Asserted against the real Set — scraping the source with
// a regex is how that check was a tautology in the first place.
export { DENY as __denyForTest };
// Reset enrichment products on imported messages; the 768-d pass flips
// nlp_processed→1 for any message whose vector we re-encrypt (search works now).
// ⛔ `categories_processed: 0` IS PART OF THE STRIP (D-047 ↻1) — same reason as vault-import's
// override: without it a restore lands rows counted as TAGGED while their vector is either absent
// or not yet re-written by vectorPass below, i.e. `tagged > embedded` straight out of the import.
// The vector pass restores embeddings for the rows it has; every row is re-categorized after it.
const MESSAGE_OVERRIDES = {
  nlp_processed: 0, nlp_processed_at: null, nlp_error: null, entities: null, relations: null, entity_summary: null,
  categories_processed: 0, categorized_at: null, categories_model: null, domain: null, register: null, subregister: null,
};

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
  // Object.create(null), not {}: `stats` is keyed by BUNDLE-CONTROLLED table names, and
  // `db/__proto__.ndjson` passes the identifier shape check (lowercase + underscores). On a
  // plain object that assignment sets the prototype instead of a key, so the entry silently
  // VANISHES from the reconciliation report — this module's contract is that a dropped
  // table is reported, never swallowed. (No rows land either way; this is the fail-loud
  // guarantee, not a row-level hole.)
  const stats = Object.create(null);
  const dbDir = path.join(root, 'db');

  // D-128: STILL EVERY BACKGROUND WRITER FIRST. This restore is a mass raw write —
  // including the vector pass's tens of thousands of UPDATEs — on the app's long-lived
  // SHARED connection, with FK enforcement deferred below. On 2026-07-30 it ran while the
  // enrich drainer kept writing the same rows and a detached snapshot worker could VACUUM
  // the same file: SQLITE_CORRUPT mid-import, vault HALTED. The latch is held for the
  // whole restore and released in the same `finally` that restores FKs. Scope note: the
  // paced importers (local-files/obsidian, row-at-a-time through captureMessage) do NOT
  // hold this latch — they write through the normal capture path and pausing enrichment
  // for their whole multi-hour run is a product decision, not a corruption fix.
  const releaseQuiesce = acquireImportQuiesce('full-export-import');
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
    const rawName = file.replace(/\.ndjson$/, '');
    // ⚠️ NORMALIZE BEFORE MATCHING. The table name comes from a bundle-controlled FILENAME
    // and is interpolated into SQL by restoreTable — and SQLite resolves identifiers
    // CASE-INSENSITIVELY. A `DENY.has(rawName)` exact-string match was therefore no guard
    // at all: `db/Secrets.ndjson` → 'Secrets' ∉ DENY → `INSERT OR IGNORE INTO Secrets`
    // → lands in `secrets`, the ONE table still field-encrypted (crypto-local.js:441), so
    // the adapter sealed the planted value under the user's own USER_MASTER — a valid,
    // working secret, indistinguishable at rest. internal-router.js:277 reads
    // TELEGRAM_BOT_TOKEN straight out of it, so a bundle pointed the user's agent at an
    // attacker's bot: a CLAUDE.md §11 egress-chokepoint takeover through the shipped
    // import UI. Trailing whitespace ('secrets ') bypassed it the same way.
    const table = rawName.trim().toLowerCase();
    // Fail closed on anything that isn't a plain identifier, BEFORE it reaches SQL.
    // (better-sqlite3's prepare() rejects multi-statement SQL, so this is not the
    // injection stop — it is the "only ever a real table name" stop, which is what makes
    // the DENY comparison meaningful.)
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) { stats[rawName] = { skipped: 'invalid_table_name' }; continue; }
    if (DENY.has(table)) { stats[table] = { skipped: 'denied' }; continue; }
    // ⚠️ DENY-BY-DEFAULT — the actual boundary. A table is importable ONLY with an
    // explicit `allow` verdict in import-credential-policy.js. A table nobody has
    // classified (a new migration, a table the credential regex never matched) is
    // refused here rather than trusted, and reported (fail-loud) so the skip is
    // visible in the reconciliation report instead of looking like an empty table.
    // `verify:import-credential-deny` RED-fails on the same condition, so the
    // omission cannot ship quietly either.
    if (!isImportAllowed(table)) { stats[table] = { skipped: 'not-classified' }; continue; }
    // attachments are owned by the blob pass (§3): it INSERTs the row WITH
    // local_path. Importing it here first would win the INSERT and leave
    // local_path null (the blob-pass INSERT OR IGNORE would then dedupe).
    if (table === 'attachments') continue;
    const overrides = table === 'messages' ? MESSAGE_OVERRIDES : {};
    const agg = { attempted: 0, inserted: 0, deduped: 0, failed: 0, refused: 0, malformed: 0, tableMissing: false };
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const r = await restoreTable(db, table, batch, { userId, overrides });
      agg.attempted += r.attempted; agg.inserted += r.inserted; agg.deduped += r.deduped; agg.failed += r.failed;
      agg.refused += r.refused || 0; // security-refused rows stay visible in the report
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
  db.messages?.noteBacklogWrite?.(); // D-132: restoreTable('messages') is a dynamic-SQL writer the backlog-cache net cannot see
  await vectorPass('clustering_points.256d.ndjson', 'clustering_points', 'nomic_embedding', 256, false);
  await vectorPass('messages.768d.ndjson', 'messages', 'embedding_768', 768, true);
  db.messages?.noteBacklogWrite?.(); // D-132: the vector pass raw-updates messages (embedding_768 + nlp_processed)
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
      // Confine strictly under attDir: att.id comes from an UNTRUSTED export. Resolve it
      // and require the result to be a proper descendant of attDir — this rejects '..',
      // '.', absolute paths, and any traversal (basename alone does NOT: basename('..')
      // === '..'), so the read sink below can only ever land inside attDir (CodeQL
      // js/path-injection → arbitrary file read). Fail closed.
      const attRoot = path.resolve(attDir);
      const attId = att.id != null ? String(att.id) : '';
      const adir = attId ? path.resolve(attRoot, attId) : null;
      if (adir && !adir.startsWith(attRoot + path.sep)) { attStats.failed++; return; }
      const fname = adir && fs.existsSync(adir) ? (fs.readdirSync(adir)[0] || null) : null;
      if (fname) {
        const abs = path.join(adir, fname);
        // Belt-and-suspenders: guard the final sink path directly (adir is already
        // confined, and fname is a single readdir basename, so this can't fail — but
        // it makes the containment barrier local to the read sink for the analyzer).
        if (!abs.startsWith(attRoot + path.sep)) { attStats.failed++; return; }
        const sz = fs.statSync(abs).size;
        if (sz > 0 && sz <= MAX_ATTACHMENT_BYTES) {
          const buf = fs.readFileSync(abs);
          sha = crypto.createHash('sha256').update(buf).digest('hex');
          // Reuse a byte-identical blob only if its path is namespaced under THIS
          // user (multi-tenant floor; always true in single-user V1).
          const reuse = blobByHash.get(sha);
          if (reuse && isUserNamespacedBlobPath(reuse, userId)) { localPath = reuse; attStats.blobsReused++; }
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
    releaseQuiesce(); // D-128: writers may resume only once FKs are back on
  }
}

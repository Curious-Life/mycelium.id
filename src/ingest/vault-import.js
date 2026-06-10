// Canonical-Mycelium vault import — ingest the ZIP produced by the canonical
// production Mycelium's `POST /portal/export` (one plaintext `manifest.json`
// with ~47 table families inline + `attachments/{id}/{file}` binaries + an
// `agents/` tree) into this V1 vault, re-encrypting everything under the V1 key.
// Design: docs/VAULT-IMPORT-FROM-CANONICAL-DESIGN-2026-06-10.md.
//
// HOW DATA LANDS (the whole crypto story): every row goes through db.rawQuery —
// the SAME auto-encrypting adapter passthrough every namespace uses
// (src/db/index.js:62 → src/adapter/d1.js autoEncryptParams), so plaintext
// export values are encrypted at the query boundary with zero crypto code here.
// Attachment binaries go through putBlob (encrypted blob store). Nothing from
// the manifest is ever written to disk in plaintext (CLAUDE.md §1), and nothing
// from the archive ever chooses a filesystem path (no zip-slip surface — blob
// names are generated UUIDs; we only READ entries the manifest references).
//
// WHAT'S RESET: messages/documents arrive with their canonical enrichment
// products stripped (`nlp_processed=0`, embedding columns nulled) because the
// export carries NO search vectors (canonical Vectorize was never exported) —
// the local drainer re-embeds the whole backlog, then Generate evolves the
// (restored) mindscape natively.
//
// WHAT'S SKIPPED (reported, never silent): the `agents/` filesystem (V1 is a
// pure tool server — D5), passkeys + secrets (different auth; values excluded
// from the export anyway), ai_providers (credentials don't ride along — re-add
// keys in Settings), connections (federation identity is per-instance),
// internal_model_items (dead schema).
import { extname } from 'node:path';
import { putBlob } from './blob-store.js';
import { getMasterKey } from '../crypto/crypto-local.js';
import { encryptVector } from '../search/ann/decode.js';

const MAX_ROWS_PER_TABLE = Number(process.env.MYCELIUM_IMPORT_MAX_MESSAGES) || 1_000_000;
const MAX_ATTACHMENT_BYTES = Number(process.env.MYCELIUM_IMPORT_ATTACHMENT_LIMIT_BYTES) || 100 * 1024 * 1024;

const asArray = (v) => (Array.isArray(v) ? v : Array.isArray(v?.data) ? v.data : []);

/** SQL-safe by construction: table names come ONLY from this module's fixed
 *  spec below — never from the manifest. */
async function tableColumns(db, table) {
  try {
    const res = await db.rawQuery(`PRAGMA table_info(${table})`);
    return new Set((res?.results || []).map((r) => r.name));
  } catch { return new Set(); }
}

const normalizeValue = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return null; } }
  return v;
};

/**
 * Insert rows into one allowlisted table: column-intersected against the live
 * schema, user_id forced to the V1 user, INSERT OR IGNORE on preserved ids
 * (⇒ idempotent re-import). Fail-soft per row — one malformed row must not
 * abort a 50k-row import.
 */
async function restoreTable(db, table, rows, { userId, overrides = {} }) {
  const out = { inserted: 0, deduped: 0, failed: 0 };
  if (!Array.isArray(rows) || rows.length === 0) return out;
  const cols = await tableColumns(db, table);
  if (cols.size === 0) { out.failed = rows.length; out.tableMissing = true; return out; }

  let n = 0;
  for (const row of rows) {
    if (++n > MAX_ROWS_PER_TABLE) break;
    if (!row || typeof row !== 'object') { out.failed++; continue; }
    try {
      const r = { ...row, ...overrides };
      if (cols.has('user_id')) r.user_id = userId;
      const keys = Object.keys(r).filter((k) => cols.has(k) && r[k] !== undefined);
      if (keys.length === 0) { out.failed++; continue; }
      const res = await db.rawQuery(
        `INSERT OR IGNORE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
        keys.map((k) => normalizeValue(r[k])),
      );
      if ((res?.meta?.changes ?? 0) > 0) out.inserted++; else out.deduped++;
    } catch { out.failed++; }
  }
  return out;
}

/** Read one zip binary entry, double-capped (declared size + actual length). */
async function readBinaryEntry(zip, name) {
  const entry = zip.file(name);
  if (!entry || entry.dir) return null;
  const declared = entry?._data?.uncompressedSize;
  if (typeof declared === 'number' && declared > MAX_ATTACHMENT_BYTES) return null;
  try {
    const buf = await entry.async('nodebuffer');
    return buf.length > 0 && buf.length <= MAX_ATTACHMENT_BYTES ? buf : null;
  } catch { return null; }
}

/** Strip canonical enrichment products so the local pipeline regenerates them. */
const MESSAGE_OVERRIDES = {
  nlp_processed: 0, nlp_processed_at: null, nlp_error: null,
  embedding_768: null, entities: null, relations: null, entity_summary: null,
};

/**
 * Import a canonical `mycelium-vault-export` manifest (+ binaries) into the open
 * V1 vault. Returns the import screen's `{ imported, skipped, stats }` shape.
 *
 * @param {import('jszip')} zip      the loaded export archive
 * @param {object} manifest         parsed manifest.json (format already verified)
 * @param {{ db:object, userId:string, enqueueEnrichment?:(id:string)=>void }} deps
 */
export async function importMyceliumVault(zip, manifest, { db, userId, enqueueEnrichment = null }) {
  if (!db?.rawQuery) throw new Error('importMyceliumVault: db.rawQuery required');
  if (!userId) throw new Error('importMyceliumVault: userId required');
  const m = manifest || {};
  const stats = {};
  const run = async (table, rows, overrides) => { stats[table] = await restoreTable(db, table, asArray(rows), { userId, overrides }); };

  // Dependency-ordered (folders before documents, people before links, points
  // after hierarchy) — mirrors the reference import's order (reference:1012-1135).
  await run('folders', m.folders);
  await run('documents', m.documents, { embedding_768: null });
  await run('document_versions', m.documents_meta?.versions);
  await run('note_links', m.documents_meta?.noteLinks);
  await run('share_links', m.documents_meta?.shareLinks);
  await run('access_grants', m.documents_meta?.accessGrants);

  // Attachments: binary → encrypted blob → row (id preserved so messages link).
  const attRows = asArray(m.attachments);
  const attStats = { inserted: 0, deduped: 0, failed: 0, blobs: 0, blobMissing: 0 };
  for (const att of attRows) {
    if (!att || typeof att !== 'object') { attStats.failed++; continue; }
    try {
      let localPath = null;
      const buf = att.zipPath ? await readBinaryEntry(zip, att.zipPath) : null;
      if (buf) {
        const ext = att.file_name ? extname(att.file_name) : '';
        const { path } = await putBlob(buf, { userId, ext });
        localPath = path;
        attStats.blobs++;
      } else { attStats.blobMissing++; }
      const { zipPath: _zp, ...row } = att;
      const r = await restoreTable(db, 'attachments', [{ ...row, local_path: localPath, r2_key: null, stream_uid: null }], { userId });
      attStats.inserted += r.inserted; attStats.deduped += r.deduped; attStats.failed += r.failed;
    } catch { attStats.failed++; }
  }
  stats.attachments = attStats;

  // Messages — the core corpus. Ids + timestamps preserved; enrichment reset so
  // the drainer re-embeds locally (the export has no search vectors).
  await run('messages', m.messages, MESSAGE_OVERRIDES);

  await run('people', m.contacts);
  await run('contact_territories', m.contacts?.territoryLinks);

  await run('health_daily', m.health?.daily ?? m.health);
  await run('activity_sessions', m.activity?.sessions);
  await run('activity_daily', m.activity?.daily);

  await run('wealth_portfolios', m.wealth?.portfolios);
  await run('wealth_assets', m.wealth?.assets);
  await run('wealth_positions', m.wealth?.positions);
  await run('wealth_transactions', m.wealth?.transactions);
  await run('wealth_snapshots', m.wealth?.snapshots);
  await run('wealth_watchlist', m.wealth?.watchlist);
  await run('wealth_wallets', m.wealthExtra?.wallets);
  await run('wealth_portfolio_access', m.wealthExtra?.portfolioAccess);

  await run('canvas_workspaces', m.canvases?.workspaces);
  await run('canvas_nodes', m.canvases?.nodes);
  await run('canvas_edges', m.canvases?.edges);
  await run('canvas_collaborators', m.canvases?.collaborators);

  await run('agent_tasks', m.tasks?.agentTasks);
  await run('tasks', m.tasks?.personalTasks);
  await run('reflections', m.reflections);
  await run('cycle_metrics', m.cycleMetrics);
  await run('scheduled_events', m.scheduledEvents);
  await run('agent_events', m.agentEvents);

  await run('user_profiles', m.user?.profile ? [m.user.profile] : []);
  await run('user_identities', m.user?.identities);

  // Mindscape — restored, not regenerated: territory narratives/names/lineage
  // are user history that cannot be recreated identically. Nomic hex vectors are
  // folded into clustering_points and auto-encrypted on insert; the next
  // Generate run evolves this hierarchy from the re-embedded messages.
  await run('realms', m.mindscape?.realms);
  await run('semantic_themes', m.mindscape?.semanticThemes);
  await run('territory_profiles', m.mindscape?.territories);
  await run('theme_cards', m.mindscape?.themeCards);
  {
    // nomicEmbeddings.data is an OBJECT MAP { pointId: hex } (reference:827) —
    // hex() of whatever bytes canonical stored. Two honest cases:
    //   • raw float32 bytes (multiple of 4) → re-encrypt under the V1 key via
    //     encryptVector — nomic_embedding is CALLER-encrypted by design
    //     (NEVER_AUTO_DECRYPT_COLUMNS: the adapter never touches it);
    //   • a wrapped-DEK envelope (JSON, starts '{') → ciphertext under the
    //     CANONICAL key, undecryptable here → DROP the vector (reported), keep
    //     the point row; the next Generate re-derives vectors.
    const points = asArray(m.mindscape?.clusteringPoints);
    const rawNomic = m.mindscape?.nomicEmbeddings?.data ?? m.mindscape?.nomicEmbeddings;
    const nomicHex = new Map();
    if (rawNomic && typeof rawNomic === 'object' && !Array.isArray(rawNomic)) {
      for (const [id, hx] of Object.entries(rawNomic)) if (typeof hx === 'string') nomicHex.set(id, hx);
    } else {
      for (const e of asArray(rawNomic)) {
        const hx = e?.nomic_embedding ?? e?.hex ?? e?.embedding;
        if (e?.id && typeof hx === 'string') nomicHex.set(e.id, hx);
      }
    }
    let vectors = 0, foreignVectors = 0;
    const masterKey = nomicHex.size ? await getMasterKey() : null;
    const folded = [];
    for (const p of points) {
      if (!p) continue;
      const hx = nomicHex.get(p.id);
      if (!hx) { folded.push(p); continue; }
      let envelope = null;
      try {
        const buf = Buffer.from(hx, 'hex');
        if (buf.length > 0 && buf[0] === 0x7b /* '{' — already an envelope */) {
          foreignVectors++;
        } else if (buf.length > 0 && buf.length % 4 === 0) {
          const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
          envelope = await encryptVector(new Float32Array(ab), 'personal', masterKey);
          vectors++;
        }
      } catch { /* malformed hex → point without vector */ }
      folded.push(envelope ? { ...p, nomic_embedding: envelope } : p);
    }
    stats.clustering_points = await restoreTable(db, 'clustering_points', folded, { userId });
    stats.clustering_points.vectors = vectors;
    stats.clustering_points.foreignVectors = foreignVectors;
  }
  await run('cluster_events', m.mindscape?.clusterEvents);
  await run('territory_cofire', m.topology?.cofiring);
  await run('territory_neighbors', m.topology?.territoryNeighbors);
  await run('realm_neighbors', m.topology?.realmNeighbors);

  // v4 historical metrics (v3 bundles simply lack these keys → no-op).
  await run('cognitive_metrics_window', m.cognitiveMetrics?.window);
  await run('cognitive_metrics_trajectory', m.cognitiveMetrics?.trajectory);
  await run('cognitive_metrics_per_territory', m.cognitiveMetrics?.perTerritory);
  await run('topology_metrics', m.cognitiveMetrics?.topology);

  // One nudge wakes the drainer; it scans the whole nlp_processed=0 backlog.
  const firstMsg = asArray(m.messages)[0];
  if (firstMsg?.id && typeof enqueueEnrichment === 'function') {
    try { enqueueEnrichment(firstMsg.id); } catch { /* non-fatal */ }
  }

  let imported = 0, skipped = 0, failed = 0;
  for (const s of Object.values(stats)) { imported += s.inserted || 0; skipped += s.deduped || 0; failed += s.failed || 0; }
  return {
    imported, skipped, failed,
    stats,
    skippedFamilies: ['agents filesystem', 'ai_providers (re-add keys in Settings)', 'connections', 'passkeys', 'secrets', 'internal_model_items'],
    exportVersion: m.version ?? null,
    exportedAt: m.exportedAt ?? null,
  };
}

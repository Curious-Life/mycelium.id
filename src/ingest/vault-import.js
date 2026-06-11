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
// WHAT'S SKIPPED (reported, never silent): passkeys (WebAuthn credentials are
// origin-bound — meaningless on a new substrate) and secrets (the exporter
// excludes the values; key-only stubs would shadow real secret reads).
// Everything else crosses: user identity meta (display name / timezone /
// settings → the V1 users row), internal_model_items (the agent's model of the
// user), connections (canonical-uid remapped to the V1 user), ai_providers
// (the canonical export decrypts, so credentials may ride along — re-encrypted
// here by the adapter), and the `agents/` filesystem's text files (mind files,
// memory, prompts — V1 has no agent runtime FS, so they land as documents under
// `agents/...`, deterministic ids ⇒ idempotent).
import { extname, basename } from 'node:path';
import crypto from 'node:crypto';
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
  // `attempted`/`capped` feed the reconciliation report: declared − attempted
  // must be zero, or the report names exactly what was never even tried.
  const out = { attempted: 0, inserted: 0, deduped: 0, failed: 0, capped: 0 };
  if (!Array.isArray(rows) || rows.length === 0) return out;
  const cols = await tableColumns(db, table);
  if (cols.size === 0) { out.failed = rows.length; out.attempted = rows.length; out.tableMissing = true; return out; }

  let n = 0;
  for (const row of rows) {
    if (++n > MAX_ROWS_PER_TABLE) { out.capped++; continue; }
    out.attempted++;
    if (!row || typeof row !== 'object') { out.failed++; continue; }
    try {
      const r = { ...row, ...overrides };
      if (cols.has('user_id')) r.user_id = userId;
      // Row↔envelope scope consistency: the adapter seals every imported value
      // under its fixed 'personal' scope, so the plaintext scope COLUMN must
      // say the same — a canonical 'org' label over a 'personal' envelope would
      // trip scope-filtered readers (SQL-level AGENT_SCOPES filtering and the
      // decrypt-time scope guardian both key off it).
      if (cols.has('scope')) r.scope = 'personal';
      // embedding_768 is NEVER_AUTO_DECRYPT: the canonical exporter's SELECT *
      // ships it as a CANONICAL-KEY envelope (territory_profiles, realms,
      // semantic_themes…), undecryptable here. Null it everywhere — V1 re-embeds.
      if (cols.has('embedding_768')) r.embedding_768 = null;
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

/**
 * Inflate one zip entry to a Buffer with TWO independent caps so a decompression
 * bomb can never exhaust memory (M-ZIPBOMB, mirrors import-parsers.js):
 *   1) fast reject on the DECLARED uncompressed size before inflating; and
 *   2) a STREAMING byte counter that aborts inflation the instant the output
 *      passes maxBytes — bounds memory even if the header lies low or a future
 *      jszip drops the internal size field. Returns null if absent/empty/oversized.
 */
export function streamEntryCapped(entry, maxBytes) {
  if (!entry || entry.dir) return Promise.resolve(null);
  const declared = entry?._data?.uncompressedSize;
  if (typeof declared === 'number' && declared > maxBytes) return Promise.resolve(null);
  return new Promise((resolve) => {
    let total = 0;
    const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let stream;
    try { stream = entry.nodeStream('nodebuffer'); } catch { return finish(null); }
    stream.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) { try { stream.destroy(); } catch { /* noop */ } return finish(null); }
      chunks.push(chunk);
    });
    stream.on('end', () => finish(total === 0 ? null : Buffer.concat(chunks)));
    stream.on('error', () => finish(null));
    stream.on('close', () => finish(null)); // aborted/destroyed without 'end'
  });
}

/** Read one zip binary entry, streaming-capped at MAX_ATTACHMENT_BYTES. */
async function readBinaryEntry(zip, name) {
  return streamEntryCapped(zip.file(name), MAX_ATTACHMENT_BYTES);
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
  // Per-FILE accountability: every id that lost its binary or failed its row is
  // NAMED in the report (ids only — zero-leakage), never folded into a count.
  const attRows = asArray(m.attachments);
  const attStats = { attempted: attRows.length, inserted: 0, deduped: 0, failed: 0, blobs: 0, blobMissing: 0, blobMissingIds: [], failedIds: [] };
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
      } else { attStats.blobMissing++; if (att.id) attStats.blobMissingIds.push(att.id); }
      const { zipPath: _zp, ...row } = att;
      const r = await restoreTable(db, 'attachments', [{ ...row, local_path: localPath, r2_key: null, stream_uid: null }], { userId });
      attStats.inserted += r.inserted; attStats.deduped += r.deduped;
      if (r.failed) { attStats.failed += r.failed; if (att.id) attStats.failedIds.push(att.id); }
    } catch { attStats.failed++; if (att?.id) attStats.failedIds.push(att.id); }
  }
  stats.attachments = attStats;

  // Messages — the core corpus. Ids + timestamps preserved; enrichment reset so
  // the drainer re-embeds locally (the export has no search vectors).
  //
  // CROSS-IMPORT CONTENT DEDUP: a message that already exists under a DIFFERENT
  // id (e.g. the same conversation previously imported via the Claude/ChatGPT
  // path) must not duplicate. Key = plaintext SHA-256 of content (the exact
  // captureMessage/0007 hash, kept in the plaintext content_hash column)
  // + normalized created_at — content alone is too aggressive (repeated short
  // messages like "ok" are legitimate); content AT the same instant is the same
  // original message. Rows without content or timestamp fall back to id-dedup.
  {
    const incoming = asArray(m.messages);
    const normTs = (t) => { const d = t ? new Date(t) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };
    const seen = new Set();
    try {
      const existing = await db.rawQuery('SELECT content_hash, created_at FROM messages WHERE content_hash IS NOT NULL', []);
      for (const row of existing?.results || []) {
        const ts = normTs(row.created_at);
        if (row.content_hash && ts) seen.add(`${row.content_hash}:${ts}`);
      }
    } catch { /* no preload → id-dedup still holds */ }
    let dedupedByContent = 0;
    const rows = [];
    for (const msg of incoming) {
      if (!msg || typeof msg !== 'object') { rows.push(msg); continue; }
      const hash = (typeof msg.content === 'string' && msg.content)
        ? crypto.createHash('sha256').update(msg.content, 'utf8').digest('hex') : null;
      const ts = normTs(msg.created_at);
      const key = hash && ts ? `${hash}:${ts}` : null;
      if (key && seen.has(key)) { dedupedByContent++; continue; }
      if (key) seen.add(key); // also dedupes duplicates WITHIN the export itself
      rows.push(hash ? { ...msg, content_hash: hash } : msg);
    }
    stats.messages = await restoreTable(db, 'messages', rows, { userId, overrides: MESSAGE_OVERRIDES });
    stats.messages.dedupedByContent = dedupedByContent;
  }

  await run('people', m.contacts);
  await run('contact_territories', m.contacts?.territoryLinks);

  // health arrives in the namespace's getRange shape (parsed rows, numbers,
  // possibly no id) — synthesize the documented deterministic key when absent.
  {
    const healthRows = asArray(m.health?.daily ?? m.health).map((h) =>
      (h && typeof h === 'object' && !h.id && h.date) ? { ...h, id: `${userId}:${h.date}` } : h);
    stats.health_daily = await restoreTable(db, 'health_daily', healthRows, { userId });
  }
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

  // The agent's internal model of the user — "model internals" are continuity-
  // critical even though new writes go to persona-claims; preserve the history.
  await run('internal_model_items', m.internalModel);

  // AI providers: the canonical export reads through its decrypting proxy, so
  // credentials MAY ride along as plaintext — the adapter re-encrypts them here
  // (ENCRYPTED_FIELDS.ai_providers). Absent credentials just mean re-keying.
  await run('ai_providers', m.aiProviders);

  // Connections: V1 carries the same user_a/user_b schema. Remap the canonical
  // user id to the V1 user on every side it appears; the counterpart stays as
  // recorded (it's another instance's identity — historical, not actionable).
  {
    const canonicalUid = m.user?.id;
    const remap = (v) => (canonicalUid && v === canonicalUid ? userId : v);
    const conns = asArray(m.connections).map((c) => (c && typeof c === 'object'
      ? { ...c, user_a: remap(c.user_a), user_b: remap(c.user_b), initiated_by: remap(c.initiated_by) }
      : c));
    stats.connections = await restoreTable(db, 'connections', conns, { userId });
  }

  await run('user_profiles', m.user?.profile ? [m.user.profile] : []);
  await run('user_identities', m.user?.identities);

  // User identity meta → the V1 users row (UPDATE, never a second row keyed by
  // the canonical id): display name, timezone, settings carry the person over.
  {
    const u = m.user || {};
    const sets = [];
    const params = [];
    if (typeof u.displayName === 'string' && u.displayName) { sets.push('display_name = ?'); params.push(u.displayName); }
    if (typeof u.timezone === 'string' && u.timezone) { sets.push('timezone = ?'); params.push(u.timezone); }
    if (u.settings && typeof u.settings === 'object' && Object.keys(u.settings).length) { sets.push('settings = ?'); params.push(JSON.stringify(u.settings)); }
    let updated = 0;
    if (sets.length) {
      try {
        await db.rawQuery('INSERT OR IGNORE INTO users (id) VALUES (?)', [userId]);
        const res = await db.rawQuery(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, userId]);
        updated = res?.meta?.changes ?? 0;
      } catch { /* fail-soft like every family */ }
    }
    // `updated`, not `inserted`: an UPDATE re-applies on every run (SQLite
    // counts matched rows), so it must not break re-import ⇒ imported:0.
    stats.user_meta = { inserted: 0, deduped: 0, failed: 0, updated };
  }

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

  // Temporal Chronicles — period narratives + the current arc. The canonical
  // exporter does not ship these yet (exporter-side gap, flagged 2026-06-10);
  // the receiver is ready for the manifest keys the exporter patch adds, and
  // tolerates singular/plural. Absent keys → no-op, like every family.
  await run('time_chronicles', m.timeChronicles);
  await run('current_arc_chronicles', m.currentArcChronicles ?? (m.currentArcChronicle ? [m.currentArcChronicle].flat() : undefined));

  // v4 historical metrics (v3 bundles simply lack these keys → no-op).
  await run('cognitive_metrics_window', m.cognitiveMetrics?.window);
  await run('cognitive_metrics_trajectory', m.cognitiveMetrics?.trajectory);
  await run('cognitive_metrics_per_territory', m.cognitiveMetrics?.perTerritory);
  await run('topology_metrics', m.cognitiveMetrics?.topology);

  // The agents/ filesystem — mind files, memory, prompts, .shared/ notes. V1 is
  // a pure tool server (no agent runtime FS), so the TEXT files land as
  // documents under their original `agents/...` path. Deterministic ids
  // (sha256 of the path) make re-imports no-ops; binaries and oversized files
  // are counted, never silently dropped.
  {
    const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv']);
    const MAX_AGENT_FILE_BYTES = 5 * 1024 * 1024;
    const agentStats = { attempted: 0, inserted: 0, deduped: 0, failed: 0, skippedBinary: 0, skippedOversize: 0 };
    const entries = Object.values(zip.files).filter((f) => !f.dir && f.name.startsWith('agents/'));
    for (const entry of entries) {
      const ext = extname(entry.name).toLowerCase();
      if (!TEXT_EXT.has(ext)) { agentStats.skippedBinary++; continue; }
      try {
        // Streaming-capped inflate (M-ZIPBOMB): aborts past MAX_AGENT_FILE_BYTES
        // before buffering the whole entry. null = absent/empty/oversized.
        const buf = await streamEntryCapped(entry, MAX_AGENT_FILE_BYTES);
        if (!buf) { agentStats.skippedOversize++; continue; }
        agentStats.attempted++;
        const id = crypto.createHash('sha256').update(`vault-import:agents:${entry.name}`).digest('hex').slice(0, 32);
        const r = await restoreTable(db, 'documents', [{
          id,
          path: entry.name,
          title: basename(entry.name),
          content: buf.toString('utf8'),
          created_by: 'vault-import',
          embedding_768: null,
        }], { userId });
        agentStats.inserted += r.inserted; agentStats.deduped += r.deduped; agentStats.failed += r.failed;
      } catch { agentStats.failed++; }
    }
    stats.agent_files = agentStats;
  }

  // One nudge wakes the drainer; it scans the whole nlp_processed=0 backlog.
  const firstMsg = asArray(m.messages)[0];
  if (firstMsg?.id && typeof enqueueEnrichment === 'function') {
    try { enqueueEnrichment(firstMsg.id); } catch { /* non-fatal */ }
  }

  let imported = 0, skipped = 0, failed = 0;
  for (const s of Object.values(stats)) {
    imported += s.inserted || 0;
    skipped += (s.deduped || 0) + (s.dedupedByContent || 0);
    failed += s.failed || 0;
  }

  // ── Reconciliation: account for EVERY data point the export declared ───────
  // Three independent accountability layers, so loss can never be silent:
  //   1. per-family: declared (the exporter's own totals where present, else
  //      the array length we consumed) vs landed (inserted+deduped) vs failed —
  //      `missing` > 0 means rows we never even attempted (cap hit etc.);
  //   2. manifest coverage: any TOP-LEVEL key this importer does not know is
  //      named in `unhandledFamilies` — a future exporter addition is flagged
  //      loudly, never silently dropped;
  //   3. per-file: attachment ids that lost a binary or failed a row are listed
  //      by id (zero-leakage) in stats.attachments.
  const KNOWN_KEYS = new Set([
    'exportedAt', 'version', 'format', 'meta', 'user', 'messages', 'documents',
    'folders', 'attachments', 'mindscape', 'contacts', 'health', 'activity',
    'wealth', 'wealthExtra', 'canvases', 'tasks', 'internalModel',
    'documents_meta', 'connections', 'reflections', 'aiProviders',
    'scheduledEvents', 'secrets', 'agentEvents', 'cycleMetrics',
    'cognitiveMetrics', 'topology', 'timeChronicles', 'currentArcChronicle',
    'currentArcChronicles',
  ]);
  const unhandledFamilies = Object.keys(m).filter((k) => !KNOWN_KEYS.has(k));

  const declaredOf = {
    messages: m.messages?.total,
    documents: m.documents?.total,
    attachments: m.attachments?.total,
    people: m.contacts?.total,
    clustering_points: m.mindscape?.clusteringPoints?.total,
    agent_events: m.agentEvents?.total,
  };
  const reconciliation = {};
  let missingTotal = 0, cappedTotal = 0, tableMissingCount = 0;
  for (const [table, s] of Object.entries(stats)) {
    const handled = (s.attempted ?? 0) + (s.capped ?? 0) + (s.dedupedByContent ?? 0);
    const declared = Number.isFinite(declaredOf[table]) ? declaredOf[table] : handled;
    const landed = (s.inserted || 0) + (s.deduped || 0) + (s.dedupedByContent || 0) + (s.updated || 0);
    const missing = Math.max(0, declared - landed - (s.failed || 0));
    reconciliation[table] = {
      declared, landed, failed: s.failed || 0, missing,
      ...(s.capped ? { capped: s.capped } : {}),
      ...(s.tableMissing ? { tableMissing: true } : {}),
      ...(s.dedupedByContent ? { dedupedByContent: s.dedupedByContent } : {}),
    };
    missingTotal += missing; cappedTotal += s.capped || 0;
    if (s.tableMissing) tableMissingCount++;
  }
  // Export-side losses (canonical couldn't fetch these from R2 — they were
  // never IN the zip; distinct from receiver-side loss but still reported).
  const exportSide = { attachmentsFetchFailedAtExport: Number(m.attachments?.failed) || 0 };
  const complete = failed === 0 && missingTotal === 0 && cappedTotal === 0
    && tableMissingCount === 0 && unhandledFamilies.length === 0;

  // Persist the report INSIDE the vault (encrypted document, deterministic id
  // keyed by the export's timestamp → a re-import refreshes it in place). The
  // response is transient; this is the durable migration-audit artifact.
  const report = {
    v: 1,
    importedAt: new Date().toISOString(),
    exportedAt: m.exportedAt ?? null,
    exportVersion: m.version ?? null,
    complete,
    unhandledFamilies,
    reconciliation,
    exportSide,
    attachmentsDetail: { blobMissingIds: stats.attachments?.blobMissingIds || [], failedIds: stats.attachments?.failedIds || [] },
    agentFiles: stats.agent_files || null,
    skippedFamilies: [
      'passkeys (WebAuthn is origin-bound — re-enroll on this device)',
      'secrets (values excluded by the exporter — re-add in Settings)',
    ],
  };
  const reportPath = `imports/vault-import-report-${String(m.exportedAt || report.importedAt).slice(0, 10)}.json`;
  try {
    const reportId = crypto.createHash('sha256').update(`vault-import-report:${m.exportedAt ?? 'unknown'}`).digest('hex').slice(0, 32);
    await db.rawQuery(
      'INSERT OR REPLACE INTO documents (id, user_id, path, title, content, created_by, scope) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [reportId, userId, reportPath, 'Vault import report', JSON.stringify(report, null, 2), 'vault-import', 'personal'],
    );
  } catch { /* the response still carries the report */ }

  return {
    imported, skipped, failed,
    complete,
    stats,
    reconciliation,
    unhandledFamilies,
    exportSide,
    reportPath,
    skippedFamilies: report.skippedFamilies,
    exportVersion: m.version ?? null,
    exportedAt: m.exportedAt ?? null,
  };
}

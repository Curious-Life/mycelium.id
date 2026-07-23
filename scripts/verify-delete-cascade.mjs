// verify:delete-cascade — THE delete contract (docs/DELETE-CASCADE-CONTRACT.md).
//
// The gate that existed before this one (verify:bulk-delete) had ZERO references to
// territory / realm / theme / seen_points / note_links / document_versions — the
// entire derived graph the delete paths were leaving behind. Any regression of the
// cascade was invisible to it. Every assertion here is MUTATION-PROVEN: removing
// the purge it guards turns it red (see the ledger in the PR).
//
//   C1  every id-addressable derivation is purged on a bulk delete
//       (clustering_points · note_links · entity_links · territory_seen_points ·
//        time_seen_points · document_versions · conversation_summaries)
//   C2  a SURVIVING row's derivations are untouched (the purge is scoped, not a wipe)
//   C3  TENANT ISOLATION: a second user's derivations are untouched
//   C4  LIVENESS PRUNE: a territory/theme/realm that lost its LAST live point is
//       gone (territory_profiles, seen_points, neighbors, lineage, vitality,
//       cofire, contact_territories, entity_snapshots, theme_cards, semantic_themes,
//       realms, realm_neighbors, cognitive_metrics_per_territory) …
//   C5  … while a territory that still HOLDS a live point SURVIVES (the ghost fix
//       must not become a mindscape shredder)
//   C6  content-QUOTING rows die: a theme_card whose sample_message_ids names a
//       deleted message; a person_claim that lost ALL its evidence (and a claim
//       that kept some evidence is REWRITTEN, not dropped)
//   C7  PRIVACY — forget(message): after redact() the content is NOT retrievable
//       from the search sidecar (fts + vec + doc_meta)
//   C8  PRIVACY — forget(document): same, via the `document:<id>` key
//   C9  PER-DOCUMENT delete reaches PARITY with bulk: point, sidecar entry,
//       note_links and document_versions all gone (it used to delete ONE row and
//       fire a permanently-empty hook array)
//   C10 documents.redact purges document_versions (content lived on in `diff`)
//   C11 FAIL-CLOSED: a cascade failure THROWS — the caller cannot report success
//   C12 REVERSE WRITER-GUARD: Generate is refused while a delete holds the lane
//   C13 TOKEN RESURRECTION: a deleted document's path-keyed share_link +
//       context_document are purged (bulk + per-doc), a survivor's are kept, and a
//       second user's share_link is untouched (share_links carry user_id)
//   C14 forget(message) purges the attachment (transcript + description) AND
//       unlinks the solely-referenced blob — forget's "content destroyed" promise
//   C15 a blob still referenced by a SURVIVING attachment row is KEPT (refcount)
//
// Boots a temp vault; no network; never logs content.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { putBlob } from '../src/ingest/blob-store.js';
import { uploadsRoot } from '../src/paths.js';
import { applyMigrations } from '../src/db/migrate.js';
import { bulkDelete } from '../src/core/bulk-delete.js';
import { purgeDerived } from '../src/core/delete-cascade.js';
import { beginDelete, _resetDeleteLane, isDeleteRunning } from '../src/core/delete-lane.js';
import { startClusteringJob } from '../src/jobs.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const DB = 'data/verify-delete-cascade.db', KCV = 'data/verify-delete-cascade-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close, searchHelpers } = await boot({
  dbPath: DB, kcvPath: KCV,
  userHex: crypto.randomBytes(32).toString('hex'),
  systemHex: crypto.randomBytes(32).toString('hex'),
  embedder: null,
});

const U = 'user-a', U2 = 'user-b';
const q = (sql, p = []) => db.rawQuery(sql, p);
const cnt = async (sql, p = []) => Number((await q(sql, p)).results?.[0]?.c ?? 0);

const insMsg = (id, user, source, type = 'note', content = 'x') =>
  q(`INSERT INTO messages (id, user_id, source, message_type, content, created_at) VALUES (?,?,?,?,?,?)`,
    [id, user, source, type, content, '2026-01-01T00:00:00.000Z']);
const insDoc = (id, user, sourceType, path, content = 'c') =>
  q(`INSERT INTO documents (id, user_id, source_type, path, title, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    [id, user, sourceType, path, 't', content, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
const insCp = (user, srcType, srcId, terr = null, theme = null, realm = null) =>
  q(`INSERT INTO clustering_points (user_id, source_type, source_id, territory_id, theme_id, realm_id) VALUES (?,?,?,?,?,?)`,
    [user, srcType, srcId, terr, theme, realm]);

// ── Seed ────────────────────────────────────────────────────────────────────────
// import-obsidian (deletable) fully occupies territory 100 / theme 100 / realm 100.
// import-hermes (survivor) occupies territory 200 / theme 200 / realm 200.
// Territory 300 is SHARED: one obsidian point + one hermes point → must SURVIVE.
await insMsg('m-obs-1', U, 'import-obsidian');
await insMsg('m-obs-2', U, 'import-obsidian');
await insMsg('m-obs-3', U, 'import-obsidian');       // the shared-territory member
await insDoc('d-obs-1', U, 'import_obsidian', 'import/obsidian/note');
await insMsg('m-herm-1', U, 'import-hermes', 'chat');
await insMsg('m-herm-2', U, 'import-hermes', 'chat'); // the other shared-territory member

await insCp(U, 'message', 'm-obs-1', 100, 100, 100);
await insCp(U, 'message', 'm-obs-2', 100, 100, 100);
await insCp(U, 'message', 'm-obs-3', 300, 300, 300);
await insCp(U, 'document', 'd-obs-1', 100, 100, 100);
await insCp(U, 'message', 'm-herm-1', 200, 200, 200);
await insCp(U, 'message', 'm-herm-2', 300, 300, 300);

// Second user: same ids' shape, must be untouched.
await insMsg('m-obs-u2', U2, 'import-obsidian');
await insCp(U2, 'message', 'm-obs-u2', 100, 100, 100);
await q(`INSERT INTO territory_profiles (user_id, territory_id, name, essence) VALUES (?,?,?,?)`, [U2, 100, 'u2 terr', 'u2 essence']);
await q(`INSERT INTO note_links (user_id, source_type, source_id, target_type, target_id) VALUES (?,?,?,?,?)`, [U2, 'message', 'm-obs-u2', 'message', 'm-obs-u2']);
await q(`INSERT INTO territory_seen_points (user_id, territory_id, source_id, pass_number) VALUES (?,?,?,?)`, [U2, 100, 'm-obs-u2', 1]);

// Derived graph for user A.
for (const [t, name] of [[100, 'doomed'], [200, 'survivor'], [300, 'shared']]) {
  await q(`INSERT INTO territory_profiles (user_id, territory_id, name, essence) VALUES (?,?,?,?)`, [U, t, name, `${name} essence`]);
  await q(`INSERT INTO territory_vitality (user_id, territory_id, entropy_diversification, connection_growth_rate, reach, cofire_partner_diversity, vitality, phase) VALUES (?,?,0,0,0,0,0,'x')`, [U, t]);
  await q(`INSERT INTO territory_pass_notes (user_id, territory_id, pass_number, points_seen, total_at_pass, cumulative_seen, cumulative_percent, notes) VALUES (?,?,1,1,1,1,1,'n')`, [U, t]);
  await q(`INSERT INTO cognitive_metrics_per_territory (user_id, territory_id, window_end, era_id) VALUES (?,?,'2026-01-01','e1')`, [U, t]);
  await q(`INSERT INTO entity_snapshots (user_id, entity_kind, entity_id, snapshot_kind, seq, payload) VALUES (?,'territory',?,'narrative',1,'{}')`, [U, t]);
  await q(`INSERT INTO semantic_themes (user_id, realm_id, semantic_theme_id, name, essence) VALUES (?,?,?,?,?)`, [U, t, t, name, `${name} theme`]);
  await q(`INSERT INTO realms (user_id, realm_id, name, essence) VALUES (?,?,?,?)`, [U, t, name, `${name} realm`]);
}
await q(`INSERT INTO territory_neighbors (user_id, territory_id, neighbor_id) VALUES (?,?,?)`, [U, 100, 200]);
await q(`INSERT INTO territory_lineage (user_id, old_territory_id, new_territory_id, message_count, transfer_strength) VALUES (?,?,?,1,1.0)`, [U, 100, 200]);
await q(`INSERT INTO territory_cofire (user_id, territory_a, territory_b) VALUES (?,?,?)`, [U, 100, 200]);
await q(`INSERT INTO realm_neighbors (user_id, realm_id, neighbor_id) VALUES (?,?,?)`, [U, 100, 200]);
await q(`INSERT INTO people (id, user_id, name) VALUES ('p1', ?, 'p')`, [U]);
await q(`INSERT INTO contact_territories (user_id, contact_id, territory_id) VALUES (?, 'p1', ?)`, [U, 100]);

// Per-id derivations for user A.
await q(`INSERT INTO note_links (user_id, source_type, source_id, target_type, target_id) VALUES (?,?,?,?,?)`, [U, 'message', 'm-obs-1', 'document', 'd-obs-1']);
await q(`INSERT INTO note_links (user_id, source_type, source_id, target_type, target_id) VALUES (?,?,?,?,?)`, [U, 'message', 'm-herm-1', 'message', 'm-obs-2']); // TARGET side
await q(`INSERT INTO note_links (user_id, source_type, source_id, target_type, target_id) VALUES (?,?,?,?,?)`, [U, 'message', 'm-herm-1', 'message', 'm-herm-2']); // survivor
await db.entities.upsert({ userId: U, type: 'person', name: 'Ada' });
const entRow = (await q(`SELECT id FROM entities WHERE user_id = ? LIMIT 1`, [U])).results[0];
await q(`INSERT INTO entity_links (user_id, entity_id, ref_type, ref_id) VALUES (?,?,?,?)`, [U, entRow.id, 'message', 'm-obs-1']);
await q(`INSERT INTO entity_links (user_id, entity_id, ref_type, ref_id) VALUES (?,?,?,?)`, [U, entRow.id, 'message', 'm-herm-1']);
await q(`INSERT INTO territory_seen_points (user_id, territory_id, source_id, pass_number) VALUES (?,?,?,1)`, [U, 100, 'm-obs-1']);
await q(`INSERT INTO territory_seen_points (user_id, territory_id, source_id, pass_number) VALUES (?,?,?,1)`, [U, 200, 'm-herm-1']);
await q(`INSERT INTO time_seen_points (user_id, granularity, period_key, source_id) VALUES (?,'week','2026-W01',?)`, [U, 'm-obs-1']);
await q(`INSERT INTO time_seen_points (user_id, granularity, period_key, source_id) VALUES (?,'week','2026-W01',?)`, [U, 'm-herm-1']);
await q(`INSERT INTO conversation_summaries (id, user_id, conversation_id, summary, through_message_id) VALUES ('cs1',?,'c1','a synthesis',?)`, [U, 'm-obs-1']);
await q(`INSERT INTO conversation_summaries (id, user_id, conversation_id, summary, through_message_id) VALUES ('cs2',?,'c2','keep me',?)`, [U, 'm-herm-1']);
await q(`INSERT INTO document_versions (id, document_id, diff) VALUES ('dv1', 'd-obs-1', 'PRIOR SECRET CONTENT')`);

// share_links + context_documents (path-keyed bearer capability + Context-Area link).
// The deleted obsidian doc's must be purged; a survivor path's must be kept; user B's
// share_link at the SAME path must be untouched (share_links carry user_id).
await q(`INSERT INTO share_links (token, user_id, document_path, expires_at, view_count) VALUES ('sl-obs',?,?,?,0)`, [U, 'import/obsidian/note', '2027-01-01T00:00:00.000Z']);
await q(`INSERT INTO share_links (token, user_id, document_path, expires_at, view_count) VALUES ('sl-keep',?,?,?,0)`, [U, 'keep/surviving/doc', '2027-01-01T00:00:00.000Z']);
await q(`INSERT INTO share_links (token, user_id, document_path, expires_at, view_count) VALUES ('sl-u2',?,?,?,0)`, [U2, 'import/obsidian/note', '2027-01-01T00:00:00.000Z']);
await q(`INSERT INTO context_documents (context_id, document_path) VALUES ('ctx1', 'import/obsidian/note')`);
await q(`INSERT INTO context_documents (context_id, document_path) VALUES ('ctx1', 'keep/surviving/doc')`);

// Content-quoting rows (C6).
await q(`INSERT INTO theme_cards (id, user_id, theme_id, territory_id, title, essence, sample_message_ids) VALUES ('tc1',?,999,999,'quoting','derived from m-obs-1',?)`,
  [U, JSON.stringify(['m-obs-1', 'm-herm-1'])]);
await q(`INSERT INTO theme_cards (id, user_id, theme_id, territory_id, title, essence, sample_message_ids) VALUES ('tc2',?,998,998,'clean','ok',?)`,
  [U, JSON.stringify(['m-herm-1'])]);
await q(`INSERT INTO person_claims (id, user_id, content, support) VALUES ('pc-all',?,'claim built only on deleted evidence',?)`,
  [U, JSON.stringify({ messages: ['m-obs-1', 'm-obs-2'] })]);
await q(`INSERT INTO person_claim_snapshots (id, user_id, claim_id, window_start, window_end) VALUES ('pcs1',?, 'pc-all','a','b')`, [U]);
await q(`INSERT INTO person_claims (id, user_id, content, support) VALUES ('pc-partial',?,'claim with surviving evidence',?)`,
  [U, JSON.stringify({ messages: ['m-obs-1', 'm-herm-1'] })]);

// Index everything into the search sidecar so eviction is observable.
for (const [id, text] of [['m-obs-1', 'xyzzy plugh obsidian secret'], ['m-obs-2', 'obsidian two'], ['m-obs-3', 'obsidian three'],
  ['m-herm-1', 'hermes one'], ['document:d-obs-1', 'quuux document secret'],
  ['territory:100', 'doomed doomed essence'], ['territory:200', 'survivor survivor essence']]) {
  await searchHelpers.backend.add({ id, text, ts: 1 });
}
const hits = async (text) => (await searchHelpers.backend.query({ text, topK: 20 })).hits.map((h) => h.id);

// ── Run: delete-by-source import-obsidian for user A ────────────────────────────
const summary = await bulkDelete(db, { userId: U, mode: 'source', key: 'import-obsidian', searchHelpers });

// ── C1 id-addressable derivations ───────────────────────────────────────────────
const DEAD = `('m-obs-1','m-obs-2','m-obs-3','d-obs-1')`;
rec('C1 clustering_points · note_links · entity_links · seen_points · document_versions · conversation_summaries purged for deleted ids',
  (await cnt(`SELECT COUNT(*) c FROM clustering_points WHERE user_id=? AND source_id IN ${DEAD}`, [U])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM note_links WHERE user_id=? AND (source_id IN ${DEAD} OR target_id IN ${DEAD})`, [U])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM entity_links WHERE user_id=? AND ref_id IN ${DEAD}`, [U])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM territory_seen_points WHERE user_id=? AND source_id IN ${DEAD}`, [U])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM time_seen_points WHERE user_id=? AND source_id IN ${DEAD}`, [U])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM document_versions WHERE document_id='d-obs-1'`)) === 0
  && (await cnt(`SELECT COUNT(*) c FROM conversation_summaries WHERE user_id=? AND id='cs1'`, [U])) === 0,
  `summary msgs=${summary.messages} docs=${summary.documents} pruned T/TH/R=${summary.territoriesPruned}/${summary.themesPruned}/${summary.realmsPruned}`);

// ── C2 the SURVIVOR's derivations are untouched ─────────────────────────────────
rec('C2 surviving row derivations untouched (purge is scoped, not a wipe)',
  (await cnt(`SELECT COUNT(*) c FROM note_links WHERE user_id=? AND target_id='m-herm-2'`, [U])) === 1
  && (await cnt(`SELECT COUNT(*) c FROM entity_links WHERE user_id=? AND ref_id='m-herm-1'`, [U])) === 1
  && (await cnt(`SELECT COUNT(*) c FROM territory_seen_points WHERE user_id=? AND source_id='m-herm-1'`, [U])) === 1
  && (await cnt(`SELECT COUNT(*) c FROM time_seen_points WHERE user_id=? AND source_id='m-herm-1'`, [U])) === 1
  && (await cnt(`SELECT COUNT(*) c FROM conversation_summaries WHERE user_id=? AND id='cs2'`, [U])) === 1);

// ── C3 tenant isolation across the DERIVED graph ────────────────────────────────
rec('C3 TENANT ISOLATION: user B derived rows untouched',
  (await cnt(`SELECT COUNT(*) c FROM clustering_points WHERE user_id=?`, [U2])) === 1
  && (await cnt(`SELECT COUNT(*) c FROM territory_profiles WHERE user_id=?`, [U2])) === 1
  && (await cnt(`SELECT COUNT(*) c FROM note_links WHERE user_id=?`, [U2])) === 1
  && (await cnt(`SELECT COUNT(*) c FROM territory_seen_points WHERE user_id=?`, [U2])) === 1);

// ── C4 LIVENESS PRUNE — territory/theme/realm 100 lost its last live point ──────
rec('C4 LIVENESS PRUNE: the fully-deleted territory/theme/realm is GONE from the whole derived graph',
  (await cnt(`SELECT COUNT(*) c FROM territory_profiles WHERE user_id=? AND territory_id=100`, [U])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM territory_vitality WHERE user_id=? AND territory_id=100`, [U])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM territory_pass_notes WHERE user_id=? AND territory_id=100`, [U])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM territory_neighbors WHERE user_id=? AND (territory_id=100 OR neighbor_id=100)`, [U])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM territory_lineage WHERE user_id=? AND (old_territory_id=100 OR new_territory_id=100)`, [U])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM territory_cofire WHERE user_id=? AND (territory_a=100 OR territory_b=100)`, [U])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM contact_territories WHERE user_id=? AND territory_id=100`, [U])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM entity_snapshots WHERE user_id=? AND entity_kind='territory' AND entity_id=100`, [U])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM cognitive_metrics_per_territory WHERE user_id=? AND territory_id=100`, [U])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM semantic_themes WHERE user_id=? AND semantic_theme_id=100`, [U])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM realms WHERE user_id=? AND realm_id=100`, [U])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM realm_neighbors WHERE user_id=? AND (realm_id=100 OR neighbor_id=100)`, [U])) === 0);

// ── C5 a territory that STILL holds a live point survives ───────────────────────
rec('C5 the SHARED territory (still holds a live hermes point) SURVIVES — and so does the untouched one',
  (await cnt(`SELECT COUNT(*) c FROM territory_profiles WHERE user_id=? AND territory_id=300`, [U])) === 1
  && (await cnt(`SELECT COUNT(*) c FROM territory_profiles WHERE user_id=? AND territory_id=200`, [U])) === 1
  && (await cnt(`SELECT COUNT(*) c FROM semantic_themes WHERE user_id=? AND semantic_theme_id IN (200,300)`, [U])) === 2
  && (await cnt(`SELECT COUNT(*) c FROM realms WHERE user_id=? AND realm_id IN (200,300)`, [U])) === 2);

// ── C6 content-quoting rows ─────────────────────────────────────────────────────
const pcPartial = (await q(`SELECT support FROM person_claims WHERE id='pc-partial'`)).results[0];
let partialSupport = null; try { partialSupport = JSON.parse(pcPartial?.support || 'null'); } catch {}
rec('C6 content-QUOTING rows: theme_card naming a deleted id is gone, all-evidence-lost claim + snapshots gone, partial claim REWRITTEN',
  (await cnt(`SELECT COUNT(*) c FROM theme_cards WHERE id='tc1'`)) === 0
  && (await cnt(`SELECT COUNT(*) c FROM theme_cards WHERE id='tc2'`)) === 1
  && (await cnt(`SELECT COUNT(*) c FROM person_claims WHERE id='pc-all'`)) === 0
  && (await cnt(`SELECT COUNT(*) c FROM person_claim_snapshots WHERE claim_id='pc-all'`)) === 0
  && (await cnt(`SELECT COUNT(*) c FROM person_claims WHERE id='pc-partial'`)) === 1
  && Array.isArray(partialSupport?.messages) && partialSupport.messages.length === 1 && partialSupport.messages[0] === 'm-herm-1',
  `pc-partial support=${JSON.stringify(partialSupport)}`);

// ── sidecar state after the bulk delete ─────────────────────────────────────────
const afterBulk = await hits('xyzzy plugh obsidian secret quuux document doomed');
rec('C1b SIDECAR: deleted message + document + pruned territory keys evicted; survivors kept',
  !afterBulk.includes('m-obs-1') && !afterBulk.includes('document:d-obs-1') && !afterBulk.includes('territory:100')
  && (await hits('hermes one')).includes('m-herm-1')
  && (await hits('survivor essence')).includes('territory:200'),
  `hits=${afterBulk.join(',') || '(none)'}`);

// ── C13 (bulk) token resurrection: deleted doc's share_link + context_document gone;
//    survivor's kept; user B's same-path share_link untouched ──────────────────────
rec('C13a BULK token resurrection: deleted document\'s share_link + context_document purged; survivor kept; user-B share_link (same path) untouched',
  (await cnt(`SELECT COUNT(*) c FROM share_links WHERE token='sl-obs'`)) === 0
  && (await cnt(`SELECT COUNT(*) c FROM context_documents WHERE document_path='import/obsidian/note'`)) === 0
  && (await cnt(`SELECT COUNT(*) c FROM share_links WHERE token='sl-keep'`)) === 1
  && (await cnt(`SELECT COUNT(*) c FROM context_documents WHERE document_path='keep/surviving/doc'`)) === 1
  && (await cnt(`SELECT COUNT(*) c FROM share_links WHERE token='sl-u2'`)) === 1);

// ══ PRIVACY: forget / redact ═══════════════════════════════════════════════════
const F = 'user-f';
await insMsg('m-forget', F, 'portal-chat', 'chat', 'grimoire incantation secret');
await insDoc('d-forget', F, 'portal-save', 'f/doc', 'palimpsest manuscript secret');
await insCp(F, 'message', 'm-forget');
await insCp(F, 'document', 'd-forget');
await q(`INSERT INTO document_versions (id, document_id, diff) VALUES ('dv-f', 'd-forget', 'PRIOR PALIMPSEST TEXT')`);
await searchHelpers.backend.add({ id: 'm-forget', text: 'grimoire incantation secret', ts: 1 });
await searchHelpers.backend.add({ id: 'document:d-forget', text: 'palimpsest manuscript secret', ts: 1 });

// forget(document) must purge its path-keyed share_link + context_document too.
await q(`INSERT INTO share_links (token, user_id, document_path, expires_at, view_count) VALUES ('sl-forget',?,?,?,0)`, [F, 'f/doc', '2027-01-01T00:00:00.000Z']);
await q(`INSERT INTO context_documents (context_id, document_path) VALUES ('ctx-f', 'f/doc')`);

// C14/C15 attachment purge: m-forget carries a voice-note attachment (verbatim
// transcript + description) whose blob is SOLELY referenced → must be unlinked;
// m-att-live is a LIVE message whose attachment shares one blob with m-att-shared
// (forgotten) → that blob must be KEPT (refcount).
const blobSolo = await putBlob(Buffer.from('solo voice bytes'), { userId: F, ext: '.m4a' });
await q(`INSERT INTO attachments (id, user_id, message_id, file_name, file_type, local_path, transcript, description) VALUES ('att-forget',?, 'm-forget','vn.m4a','voice',?,?,?)`,
  [F, blobSolo.path, 'voxglyph verbatim transcript secret', 'runeform description secret']);
await q(`UPDATE messages SET attachment_id='att-forget' WHERE id='m-forget' AND user_id=?`, [F]);

const blobShared = await putBlob(Buffer.from('shared voice bytes'), { userId: F, ext: '.m4a' });
await insMsg('m-att-shared', F, 'portal-chat', 'voice', 'shared attachment carrier');
await insMsg('m-att-live', F, 'portal-chat', 'voice', 'live attachment carrier');
await q(`INSERT INTO attachments (id, user_id, message_id, file_name, file_type, local_path, transcript) VALUES ('att-shared',?, 'm-att-shared','s.m4a','voice',?,'shared transcript')`, [F, blobShared.path]);
await q(`INSERT INTO attachments (id, user_id, message_id, file_name, file_type, local_path, transcript) VALUES ('att-live',?, 'm-att-live','l.m4a','voice',?,'live transcript')`, [F, blobShared.path]);
await q(`UPDATE messages SET attachment_id='att-shared' WHERE id='m-att-shared' AND user_id=?`, [F]);
await q(`UPDATE messages SET attachment_id='att-live'   WHERE id='m-att-live'   AND user_id=?`, [F]);
const soloBlobExisted = existsSync(join(uploadsRoot(), blobSolo.path));
const sharedBlobExisted = existsSync(join(uploadsRoot(), blobShared.path));

const beforeMsg = (await hits('grimoire incantation')).includes('m-forget');
await db.messages.redact('m-forget', F, { searchHelpers });
rec('C7 PRIVACY forget(message): content NOT retrievable from the search sidecar after redact()',
  beforeMsg === true && !(await hits('grimoire incantation')).includes('m-forget'),
  `searchable before=${beforeMsg} after=${(await hits('grimoire incantation')).includes('m-forget')}`);

// C14: redact('m-forget') destroyed the attachment (row + transcript + description)
// and unlinked its solely-referenced blob.
rec('C14 forget(message) purges the attachment (transcript + description) AND unlinks the sole-reference blob',
  soloBlobExisted === true
  && (await cnt(`SELECT COUNT(*) c FROM attachments WHERE id='att-forget'`)) === 0
  && (await cnt(`SELECT COUNT(*) c FROM attachments WHERE transcript IS NOT NULL AND transcript LIKE '%voxglyph%'`)) === 0
  && !existsSync(join(uploadsRoot(), blobSolo.path)),
  `soloBlobExisted=${soloBlobExisted} rowGone=${(await cnt(`SELECT COUNT(*) c FROM attachments WHERE id='att-forget'`)) === 0}`);

// C14b: a TRANSCRIPT-ONLY attachment whose blob is UNAVAILABLE (no local_path — e.g. a
// media-unavailable voice note that was transcribed but never had its bytes stored). The
// blob-unlink is correctly a no-op here, but the ROW delete (which carries the verbatim
// transcript + description) must be UNCONDITIONAL — forget's "content destroyed" promise.
// ⚠️ Without this fixture, gating the row DELETE on blob presence (`if (attId && attLocalPath)`)
// stays GREEN: every other forget fixture (att-forget/att-shared/att-live) has a local_path, so
// the blob-less branch — the exact case a transcript-only attachment hits — was never exercised.
await insMsg('m-forget-noblob', F, 'portal-chat', 'voice', 'blobless voice carrier');
await q(`INSERT INTO attachments (id, user_id, message_id, file_name, file_type, transcript, description) VALUES ('att-noblob',?, 'm-forget-noblob','vn2.m4a','voice',?,?)`,
  [F, 'sigilless verbatim transcript secret', 'glyphless description secret']);
await q(`UPDATE messages SET attachment_id='att-noblob' WHERE id='m-forget-noblob' AND user_id=?`, [F]);
const noblobLocalPath = (await q(`SELECT local_path FROM attachments WHERE id='att-noblob'`)).results[0]?.local_path ?? null;
await db.messages.redact('m-forget-noblob', F, { searchHelpers });
rec('C14b forget purges a TRANSCRIPT-ONLY (blob-less) attachment row unconditionally — the DELETE is not gated on blob presence',
  noblobLocalPath === null
  && (await cnt(`SELECT COUNT(*) c FROM attachments WHERE id='att-noblob'`)) === 0
  && (await cnt(`SELECT COUNT(*) c FROM attachments WHERE transcript LIKE '%sigilless%'`)) === 0,
  `localPathNull=${noblobLocalPath === null} rowGone=${(await cnt(`SELECT COUNT(*) c FROM attachments WHERE id='att-noblob'`)) === 0}`);

// C15: forget one of two messages sharing a blob → its attachment row goes, but the
// blob stays because the LIVE message's attachment still references it (refcount).
await db.messages.redact('m-att-shared', F, { searchHelpers });
rec('C15 a blob still referenced by a SURVIVING attachment row is KEPT (refcount holds)',
  sharedBlobExisted === true
  && (await cnt(`SELECT COUNT(*) c FROM attachments WHERE id='att-shared'`)) === 0
  && (await cnt(`SELECT COUNT(*) c FROM attachments WHERE id='att-live'`)) === 1
  && existsSync(join(uploadsRoot(), blobShared.path)),
  `sharedBlobExisted=${sharedBlobExisted} blobKept=${existsSync(join(uploadsRoot(), blobShared.path))}`);

const beforeDoc = (await hits('palimpsest manuscript')).includes('document:d-forget');
await db.documents.redact(F, 'f/doc', { searchHelpers });
rec('C8 PRIVACY forget(document): content NOT retrievable from the search sidecar after redact()',
  beforeDoc === true && !(await hits('palimpsest manuscript')).includes('document:d-forget'),
  `searchable before=${beforeDoc} after=${(await hits('palimpsest manuscript')).includes('document:d-forget')}`);

rec('C10 documents.redact purges document_versions (prior content lived on in `diff`)',
  (await cnt(`SELECT COUNT(*) c FROM document_versions WHERE document_id='d-forget'`)) === 0);

rec('C13b forget(document) purges its path-keyed share_link + context_document',
  (await cnt(`SELECT COUNT(*) c FROM share_links WHERE token='sl-forget'`)) === 0
  && (await cnt(`SELECT COUNT(*) c FROM context_documents WHERE document_path='f/doc'`)) === 0);

// ══ C9 PER-DOCUMENT delete parity ══════════════════════════════════════════════
const P = 'user-p';
await insDoc('d-solo', P, 'portal-save', 'p/solo', 'zarquon solo document');
await insCp(P, 'document', 'd-solo', 700, 700, 700);
await q(`INSERT INTO territory_profiles (user_id, territory_id, name, essence) VALUES (?,700,'p terr','p essence')`, [P]);
await q(`INSERT INTO note_links (user_id, source_type, source_id, target_type, target_id) VALUES (?,'document','d-solo','document','d-solo')`, [P]);
await q(`INSERT INTO document_versions (id, document_id, diff) VALUES ('dv-p', 'd-solo', 'PRIOR ZARQUON')`);
await q(`INSERT INTO share_links (token, user_id, document_path, expires_at, view_count) VALUES ('sl-solo',?,'p/solo',?,0)`, [P, '2027-01-01T00:00:00.000Z']);
await q(`INSERT INTO context_documents (context_id, document_path) VALUES ('ctx-p', 'p/solo')`);
await searchHelpers.backend.add({ id: 'document:d-solo', text: 'zarquon solo document', ts: 1 });

await db.documents.delete(P, 'p/solo', { searchHelpers });
rec('C9 PER-DOCUMENT delete reaches BULK parity: row + point + note_links + document_versions + sidecar + dead territory + share_link + context_document all gone',
  (await cnt(`SELECT COUNT(*) c FROM documents WHERE user_id=? AND path='p/solo'`, [P])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM clustering_points WHERE user_id=? AND source_id='d-solo'`, [P])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM note_links WHERE user_id=?`, [P])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM document_versions WHERE document_id='d-solo'`)) === 0
  && (await cnt(`SELECT COUNT(*) c FROM territory_profiles WHERE user_id=? AND territory_id=700`, [P])) === 0
  && (await cnt(`SELECT COUNT(*) c FROM share_links WHERE token='sl-solo'`)) === 0
  && (await cnt(`SELECT COUNT(*) c FROM context_documents WHERE document_path='p/solo'`)) === 0
  && !(await hits('zarquon solo')).includes('document:d-solo'));

// ══ C11 FAIL-CLOSED ════════════════════════════════════════════════════════════
{
  let threw = false;
  const brokenSearch = { backend: { delete: () => { throw new Error('sidecar down'); } } };
  await insMsg('m-failclosed', 'user-x', 'portal-chat', 'chat', 'content');
  try { await db.messages.deleteIds(['m-failclosed'], 'user-x', { searchHelpers: brokenSearch }); }
  catch { threw = true; }
  rec('C11 FAIL-CLOSED: sidecar eviction failure THROWS and the row is NOT reported deleted',
    threw && (await cnt(`SELECT COUNT(*) c FROM messages WHERE id='m-failclosed'`)) === 1,
    `threw=${threw}`);
  // userId is still mandatory (never table-wide)
  let noUser = false;
  try { await purgeDerived(db, '', { messageIds: ['x'] }); } catch { noUser = true; }
  rec('C11b purgeDerived refuses an empty userId (never table-wide)', noUser);
}

// ══ C12 REVERSE WRITER-GUARD ═══════════════════════════════════════════════════
{
  _resetDeleteLane();
  // The guard fires BEFORE any key resolution / spawn, so this needs no real keys.
  const control = isDeleteRunning();               // lane free
  const release = beginDelete();
  const during = startClusteringJob({ dbPath: DB, userId: U, db });
  const heldWhileActive = isDeleteRunning();
  release();
  const freedAfter = isDeleteRunning();
  rec('C12 REVERSE WRITER-GUARD: Generate is refused while a delete holds the lane; lane frees on release',
    control === false && during?.status === 'delete_running' && heldWhileActive === true && freedAfter === false,
    `control=${control} during=${during?.status} held=${heldWhileActive} freed=${freedAfter}`);
}

close?.();
const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — the delete cascade contract holds across bulk, per-object and forget');

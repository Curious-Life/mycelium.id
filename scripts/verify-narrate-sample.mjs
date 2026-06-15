// verify:narrate-sample — the shared narration sampler (pipeline/lib/narrate-sample.js).
// Proves the user-specified draw against a REAL seeded vault (boot + adapter):
//   S1 ALL source types load (message/document/transcript/image_description)
//   S2 timeline-stratified: sample spans the WHOLE date range (incl. oldest+newest),
//      NOT recency — and is date-ordered
//   S3 5,000-char cap per snippet
//   S4 top tags + entities aggregated across members
//   S5 incremental: seenIds biases to UNSEEN; recordSeen + exploredPercent accumulate
//   S6 stratifiedPick is deterministic + spreads (unit)
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import {
  loadMembers, sampleMembers, stratifiedPick,
  getSeenIds, recordSeen, exploredPercent, lastPassNumber,
} from '../pipeline/lib/narrate-sample.js';

const DB = 'data/verify-narrate-sample.db', KCV = 'data/verify-narrate-sample-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const U = 'local-user';
const T = 1; // territory under test

{ const d0 = new Database(DB); applyMigrations(d0); d0.close(); }
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const query = (sql, p = []) => db.rawQuery(sql, p).then((r) => r.results || r || []);

// ── Seed: 40 messages spread 2018→2026 (with tags+entities) + 1 doc + 1 transcript
//    + 1 image_description, all in territory T. ──
const cp = (sid, type, ts) => query(
  `INSERT INTO clustering_points (id, user_id, source_type, source_id, territory_id, realm_id, created_at)
   VALUES (?, ?, ?, ?, ?, 0, ?)`, [`cp-${type}-${sid}`, U, type, sid, T, ts]);

const YEARS = 8; const PER = 5; // 40 messages, 5/year 2018..2025 + 2026
let mi = 0;
for (let y = 0; y < YEARS; y++) {
  for (let k = 0; k < PER; k++) {
    const id = `m${mi}`;
    const ts = `${2018 + y}-0${1 + (k % 9)}-15T10:00:00Z`;
    const tags = JSON.stringify([`tag${y}`, 'common']);
    const entities = JSON.stringify({ people: [`person${y}`], topics: ['mycelium'] });
    await query(`INSERT INTO messages (id, user_id, content, tags, entities, created_at) VALUES (?,?,?,?,?,?)`,
      [id, U, `message number ${mi} from year ${2018 + y} about ideas`, tags, entities, ts]);
    await cp(id, 'message', ts);
    mi++;
  }
}
// one giant message (10k chars) at the newest end → tests 5k cap
await query(`INSERT INTO messages (id, user_id, content, created_at) VALUES (?,?,?,?)`,
  ['mbig', U, 'X'.repeat(10000), '2026-06-01T10:00:00Z']);
await cp('mbig', 'message', '2026-06-01T10:00:00Z');
// document + transcript + image_description (non-message sources)
await query(`INSERT INTO documents (id, user_id, path, title, content, created_at) VALUES (?,?,?,?,?,?)`,
  ['d1', U, 'notes/d1.md', 'Doc One', 'a document about forests and networks', '2022-03-03T10:00:00Z']);
await cp('d1', 'document', '2022-03-03T10:00:00Z');
await query(`INSERT INTO attachments (id, user_id, file_name, file_type, transcript, created_at) VALUES (?,?,?,?,?,?)`,
  ['a1', U, 'voice.ogg', 'audio/ogg', 'a transcript of a spoken reflection on growth', '2023-04-04T10:00:00Z']);
await cp('a1', 'transcript', '2023-04-04T10:00:00Z');
await query(`INSERT INTO attachments (id, user_id, file_name, file_type, description, created_at) VALUES (?,?,?,?,?,?)`,
  ['a2', U, 'pic.png', 'image/png', 'an image description of a mushroom cap', '2024-05-05T10:00:00Z']);
await cp('a2', 'image_description', '2024-05-05T10:00:00Z');

const members = await loadMembers(query, U, 'territory_id', T);

// ── S1: all source types present ──
const types = new Set(members.map((m) => m.source_type));
rec('S1. all 4 source types load (message/document/transcript/image_description)',
  ['message', 'document', 'transcript', 'image_description'].every((t) => types.has(t)),
  `types=${[...types].sort().join(',')} members=${members.length}`);

// ── S2: timeline-stratified spread + date order ──
const s = sampleMembers(members, { n: 20 });
const yearsCovered = new Set(s.samples.map((x) => String(x.created_at).slice(0, 4)));
const ordered = s.samples.every((x, i, a) => i === 0 || String(a[i - 1].created_at) <= String(x.created_at));
const hasOldest = s.samples.some((x) => String(x.created_at).startsWith('2018'));
const hasNewest = s.samples.some((x) => String(x.created_at).startsWith('2026'));
rec('S2. stratified across whole timeline (oldest 2018 + newest 2026 incl.), date-ordered, ≥6 yrs',
  s.samples.length === 20 && ordered && hasOldest && hasNewest && yearsCovered.size >= 6,
  `n=${s.samples.length} years=${[...yearsCovered].sort().join(',')} ordered=${ordered}`);

// ── S3: per-message cap (≤5k) AND total-prompt budget (the whole prompt fits) ──
const big = s.samples.find((x) => x.id === 'mbig');
const totalChars = s.samples.reduce((a, x) => a + x.content.length, 0);
const maxOne = Math.max(...s.samples.map((x) => x.content.length));
rec('S3. per-message ≤5k AND total prompt bounded by budget (oversized snippet trimmed)',
  maxOne <= 5000 && totalChars <= 16000 + 500 && big && big.content.length < 10000,
  `maxSnippet=${maxOne} total=${totalChars} (budget 16000) big=${big?.content.length}`);

// ── S4: tags + entities aggregated ──
rec('S4. top tags + entities aggregated across members',
  s.topTags.includes('common') && s.topTags.some((t) => /^tag\d$/.test(t)) && s.entities.includes('mycelium') && s.entities.some((e) => /^person\d$/.test(e)),
  `tags=${s.topTags.slice(0, 5).join(',')} entities=${s.entities.slice(0, 5).join(',')}`);

// ── S5: incremental coverage ──
const total = members.length;
const pass1Seen = await getSeenIds(query, U, T); // empty first
const r1 = sampleMembers(members, { n: 20, seenIds: pass1Seen });
await recordSeen(query, U, T, r1.sampledIds, (await lastPassNumber(query, U, T)) + 1);
const seenAfter1 = await getSeenIds(query, U, T);
const pct1 = exploredPercent(seenAfter1.size, total);

const r2 = sampleMembers(members, { n: 20, seenIds: seenAfter1 });
const r2NewCount = r2.sampledIds.filter((id) => !seenAfter1.has(id)).length;
await recordSeen(query, U, T, r2.sampledIds, (await lastPassNumber(query, U, T)) + 1);
const seenAfter2 = await getSeenIds(query, U, T);
const pct2 = exploredPercent(seenAfter2.size, total);

rec('S5. incremental: pass-2 pulls mostly UNSEEN; coverage % strictly grows',
  r2NewCount >= 10 && seenAfter2.size > seenAfter1.size && pct2 > pct1 && pct1 > 0,
  `seen1=${seenAfter1.size}(${pct1}%) → seen2=${seenAfter2.size}(${pct2}%), pass2_new=${r2NewCount}/20`);

// ── S6: stratifiedPick unit — deterministic + endpoints + spread ──
const arr = Array.from({ length: 100 }, (_, i) => i);
const pick = stratifiedPick(arr, 10);
const pick2 = stratifiedPick(arr, 10);
rec('S6. stratifiedPick: deterministic, includes endpoints, spreads (not clustered)',
  JSON.stringify(pick) === JSON.stringify(pick2) && pick[0] === 0 && pick[pick.length - 1] === 99 && pick.length === 10,
  `pick=${pick.join(',')}`);

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — narration sampler: all-source · timeline-stratified · 5k · tags/entities · incremental coverage' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

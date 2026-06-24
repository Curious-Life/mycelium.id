// verify:describe-entity-tool — the narration MCP domain (src/tools/narration.js) +
// the v4 metrics layer on the Context Capsule. Against a REAL seeded vault:
//   D1 getEntityContext returns the capsule + rendered block (temporal + connected-by-name)
//   D2 the v4 SHAPE line: capsule.metrics folds vitality/phase/movement/coherence/recurrence
//      when the analysis engine has written them (and omits them when absent)
//   D3 describeEntity writes name+essence + stamps described_period_* (UPDATE-only)
//   D4 describeEntity rejects junk (no name / empty essence) WITHOUT wiping the prior
//   D5 describeEntity on a missing id is fail-closed (never creates)
//   D6 registry + grants: both tools registered; getEntityContext ∈ SAFE_AUTONOMOUS,
//      describeEntity ∈ AUTONOMY_TOOLS and NOT in the chat DOMAINS catalog
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createNarrationDomain } from '../src/tools/narration.js';
import { SAFE_AUTONOMOUS_TOOLS, AUTONOMY_TOOLS } from '../src/agent/autonomy-tools.js';
import { DOMAINS } from '../src/agent/tool-domains.js';

const DB = 'data/verify-describe-entity.db', KCV = 'data/verify-describe-entity-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const U = 'local-user';
const T = 1, REALM = 5;

{ const d0 = new Database(DB); applyMigrations(d0); d0.close(); }
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const query = (sql, p = []) => db.rawQuery(sql, p).then((r) => r.results || r || []);

// ── Seed: realm 5, territory 1 (with members across two time bands), a centroid
//    neighbour, + the v4 metric signals (vitality/phase/coherence + fisher). ──
await query(`INSERT INTO realms (user_id, realm_id, name, essence) VALUES (?,?,?,?)`,
  [U, REALM, 'Inner weather', 'shifting inner moods']);
await query(`INSERT INTO territory_profiles (user_id, territory_id, realm_id, name, essence, message_count, centroid_256, current_vitality, current_phase, coherence) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  [U, T, REALM, 'Grief & repair', 'loss metabolized into care', 18, JSON.stringify([1, 0, 0, 0]), 0.71, 'active', 0.35]);
await query(`INSERT INTO territory_profiles (user_id, territory_id, realm_id, name, message_count, centroid_256) VALUES (?,?,?,?,?,?)`,
  [U, 2, REALM, 'Caretaking', 15, JSON.stringify([0.95, 0.05, 0, 0])]);
// fisher movement (level-wide latest) + per-territory recurrence
await query(`INSERT INTO fisher_trajectory (id, user_id, level, window_type, window_start, window_end, activation_vector, phase, phase_recent, message_count, active_territory_count, clustering_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  [`f1`, U, 'territory', 'weekly_step', '2024-01-01', '2024-08-01', '{}', 'exploring', 'exploring', 18, 1, 'v2']);
await query(`INSERT INTO cognitive_metrics_per_territory (user_id, territory_id, window_end, era_id, recurrence_interval, message_count) VALUES (?,?,?,?,?,?)`,
  [U, T, '2024-08-01', 'v2', 6.0, 18]).catch(() => {});

const mk = async (id, ts) => {
  await query(`INSERT INTO messages (id, user_id, content, created_at) VALUES (?,?,?,?)`,
    [id, U, `a reflection ${id} on loss and care`, ts]);
  await query(`INSERT INTO clustering_points (id, user_id, source_type, source_id, territory_id, realm_id, created_at) VALUES (?,?,?,?,?,?,?)`,
    [`cp-${id}`, U, 'message', id, T, REALM, ts]);
};
for (let i = 0; i < 10; i++) await mk(`old${i}`, `2023-0${1 + (i % 9)}-15T10:00:00Z`);
for (let i = 0; i < 8; i++) await mk(`new${i}`, `2024-0${1 + (i % 8)}-15T10:00:00Z`);

const { tools, handlers } = createNarrationDomain({ db, userId: U });

// ── D1 — getEntityContext returns capsule + rendered ──
const ctx = await handlers.getEntityContext({ kind: 'territory', id: T });
rec('D1. getEntityContext returns capsule + rendered block (temporal + connected-by-name)',
  typeof ctx === 'object' && ctx.capsule && /NOW FOLDING IN|FIRST DESCRIPTION/.test(ctx.rendered) && /Inner weather|Caretaking/.test(ctx.rendered),
  ctx.rendered ? ctx.rendered.split('\n').map((l) => `      | ${l}`).join('\n') : String(ctx));

// ── D2 — v4 SHAPE line from the metric signals ──
const mx = ctx.capsule?.metrics || {};
rec('D2. v4 metrics: vitality/phase/movement/coherence/recurrence folded + SHAPE line rendered',
  mx.vitality === 0.71 && mx.phase === 'active' && mx.fisherPhase === 'exploring' && mx.coherence === 0.35 && Math.round(mx.recurrence) === 6
  && /SHAPE: vitality 0\.71 \(active\) · movement exploring · coherence 0\.35 \(scattered\) · recurs ~6d/.test(ctx.rendered),
  `metrics=${JSON.stringify(mx)}`);

// ── D3 — describeEntity writes name+essence + described_period (UPDATE-only) ──
const wrote = await handlers.describeEntity({ kind: 'territory', id: T, name: 'Tending grief', essence: 'where loss becomes care over time' });
const [after] = await query(`SELECT name, essence, described_period_start, described_period_end FROM territory_profiles WHERE user_id=? AND territory_id=?`, [U, T]);
rec('D3. describeEntity writes name+essence + stamps described_period_* (covers the seen span)',
  /Described territory/.test(String(wrote)) && after.name === 'Tending grief' && after.essence.startsWith('where loss')
  && after.described_period_start?.startsWith('2023') && after.described_period_end?.startsWith('2024'),
  `wrote="${wrote}" name="${after.name}" period=${after.described_period_start?.slice(0,7)}..${after.described_period_end?.slice(0,7)}`);

// ── D4 — junk rejected, prior NOT wiped ──
const bad = await handlers.describeEntity({ kind: 'territory', id: T, name: 'a b c d e f g h', essence: '' });
const [stillThere] = await query(`SELECT name FROM territory_profiles WHERE user_id=? AND territory_id=?`, [U, T]);
rec('D4. describeEntity rejects junk (bad name / empty essence) and does NOT wipe the prior',
  /rejected/.test(String(bad)) && stillThere.name === 'Tending grief',
  `resp="${bad}" name-still="${stillThere.name}"`);

// ── D5 — fail-closed on a missing id (never creates) ──
const missing = await handlers.describeEntity({ kind: 'territory', id: 9999, name: 'Ghost', essence: 'should not be created' });
const [none] = await query(`SELECT COUNT(*) AS c FROM territory_profiles WHERE user_id=? AND territory_id=?`, [U, 9999]);
rec('D5. describeEntity is fail-closed: missing id is rejected, no row created',
  /does not exist/.test(String(missing)) && Number(none.c) === 0, `resp="${missing}" rows=${none.c}`);

// ── D6 — registry + autonomy/chat placement ──
const names = new Set(tools.map((t) => t.name));
const inChat = Object.values(DOMAINS || {}).some((d) => (d.tools || []).includes('describeEntity'));
rec('D6. both tools registered; getEntityContext∈SAFE, describeEntity∈AUTONOMY and NOT in chat DOMAINS',
  names.has('getEntityContext') && names.has('describeEntity')
  && SAFE_AUTONOMOUS_TOOLS.has('getEntityContext') && AUTONOMY_TOOLS.has('describeEntity') && !inChat,
  `registry=[${[...names].join(', ')}] safe=${SAFE_AUTONOMOUS_TOOLS.has('getEntityContext')} autonomy=${AUTONOMY_TOOLS.has('describeEntity')} inChat=${inChat}`);

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — narration domain: getEntityContext (capsule + metrics) · describeEntity (validated, UPDATE-only, gated)' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

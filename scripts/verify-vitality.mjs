// verify:vitality — T1. Proves pipeline/compute-vitality.js computes per-
// territory behavioral phases end-to-end on a seeded vault, that the six
// territory_vitality metric columns are ENCRYPTED at rest (wrapped-DEK
// envelopes, not plaintext numbers) while structural columns (phase enum,
// territory_id, clustering_run_id) stay plaintext, AND that a read through the
// adapter (db.rawQuery) returns decrypted/usable numbers. Runs the REAL stage
// via spawnSync(node …). PASS/FAIL ledger; exits 0 only if all pass.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-vitality.db', KCV = 'data/verify-vitality-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const RUN = 'era-verify-vitality-0001';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const isEnvelope = (v) => {
  if (typeof v !== 'string') return false;
  try { const o = JSON.parse(Buffer.from(v, 'base64').toString('utf8')); return !!(o.v && o.s && o.iv && o.ct && o.dk); }
  catch { return false; }
};
// 256-D centroid: a unit-ish vector that differs per territory so reach/semantic
// span are non-zero.
const centroid = (seed) => {
  const v = new Array(256).fill(0).map((_, i) => Math.sin((i + 1) * (seed + 1) * 0.013));
  return JSON.stringify(v);
};

// ── Seed: 5 territories across 3 realms/themes with co-firing edges so degree /
//    bridge / partner signals are non-degenerate. coherence/energy/centroid_256
//    are ENCRYPTED by the adapter on write. ──
const TERRS = [
  { tid: 1, realm: 10, theme: 100, mc: 400, coh: 0.8, en: 0.02 },
  { tid: 2, realm: 10, theme: 101, mc: 250, coh: 0.6, en: 0.015 },
  { tid: 3, realm: 11, theme: 102, mc: 600, coh: 0.9, en: 0.03 },
  { tid: 4, realm: 12, theme: 103, mc: 120, coh: 0.4, en: 0.008 },
  { tid: 5, realm: 11, theme: 102, mc: 80,  coh: 0.3, en: 0.005 },
];
for (const t of TERRS) {
  await db.rawQuery(
    `INSERT INTO territory_profiles
       (id, user_id, territory_id, realm_id, semantic_theme_id, message_count,
        coherence, energy, centroid_256, is_catchall, dissolved_at)
     VALUES (?,?,?,?,?,?,?,?,?,0,NULL)`,
    [`tp-${t.tid}`, U, t.tid, t.realm, t.theme, t.mc, t.coh, t.en, centroid(t.tid)]);
}
// Co-firing edges (cofire_* ENCRYPTED by the adapter). Make T1/T3 well-connected
// cross-realm bridges; T4/T5 weakly connected.
const EDGES = [
  { a: 1, b: 3, imm: 0.5, ses: 0.6, day: 1.2, wk: 0.9 },
  { a: 1, b: 2, imm: 0.3, ses: 0.4, day: 0.8, wk: 0.5 },
  { a: 3, b: 4, imm: 0.2, ses: 0.3, day: 0.6, wk: 0.4 },
  { a: 3, b: 5, imm: 0.1, ses: 0.2, day: 0.5, wk: 0.3 },
  { a: 2, b: 4, imm: 0.1, ses: 0.15, day: 0.4, wk: 0.2 },
];
for (const e of EDGES) {
  await db.rawQuery(
    `INSERT INTO territory_cofire
       (id, user_id, territory_a, territory_b, cofire_immediate, cofire_session, cofire_daily, cofire_weekly)
     VALUES (?,?,?,?,?,?,?,?)`,
    [`${U}:${e.a}:${e.b}`, U, e.a, e.b, e.imm, e.ses, e.day, e.wk]);
}

try {
  // ── V1. compute-vitality.js runs clean ─────────────────────────────────────
  const run = spawnSync('node', ['pipeline/compute-vitality.js'], {
    encoding: 'utf8',
    env: { ...process.env, MYCELIUM_DB: DB, MYCELIUM_KCV: KCV, MYCELIUM_USER_ID: U,
      USER_MASTER: userHex, SYSTEM_KEY: systemHex, CLUSTERING_RUN_ID: RUN },
  });
  rec('V1. compute-vitality.js exits 0 on a seeded vault',
    run.status === 0, run.status !== 0 ? (run.stderr || run.stdout || '').slice(-400) : (run.stdout.match(/\[vitality\] Done.*/)?.[0] || ''));

  // ── V2. territory_vitality populated ───────────────────────────────────────
  const raw = new Database(DB, { readonly: true });
  const count = raw.prepare(`SELECT COUNT(*) n FROM territory_vitality WHERE user_id=?`).get(U).n;
  rec('V2. territory_vitality populated (one row per territory)',
    count === TERRS.length, `rows=${count} (expected ${TERRS.length})`);

  // ── V3. metric columns ciphertext at rest; structural columns plaintext ─────
  const row = raw.prepare(
    `SELECT entropy_diversification, connection_growth_rate, reach, cofire_partner_diversity,
            engagement_depth_normalized, vitality, phase, territory_id, clustering_run_id
     FROM territory_vitality WHERE user_id=? AND territory_id=1`).get(U);
  const encCols = ['entropy_diversification', 'connection_growth_rate', 'reach',
    'cofire_partner_diversity', 'engagement_depth_normalized', 'vitality'];
  const allEnc = row && encCols.every((c) => isEnvelope(row[c]));
  rec('V3. territory_vitality metric columns are envelopes at rest (no plaintext numbers)',
    !!allEnc,
    row ? `enc{${encCols.filter((c) => isEnvelope(row[c])).length}/${encCols.length}}` : 'no row');
  rec('V4. structural columns stay plaintext (phase enum / territory_id / run_id)',
    row && !isEnvelope(row.phase) && ['sparse', 'active', 'anchor'].includes(row.phase)
      && !isEnvelope(String(row.territory_id)) && row.clustering_run_id === RUN,
    row ? `phase=${row.phase} territory_id=${row.territory_id} run=${row.clustering_run_id}` : 'no row');

  // current_vitality cached on profile is also encrypted (SEC-3); current_phase plaintext.
  const prof = raw.prepare(`SELECT current_vitality, current_phase FROM territory_profiles WHERE user_id=? AND territory_id=1`).get(U);
  raw.close();
  rec('V5. territory_profiles cache: current_vitality encrypted, current_phase plaintext enum',
    prof && isEnvelope(prof.current_vitality) && !isEnvelope(prof.current_phase)
      && ['sparse', 'active', 'anchor'].includes(prof.current_phase),
    prof ? `vit_enc=${isEnvelope(prof.current_vitality)} phase=${prof.current_phase}` : 'no profile');

  // ── V6. adapter read decrypts + coerces → usable numbers ───────────────────
  const dec = await db.rawQuery(
    `SELECT vitality, reach, entropy_diversification, phase FROM territory_vitality WHERE user_id=? AND territory_id=1`, [U]);
  const dr = (Array.isArray(dec) ? dec[0] : dec?.results?.[0]);
  const vNum = dr ? Number(dr.vitality) : NaN;
  rec('V6. adapter auto-decrypts metric columns → finite numbers (Number()-coercible)',
    !!dr && Number.isFinite(vNum) && vNum >= 0 && vNum <= 1 && Number.isFinite(Number(dr.reach)),
    dr ? `vitality=${dr.vitality} (→${vNum}) reach=${dr.reach} phase=${dr.phase}` : 'no row');

  // ── V7. re-run is idempotent (dedup): a SECOND run with a NEW run id must
  //        REPLACE rows, not accumulate (the 128× 'backfill-v1' bug). ──────────
  const run2 = spawnSync('node', ['pipeline/compute-vitality.js'], {
    encoding: 'utf8',
    env: { ...process.env, MYCELIUM_DB: DB, MYCELIUM_KCV: KCV, MYCELIUM_USER_ID: U,
      USER_MASTER: userHex, SYSTEM_KEY: systemHex, CLUSTERING_RUN_ID: `${RUN}-2` },
  });
  const raw2 = new Database(DB, { readonly: true });
  const count2 = raw2.prepare(`SELECT COUNT(*) n FROM territory_vitality WHERE user_id=?`).get(U).n;
  const runs2 = raw2.prepare(`SELECT DISTINCT clustering_run_id r FROM territory_vitality WHERE user_id=?`).all(U).map((x) => x.r);
  raw2.close();
  rec('V7. re-run dedups (clear-before-insert): 1 row/territory, old run replaced',
    run2.status === 0 && count2 === TERRS.length && runs2.length === 1 && runs2[0] === `${RUN}-2`,
    `rows=${count2} (expected ${TERRS.length}) runs=${JSON.stringify(runs2)}`);
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — vitality computes; metrics encrypted at rest; adapter decrypts + coerces; structural keys plaintext' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

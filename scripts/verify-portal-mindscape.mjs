// Verify Phase M — the Mindscape READ surface (/api/v1/portal/mindscape*) that
// the canonical 3D screen consumes. Seeds realms + territory_profiles +
// clustering_points through the encrypting adapter, then asserts the exact
// shapes the UI reads. Graceful-empty surfaces (no V1 data source) must return
// benign shapes, never throw. Also a regression check that the second router
// mounted at /api/v1/portal does NOT shadow the compat router or the raw API.
//
//   M1 aggregator   GET /mindscape            → {nodes,themes,territories,realms,semanticThemes,meta}
//   M2 territories   GET /mindscape/territories → {territories:[…]}
//   M3 realms        GET /mindscape/realms     → {realms:[…]}
//   M4 noise-stats   GET /mindscape/noise-stats → {total,noise,noisePct}
//   M5 activations   GET /mindscape/activations → {active:[],silent:[],…} (no throw)
//   M6 graceful      fingerprint/complexity/exploration-status/phase-history/cofire/trajectory
//   M7 regression    compat /documents + raw /api/v1/tools still resolve
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';

const DB = 'data/verify-portal-mindscape.db';
const KCV = 'data/verify-portal-mindscape-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url, db } = srv;
  const uid = 'local-user'; // bootUserId default for the single-user vault
  const j = async (p) => { const r = await fetch(`${url}${p}`); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
  const M = (p) => `/api/v1/portal${p}`;

  try {
    // ── Seed through the encrypting adapter (symmetric with the read path) ──
    await db.rawQuery(`INSERT INTO realms (realm_id, user_id, name, essence) VALUES (?,?,?,?)`, [0, uid, 'Inner', 'where it begins']);
    await db.rawQuery(`INSERT INTO realms (realm_id, user_id, name, essence) VALUES (?,?,?,?)`, [1, uid, 'Outer', 'the far reaches']);
    await db.rawQuery(`INSERT INTO territory_profiles (territory_id, user_id, realm_id, name, essence, message_count) VALUES (?,?,?,?,?,?)`, [10, uid, 0, 'Roots', 'the underground', 5]);
    await db.rawQuery(`INSERT INTO territory_profiles (territory_id, user_id, realm_id, name, essence, message_count) VALUES (?,?,?,?,?,?)`, [11, uid, 1, 'Canopy', 'the high branches', 3]);
    const pt = (sid, terr, realm, x, y, z) => db.rawQuery(
      `INSERT INTO clustering_points (user_id, source_type, source_id, territory_id, realm_id, landscape_x, landscape_y, landscape_z, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [uid, 'message', sid, terr, realm, x, y, z, '2026-05-01T12:00:00.000Z']);
    await pt('m1', 10, 0, 1.0, 2.0, 3.0);
    await pt('m2', 10, 0, 1.1, 2.1, 3.1);
    await pt('m3', 11, 1, -1.0, -2.0, -3.0);
    await pt('m4', 11, 1, -1.1, -2.1, -3.1);
    await pt('m5', -1, -1, 0.0, 0.0, 0.0); // noise

    // ── M1 aggregator ──
    const agg = await j(M('/mindscape'));
    const b = agg.body || {};
    const aggOk = agg.status === 200
      && Array.isArray(b.nodes) && b.nodes.length === 5
      && b.nodes[0]?.data?.position3d && typeof b.nodes[0].data.position3d.x === 'number'
      && b.territories?.['10']?.name === 'Roots' && b.territories?.['11']?.name === 'Canopy'
      && b.realms?.['0'] && b.realms?.['1']
      && b.meta?.total === 5 && b.meta?.noise3d === 1;
    rec('M1. aggregator → nodes + territories + realms + meta', aggOk,
      `nodes=${b.nodes?.length} terr=${Object.keys(b.territories || {}).length} meta.total=${b.meta?.total} noise3d=${b.meta?.noise3d}`);

    // ── M2 territories ──
    const terr = await j(M('/mindscape/territories'));
    rec('M2. /territories → {territories:[…]} (2, with name)',
      terr.status === 200 && Array.isArray(terr.body?.territories) && terr.body.territories.length === 2
      && terr.body.territories.some((t) => t.name === 'Roots'),
      `count=${terr.body?.territories?.length}`);

    // ── M3 realms ──
    const realms = await j(M('/mindscape/realms'));
    rec('M3. /realms → {realms:[…]} (2)',
      realms.status === 200 && Array.isArray(realms.body?.realms) && realms.body.realms.length === 2,
      `count=${realms.body?.realms?.length}`);

    // ── M4 noise-stats ──
    const noise = await j(M('/mindscape/noise-stats'));
    rec('M4. /noise-stats → {total,noise,noisePct}',
      noise.status === 200 && noise.body?.total === 5 && noise.body?.noise === 1 && typeof noise.body?.noisePct === 'string',
      `total=${noise.body?.total} noise=${noise.body?.noise} pct=${noise.body?.noisePct}`);

    // ── M5 activations (benign; messages not seeded → empty but no throw) ──
    const act = await j(M('/mindscape/activations'));
    rec('M5. /activations → {active:[],silent:[]} (no throw)',
      act.status === 200 && Array.isArray(act.body?.active) && Array.isArray(act.body?.silent));

    // ── M6 graceful-empty + real trajectory ──
    const fp = await j(M('/mindscape/fingerprint'));
    const cx = await j(M('/mindscape/complexity'));
    const es = await j(M('/mindscape/exploration-status'));
    const ph = await j(M('/mindscape/phase-history'));
    const cf = await j(M('/mindscape/cofire'));
    const tr = await j(M('/trajectory/summary'));
    const m6 = fp.body?.fingerprint === null
      && Array.isArray(cx.body?.territories) && cx.body?.global_complexity === null
      && es.body?.totalTerritories === 2 && es.body?.explorationRunning === false
      && Array.isArray(ph.body?.territories) && Array.isArray(cf.body?.connections)
      && ('summary' in (tr.body || {}));
    rec('M6. graceful-empty surfaces + trajectory/summary (no throw)', m6,
      `fingerprint=${fp.body?.fingerprint} explore.totalTerritories=${es.body?.totalTerritories}`);

    // ── M7 regression: the compat router + raw API are not shadowed ──
    const docs = await j(M('/documents'));
    const tools = await j('/api/v1/tools');
    rec('M7. compat /documents + raw /api/v1/tools still resolve',
      docs.status === 200 && Array.isArray(docs.body?.documents)
      && tools.status === 200,
      `docs=${docs.status} tools=${tools.status}`);
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — Phase M: mindscape read surface wired to real local data (aggregator + panels + graceful-empty)' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-portal-mindscape threw:', e); process.exit(1); });

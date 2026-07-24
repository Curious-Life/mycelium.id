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
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';
import { bustMindscapePoints } from '../src/mindscape-cache.js';
import { dataDir } from '../src/paths.js';

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

    // before any diagnostics row, partitionConfidence is null (not measured yet)
    rec('M1b. meta.partitionConfidence null before first run',
      b.meta?.partitionConfidence === null, `value=${JSON.stringify(b.meta?.partitionConfidence)}`);

    // ── M1c clustering-validity diagnostics surface (METRICS-AUDIT S5) ──
    await db.rawQuery(
      `INSERT OR REPLACE INTO clustering_diagnostics
         (user_id, cluster_version, realm_max_share, realm_count, territory_validity,
          bootstrap_ari_mean, bootstrap_ari_std, bootstrap_ari_runs, low_confidence, confidence_note)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [uid, '2026-06-19T00:00:00Z', 0.78, 2, 0.05, 0.55, 0.04, 12, 1,
       'Low-confidence partition: largest realm holds 78% of points (>50%).']);
    bustMindscapePoints(uid); // prod parity: clustering writes diagnostics WITH the points →
                              // a point bust (jobs.js:219), which refreshes the durable points
                              // bundle that carries meta.partitionConfidence.
    const agg2 = (await j(M('/mindscape'))).body || {};
    const pc = agg2.meta?.partitionConfidence;
    rec('M1c. meta.partitionConfidence surfaces low-confidence flag + scalars',
      pc?.lowConfidence === true && pc?.realmMaxShare === 0.78 && pc?.bootstrapAriMean === 0.55
      && pc?.bootstrapAriRuns === 12 && typeof pc?.note === 'string',
      `lowConfidence=${pc?.lowConfidence} maxShare=${pc?.realmMaxShare} ari=${pc?.bootstrapAriMean}`);

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

  await partS();

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — Phase M: mindscape read surface wired to real local data (aggregator + panels + graceful-empty) + STALENESS-AWARE Generate debounce (D-004)' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

// =====================================================================================
// PART S — THE GENERATE DEBOUNCE MUST BE STALENESS-AWARE (defect D-004 ↻1)
// =====================================================================================
// The pre-fix skip predicate was `COUNT(clustering_points) > 0` — no staleness condition —
// so once a map existed it could never catch up. The operator's report, verbatim:
//   1. "i have 2510 points byt the mycelium and map that is shown in mycelium page only has
//      369 points"
//   2. "it shows me a text saying map already built; pass ?force=1 to rebuild. this i cant do
//      from the UI as a user"
//   3. "the cluster names dont show, they say territory 2 etc.... not the actual name"
// (3) is downstream of the same line: pipeline/describe-clusters.js is the ONLY writer of
// realms.name / territory_profiles.name and runs as Generate step 3/16 — the step the skip
// never reached (verify:illuminate-naming Part N owns that half of the proof).
//
// The gate holds BOTH halves against each other, because either one alone is a regression:
//   S1 a STALE point set MUST NOT be skipped  — the defect
//   S2 a FRESH point set MUST be skipped      — the debounce's real property; deleting it
//      restores the "map blanks for minutes on every app launch" bug it was added for
// plus the honesty surface (S3), the reachable rebuild (S4), the recorded baseline that stops
// the fallback from looping (S5), and the run that records it (S6).
//
// Every check below was mutation-tested (/gate-teeth): the thing it claims to catch was
// broken, the gate was watched to RED on the expected row, then restored to GREEN.
//
// MUTATION-TESTED: src/portal-mindscape.js skip predicate reverted to the pre-fix
//   `if (!force && freshness?.built)` (no staleness condition) → S1 REDs
//   ("status=skipped reason=topology_fresh"); S6 REDs downstream because no run started, so
//   no baseline was recorded. S2/S3/S4/S5 stay GREEN — the failing rows are the ones that
//   encode the defect.
// MUTATION-TESTED: src/mindscape-freshness.js `stale` forced to `true` (i.e. the debounce
//   deleted rather than made conditional) → S2 REDs ("fresh point set was NOT skipped"),
//   S3/S5 RED with it. The gate therefore also refuses the naive "just remove the debounce"
//   fix, which would restore the blank-map-on-every-launch bug.
// MUTATION-TESTED: src/mindscape-freshness.js `reference` hardcoded to the mapped count
//   (the recorded baseline ignored) → S5 REDs ("stale=true, basis=baseline"), proving the
//   no-rebuild-loop property is asserted and not merely commented. First attempt at S5 did
//   NOT red — a 10-point gap is fresh under both rules — so the fixture was widened to a
//   36/250 gap. A mutation that fails to red is the gate's problem, not the mutation's.
// MUTATION-TESTED: src/jobs.js post-run writeGenerateStats call stripped of its `embedded:`
//   argument → S6 REDs ("lastEmbedded=null expected=250"); everything else stays GREEN.
// MUTATION-TESTED: GET /mycelium/map-status reduced to `{ embedded, mapped }` (drops
//   stale/drift/basis) → S3 REDs, so the honesty surface is asserted on its CONTENT, not on
//   a 200 status; S5 REDs with it (it reads `basis`).
async function partS() {
  const DBS = 'data/verify-portal-mindscape-stale.db';
  const KCVS = 'data/verify-portal-mindscape-stale-kcv.json';
  for (const f of [DBS, KCVS, `${DBS}-shm`, `${DBS}-wal`]) { try { rmSync(f); } catch {} }
  const uid = 'local-user';

  // A fake clustering script: the assertion is "a run was STARTED", never that the real Python
  // pipeline ran. `exit 0` so the post-run baseline write (S6) is exercised end to end.
  const FAKE = 'data/verify-portal-mindscape-fake-cluster.sh';
  writeFileSync(FAKE, '#!/bin/bash\necho "Step 1/16: fake"\nexit 0\n');
  const prevScript = process.env.MYCELIUM_CLUSTER_SCRIPT;
  process.env.MYCELIUM_CLUSTER_SCRIPT = FAKE;

  // The freshness baseline lives in dataDir()/generate-stats.json. Clear it so S1/S2 exercise
  // the NO-BASELINE fallback (mapped vs embedded) — which is exactly the operator's vault: a
  // map built by a release that predates the baseline.
  const statsFile = join(dataDir(), 'generate-stats.json');
  const prevStats = existsSync(statsFile) ? readFileSync(statsFile, 'utf8') : null;
  const clearStats = () => { try { rmSync(statsFile); } catch {} };
  const setBaseline = (embedded) => writeFileSync(statsFile, JSON.stringify({ lastDurationMs: 1000, lastMessages: null, lastEmbedded: embedded, at: Date.now() }));
  clearStats();

  // Seed BEFORE boot: the embedded count rides a cold readiness scan at first read, and
  // map-status deliberately uses the CACHED slice (it is a mount/poll surface).
  // Only NULL-ness matters to the counts, so raw rows are faithful for this assertion.
  const EMBEDDED = 250;          // stands in for the operator's 2510
  const MAPPED_STALE = 36;       // stands in for their 369 (same ~15% ratio)
  const MAPPED_FRESH = 240;      // drift 10 → 4% ≤ tolerance ⇒ fresh
  {
    const d = new Database(DBS);
    applyMigrations(d);
    const ins = d.prepare(`INSERT INTO messages (id, user_id, content, role, created_at, embedding_768, nlp_processed) VALUES (?,?,?,?,?,?,1)`);
    const emb = Buffer.alloc(16, 1);
    const tx = d.transaction(() => { for (let i = 0; i < EMBEDDED; i++) ins.run(`m${i}`, uid, `t${i}`, 'user', '2026-05-01T12:00:00.000Z', emb); });
    tx();
    d.prepare(`INSERT INTO realms (realm_id, user_id, name, essence) VALUES (?,?,?,?)`).run(0, uid, null, null);
    d.prepare(`INSERT INTO territory_profiles (territory_id, user_id, realm_id, name, essence, message_count) VALUES (?,?,?,?,?,?)`).run(2, uid, 0, null, null, MAPPED_STALE);
    const pin = d.prepare(`INSERT INTO clustering_points (user_id, source_type, source_id, territory_id, realm_id, landscape_x, landscape_y, landscape_z, created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
    const ptx = d.transaction((n, from) => { for (let i = from; i < n; i++) pin.run(uid, 'message', `m${i}`, 2, 0, i * 0.01, i * 0.02, i * 0.03, '2026-05-01T12:00:00.000Z'); });
    ptx(MAPPED_STALE, 0);
    d.close();
  }

  const srv = await startRestServer({ dbPath: DBS, kcvPath: KCVS, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url } = srv;
  const jj = async (p, opts) => { const r = await fetch(`${url}${p}`, opts); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
  const P = (p) => `/api/v1/portal${p}`;
  const addPoints = (to, from) => {
    const d = new Database(DBS);
    const pin = d.prepare(`INSERT INTO clustering_points (user_id, source_type, source_id, territory_id, realm_id, landscape_x, landscape_y, landscape_z, created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
    d.transaction(() => { for (let i = from; i < to; i++) pin.run(uid, 'message', `m${i}`, 2, 0, i * 0.01, i * 0.02, i * 0.03, '2026-05-01T12:00:00.000Z'); })();
    d.close();
  };

  try {
    // ── S1: THE DEFECT. 250 embedded, 36 mapped ⇒ STALE ⇒ a run MUST start. ──
    const stale = await jj(P('/mycelium/generate'), { method: 'POST' });
    rec(`S1. a STALE point set (${EMBEDDED} embedded / ${MAPPED_STALE} mapped) is NOT skipped — it rebuilds`,
      stale.status === 200 && stale.body?.status !== 'skipped' && Boolean(stale.body?.jobId),
      `status=${stale.body?.status} reason=${stale.body?.reason ?? '—'} jobId=${stale.body?.jobId ?? 'null'}`);

    // Let the fake child close so the single-flight latch clears (and S6's baseline lands).
    for (let i = 0; i < 60 && (await jj(P(`/mycelium/generate/status/${stale.body?.jobId}`))).body?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // ── S6: a completed run records the freshness baseline (this is what stops S5 looping). ──
    let recorded = null;
    for (let i = 0; i < 60; i++) {
      try { recorded = JSON.parse(readFileSync(statsFile, 'utf8')); } catch { recorded = null; }
      if (recorded?.lastEmbedded != null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    rec('S6. a completed clustering run RECORDS the embedded count as the freshness baseline',
      Number(recorded?.lastEmbedded) === EMBEDDED,
      `lastEmbedded=${recorded?.lastEmbedded ?? 'null'} expected=${EMBEDDED}`);

    // ── S2: THE DEBOUNCE'S REAL PROPERTY. Catch the map up ⇒ FRESH ⇒ MUST skip. ──
    // Cleared baseline on purpose: this asserts the FALLBACK path is fresh-aware too, so
    // "just delete the debounce" cannot pass this gate.
    clearStats();
    addPoints(MAPPED_FRESH, MAPPED_STALE);
    const fresh = await jj(P('/mycelium/generate'), { method: 'POST' });
    rec(`S2. a FRESH point set (${EMBEDDED} embedded / ${MAPPED_FRESH} mapped) IS still skipped — the debounce survives`,
      fresh.status === 200 && fresh.body?.status === 'skipped' && fresh.body?.reason === 'topology_fresh'
      && fresh.body?.map?.mapped === MAPPED_FRESH && fresh.body?.map?.stale === false,
      `status=${fresh.body?.status} reason=${fresh.body?.reason} map=${JSON.stringify(fresh.body?.map)}`);

    // ── S3: POINT-COUNT HONESTY as a first-class served state, not a note in a skip body. ──
    const ms = await jj(P('/mycelium/map-status'));
    rec('S3. GET /mycelium/map-status serves embedded vs mapped (+ drift + stale) as a first-class fact',
      ms.status === 200 && ms.body?.embedded === EMBEDDED && ms.body?.mapped === MAPPED_FRESH
      && typeof ms.body?.stale === 'boolean' && ms.body?.stale === false
      && typeof ms.body?.drift === 'number' && ms.body?.unknown !== true,
      JSON.stringify(ms.body));

    // ── S4: THE REBUILD IS REACHABLE. Same force path the UI button now calls. ──
    const forced = await jj(P('/mycelium/generate?force=1'), { method: 'POST' });
    rec('S4. ?force=1 rebuilds a FRESH map — the path the UI rebuild control drives',
      forced.status === 200 && forced.body?.status !== 'skipped' && Boolean(forced.body?.jobId),
      `status=${forced.body?.status} jobId=${forced.body?.jobId ?? 'null'}`);
    for (let i = 0; i < 60 && (await jj(P(`/mycelium/generate/status/${forced.body?.jobId}`))).body?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // ── S5: NO REBUILD LOOP. With a baseline recorded at the current embedded count, a map
    //    that holds FEWER points than there are embedded messages is still FRESH — because
    //    cluster.py does not promise one point per message, and a mapped-vs-embedded gap that
    //    governed the steady state would re-cluster on every single app launch. The baseline
    //    is what makes the fallback a one-shot. ──
    // The gap must be BIG enough that the fallback would call it stale — otherwise the check
    // passes for the wrong reason (it did, on the first mutation run: a 10-point gap is fresh
    // under BOTH rules, so removing the baseline changed nothing).
    setBaseline(EMBEDDED);
    { const d = new Database(DBS); d.prepare('DELETE FROM clustering_points WHERE user_id = ? AND source_id NOT IN (SELECT source_id FROM clustering_points WHERE user_id = ? LIMIT ?)').run(uid, uid, MAPPED_STALE); d.close(); }
    const looped = await jj(P('/mycelium/generate'), { method: 'POST' });
    const st5 = await jj(P('/mycelium/map-status'));
    rec(`S5. with a recorded baseline, a large mapped<embedded gap (${MAPPED_STALE}/${EMBEDDED}) does NOT re-trigger (no rebuild loop)`,
      looped.body?.status === 'skipped' && looped.body?.reason === 'topology_fresh'
      && st5.body?.basis === 'baseline' && st5.body?.mapped === MAPPED_STALE && st5.body?.stale === false,
      `status=${looped.body?.status} basis=${st5.body?.basis} drift=${st5.body?.drift} mapped=${st5.body?.mapped}`);
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
    if (prevScript === undefined) delete process.env.MYCELIUM_CLUSTER_SCRIPT; else process.env.MYCELIUM_CLUSTER_SCRIPT = prevScript;
    try { rmSync(FAKE); } catch {}
    if (prevStats != null) { try { writeFileSync(statsFile, prevStats); } catch {} } else { try { rmSync(statsFile); } catch {} }
  }
}

main().catch((e) => { console.error('verify-portal-mindscape threw:', e); process.exit(1); });

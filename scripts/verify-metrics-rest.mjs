// verify:metrics-rest — S1. Proves the measurement REST bridge surfaces the
// (now-populated) measurement plane to the HUMAN over HTTP: cognitive-metrics
// window/series/contracts, vitality (per-territory + topology audit), Fisher
// trajectory/current/summary/milestones, and metric-freshness. Seeds a vault
// with crypto.randomBytes keys (NEVER a real keychain), populates representative
// rows THROUGH the booted encrypting adapter (so the sensitive columns are
// encrypted at rest exactly as the pipeline writes them), starts the REST
// server, then asserts every endpoint returns 200 with REAL numbers (not
// null/"unavailable"), that an UNAUTH request is rejected (fail-closed), and
// that NO response body leaks a wrapped-DEK envelope ({v,s,iv,ct,dk}).
// PASS/FAIL ledger; exit 0 only if all pass.

import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';

const DB = 'data/verify-metrics-rest.db';
const KCV = 'data/verify-metrics-rest-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// Wrapped-DEK envelope detector: the at-rest format is base64(JSON{v,s,iv,ct,dk}).
// A leak would put either the raw JSON keys or that base64 blob in a response.
// We scan the SERIALIZED body for the co-occurrence of the envelope keys.
function looksLikeCiphertext(s) {
  if (typeof s !== 'string' || s.length < 24) return false;
  // (a) raw JSON envelope keys present together
  if (/"ct"\s*:/.test(s) && /"dk"\s*:/.test(s) && /"iv"\s*:/.test(s)) return true;
  // (b) a base64 token that decodes to an envelope JSON
  for (const tok of s.match(/[A-Za-z0-9+/]{40,}={0,2}/g) || []) {
    try {
      const dec = Buffer.from(tok, 'base64').toString('utf8');
      if (dec.startsWith('{') && /"v"\s*:/.test(dec) && /"ct"\s*:/.test(dec) && /"dk"\s*:/.test(dec)) return true;
    } catch { /* not base64 */ }
  }
  return false;
}

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url, db } = srv;
  const uid = 'local-user';
  const RUN = 'era-verify-metrics-0001';
  const M = (p) => `/api/v1/portal${p}`;
  const j = async (p, opts = {}) => {
    const r = await fetch(`${url}${p}`, opts);
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  // Collect every authed response body to scan for ciphertext at the end.
  const bodies = [];
  const ja = async (p, opts = {}) => { const r = await j(p, opts); bodies.push({ p, text: r.text }); return r; };

  try {
    // ── Seed measurement data through the encrypting adapter ──────────────────
    const isoDaysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

    // (1) Fisher trajectory: two weekly_step realm windows with a drift so the
    // period summary computes non-trivial distance/displacement. The metric
    // columns (velocity/z/displacement/length/ratio/R_recent) are ENCRYPTED at
    // rest (K1b) — written through db.rawQuery so they're enveloped.
    await db.rawQuery(
      `INSERT INTO fisher_trajectory
        (user_id, level, window_type, window_start, window_end, activation_vector,
         fisher_velocity, fisher_velocity_z, fisher_displacement, fisher_trajectory_length,
         exploration_ratio, phase, phase_recent, activation_entropy, top_contributors,
         message_count, active_territory_count, clustering_run_id, low_confidence, R_recent)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uid, 'realm', 'weekly_step', isoDaysAgo(14), isoDaysAgo(7),
       JSON.stringify({ R1: 0.7, R2: 0.2, R3: 0.1 }),
       0.12, 0.8, 0.20, 0.30, 0.67, 'exploring', 'exploring', 1.05,
       JSON.stringify([{ id: 'R1', delta: 0.3 }]), 42, 3, RUN, 0, 0.55]);
    await db.rawQuery(
      `INSERT INTO fisher_trajectory
        (user_id, level, window_type, window_start, window_end, activation_vector,
         fisher_velocity, fisher_velocity_z, fisher_displacement, fisher_trajectory_length,
         exploration_ratio, phase, phase_recent, activation_entropy, top_contributors,
         message_count, active_territory_count, clustering_run_id, low_confidence, R_recent)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uid, 'realm', 'weekly_step', isoDaysAgo(7), isoDaysAgo(0),
       JSON.stringify({ R1: 0.2, R2: 0.3, R3: 0.5 }),
       0.34, 2.1, 0.55, 0.90, 0.61, 'transforming', 'transforming', 1.42,
       JSON.stringify([{ id: 'R3', delta: 0.4 }, { id: 'R1', delta: -0.5 }]), 51, 3, RUN, 0, 0.72]);

    // (2) Fisher milestone (velocity_z + displacement encrypted).
    await db.rawQuery(
      `INSERT INTO fisher_milestones
        (user_id, rule_type, level, window_start, window_end, phase_from, phase_to,
         velocity_z, displacement, detail, headline, clustering_run_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uid, 'phase_shift', 'realm', isoDaysAgo(7), isoDaysAgo(0), 'exploring', 'transforming',
       2.1, 0.55, JSON.stringify({ note: 'big move' }), 'You shifted into transforming', RUN]);

    // (3) Territory vitality (all six scalars encrypted, SEC-3).
    const vit = (tid, ed, cgr, reach, cpd, depth, vitality, phase) => db.rawQuery(
      `INSERT INTO territory_vitality
        (user_id, territory_id, entropy_diversification, connection_growth_rate, reach,
         cofire_partner_diversity, engagement_depth_normalized, vitality, phase, clustering_run_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [uid, tid, ed, cgr, reach, cpd, depth, vitality, phase, RUN]);
    await vit(10, 0.81, 0.12, 0.40, 0.55, 0.62, 0.74, 'active');
    await vit(11, 0.33, 0.02, 0.10, 0.18, 0.21, 0.22, 'sparse');

    // (4) Topology audit snapshot (all metric scalars encrypted, T1).
    await db.rawQuery(
      `INSERT INTO topology_audit_snapshots
        (user_id, cluster_version, total_territories, total_connections, catchall_count,
         orphan_count, bridge_count, max_degree, mean_degree, degree_gini,
         m2_entropy, m2_delta, m2_trend)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uid, RUN, 12, 28, 1, 2, 3, 7, 4.6, 0.31, 2.84, 0.12, 'expanding']);

    // (5) Cognitive harmonics window (alpha grain). The harmonic columns are
    // plaintext in V1; this drives /metrics/window + /metrics/series.
    // Anchor the era: pipeline_state.cluster.last_success_at → era-<ts> so
    // db.metrics.getCurrentEra resolves to RUN-compatible id. We instead match
    // the window's clustering_run_id to that derived era so getCurrentWindow finds it.
    const clusterTs = isoDaysAgo(0);
    await db.rawQuery(
      `INSERT INTO pipeline_state (user_id, stage_name, last_success_at) VALUES (?,?,?)`,
      [uid, 'cluster', clusterTs]);
    await db.rawQuery(
      `INSERT INTO pipeline_state (user_id, stage_name, last_success_at) VALUES (?,?,?)`,
      [uid, 'cognitive-harmonics', clusterTs]);
    const era = `era-${clusterTs}`;
    const hWin = (windowEnd, a1) => db.rawQuery(
      `INSERT INTO cognitive_metrics_harmonic
        (user_id, window_end, granularity, language, clustering_run_id,
         harmonic_amplitude_alpha_k1, harmonic_amplitude_gamma_k1, autocorrelation_lag1_alpha,
         topology_h0_persistence_entropy, message_count, low_confidence)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [uid, windowEnd, 'alpha', 'en', era, a1, a1 * 0.5, 0.42, 1.73, 30, 0]);
    await hWin(isoDaysAgo(2), 0.61);
    await hWin(isoDaysAgo(1), 0.66);
    await hWin(isoDaysAgo(0), 0.70);

    // ── A. /metrics/window → real harmonic numbers ───────────────────────────
    const win = await ja(M('/metrics/window?granularity=alpha'));
    const winOk = win.status === 200 && win.body?.window_end
      && win.body?.era_id === era
      && typeof win.body?.values?.harmonic_amplitude_alpha_k1 === 'number'
      && win.body.values.harmonic_amplitude_alpha_k1 > 0;
    rec('A. GET /metrics/window → 200 + real harmonic_amplitude (not null)', winOk,
      `status=${win.status} era=${win.body?.era_id} a1=${win.body?.values?.harmonic_amplitude_alpha_k1}`);

    // ── B. /metrics/series → time-series with real values ────────────────────
    const ser = await ja(M('/metrics/series?granularity=alpha&metric=harmonic_amplitude_alpha_k1'));
    const serOk = ser.status === 200 && Array.isArray(ser.body?.series) && ser.body.series.length === 3
      && ser.body.series.every((r) => typeof r.value === 'number');
    rec('B. GET /metrics/series → 200 + 3 windows of real values', serOk,
      `status=${ser.status} n=${ser.body?.series?.length} vals=${ser.body?.series?.map((r) => r.value).join(',')}`);

    // ── C. /metrics/contracts/:family → presentation contract ────────────────
    const con = await ja(M('/metrics/contracts/information_harmonic_amplitude'));
    const conOk = con.status === 200 && con.body?.contract?.refusal_mode && con.body?.contract?.preferred_vocab;
    rec('C. GET /metrics/contracts/:family → 200 + contract', conOk, `status=${con.status}`);
    const con404 = await ja(M('/metrics/contracts/not_a_family'));
    rec('C2. unknown family → 404', con404.status === 404, `status=${con404.status}`);

    // ── D. /vitality/snapshot → real per-territory vitality ──────────────────
    const vis = await ja(M('/vitality/snapshot'));
    const visOk = vis.status === 200 && Array.isArray(vis.body?.territories) && vis.body.territories.length === 2
      && vis.body.territories.every((t) => typeof t.vitality === 'number')
      && typeof vis.body?.summary?.avg_vitality === 'number';
    rec('D. GET /vitality/snapshot → 200 + real vitality scalars (decrypted)', visOk,
      `status=${vis.status} n=${vis.body?.territories?.length} avg=${vis.body?.summary?.avg_vitality} v0=${vis.body?.territories?.[0]?.vitality}`);

    // ── E. /vitality/audit → real topology-health snapshot ───────────────────
    const aud = await ja(M('/vitality/audit'));
    const audOk = aud.status === 200 && aud.body?.audit
      && typeof aud.body.audit.m2_entropy === 'number' && aud.body.audit.m2_entropy > 0
      && typeof aud.body.audit.degree_gini === 'number';
    rec('E. GET /vitality/audit → 200 + real m2_entropy/degree_gini (decrypted)', audOk,
      `status=${aud.status} m2=${aud.body?.audit?.m2_entropy} gini=${aud.body?.audit?.degree_gini} trend=${aud.body?.audit?.m2_trend}`);

    // ── F. /trajectory → paged rows with real metric numbers ─────────────────
    const tj = await ja(M('/trajectory?level=realm&window_type=weekly_step'));
    const tjOk = tj.status === 200 && Array.isArray(tj.body?.trajectory) && tj.body.trajectory.length === 2
      && tj.body.trajectory.every((r) => typeof r.fisher_velocity === 'number');
    rec('F. GET /trajectory → 200 + 2 rows w/ real fisher_velocity (decrypted)', tjOk,
      `status=${tj.status} n=${tj.body?.trajectory?.length} v=${tj.body?.trajectory?.map((r) => r.fisher_velocity).join(',')}`);

    // ── G. /trajectory/current → latest phase row ────────────────────────────
    const cur = await ja(M('/trajectory/current?level=realm'));
    const curOk = cur.status === 200 && cur.body?.current
      && cur.body.current.phase === 'transforming'
      && typeof cur.body.current.fisher_velocity === 'number';
    rec('G. GET /trajectory/current → 200 + classified phase + real velocity', curOk,
      `status=${cur.status} phase=${cur.body?.current?.phase} v=${cur.body?.current?.fisher_velocity}`);

    // ── H. /trajectory/summary → headline numbers (not null) ─────────────────
    const sum = await ja(M('/trajectory/summary?period=month&level=realm'));
    const sumOk = sum.status === 200 && sum.body?.summary
      && typeof sum.body.summary.total_distance === 'number'
      && typeof sum.body.summary.displacement === 'number'
      && sum.body.summary.phase === 'transforming';
    rec('H. GET /trajectory/summary → 200 + real distance/displacement (not null)', sumOk,
      `status=${sum.status} dist=${sum.body?.summary?.total_distance} disp=${sum.body?.summary?.displacement} phase=${sum.body?.summary?.phase}`);

    // ── I. /trajectory/milestones → active milestone ─────────────────────────
    const ms = await ja(M('/trajectory/milestones'));
    const msOk = ms.status === 200 && Array.isArray(ms.body?.milestones) && ms.body.milestones.length === 1
      && ms.body.milestones[0].headline && typeof ms.body.milestones[0].velocity_z === 'number';
    rec('I. GET /trajectory/milestones → 200 + 1 active milestone (real velocity_z)', msOk,
      `status=${ms.status} n=${ms.body?.milestones?.length} z=${ms.body?.milestones?.[0]?.velocity_z}`);

    // ── J. /metric-freshness → per-table verdicts; seeded tables are present ──
    const fr = await ja(M('/metric-freshness'));
    const byTable = Object.fromEntries((fr.body?.metrics || []).map((m) => [m.table, m]));
    const frOk = fr.status === 200 && fr.body?.summary?.total > 0
      && byTable.fisher_trajectory?.present === true && byTable.fisher_trajectory?.last_write
      && byTable.territory_vitality?.last_write
      && byTable.cognitive_metrics_harmonic?.last_write; // pipeline_state probe
    rec('J. GET /metric-freshness → 200 + seeded tables present w/ last_write', frOk,
      `status=${fr.status} total=${fr.body?.summary?.total} fisher=${byTable.fisher_trajectory?.verdict} vitality=${byTable.territory_vitality?.verdict} harmonic=${byTable.cognitive_metrics_harmonic?.verdict}`);

    // ── L. /measurement-health → freshness verdict JOINED with pipeline_state ──
    // Seed a chronically-failed stage so "stale because it failed" is legible.
    await db.rawQuery(
      `INSERT INTO pipeline_state (user_id, stage_name, last_failure_at, last_failure_reason, consecutive_failures, quarantined, last_duration_ms)
       VALUES (?, 'vitality', ?, ?, 3, 1, 1200)`,
      [uid, isoDaysAgo(0), 'vitality: incomplete — 0/42 written, 42 failed (e.g. SQLITE_ERROR)']);
    const mh = await ja(M('/measurement-health'));
    const fam = Object.fromEntries((mh.body?.families || []).map((f) => [f.stage || f.table, f]));
    const vitFam = (mh.body?.families || []).find((f) => f.stage === 'vitality');
    const mhOk = mh.status === 200
      && Array.isArray(mh.body?.families) && mh.body.families.length > 0
      && vitFam?.quarantined === true && /incomplete/.test(vitFam?.last_failure_reason || '')
      && mh.body?.summary?.quarantined >= 1 && mh.body?.summary?.failing >= 1
      && 'fresh' in (mh.body?.summary || {}) // freshness verdict still merged in
      && !!fam['cluster']?.last_success_at;  // a success-only stage surfaces too
    rec('L. GET /measurement-health → 200 + freshness⋈pipeline_state; quarantined legible', mhOk,
      `status=${mh.status} fams=${mh.body?.families?.length} vitQ=${vitFam?.quarantined} q=${mh.body?.summary?.quarantined} failing=${mh.body?.summary?.failing}`);

    // ── K. FAIL-CLOSED: an unauth (proxied) request is rejected with 401 ─────
    // Pattern-B gate: a genuine same-host request never carries x-forwarded-for;
    // setting it simulates a request relayed through a network proxy → 401.
    const unauth = await j(M('/vitality/snapshot'), { headers: { 'x-forwarded-for': '203.0.113.7' } });
    const unauthOk = unauth.status === 401 && !unauth.text.includes('vitality') && !unauth.text.includes('territories');
    rec('K. UNAUTH (x-forwarded-for) → 401, no data leaked', unauthOk,
      `status=${unauth.status} body=${unauth.text.slice(0, 80)}`);
    // Spot-check a second endpoint is gated identically.
    const unauth2 = await j(M('/trajectory/current?level=realm'), { headers: { 'x-forwarded-for': '203.0.113.7' } });
    rec('K2. UNAUTH on /trajectory/current → 401', unauth2.status === 401, `status=${unauth2.status}`);

    // ── L. NO CIPHERTEXT LEAK: scan every authed response body ───────────────
    const leaks = bodies.filter((b) => looksLikeCiphertext(b.text));
    rec('L. No wrapped-DEK envelope ({v,s,iv,ct,dk}) in any response body', leaks.length === 0,
      leaks.length ? `LEAKED in: ${leaks.map((l) => l.p).join(', ')}` : `scanned ${bodies.length} bodies, clean`);

    // ── M. regression: the existing mindscape surface still resolves ─────────
    const mind = await j(M('/mindscape'));
    rec('M. regression: /mindscape still resolves (router not shadowed)', mind.status === 200, `status=${mind.status}`);
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
    for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  }

  const allPass = ledger.every(Boolean);
  console.log('\n' + '='.repeat(64));
  console.log(`VERDICT: ${allPass ? 'GO — S1: measurement REST bridge surfaces real numbers; fail-closed auth; zero ciphertext leak' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
  console.log('='.repeat(64));
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-metrics-rest threw:', e); process.exit(1); });

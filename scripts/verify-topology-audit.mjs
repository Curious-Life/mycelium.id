// verify:topology-audit — T1. Proves pipeline/topology-audit.js computes
// mindscape-health snapshots + findings end-to-end on a seeded vault (T1 FIX:
// no Cloudflare/auth/HTTP — local vault only), that the snapshot metric columns
// and the per-finding metrics + explanation are ENCRYPTED at rest while
// structural columns (finding_type/severity enums, ids) stay plaintext, AND
// that reads through the adapter (db.topology.getLatestAudit / getAuditFindings)
// return decrypted/usable values (with the message_count ORDER BY moved to JS).
// Runs the REAL stage via spawnSync(node …). PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-topo-audit.db', KCV = 'data/verify-topo-audit-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const isEnvelope = (v) => {
  if (typeof v !== 'string') return false;
  try { const o = JSON.parse(Buffer.from(v, 'base64').toString('utf8')); return !!(o.v && o.s && o.iv && o.ct && o.dk); }
  catch { return false; }
};

// ── Seed: a graph that yields ≥1 critical (catch_all) + ≥1 warning (orphan)
//    finding so both the snapshot and the findings table are exercised. ──
const TERRS = [
  { tid: 1, realm: 10, mc: 400, coh: 0.8, cat: 0 },           // well-connected
  { tid: 2, realm: 10, mc: 250, coh: 0.6, cat: 0 },
  { tid: 3, realm: 11, mc: 600, coh: 0.9, cat: 0 },           // cross-realm bridge
  { tid: 4, realm: 12, mc: 120, coh: 0.5, cat: 0 },
  { tid: 5, realm: 11, mc: 90,  coh: 0.4, cat: 0 },
  { tid: 6, realm: 13, mc: 200, coh: 0.05, cat: 1 },          // catch_all → critical
  { tid: 7, realm: 14, mc: 80,  coh: 0.3, cat: 0 },           // orphan (≥50, 0 edges) → warning
];
for (const t of TERRS) {
  await db.rawQuery(
    `INSERT INTO territory_profiles
       (id, user_id, territory_id, realm_id, message_count, coherence, is_catchall, dissolved_at)
     VALUES (?,?,?,?,?,?,?,NULL)`,
    [`tp-${t.tid}`, U, t.tid, t.realm, t.mc, t.coh, t.cat]);
}
// Edges connecting T1/T2/T3/T4/T5 (T6 catch-all + T7 orphan left unconnected).
// Give T3 ≥10 cross-realm connections so it could register as a bridge.
const EDGES = [];
const link = (a, b, wk) => EDGES.push({ a, b, ses: wk * 0.7, wk });
link(1, 2, 0.9); link(1, 3, 0.8); link(2, 3, 0.6); link(3, 4, 0.5); link(3, 5, 0.4);
link(4, 5, 0.3); link(2, 4, 0.3); link(1, 4, 0.4); link(1, 5, 0.5); link(2, 5, 0.6);
for (const e of EDGES) {
  await db.rawQuery(
    `INSERT INTO territory_cofire
       (id, user_id, territory_a, territory_b, cofire_immediate, cofire_session, cofire_daily, cofire_weekly)
     VALUES (?,?,?,?,?,?,?,?)`,
    [`${U}:${e.a}:${e.b}`, U, e.a, e.b, 0, e.ses, e.wk, e.wk]);
}

try {
  // ── A1. topology-audit.js runs clean (local vault only; no Worker/auth) ─────
  const run = spawnSync('node', ['pipeline/topology-audit.js'], {
    encoding: 'utf8',
    env: { ...process.env, MYCELIUM_DB: DB, MYCELIUM_KCV: KCV, MYCELIUM_USER_ID: U,
      USER_MASTER: userHex, SYSTEM_KEY: systemHex },
  });
  rec('A1. topology-audit.js exits 0 on a seeded vault (local vault only — T1 fix)',
    run.status === 0, run.status !== 0 ? (run.stderr || run.stdout || '').slice(-400) : (run.stdout.match(/\[audit\] Snapshot written.*/)?.[0] || ''));

  // ── A2. snapshot + findings populated ──────────────────────────────────────
  const raw = new Database(DB, { readonly: true });
  const snapCount = raw.prepare(`SELECT COUNT(*) n FROM topology_audit_snapshots WHERE user_id=?`).get(U).n;
  const findCount = raw.prepare(`SELECT COUNT(*) n FROM topology_audit_findings WHERE user_id=?`).get(U).n;
  rec('A2. topology_audit_snapshots + topology_audit_findings populated',
    snapCount === 1 && findCount > 0, `snapshots=${snapCount} findings=${findCount}`);

  // ── A3. snapshot metric columns ciphertext; ids/run_at plaintext ────────────
  const snap = raw.prepare(
    `SELECT total_territories, total_connections, catchall_count, orphan_count, bridge_count,
            max_degree, mean_degree, degree_gini, m2_entropy, m2_delta, m2_trend, id, run_at
     FROM topology_audit_snapshots WHERE user_id=? LIMIT 1`).get(U);
  // m2_delta is NULL on the first run (no prior snapshot) → excluded from the enc check.
  const encCols = ['total_territories', 'total_connections', 'catchall_count', 'orphan_count',
    'bridge_count', 'max_degree', 'mean_degree', 'degree_gini', 'm2_entropy', 'm2_trend'];
  const allEnc = snap && encCols.every((c) => isEnvelope(snap[c]));
  rec('A3. snapshot metric columns are envelopes at rest (incl. m2_trend); keys/time plaintext',
    !!allEnc && !isEnvelope(snap.id) && !isEnvelope(String(snap.run_at)) && snap.m2_delta == null,
    snap ? `enc{${encCols.filter((c) => isEnvelope(snap[c])).length}/${encCols.length}} m2_delta=${snap.m2_delta}` : 'no row');

  // ── A4. finding metric columns + explanation ciphertext; enums plaintext ────
  const find = raw.prepare(
    `SELECT message_count, connection_count, connected_realms, coherence, explanation,
            finding_type, severity, snapshot_id, territory_id
     FROM topology_audit_findings WHERE user_id=? AND finding_type='catch_all' LIMIT 1`).get(U);
  raw.close();
  const fEnc = ['message_count', 'connection_count', 'connected_realms', 'coherence', 'explanation'];
  rec('A4. finding metrics + explanation are envelopes at rest; finding_type/severity plaintext',
    find && fEnc.every((c) => isEnvelope(find[c]))
      && !isEnvelope(find.finding_type) && find.finding_type === 'catch_all'
      && !isEnvelope(find.severity) && ['info', 'warning', 'critical'].includes(find.severity),
    find ? `enc{${fEnc.filter((c) => isEnvelope(find[c])).length}/${fEnc.length}} type=${find.finding_type} sev=${find.severity}` : 'no catch_all finding');

  // ── A5. adapter read decrypts + coerces (getLatestAudit numbers + getAuditFindings JS-sort) ─
  const latest = await db.topology.getLatestAudit({ p_user_id: U });
  const findings = await db.topology.getAuditFindings({ p_user_id: U, p_snapshot_id: snap.id, p_limit: 50 });
  // getAuditFindings sorts by severity then DECRYPTED message_count (the SQL
  // ORDER BY on message_count was removed because it's now ciphertext).
  const critFirst = findings.length > 0 && findings[0].severity === 'critical';
  const msgCoerced = findings.every((f) => f.message_count == null || typeof f.message_count === 'number');
  rec('A5. getLatestAudit coerces metrics → numbers; getAuditFindings JS-sorts on decrypted message_count',
    !!latest && typeof latest.m2_entropy === 'number' && typeof latest.degree_gini === 'number'
      && findings.length > 0 && critFirst && msgCoerced,
    latest ? `m2_entropy=${latest.m2_entropy} (typeof ${typeof latest.m2_entropy}) gini=${latest.degree_gini} findings=${findings.length} first_sev=${findings[0]?.severity}` : 'null');

  // ── A6. bounded growth: re-runs PRUNE to KEEP snapshots (no INSERT-forever) ──
  // The stage accumulates 1 snapshot/run. With MYCELIUM_AUDIT_KEEP=2, two more runs
  // must leave exactly 2 snapshots (not 3), zero orphaned findings, and the m2_delta
  // prior preserved (latest snapshot's m2_delta is computed, not null).
  const reEnv = { ...process.env, MYCELIUM_DB: DB, MYCELIUM_KCV: KCV, MYCELIUM_USER_ID: U,
    USER_MASTER: userHex, SYSTEM_KEY: systemHex, MYCELIUM_AUDIT_KEEP: '2' };
  spawnSync('node', ['pipeline/topology-audit.js'], { encoding: 'utf8', env: reEnv });
  spawnSync('node', ['pipeline/topology-audit.js'], { encoding: 'utf8', env: reEnv });
  const raw3 = new Database(DB, { readonly: true });
  const snapN = raw3.prepare(`SELECT COUNT(*) n FROM topology_audit_snapshots WHERE user_id=?`).get(U).n;
  const orphanFinds = raw3.prepare(
    `SELECT COUNT(*) n FROM topology_audit_findings WHERE user_id=? AND snapshot_id NOT IN (SELECT id FROM topology_audit_snapshots WHERE user_id=?)`).get(U, U).n;
  raw3.close();
  const latest2 = await db.topology.getLatestAudit({ p_user_id: U });
  rec('A6. re-runs prune to KEEP snapshots + orphan findings; m2_delta prior preserved',
    snapN === 2 && orphanFinds === 0 && !!latest2 && Number.isFinite(Number(latest2.m2_delta)),
    `snapshots=${snapN} (KEEP=2) orphanFindings=${orphanFinds} m2_delta=${latest2?.m2_delta}`);
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — topology audit computes (local-only); snapshot + findings encrypted at rest; adapter decrypts + JS-sorts; enums plaintext' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

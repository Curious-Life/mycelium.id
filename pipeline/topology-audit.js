#!/usr/bin/env node
/**
 * Topology Audit — V1 single-user port of scripts/topology-audit.js.
 *
 * Read-only analysis of mindscape health (Gamma Separation: reads topology
 * tables, writes ONLY topology_audit_snapshots + topology_audit_findings —
 * never mutates clustering_points / territory_profiles / territory_cofire /
 * territory_neighbors).
 *
 * Computes:
 *   - Degree distribution + Gini coefficient
 *   - Catch-all validation · Orphan detection · Bridge quality scoring
 *   - M2 entropy (Shannon entropy of territory sizes) + delta/trend vs prior run
 *
 * ── T1 FIX: strip all Cloudflare-Worker / auth / HTTP code ──
 * The canonical talked to a Worker D1 proxy over fetch() with a Bearer token
 * (MYA_WORKER_URL + ADMIN_SECRET/AGENT_TOKEN). V1 is single-user with a LOCAL
 * encrypted SQLite vault: all that HTTP/auth plumbing is removed; queries run
 * in-process via src/db (getDb), scope always 'personal'. Identical pattern to
 * pipeline/compute-cofire.js / compute-vitality.js.
 *
 * AT-REST ENCRYPTION: every graph-shape scalar on topology_audit_snapshots and
 * the per-finding metrics + explanation are in ENCRYPTED_FIELDS → the adapter
 * auto-encrypts on INSERT, auto-decrypts on read. finding_type / severity stay
 * plaintext enums; ids/keys/run_at plaintext. The "previous snapshot" read
 * SELECTs m2_entropy ordered by run_at (PLAINTEXT) — fine — but the VALUE
 * decrypts to a STRING, so it's Number()-coerced before the delta math.
 *
 * Never logs explanations or metric values — counts + severity tallies only.
 *
 * Usage:
 *   USER_MASTER=<hex> SYSTEM_KEY=<hex> MYCELIUM_DB=./data/vault.db \
 *     node pipeline/topology-audit.js [--dry-run]
 */

import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { gini, entropyBits, entropyNormalized, countsToProbs } from '../src/metrics/primitives.js';

/**
 * Core stage. Exported for the verify gate.
 * @returns {Promise<{snapshotId:string|null, territories:number, findings:number, critical:number, warning:number}>}
 */
export async function topologyAudit({ db, userId, dryRun = false, log = console.log }) {
  if (!db?.rawQuery) throw new TypeError('topologyAudit: db.rawQuery required');
  if (typeof userId !== 'string') throw new TypeError('topologyAudit: userId required');
  const asArray = (r) => (Array.isArray(r) ? r : (r && Array.isArray(r.results) ? r.results : []));
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  // 1. Territory profiles. coherence/energy are ENCRYPTED (SEC-3) → decrypt+coerce;
  //    message_count / realm_id / is_catchall are plaintext (SQL filter valid).
  const territories = asArray(await db.rawQuery(
    `SELECT territory_id, name, message_count, coherence, energy, realm_id,
            COALESCE(is_catchall, 0) AS is_catchall
     FROM territory_profiles
     WHERE user_id = ? AND message_count > 0 AND dissolved_at IS NULL`,
    [userId],
  ));
  log(`[audit] ${territories.length} territories loaded`);
  if (territories.length === 0) {
    log('[audit] No territories. Exiting.');
    return { snapshotId: null, territories: 0, findings: 0, critical: 0, warning: 0 };
  }

  // 2. Co-firing edges. cofire_* ENCRYPTED (SEC-2) → decrypt+coerce.
  const edges = asArray(await db.rawQuery(
    `SELECT territory_a, territory_b, cofire_session, cofire_weekly
     FROM territory_cofire WHERE user_id = ?`,
    [userId],
  ));
  log(`[audit] ${edges.length} co-firing edges loaded`);

  // 3. Degree distribution.
  const degree = new Map();
  const realmConnections = new Map();
  const strengthSum = new Map();
  const territoryRealm = new Map();

  for (const t of territories) {
    degree.set(t.territory_id, 0);
    realmConnections.set(t.territory_id, new Set());
    strengthSum.set(t.territory_id, 0);
    territoryRealm.set(t.territory_id, t.realm_id);
  }

  for (const e of edges) {
    const s = num(e.cofire_weekly) || num(e.cofire_session);
    if (s <= 0.05) continue;
    for (const tid of [e.territory_a, e.territory_b]) {
      degree.set(tid, (degree.get(tid) || 0) + 1);
      strengthSum.set(tid, (strengthSum.get(tid) || 0) + s);
    }
    const realmA = territoryRealm.get(e.territory_a);
    const realmB = territoryRealm.get(e.territory_b);
    if (realmA != null) realmConnections.get(e.territory_a)?.add(realmB);
    if (realmB != null) realmConnections.get(e.territory_b)?.add(realmA);
  }

  const degrees = [...degree.values()];
  const maxDegree = Math.max(...degrees, 0);
  const meanDegree = degrees.length > 0 ? degrees.reduce((a, b) => a + b, 0) / degrees.length : 0;
  const degreeGini = gini(degrees);

  // 4. M2 entropy — normalized Shannon entropy of (non-catch-all) territory sizes.
  const sizes = territories.filter((t) => !t.is_catchall).map((t) => num(t.message_count));
  const probs = countsToProbs(sizes);
  const m2Normalized = entropyNormalized(probs);
  const m2Entropy = entropyBits(probs);
  const m2MaxEntropy = sizes.length > 1 ? Math.log2(sizes.length) : 1;

  // Previous snapshot for delta. m2_entropy is ENCRYPTED → the adapter decrypts
  // it to a STRING on read; Number()-coerce before delta math (ORDER BY run_at
  // is plaintext, so the "latest" lookup is correct).
  const prevSnapshots = asArray(await db.rawQuery(
    `SELECT m2_entropy FROM topology_audit_snapshots WHERE user_id = ? ORDER BY run_at DESC LIMIT 1`,
    [userId],
  ));
  const prevRaw = prevSnapshots[0]?.m2_entropy;
  const prevEntropy = prevRaw != null && Number.isFinite(Number(prevRaw)) ? Number(prevRaw) : null;
  const m2Delta = prevEntropy != null ? m2Normalized - prevEntropy : null;
  let m2Trend = 'stable';
  if (m2Delta != null) {
    if (m2Delta < -0.05) m2Trend = 'contracting';
    else if (m2Delta > 0.05) m2Trend = 'expanding';
  }

  // 5. Classify territories.
  const findings = [];
  let catchallCount = 0, orphanCount = 0, bridgeCount = 0;

  for (const t of territories) {
    const d = degree.get(t.territory_id) || 0;
    const connRealms = realmConnections.get(t.territory_id)?.size || 0;
    const avgStrength = d > 0 ? (strengthSum.get(t.territory_id) || 0) / d : 0;
    const coherence = num(t.coherence);
    const messageCount = num(t.message_count);

    let findingType = 'healthy';
    let severity = 'info';
    let explanation = '';
    let bridgeQuality = null;

    if (t.is_catchall) {
      findingType = 'catch_all';
      severity = 'critical';
      explanation = `${messageCount} messages, coherence ${coherence.toFixed(2)} — statistical outlier with low coherence`;
      catchallCount++;
    } else if (d === 0 && messageCount >= 50) {
      findingType = 'orphan';
      severity = 'warning';
      explanation = `${messageCount} messages with 0 co-firing connections — invisible to topology navigation`;
      orphanCount++;
    } else if (d >= 10 && connRealms > 1) {
      bridgeQuality = avgStrength * coherence;
      if (bridgeQuality < 0.3) {
        findingType = 'wishful_bridge';
        severity = 'warning';
        explanation = `${d} connections across ${connRealms} realms but low quality (${bridgeQuality.toFixed(2)}) — likely absorbing connectivity`;
      } else {
        findingType = 'healthy_bridge';
        severity = 'info';
        explanation = `${d} connections across ${connRealms} realms, quality ${bridgeQuality.toFixed(2)}`;
        bridgeCount++;
      }
    } else if (d > 0) {
      findingType = 'healthy';
      severity = 'info';
    }

    findings.push({
      territory_id: t.territory_id,
      finding_type: findingType,
      severity,
      message_count: messageCount,
      connection_count: d,
      connected_realms: connRealms,
      coherence,
      bridge_quality: bridgeQuality,
      explanation,
    });
  }

  const criticalCount = findings.filter((f) => f.severity === 'critical').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;

  // Counts only — never log explanations or metric values.
  log(`[audit] territories=${territories.length} (catchall=${catchallCount} orphan=${orphanCount} bridges=${bridgeCount})`);
  log(`[audit] edges=${edges.length} maxDegree=${maxDegree} findings: ${criticalCount} critical, ${warningCount} warning`);

  if (dryRun) {
    log('[audit] Dry run — not writing');
    return { snapshotId: null, territories: territories.length, findings: 0, critical: criticalCount, warning: warningCount };
  }

  // 7. Write snapshot. All metric columns are ENCRYPTED by the adapter; id /
  //    user_id / run_at(default) stay plaintext. m2_trend is encrypted too.
  const snapshotId = crypto.randomUUID();
  await db.rawQuery(
    `INSERT INTO topology_audit_snapshots
       (id, user_id, total_territories, total_connections, catchall_count,
        orphan_count, bridge_count, max_degree, mean_degree, degree_gini,
        m2_entropy, m2_delta, m2_trend)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [snapshotId, userId, territories.length, edges.length, catchallCount,
     orphanCount, bridgeCount, maxDegree, Math.round(meanDegree * 100) / 100,
     Math.round(degreeGini * 1000) / 1000,
     Math.round(m2Normalized * 1000) / 1000,
     m2Delta != null ? Math.round(m2Delta * 1000) / 1000 : null,
     m2Trend],
  );

  // 8. Write non-healthy findings only (keep the table small). Each metric
  //    column + explanation is ENCRYPTED by the adapter.
  const nonHealthy = findings.filter((f) => f.finding_type !== 'healthy');
  let writtenFindings = 0;
  for (const f of nonHealthy) {
    try {
      await db.rawQuery(
        `INSERT INTO topology_audit_findings
           (id, snapshot_id, user_id, territory_id, finding_type, severity,
            message_count, connection_count, connected_realms, coherence,
            bridge_quality, explanation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), snapshotId, userId, f.territory_id,
         f.finding_type, f.severity, f.message_count, f.connection_count,
         f.connected_realms, Math.round(f.coherence * 1000) / 1000,
         f.bridge_quality != null ? Math.round(f.bridge_quality * 1000) / 1000 : null,
         f.explanation],
      );
      writtenFindings++;
    } catch (err) {
      log(`[audit] finding insert failed for T${f.territory_id}: ${err.message}`);
    }
  }

  log(`[audit] Snapshot written with ${writtenFindings} findings`);
  // Suppress unused m2Entropy/m2MaxEntropy lints — kept for parity (diagnostic).
  void m2Entropy; void m2MaxEntropy;
  return { snapshotId, territories: territories.length, findings: writtenFindings, critical: criticalCount, warning: warningCount };
}

// ── CLI wrapper ──────────────────────────────────────────────────────────────
// boot() (NOT getDb-with-hex): unlock() turns the hex keys into CryptoKeys so the
// adapter's auto-encrypt of the snapshot/finding metric columns actually runs
// (see compute-vitality.js for the rationale).
async function runCli() {
  const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
  const DB_PATH = process.env.MYCELIUM_DB || './data/vault.db';
  if (!process.env.USER_MASTER || !process.env.SYSTEM_KEY) {
    console.error('Missing: USER_MASTER and SYSTEM_KEY (64-char hex each)');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');

  const { boot } = await import('../src/index.js');
  const { db, close } = await boot({
    dbPath: DB_PATH,
    userHex: process.env.USER_MASTER,
    systemHex: process.env.SYSTEM_KEY,
    userId: USER_ID,
    embedder: null,
  });
  try {
    await topologyAudit({ db, userId: USER_ID, dryRun });
  } finally {
    close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((err) => { console.error('[audit] Fatal:', err); process.exit(1); });
}

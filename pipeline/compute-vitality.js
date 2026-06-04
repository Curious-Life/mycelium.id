#!/usr/bin/env node
/**
 * Territory Vitality Scoring — V1 single-user port of scripts/compute-vitality.js.
 *
 * Computes a behavioral phase for each territory:
 *   Sparse (0.0–0.33):  contracting, looping, isolated
 *   Active (0.33–0.66): actively forming connections
 *   Anchor (0.66–1.0):  genuine cross-domain bridge
 *
 * Reads from: territory_profiles, territory_cofire.
 * Writes to:  territory_vitality, territory_profiles (cached current_vitality /
 *             current_phase).
 *
 * V1 single-user port: reads/writes the local encrypted SQLite vault in-process
 * via src/db (no Worker proxy, no MINDSCAPE_OWNER_ID / AGENT_TOKEN auth plumbing,
 * scope always 'personal'). Mirrors pipeline/compute-cofire.js.
 *
 * ── T1 FIX: scale the canonical magic-constant thresholds to the LOCAL vault ──
 * The canonical script hard-coded thresholds tuned for a large CLOUD vault
 * (realmBreadth / 6.0, themeBreadth / 10.0, nicheBreadth / 20.0, etc.). On a
 * small local vault those denominators are far larger than any achievable count,
 * so every territory's reach/breadth signals floor at ~0 and vitality collapses
 * to a degenerate "everything is sparse". Here those magic constants are derived
 * from the actual vault size at runtime (number of realms, themes, and the p90
 * partner/message counts) so the signals stay well-distributed regardless of
 * scale. Each derived denominator is documented inline at its use site. We keep
 * the canonical WEIGHTS (they're scale-free ratios) and the same composite.
 *
 * AT-REST ENCRYPTION: the six territory_vitality metric scalars are in
 * ENCRYPTED_FIELDS (crypto-local.js) → the adapter auto-encrypts them on the
 * INSERT and auto-decrypts on read; territory_profiles.current_vitality is also
 * encrypted (SEC-3). No SQL filters/sorts/aggregates over the encrypted columns
 * (all combining happens in JS over plaintext signals), so nothing to rework.
 * phase / current_phase are plaintext enums. Never logs metric VALUES — counts
 * and phase tallies only.
 *
 * Usage:
 *   USER_MASTER=<hex> SYSTEM_KEY=<hex> MYCELIUM_DB=./data/vault.db \
 *     node pipeline/compute-vitality.js [--dry-run]
 */

import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { cosineSim } from '../src/metrics/primitives.js';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** p-th percentile (0..1) of a numeric array; floor 1. Falls back to 1 on empty. */
function percentile(arr, p) {
  if (!arr.length) return 1;
  const sorted = [...arr].sort((a, b) => a - b);
  return Math.max(1, sorted[Math.floor(sorted.length * p)] || 1);
}

/**
 * Core stage: compute + persist vitality for every active territory.
 * Exported for the verify gate (unit-testable against a booted vault).
 *
 * @param {object}  deps
 * @param {object}  deps.db      assembled db (needs db.rawQuery; auto-crypts)
 * @param {string}  deps.userId  single-user scope id
 * @param {string}  [deps.runId] clustering_run_id stamped on rows (nullable)
 * @param {boolean} [deps.dryRun]
 * @param {(s:string)=>void} [deps.log]
 * @returns {Promise<{territories:number, written:number, sparse:number, active:number, anchor:number}>}
 */
export async function computeVitality({ db, userId, runId = null, dryRun = false, log = console.log }) {
  if (!db?.rawQuery) throw new TypeError('computeVitality: db.rawQuery required');
  if (typeof userId !== 'string') throw new TypeError('computeVitality: userId required');
  const asArray = (r) => (Array.isArray(r) ? r : (r && Array.isArray(r.results) ? r.results : []));
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

  // Active, non-dissolved territories. coherence/energy are ENCRYPTED (SEC-3) —
  // the adapter decrypts them to strings on read; num() coerces. message_count
  // stays plaintext (structural ranking key). centroid_256 is encrypted JSON.
  const territories = asArray(await db.rawQuery(
    `SELECT territory_id, name, message_count, coherence, energy, realm_id,
            semantic_theme_id, COALESCE(is_catchall, 0) AS is_catchall, centroid_256
     FROM territory_profiles
     WHERE user_id = ? AND message_count > 0 AND dissolved_at IS NULL`,
    [userId],
  ));
  log(`[vitality] ${territories.length} territories`);
  if (territories.length === 0) {
    log('[vitality] No territories. Exiting.');
    return { territories: 0, written: 0, sparse: 0, active: 0, anchor: 0 };
  }

  // Co-firing edges (4 timescales). cofire_* are ENCRYPTED (SEC-2) → decrypt+coerce.
  const edges = asArray(await db.rawQuery(
    `SELECT territory_a, territory_b,
            cofire_immediate, cofire_session, cofire_daily, cofire_weekly
     FROM territory_cofire WHERE user_id = ?`,
    [userId],
  ));

  // Build degree + partner maps + temporal momentum per territory.
  const degree = new Map();
  const partners = new Map();
  const partnerRealms = new Map();
  const partnerThemes = new Map();
  const intraRealmPartners = new Map();
  const territoryRealm = new Map();
  const territoryTheme = new Map();
  const catchAllSet = new Set();
  const shortTermStrength = new Map();
  const longTermStrength = new Map();

  for (const t of territories) {
    degree.set(t.territory_id, 0);
    partners.set(t.territory_id, new Set());
    partnerRealms.set(t.territory_id, new Set());
    partnerThemes.set(t.territory_id, new Set());
    intraRealmPartners.set(t.territory_id, 0);
    territoryRealm.set(t.territory_id, t.realm_id);
    territoryTheme.set(t.territory_id, t.semantic_theme_id);
    shortTermStrength.set(t.territory_id, 0);
    longTermStrength.set(t.territory_id, 0);
    if (t.is_catchall) catchAllSet.add(t.territory_id);
  }

  for (const e of edges) {
    const weekly = num(e.cofire_weekly);
    if (weekly <= 0.05) continue;
    if (catchAllSet.has(e.territory_a) || catchAllSet.has(e.territory_b)) continue;

    const shortTerm = num(e.cofire_immediate) + num(e.cofire_session);
    const longTerm = num(e.cofire_daily) + num(e.cofire_weekly);

    for (const [tid, other] of [[e.territory_a, e.territory_b], [e.territory_b, e.territory_a]]) {
      degree.set(tid, (degree.get(tid) || 0) + 1);
      partners.get(tid)?.add(other);
      shortTermStrength.set(tid, (shortTermStrength.get(tid) || 0) + shortTerm);
      longTermStrength.set(tid, (longTermStrength.get(tid) || 0) + longTerm);

      const otherRealm = territoryRealm.get(other);
      const otherTheme = territoryTheme.get(other);
      if (otherRealm != null) partnerRealms.get(tid)?.add(otherRealm);
      if (otherTheme != null) partnerThemes.get(tid)?.add(otherTheme);

      const ownRealm = territoryRealm.get(tid);
      if (ownRealm != null && otherRealm === ownRealm) {
        intraRealmPartners.set(tid, (intraRealmPartners.get(tid) || 0) + 1);
      }
    }
  }

  const active = territories.filter((t) => !t.is_catchall);

  // ── T1 FIX: vault-size-derived denominators (replace the cloud magic numbers) ──
  // realmDenom: canonical "/ 6.0" assumed ~6 realms. Derive from the actual realm
  // count so realmBreadth spans [0,1] on THIS vault (a 3-realm vault now reaches 1
  // at 3 cross-realm partners, not 6). Floor 1 to avoid divide-by-zero.
  const realmDenom = Math.max(1, new Set(active.map((t) => t.realm_id).filter((r) => r != null)).size);
  // themeDenom: canonical "/ 10.0". Derive from the distinct semantic-theme count.
  const themeDenom = Math.max(1, new Set(active.map((t) => t.semantic_theme_id).filter((th) => th != null)).size);
  // nicheDenom: canonical "/ 20.0" (partner-set size). Use p90 of the actual
  // partner-set sizes so partner-diversity isn't degenerate on a small graph.
  const nicheDenom = percentile(active.map((t) => (partners.get(t.territory_id) || new Set()).size), 0.9);
  // p90 intra-realm partner count — local-breadth normalization (canonical kept
  // this one data-derived already; preserved).
  const p90Intra = percentile(active.map((t) => intraRealmPartners.get(t.territory_id) || 0), 0.9);
  // p90 message count — engagement-depth normalization (canonical was data-derived).
  const p90Messages = percentile(active.map((t) => num(t.message_count)), 0.9);

  log(`[vitality] denominators: realms=${realmDenom} themes=${themeDenom} p90niche=${nicheDenom} p90intra=${p90Intra} p90msgs=${p90Messages}`);

  // Parse centroids (encrypted JSON → decrypted JSON string → array).
  const centroids = new Map();
  for (const t of territories) {
    if (t.centroid_256) {
      try {
        const v = typeof t.centroid_256 === 'string' ? JSON.parse(t.centroid_256) : t.centroid_256;
        if (Array.isArray(v) && v.length) centroids.set(t.territory_id, v);
      } catch { /* skip malformed */ }
    }
  }

  const results = [];
  for (const t of territories) {
    if (t.is_catchall) {
      results.push({
        territory_id: t.territory_id, vitality: 0, phase: 'sparse',
        entropy_diversification: 0, connection_growth_rate: 0, reach: 0,
        cofire_partner_diversity: 0, engagement_depth_normalized: 0, connection_count: 0,
      });
      continue;
    }

    const d = degree.get(t.territory_id) || 0;
    const partnerSet = partners.get(t.territory_id) || new Set();
    const realmSet = partnerRealms.get(t.territory_id) || new Set();
    const coherence = num(t.coherence);
    const energy = num(t.energy);

    // Signal 1: Entropy direction — coherence × attention share (scale-free).
    const diversification = clamp(coherence * 0.7 + Math.min(energy * 50, 1) * 0.3, 0, 1);

    // Signal 2: Connection growth — temporal momentum from co-fire scales (ratio).
    let growth = 0;
    const st = shortTermStrength.get(t.territory_id) || 0;
    const lt = longTermStrength.get(t.territory_id) || 0;
    if (lt > 0) {
      const momentum = st / lt;
      growth = clamp((momentum - 0.05) / 0.25, 0, 1);
    } else if (st > 0) {
      growth = 1.0;
    }

    // Signal 3: Bridge health — multi-level, with VAULT-DERIVED denominators.
    let reach = 0;
    if (d > 0) {
      const realmCount = realmSet.size;
      const themeCount = (partnerThemes.get(t.territory_id) || new Set()).size;
      const intraCount = intraRealmPartners.get(t.territory_id) || 0;
      const seedCentroid = centroids.get(t.territory_id);

      let meanDistance = 0;
      if (seedCentroid && partnerSet.size > 0) {
        let distSum = 0, distCount = 0;
        for (const pid of partnerSet) {
          const pc = centroids.get(pid);
          if (pc) { distSum += 1.0 - cosineSim(seedCentroid, pc); distCount++; }
        }
        meanDistance = distCount > 0 ? distSum / distCount : 0;
      }

      // T1 FIX: realmDenom/themeDenom/p90Intra replace 6.0/10.0/p90 magic numbers.
      const bhRealmBreadth = clamp(realmCount / realmDenom, 0, 1);
      const bhThemeBreadth = clamp(themeCount / themeDenom, 0, 1);
      const bhLocalBreadth = clamp(intraCount / p90Intra, 0, 1);
      const bhSemanticSpan = clamp(meanDistance, 0, 1);

      // Canonical weights (scale-free) preserved.
      reach = clamp(
        0.40 * bhRealmBreadth + 0.25 * bhThemeBreadth +
        0.10 * bhLocalBreadth + 0.25 * bhSemanticSpan,
        0, 1,
      );
    }

    // Signal 4: Partner diversity — T1 FIX: nicheDenom (p90 partner count) vs "/20".
    const nicheBreadth = clamp(partnerSet.size / nicheDenom, 0, 1);

    // Signal 5: Engagement depth — message density × coherence (data-derived p90).
    const engagementDepth = clamp((num(t.message_count) / p90Messages) * coherence, 0, 1);

    // Composite — canonical weights (content 45% + connectivity 55%).
    const vitality = 0.25 * diversification + 0.20 * engagementDepth +
      0.20 * growth + 0.20 * reach + 0.15 * nicheBreadth;
    const phase = vitality < 0.33 ? 'sparse' : vitality < 0.66 ? 'active' : 'anchor';

    const r3 = (x) => Math.round(x * 1000) / 1000;
    results.push({
      territory_id: t.territory_id,
      vitality: r3(vitality),
      phase,
      entropy_diversification: r3(diversification),
      connection_growth_rate: r3(growth),
      reach: r3(reach),
      cofire_partner_diversity: r3(nicheBreadth),
      engagement_depth_normalized: r3(engagementDepth),
      connection_count: d,
    });
  }

  const sparse = results.filter((r) => r.phase === 'sparse').length;
  const activeN = results.filter((r) => r.phase === 'active').length;
  const anchor = results.filter((r) => r.phase === 'anchor').length;
  // Counts + phase tallies only — never log metric values.
  log(`[vitality] phases: ${sparse} sparse, ${activeN} active, ${anchor} anchor`);

  if (dryRun) {
    log('[vitality] Dry run — not writing');
    return { territories: territories.length, written: 0, sparse, active: activeN, anchor };
  }

  let written = 0;
  for (const r of results) {
    try {
      await db.rawQuery(
        `INSERT INTO territory_vitality
           (id, user_id, territory_id, entropy_diversification, connection_growth_rate,
            reach, cofire_partner_diversity, engagement_depth_normalized, vitality, phase,
            clustering_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), userId, r.territory_id,
         r.entropy_diversification, r.connection_growth_rate, r.reach,
         r.cofire_partner_diversity, r.engagement_depth_normalized, r.vitality, r.phase,
         runId],
      );
      written++;
    } catch (err) {
      log(`[vitality] insert failed for T${r.territory_id}: ${err.message}`);
    }
  }

  // Cache current_vitality (ENCRYPTED, SEC-3) + current_phase (plaintext enum)
  // on territory_profiles. The UPDATE's value column is the encrypted one; the
  // adapter encrypts it because territory_profiles.current_vitality is listed.
  for (const r of results) {
    await db.rawQuery(
      `UPDATE territory_profiles SET current_vitality = ?, current_phase = ?
       WHERE user_id = ? AND territory_id = ?`,
      [r.vitality, r.phase, userId, r.territory_id],
    );
  }

  log(`[vitality] Done: ${written} vitality scores written`);
  return { territories: territories.length, written, sparse, active: activeN, anchor };
}

// ── CLI wrapper (only when invoked directly, never on import) ────────────────
// Uses boot() (NOT getDb with raw hex): boot runs unlock() to turn the hex keys
// into CryptoKeys + KCV-verifies before any write — without it, the adapter's
// auto-encrypt path throws "argument is not of type CryptoKey" on every encrypted
// column and silently swallows the write (latent in the older getDb-hex CLI
// wrappers). boot reads USER_MASTER/SYSTEM_KEY from env via the key source.
async function runCli() {
  const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
  const DB_PATH = process.env.MYCELIUM_DB || './data/vault.db';
  if (!process.env.USER_MASTER || !process.env.SYSTEM_KEY) {
    console.error('Missing: USER_MASTER and SYSTEM_KEY (64-char hex each)');
    process.exit(1);
  }
  const runId = process.env.CLUSTERING_RUN_ID || null;
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
    await computeVitality({ db, userId: USER_ID, runId, dryRun });
  } finally {
    close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((err) => { console.error('[vitality] Fatal:', err); process.exit(1); });
}

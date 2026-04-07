#!/usr/bin/env node
/**
 * Compute embedding-based cognitive fingerprint scores for a user.
 *
 * Four scores (0–1):
 *   - Depth:       avg intra-cluster cosine distance (how deep within territories)
 *   - Breadth:     log-normalized distinct territory count
 *   - Coherence:   mean pairwise cosine similarity of territory centroids
 *   - Exploration:  entropy of per-message territory transition matrix
 *
 * Writes results to user_profiles via the Worker DB proxy.
 *
 * Usage: MYA_WORKER_URL=... ADMIN_SECRET=... node scripts/compute-cognitive-fingerprint.js [--dry-run]
 */

import 'dotenv/config';

const WORKER_URL = process.env.MYA_WORKER_URL;
const TOKEN = process.env.ADMIN_SECRET || process.env.AGENT_TOKEN;
const USER_ID = process.env.USER_ID || process.env.MYA_USER_ID;
const DRY_RUN = process.argv.includes('--dry-run');

if (!WORKER_URL || !TOKEN || !USER_ID) {
  console.error('Missing: MYA_WORKER_URL, ADMIN_SECRET/AGENT_TOKEN, USER_ID/MYA_USER_ID');
  process.exit(1);
}

const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` };

async function query(sql, params = []) {
  const res = await fetch(`${WORKER_URL}/api/db/query`, {
    method: 'POST', headers,
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Query failed: ${res.status} ${await res.text()}`);
  return (await res.json()).results || [];
}

// ── Vector math ──────────────────────────────────────────────────────────────

function decodeBlob(hexStr) {
  const buf = Buffer.from(hexStr, 'hex');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

// Sigmoid normalization: maps raw value to [0, 1]
function sigmoid(x, midpoint, steepness) {
  return 1 / (1 + Math.exp(-steepness * (x - midpoint)));
}

// ── Score 1: Depth ───────────────────────────────────────────────────────────
// Average intra-cluster cosine distance (embeddings vs territory centroids)
// Higher = user explores nuances within territories, not just surface

async function computeDepth(userId) {
  console.log('[fingerprint] Computing depth...');

  // Fetch territory centroids
  const centroids = await query(
    `SELECT territory_id, centroid_256 FROM territory_profiles
     WHERE user_id = ? AND centroid_256 IS NOT NULL AND dissolved_at IS NULL`,
    [userId],
  );
  const centroidMap = new Map();
  for (const row of centroids) {
    try {
      centroidMap.set(row.territory_id, new Float32Array(JSON.parse(row.centroid_256)));
    } catch {}
  }
  if (centroidMap.size === 0) return { depthScore: 0, rawDepth: 0, pointCount: 0 };

  // Sample up to 50 embeddings per territory (ROW_NUMBER is supported in D1/SQLite)
  const sampled = await query(
    `SELECT territory_id, nomic_embedding FROM (
       SELECT territory_id, nomic_embedding,
         ROW_NUMBER() OVER (PARTITION BY territory_id ORDER BY RANDOM()) as rn
       FROM clustering_points
       WHERE user_id = ? AND territory_id IS NOT NULL AND nomic_embedding IS NOT NULL
     ) WHERE rn <= 50`,
    [userId],
  );

  let totalWeightedDist = 0;
  let totalWeight = 0;

  // Group by territory, compute mean distance
  const byTerritory = new Map();
  for (const p of sampled) {
    const centroid = centroidMap.get(p.territory_id);
    if (!centroid || !p.nomic_embedding) continue;
    if (!byTerritory.has(p.territory_id)) byTerritory.set(p.territory_id, []);
    const emb = decodeBlob(p.nomic_embedding);
    const dist = 1 - cosineSimilarity(emb, centroid);
    byTerritory.get(p.territory_id).push(dist);
  }

  for (const [, dists] of byTerritory) {
    const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
    totalWeightedDist += mean * dists.length;
    totalWeight += dists.length;
  }

  const rawDepth = totalWeight > 0 ? totalWeightedDist / totalWeight : 0;
  // Sigmoid: midpoint=0.25, steepness=12. Maps typical range [0.1, 0.5] → [0.15, 0.95]
  const depthScore = sigmoid(rawDepth, 0.25, 12);

  console.log(`  raw=${rawDepth.toFixed(4)}, score=${depthScore.toFixed(2)}, samples=${totalWeight}, territories=${byTerritory.size}`);
  return { depthScore: Math.round(depthScore * 100) / 100, rawDepth, pointCount: totalWeight };
}

// ── Score 2: Breadth ─────────────────────────────────────────────────────────
// Log-normalized distinct territory count. 300 territories = 1.0.

async function computeBreadth(userId) {
  console.log('[fingerprint] Computing breadth...');
  const [row] = await query(
    `SELECT COUNT(DISTINCT territory_id) as cnt FROM clustering_points
     WHERE user_id = ? AND territory_id IS NOT NULL`,
    [userId],
  );
  const count = row?.cnt || 0;
  const MAX_TERRITORIES = 300;
  const breadthScore = Math.min(1, Math.log(1 + count) / Math.log(1 + MAX_TERRITORIES));

  console.log(`  territories=${count}, score=${breadthScore.toFixed(2)}`);
  return { breadthScore: Math.round(breadthScore * 100) / 100, rawBreadth: count };
}

// ── Score 3: Coherence ───────────────────────────────────────────────────────
// Mean pairwise cosine similarity of territory centroids.
// Higher = thinking is interconnected across territories.

async function computeCoherence(userId) {
  console.log('[fingerprint] Computing coherence...');
  const profiles = await query(
    `SELECT territory_id, centroid_256 FROM territory_profiles
     WHERE user_id = ? AND centroid_256 IS NOT NULL AND dissolved_at IS NULL`,
    [userId],
  );

  const centroids = [];
  for (const r of profiles) {
    try { centroids.push(new Float32Array(JSON.parse(r.centroid_256))); } catch {}
  }

  const N = centroids.length;
  if (N < 2) return { coherenceScore: 0, rawCoherence: 0 };

  let sumSim = 0;
  let pairs = 0;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      sumSim += cosineSimilarity(centroids[i], centroids[j]);
      pairs++;
    }
  }

  const rawCoherence = sumSim / pairs;
  // Rescale typical range [0.05, 0.50] → [0, 1]
  const coherenceScore = Math.max(0, Math.min(1, (rawCoherence - 0.05) / 0.45));

  console.log(`  pairs=${pairs}, raw=${rawCoherence.toFixed(4)}, score=${coherenceScore.toFixed(2)}`);
  return { coherenceScore: Math.round(coherenceScore * 100) / 100, rawCoherence };
}

// ── Score 4: Exploration ─────────────────────────────────────────────────────
// Entropy of per-message territory transition matrix (skip self-transitions).
// Higher = user moves unpredictably between territories.

async function computeExploration(userId) {
  console.log('[fingerprint] Computing exploration...');
  const points = await query(
    `SELECT territory_id, created_at FROM clustering_points
     WHERE user_id = ? AND territory_id IS NOT NULL
     ORDER BY created_at`,
    [userId],
  );

  if (points.length < 2) return { explorationScore: 0, rawExploration: 0, months: 0 };

  // Build transition counts (skip self-transitions)
  const transitions = new Map(); // from → Map(to → count)
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i].territory_id;
    const to = points[i + 1].territory_id;
    if (from === to) continue;
    if (!transitions.has(from)) transitions.set(from, new Map());
    const row = transitions.get(from);
    row.set(to, (row.get(to) || 0) + 1);
  }

  // Compute weighted entropy
  let totalWeight = 0;
  let weightedEntropy = 0;
  for (const [, row] of transitions) {
    const rowSum = [...row.values()].reduce((a, b) => a + b, 0);
    let H = 0;
    for (const count of row.values()) {
      const p = count / rowSum;
      if (p > 0) H -= p * Math.log2(p);
    }
    weightedEntropy += rowSum * H;
    totalWeight += rowSum;
  }

  const rawEntropy = totalWeight > 0 ? weightedEntropy / totalWeight : 0;
  const distinctTerritories = new Set(points.map(p => p.territory_id)).size;
  const maxEntropy = Math.log2(Math.max(2, distinctTerritories));
  const explorationScore = maxEntropy > 0 ? Math.min(1, rawEntropy / maxEntropy) : 0;

  const months = new Set(points.map(p => (p.created_at || '').slice(0, 7))).size;

  console.log(`  transitions=${totalWeight}, distinct=${distinctTerritories}, raw=${rawEntropy.toFixed(4)}, maxH=${maxEntropy.toFixed(2)}, score=${explorationScore.toFixed(2)}, months=${months}`);
  return { explorationScore: Math.round(explorationScore * 100) / 100, rawExploration: rawEntropy, months };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`[fingerprint] Computing cognitive fingerprint for user=${USER_ID}`);
  const t0 = Date.now();

  const [depth, breadth, coherence, exploration] = await Promise.all([
    computeDepth(USER_ID),
    computeBreadth(USER_ID),
    computeCoherence(USER_ID),
    computeExploration(USER_ID),
  ]);

  // Also fetch basic counts for profile
  const [countRow] = await query(
    `SELECT COUNT(DISTINCT territory_id) as tc, COUNT(DISTINCT realm_id) as rc
     FROM territory_profiles WHERE user_id = ? AND dissolved_at IS NULL`,
    [USER_ID],
  );
  const [msgRow] = await query(
    `SELECT COUNT(*) as mc, MIN(created_at) as ms FROM messages WHERE user_id = ?`,
    [USER_ID],
  );

  // Realm names for public profile
  const realmRows = await query(
    `SELECT DISTINCT name FROM realms WHERE user_id = ? AND name IS NOT NULL`,
    [USER_ID],
  );
  const publicRealms = realmRows.map(r => r.name).filter(Boolean);

  const profile = {
    depth_score: depth.depthScore,
    breadth_score: breadth.breadthScore,
    coherence_score: coherence.coherenceScore,
    exploration_score: exploration.explorationScore,
    territory_count: countRow?.tc || 0,
    realm_count: countRow?.rc || 0,
    message_count: msgRow?.mc || 0,
    member_since: msgRow?.ms || null,
    public_realms_json: JSON.stringify(publicRealms),
  };

  console.log('\n[fingerprint] Results:');
  console.log(`  Depth:       ${profile.depth_score} (raw: ${depth.rawDepth.toFixed(4)}, ${depth.pointCount} samples)`);
  console.log(`  Breadth:     ${profile.breadth_score} (${breadth.rawBreadth} territories)`);
  console.log(`  Coherence:   ${profile.coherence_score} (raw: ${coherence.rawCoherence.toFixed(4)})`);
  console.log(`  Exploration: ${profile.exploration_score} (raw: ${exploration.rawExploration.toFixed(4)}, ${exploration.months} months)`);
  console.log(`  Territories: ${profile.territory_count}, Realms: ${profile.realm_count}, Messages: ${profile.message_count}`);

  if (DRY_RUN) {
    console.log('\n[fingerprint] DRY RUN — not writing to database');
  } else {
    // Upsert user_profiles
    const setCols = Object.entries(profile)
      .map(([k]) => `${k} = excluded.${k}`)
      .join(', ');
    const cols = ['user_id', ...Object.keys(profile)];
    const vals = [USER_ID, ...Object.values(profile)];
    const placeholders = cols.map(() => '?').join(', ');

    await query(
      `INSERT INTO user_profiles (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT (user_id) DO UPDATE SET ${setCols}, updated_at = datetime('now')`,
      vals,
    );
    console.log('\n[fingerprint] Written to user_profiles');
  }

  console.log(`[fingerprint] Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

run().catch(e => {
  console.error('[fingerprint] Fatal:', e);
  process.exit(1);
});

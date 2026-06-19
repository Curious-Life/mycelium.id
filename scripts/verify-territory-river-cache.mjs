// verify:territory-river-cache — proves the territory-river perf cache is correct
// AND honest. The endpoint folds 400+ encrypted weekly activation vectors into
// the river shape on every open (~21s cold/congested); the cache memoises that
// shape, keyed by a cheap staleness probe, so warm + cold-boot reads skip the
// fold. This gate asserts:
//   1. the endpoint still returns a correct river through the cache,
//   2. the persisted payload is ENCRYPTED at rest (no territory-name leak),
//   3. an in-process hit and a persisted (cross-"reboot") hit both skip recompute,
//   4. a structural data change (new week) rotates the key → recompute, while
//      benign profile updated_at churn does NOT (cache survives active enrich),
//   5. concurrent cold requests single-flight onto ONE recompute,
//   6. fail-soft: with the cache table absent, the endpoint still answers.
// PASS/FAIL ledger; exit 0 only if all pass.

import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';
import { getTerritoryRiverCached, riverCacheKey, bustTerritoryRiver } from '../src/territory-river-cache.js';

const DB = 'data/verify-territory-river-cache.db';
const KCV = 'data/verify-territory-river-cache-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const UID = 'local-user';
const RUN = 'run-river-0001';
const SECRET_NAME = 'SECRETLAND-zzz'; // distinctive territory name → must never appear in at-rest payload

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url, db } = srv;

  // A second raw connection (WAL → multi-connection safe) for direct seeding and
  // at-rest raw reads. The wired `db` only exposes rawQuery + namespaces.
  const seed = new Database(DB);

  // ── Seed a small weekly territory trajectory + profiles + frequency snapshots.
  // activation_vector + name are plaintext here (the endpoint auto-parses/passes
  // either form); the at-rest cost the cache models is the Python-encrypted
  // vectors — irrelevant to the cache's correctness, which is what this proves.
  const weeks = ['2025-01-05', '2025-01-12', '2025-01-19', '2025-01-26', '2025-02-02'];
  weeks.forEach((w, i) => {
    const vec = JSON.stringify({ '10': 0.5 + i * 0.02, '20': 0.3, '30': 0.05 });
    seed.prepare(
      `INSERT INTO fisher_trajectory
         (user_id, level, window_type, window_start, window_end, activation_vector,
          message_count, active_territory_count, clustering_run_id, low_confidence, scope)
       VALUES (?, 'territory', 'weekly_step', ?, ?, ?, 12, 3, ?, 0, 'personal')`,
    ).run(UID, w, w, vec, RUN);
  });
  // Two territory profiles — one is the distinctive-named anchor.
  seed.prepare(
    `INSERT INTO territory_profiles (territory_id, user_id, name, is_anchored, last_active, updated_at)
       VALUES (10, ?, ?, 1, '2025-02-02', '2025-02-02T00:00:00Z')`,
  ).run(UID, SECRET_NAME);
  seed.prepare(
    `INSERT INTO territory_profiles (territory_id, user_id, name, is_anchored, last_active, updated_at)
       VALUES (20, ?, 'Other', 0, '2025-02-02', '2025-02-02T00:00:00Z')`,
  ).run(UID);
  weeks.forEach((w) => {
    seed.prepare(
      `INSERT INTO frequency_snapshots (user_id, window_start, window_end, granularity, compression)
         VALUES (?, ?, ?, 'week', 0.37)`,
    ).run(UID, w, w);
  });
  bustTerritoryRiver(); // clean in-proc state for a deterministic run

  // 1) Endpoint returns a correct river THROUGH the cache.
  const r1 = await fetch(`${url}/api/v1/portal/territory-river`);
  const body = await r1.json();
  const anchorNames = (body.anchors || []).map((a) => a.name);
  rec('1. endpoint 200 + river shaped (weeks/anchors/novelty)',
    r1.status === 200 && body.weeks?.length === 5 && body.anchors?.length >= 1 && !!body.novelty,
    `status=${r1.status} weeks=${body.weeks?.length} anchors=${anchorNames.join(',')}`);

  // 2) Persisted row exists and payload is ENCRYPTED at rest (no name leak).
  const rawDb = new Database(DB, { readonly: true });
  const row = rawDb.prepare('SELECT cache_key, payload FROM territory_river_cache WHERE user_id = ?').get(UID);
  rawDb.close();
  const enc = row && typeof row.payload === 'string' && row.payload.startsWith('ey') && !row.payload.includes(SECRET_NAME);
  rec('2. payload encrypted at rest (envelope, no plaintext territory name)',
    !!row && enc,
    row ? `key=${row.cache_key.slice(0, 24)}… payload[0..16]=${row.payload.slice(0, 16)} leaks=${row.payload.includes(SECRET_NAME)}` : 'no row');

  // 3) Direct cache-module instrumentation: count recomputes.
  let computes = 0;
  const compute = async () => { computes++; return { marker: computes, at: 'x' }; };
  bustTerritoryRiver();
  // Drop the persisted row so the first direct call is a genuine miss.
  seed.prepare('DELETE FROM territory_river_cache WHERE user_id = ?').run(UID);

  const a = await getTerritoryRiverCached(db, UID, compute); // miss → compute (1)
  const b = await getTerritoryRiverCached(db, UID, compute); // in-proc hit → no compute
  rec('3. in-process hit skips recompute', computes === 1 && a.marker === b.marker, `computes=${computes}`);

  // 4) Cross-"reboot" persisted hit: clear the in-process memo, recompute must
  //    come from the persisted row (no computeFn call).
  bustTerritoryRiver();
  const c = await getTerritoryRiverCached(db, UID, compute); // persisted hit → no compute
  rec('4. persisted hit (post in-proc clear) skips recompute', computes === 1 && c.marker === a.marker, `computes=${computes} marker=${c.marker}`);

  // 5) A structural data change (new weekly step) rotates the key → recompute.
  const keyBefore = await riverCacheKey(db, UID);
  seed.prepare(
    `INSERT INTO fisher_trajectory
       (user_id, level, window_type, window_start, window_end, activation_vector,
        message_count, active_territory_count, clustering_run_id, low_confidence, scope)
     VALUES (?, 'territory', 'weekly_step', '2025-02-09', '2025-02-09', ?, 12, 3, ?, 0, 'personal')`,
  ).run(UID, JSON.stringify({ '10': 0.6, '20': 0.3, '30': 0.05 }), RUN);
  const keyAfter = await riverCacheKey(db, UID);
  const d = await getTerritoryRiverCached(db, UID, compute); // miss → compute (2)
  rec('5. structural data change (new week) rotates key → recompute', keyBefore !== keyAfter && computes === 2 && d.marker === 2,
    `keyMoved=${keyBefore !== keyAfter} computes=${computes}`);

  // 5b) Benign profile updated_at churn (per-profile re-describe during an active
  //     enrich pipeline) must NOT rotate the key. This was the regression that made
  //     the cache never hit under load — the key included MAX(updated_at), so a 2nd
  //     back-to-back river call still paid the full ~10–23s fold. The robust key
  //     (no updated_at) tolerates this churn; labels refresh on the next clustering
  //     run. @see src/territory-river-cache.js.
  const kPre = await riverCacheKey(db, UID);
  seed.prepare(`UPDATE territory_profiles SET updated_at = '2099-12-31T23:59:59Z' WHERE user_id = ? AND territory_id = 10`).run(UID);
  const kPost = await riverCacheKey(db, UID);
  rec('5b. benign updated_at churn does NOT rotate key (survives active enrich)',
    kPre === kPost, `moved=${kPre !== kPost}`);

  // 6) Single-flight: clear memo, fire 5 concurrent cold requests → ONE recompute.
  bustTerritoryRiver();
  seed.prepare('DELETE FROM territory_river_cache WHERE user_id = ?').run(UID);
  const before = computes;
  const slowCompute = async () => { computes++; await new Promise((r) => setTimeout(r, 30)); return { marker: 'sf' }; };
  await Promise.all(Array.from({ length: 5 }, () => getTerritoryRiverCached(db, UID, slowCompute)));
  rec('6. single-flight collapses concurrent cold requests', computes - before === 1, `recomputes=${computes - before} (expected 1)`);

  // 7) Fail-soft: drop the cache table → endpoint/module still answers.
  bustTerritoryRiver();
  seed.prepare('DROP TABLE territory_river_cache').run();
  let failSoftOk = false;
  try {
    const e = await getTerritoryRiverCached(db, UID, async () => ({ marker: 'no-table' }));
    failSoftOk = e.marker === 'no-table';
  } catch { failSoftOk = false; }
  const r7 = await fetch(`${url}/api/v1/portal/territory-river`);
  rec('7. fail-soft when cache table absent (module + endpoint)', failSoftOk && r7.status === 200, `module=${failSoftOk} endpoint=${r7.status}`);

  await srv.close?.();
  const allPass = ledger.every(Boolean);
  console.log('\n================================================================');
  console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'} — territory-river cache: correct, encrypted-at-rest, recompute-skipping  EXIT=${allPass ? 0 : 1}`);
  console.log('================================================================');
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });

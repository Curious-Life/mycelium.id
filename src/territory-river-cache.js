// Persisted + in-process cache for the territory-river response.
//
// GET /api/v1/portal/territory-river folds 400+ weekly territory-activation
// vectors (each an encrypted JSON blob in fisher_trajectory) plus
// territory_profiles + frequency_snapshots into the river shape. Idle that is
// ~1s; on a cold/congested app (boot-time decrypt storm, empty #289 decrypt-once
// plaintext cache) it balloons to ~21s — and the Curious Life page fetches it as
// its hero, so the first load after every restart is poor UX.
//
// The river is a pure function of a single clustering run's trajectory + the
// current territory profiles + the weekly frequency snapshots. It only changes
// when those are recomputed. So we memoise the computed payload, keyed by a CHEAP
// staleness probe — counts + max-timestamps over PLAINTEXT structural columns, no
// vector decrypt. Two layers:
//
//   1. In-process Map (userId -> {key, value}) — instant warm hits, no DB touch.
//   2. Persisted row (territory_river_cache, payload encrypted) — survives reboot,
//      so the cold-boot read decrypts ONE blob instead of 400 vectors.
//
// Single-flight per user collapses a stampede of concurrent cold requests (the
// exact boot-congestion case) onto one recompute. The cache is STRICT, not
// stale-while-revalidate: a value is only ever served when its key matches the
// live probe, so the human never sees a river that disagrees with the current
// run/profiles. The trade is that the first request after a re-cluster pays the
// recompute — rare, and the page already loads the river non-blocking.
//
// Fail-soft everywhere: if the cache table is absent (migration not yet applied)
// or a read/write errors, we silently fall back to recompute. The endpoint always
// gets a correct answer; persistence is best-effort.

const _mem = new Map();      // userId -> { key, value }
const _inFlight = new Map(); // userId -> { key, promise }

// Payload-shape version. Bump whenever the river payload SHAPE changes (not its
// data) so stale persisted/in-process caches from an older code version are
// invalidated — the data-only probe below can't see code changes. v2: anchor_count.
// v4: dropped territory_profiles.MAX(updated_at) from the probe (see below).
const RIVER_SCHEMA = 'v4-robustkey';

/**
 * Cheap staleness probe. Reads only structural (non-encrypted) columns —
 * COUNT / MAX over fisher_trajectory + frequency_snapshots, COUNT over
 * territory_profiles — so it never decrypts an activation vector. Any change that
 * alters the river *structurally* (new clustering run, appended weekly step,
 * added/removed profile, new weekly frequency snapshot) moves one of these
 * signals and rotates the key.
 *
 * Deliberately EXCLUDES territory_profiles.MAX(updated_at). That column churns on
 * every per-profile re-describe during an active measure/enrich pipeline — the
 * exact congested state this cache exists to survive — which rotated the key on
 * back-to-back calls and made the cache never hit (a 2nd river call still paid the
 * full ~10–23s fold). The river only changes meaningfully when a clustering run is
 * recomputed (caught by `r:` = MAX(clustering_run_id)) or a step/profile/snapshot
 * is added/removed (caught by the COUNTs / window-ends). A cosmetic re-describe
 * (a band's NAME) within the same run is a label overlay that refreshes on the
 * next run — an acceptable trade for staying responsive under load. See #301.
 *
 * `variant` folds a request-shaped parameter (e.g. the recent-week cap) into the
 * key so two different windows never collide on the single per-user cache slot.
 *
 * @param {{ rawQuery: Function }} db
 * @param {string} userId
 * @param {string} [variant]  request-shaped key component (e.g. `cap:180`)
 * @returns {Promise<string>}
 */
export async function riverCacheKey(db, userId, variant = '') {
  const one = async (sql) => (await db.rawQuery(sql, [userId])).results?.[0] || {};
  const traj = await one(
    `SELECT MAX(clustering_run_id) AS run, COUNT(*) AS n, MAX(window_end) AS w
       FROM fisher_trajectory
      WHERE user_id = ? AND level = 'territory' AND window_type = 'weekly_step'`);
  const prof = await one(
    `SELECT COUNT(*) AS n FROM territory_profiles WHERE user_id = ?`);
  const freq = await one(
    `SELECT COUNT(*) AS n, MAX(window_end) AS w
       FROM frequency_snapshots WHERE user_id = ? AND granularity = 'week'`);
  return [
    `s:${RIVER_SCHEMA}`,
    `v:${variant || '-'}`,
    `r:${traj.run ?? '-'}`, `tn:${traj.n ?? 0}`, `tw:${traj.w ?? '-'}`,
    `pn:${prof.n ?? 0}`,
    `fn:${freq.n ?? 0}`, `fw:${freq.w ?? '-'}`,
  ].join('|');
}

/**
 * Serve the river for `userId` from cache, recomputing via `computeFn` only when
 * the cheap key has moved. In-process hit → instant; persisted hit → one-blob
 * decrypt; miss → recompute + write-through. Single-flight per user.
 *
 * @param {{ rawQuery: Function }} db
 * @param {string} userId
 * @param {() => Promise<object>} computeFn  produces the full river payload
 * @param {string} [variant]  request-shaped key component (e.g. `cap:180`)
 * @returns {Promise<object>}
 */
export async function getTerritoryRiverCached(db, userId, computeFn, variant = '') {
  const key = await riverCacheKey(db, userId, variant);

  const mem = _mem.get(userId);
  if (mem && mem.key === key) return mem.value;

  const flight = _inFlight.get(userId);
  if (flight && flight.key === key) return flight.promise;

  const promise = (async () => {
    // 1) Persisted backing — survives reboot. Cold read decrypts ONE payload blob.
    try {
      const row = (await db.rawQuery(
        'SELECT cache_key, payload FROM territory_river_cache WHERE user_id = ?', [userId])).results?.[0];
      if (row && row.cache_key === key && typeof row.payload === 'string') {
        const value = JSON.parse(row.payload);
        _mem.set(userId, { key, value });
        return value;
      }
    } catch { /* table missing / parse fail → recompute (fail-soft) */ }

    // 2) Miss — recompute (the expensive 400-vector decrypt) + write-through.
    const value = await computeFn();
    _mem.set(userId, { key, value });
    try {
      await db.rawQuery(
        `INSERT OR REPLACE INTO territory_river_cache (user_id, cache_key, payload, computed_at)
           VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
        [userId, key, JSON.stringify(value)]);
    } catch { /* persistence is best-effort; the in-process memo still serves */ }
    return value;
  })();

  _inFlight.set(userId, { key, promise });
  try {
    return await promise;
  } finally {
    if (_inFlight.get(userId)?.promise === promise) _inFlight.delete(userId);
  }
}

/** Drop the in-process memo (tests / explicit invalidation). Persisted row is
 *  self-invalidating via the key, so this is rarely needed. */
export function bustTerritoryRiver(userId) {
  if (userId == null) { _mem.clear(); _inFlight.clear(); return; }
  _mem.delete(userId);
  _inFlight.delete(userId);
}

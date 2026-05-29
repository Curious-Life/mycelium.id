/**
 * Canonical operator user.id resolver.
 *
 * Background — `telegram_groups` rows store an `authorized_by` value that
 * the portal filters by when listing the operator's groups. Three writers
 * historically supplied different values for `authorized_by`:
 *
 *   - `packages/bots/telegram-bot.js`     → const `USER_ID = process.env.USER_ID`
 *   - `packages/server/routes/bots.js`    → `process.env.USER_ID` directly
 *   - `packages/server/routes/portal-*`   → `user.id` from authenticatePortalRequest
 *                                           (which calls `db.users.getFirst()`)
 *
 * If env drifts from the D1 row (rename, migration, redeploy), the bot
 * authorizes groups under one id and the portal lists under another — so
 * groups become invisible to the operator's settings page even though the
 * bot still responds in them. That's the bug surfaced when the operator
 * saw "only one of two groups" listed.
 *
 * The fix: every callsite that needs the operator id resolves it via
 * `getCanonicalOperatorId(db)`. This delegates to `db.users.getFirst()`,
 * the SAME function `authenticatePortalRequest` uses, so writes and reads
 * are guaranteed to agree.
 *
 * Falls back to `envFallback` ONLY when D1 is unreachable at boot
 * (network blip, sub-second startup race) — fail-closed otherwise per
 * CLAUDE.md §3.
 *
 * Result is cached at module scope after first successful resolution.
 * Restart the process to re-resolve.
 */

let cachedPromise = null;

/**
 * @param {object} db                 — D1 namespace bag, must expose users.getFirst()
 * @param {object} [options]
 * @param {string} [options.envFallback] — fallback id used if D1 lookup fails
 * @returns {Promise<string>} resolved operator user.id
 * @throws {Error} when D1 returns no user AND no envFallback is set, or when
 *                 D1 throws AND no envFallback is set.
 */
export async function getCanonicalOperatorId(db, options = {}) {
  if (cachedPromise) return cachedPromise;
  cachedPromise = (async () => {
    const { envFallback } = options;

    if (!db?.users?.getFirst) {
      if (envFallback) return String(envFallback);
      throw new Error('canonical-user-id: db.users.getFirst() unavailable and no envFallback');
    }

    let row;
    try {
      row = await db.users.getFirst();
    } catch (err) {
      if (envFallback) {
        console.warn(
          `[canonical-user-id] D1 lookup failed (${err.message}); using envFallback`,
        );
        return String(envFallback);
      }
      throw err;
    }

    if (row?.id) return String(row.id);

    if (envFallback) {
      console.warn(
        '[canonical-user-id] D1 returned no user; using envFallback',
      );
      return String(envFallback);
    }

    throw new Error('canonical-user-id: no user in D1 and no envFallback provided');
  })();

  // If the first attempt fails, clear the cache so a retry can succeed.
  // Successful resolutions stay cached for the process lifetime.
  cachedPromise.catch(() => { cachedPromise = null; });

  return cachedPromise;
}

/** Test-only helper. Resets the module-scope cache. */
export function _resetCanonicalCache() {
  cachedPromise = null;
}

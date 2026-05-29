/**
 * Owner-name resolver — single source of truth for "what name should I call
 * the principal?". Used in system prompts, contact chronicles, LinkedIn
 * import, and anywhere else the system needs to refer to the account owner.
 *
 * Resolution order:
 *   1. D1 `users.display_name` (canonical — set during portal onboarding)
 *   2. D1 `users.handle`        (canonical — set during portal onboarding)
 *   3. process.env.OWNER_NAME   (provisioning-time fallback)
 *   4. options.fallback         (last resort, defaults to 'User')
 *
 * Email-style `+alias` suffixes are stripped (e.g. `foo.bar+1` → `foo.bar`).
 *
 * Cached for 5 minutes to avoid hammering D1 on every prompt build.
 */

const TTL_MS = 5 * 60 * 1000;
let cached = null;
let cachedAt = 0;

/** Strip a single trailing `+alias` segment and trim whitespace. */
export function normalizeOwnerName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const plus = trimmed.indexOf('+');
  const stripped = plus === -1 ? trimmed : trimmed.slice(0, plus).trim();
  return stripped || null;
}

/**
 * @param {object}  [options]
 * @param {object}  [options.db]        — D1 wrapper (must expose `users.getFirst()`)
 * @param {string}  [options.fallback]  — final fallback (default 'User')
 * @param {boolean} [options.refresh]   — bypass cache
 * @returns {Promise<string>}
 */
export async function resolveOwnerName(options = {}) {
  const { db, fallback = 'User', refresh = false } = options;
  if (!refresh && cached && Date.now() - cachedAt < TTL_MS) return cached;

  let name = null;
  try {
    const user = await db?.users?.getFirst?.();
    if (user) {
      name = normalizeOwnerName(user.display_name) || normalizeOwnerName(user.handle);
    }
  } catch { /* fall through to env */ }

  if (!name) name = normalizeOwnerName(process.env.OWNER_NAME);
  if (!name) name = fallback;

  cached = name;
  cachedAt = Date.now();
  return name;
}

/** Test/seam: clear the in-process cache. */
export function clearOwnerNameCache() {
  cached = null;
  cachedAt = 0;
}

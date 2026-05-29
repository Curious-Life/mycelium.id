/**
 * Telegram identity resolver — bridges Telegram user IDs to identity_channels.
 *
 * Per IDENTITY-CHANNELS.md §6 Phase 2 V6 (hardening: replace OWNER_TELEGRAM_ID
 * env-var hardcoding with identity_channels lookup).
 *
 * Two operations:
 *
 *   1. isOperatorTelegram(db, telegramId)
 *      Returns true iff the given Telegram user_id is bound to the operator
 *      (the canonical operator user.id from db.users.getFirst()). Source of
 *      truth: identity_channels (channel_kind='telegram'). Falls back to
 *      OWNER_TELEGRAM_ID env var ONLY for the bootstrap window before a
 *      binding exists in D1.
 *
 *   2. bootstrapOwnerBindingFromEnv(db)
 *      One-shot at process startup. If OWNER_TELEGRAM_ID is set AND no
 *      identity_channels row exists for that pair, INSERT a binding with
 *      evidence={source:'owner_env_bootstrap'}. Idempotent — safe to call
 *      on every restart.
 *
 * Caching: isOperatorTelegram caches positive results in-memory per process.
 * Negative results are NOT cached (operator may bind a new device later).
 * Cache invalidates on process restart.
 *
 * Security:
 *   - Lookup is FK-bound: identity_channels.owner_user_id is matched against
 *     the operator's user.id (resolved via getCanonicalOperatorId, the same
 *     function authenticatePortalRequest uses).
 *   - revoked_at IS NULL filter ensures revoked bindings can't authenticate.
 *   - Env-var fallback is "bootstrap only" — once a binding exists, the env
 *     var is no longer consulted. This makes the env var harmless even if
 *     it's misconfigured later, as long as the binding is live.
 *   - Bootstrap auto-write tags evidence with source so audit can distinguish
 *     widget-attested bindings from env-bootstrapped ones.
 */

import { createHash } from 'node:crypto';
import { getCanonicalOperatorId } from './canonical-user-id.js';

const TELEGRAM_KIND = 'telegram';
const TELEGRAM_VALUE_PREFIX = 'tg:';
const ENV_OWNER_TELEGRAM_ID = 'OWNER_TELEGRAM_ID';

// Per-process positive cache. Once we've confirmed a Telegram ID is the
// operator, the result is stable (the binding can be revoked, but the cache
// will be busted on restart). Cleared via clearTelegramOwnerCache() in tests.
const positiveCache = new Set();

export function clearTelegramOwnerCache() {
  positiveCache.clear();
}

function tgValue(telegramId) {
  return `${TELEGRAM_VALUE_PREFIX}${String(telegramId)}`;
}

/**
 * Look up a Telegram user_id in identity_channels and return the bound
 * owner_user_id (or null if absent / revoked).
 *
 * @param {object} db
 * @param {string|number} telegramId
 * @returns {Promise<string|null>}
 */
export async function lookupTelegramOwnerUserId(db, telegramId) {
  if (!db?.identityChannels?.getByChannel) return null;
  const row = await db.identityChannels.getByChannel(TELEGRAM_KIND, tgValue(telegramId));
  if (!row || row.revoked_at || !row.owner_user_id) return null;
  return row.owner_user_id;
}

/**
 * Returns true iff the given Telegram user_id is the operator.
 *
 * Resolution order:
 *   1. Positive cache hit → true
 *   2. identity_channels lookup → owner_user_id matches canonical operator → true
 *   3. OWNER_TELEGRAM_ID env var matches → true (bootstrap fallback)
 *   4. otherwise → false
 *
 * Negative results never cached — operator may add the binding mid-session.
 *
 * @param {object} db                  D1 namespace bag (must expose
 *                                     identityChannels + users)
 * @param {string|number} telegramId
 * @param {object} [opts]
 * @param {string} [opts.envFallback]  Override the env var (tests)
 * @returns {Promise<boolean>}
 */
export async function isOperatorTelegram(db, telegramId, opts = {}) {
  if (telegramId == null) return false;
  const id = String(telegramId);

  if (positiveCache.has(id)) return true;

  // Source of truth: identity_channels.
  if (db?.identityChannels && db?.users) {
    try {
      const ownerUserId = await lookupTelegramOwnerUserId(db, id);
      if (ownerUserId) {
        const canonical = await getCanonicalOperatorId(db, {});
        if (canonical && ownerUserId === canonical) {
          positiveCache.add(id);
          return true;
        }
      }
    } catch {
      // Non-fatal: fall through to env-var fallback. We don't want a transient
      // D1 hiccup to fail-open OR fail-closed unpredictably; env-var fallback
      // makes the bootstrap window deterministic.
    }
  }

  // Bootstrap fallback. Only honored if the env var is set.
  const envOwner = opts.envFallback ?? process.env[ENV_OWNER_TELEGRAM_ID];
  if (envOwner && id === String(envOwner)) {
    positiveCache.add(id);
    return true;
  }

  return false;
}

/**
 * Idempotent bootstrap: write the env-var owner binding to identity_channels
 * if it's not already there. Call once at process startup AFTER D1 is ready.
 *
 * No-op if:
 *   - OWNER_TELEGRAM_ID is unset
 *   - canonical operator user.id can't be resolved (D1 not ready)
 *   - a row already exists for (telegram, tg:<id>) with the right owner
 *
 * On a successful insert, emits an audit_log entry of type
 * 'channel.bootstrapped' so the operator can see when the auto-write fired.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string} [opts.envFallback]  Override OWNER_TELEGRAM_ID (tests)
 * @param {Function} [opts.audit]      ({ action, userId, details }) => Promise
 * @param {object} [opts.log]          structured logger
 * @returns {Promise<{ wrote: boolean, reason: string }>}
 */
export async function bootstrapOwnerBindingFromEnv(db, opts = {}) {
  const log = opts.log || { info: () => {}, warn: () => {} };
  const envOwner = opts.envFallback ?? process.env[ENV_OWNER_TELEGRAM_ID];

  if (!envOwner) {
    return { wrote: false, reason: 'env_owner_unset' };
  }
  if (!db?.identityChannels?.upsert || !db?.users) {
    return { wrote: false, reason: 'db_not_ready' };
  }

  let canonical;
  try {
    canonical = await getCanonicalOperatorId(db, {});
  } catch (err) {
    log.warn?.('telegram-bootstrap: canonical operator id unresolved', {
      message: String(err?.message || err),
    });
    return { wrote: false, reason: 'canonical_unresolved' };
  }
  if (!canonical) {
    return { wrote: false, reason: 'canonical_missing' };
  }

  const value = tgValue(envOwner);
  const existing = await db.identityChannels.getByChannel(TELEGRAM_KIND, value);

  if (existing && existing.owner_user_id === canonical && !existing.revoked_at) {
    return { wrote: false, reason: 'already_bound' };
  }

  // Insert / refresh. Use upsert + bindToUser to safely populate without
  // overwriting a stronger (widget-attested) binding if it already exists.
  await db.identityChannels.upsert({
    channel_kind: TELEGRAM_KIND,
    channel_value: value,
    owner_user_id: existing?.owner_user_id || null,
    display_name: existing?.display_name || null,
    evidence_json: JSON.stringify({ proof: 'owner_env_bootstrap' }),
  });

  if (typeof db.identityChannels.bindToUser === 'function' &&
      (!existing || !existing.owner_user_id)) {
    await db.identityChannels.bindToUser(TELEGRAM_KIND, value, canonical);
  }

  positiveCache.add(String(envOwner));

  if (typeof opts.audit === 'function') {
    try {
      await opts.audit({
        action: 'channel.bootstrapped',
        userId: canonical,
        resourceType: 'identity_channel',
        details: { kind: TELEGRAM_KIND, value_digest: hashDigest(value), proof: 'owner_env_bootstrap' },
      });
    } catch { /* fire-and-forget */ }
  }

  log.info?.('telegram-bootstrap: owner binding written', {
    user_id: canonical, kind: TELEGRAM_KIND, value_digest: hashDigest(value),
  });

  return { wrote: true, reason: existing ? 'rebound' : 'inserted' };
}

// 16-char SHA-256 digest of channel_value for audit (avoids logging the raw
// Telegram ID; matches the convention used by upsert-channel.js).
function hashDigest(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

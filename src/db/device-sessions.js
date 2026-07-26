/**
 * Device sessions namespace — the ONE unified session mechanism for a second
 * client reaching the vault (the unified-auth design).
 *
 * A device session is an ambient COOKIE credential (`mycelium_device_session`)
 * bound to a device_tokens row. It exists because a browser / embedded WKWebView
 * cannot always set an `Authorization` header on the SPA's same-origin fetches, so
 * it must present a cookie — and a cookie must NOT carry a raw device token
 * (header-only, CSRF-exempt by design). This narrower, per-request-validated
 * credential is the safe cookie shape.
 *
 * SECURITY (the invariants a mutation must break, gate: verify:device-session):
 *  - The raw session secret is returned by mint() ONCE (server sets it as an
 *    HttpOnly cookie); only its SHA-256 hash is ever stored. Never logged.
 *  - matchSync() is the AUTH HOT PATH: SYNCHRONOUS (raw better-sqlite3 handle) so
 *    it slots into the sync makePortalOwnerGate without changing that contract.
 *    Fail-closed: any throw / short input / no row → null.
 *  - VALIDITY == TOKEN-LIVENESS (R0): the JOIN to device_tokens is the binding.
 *    A revoked token, a revoked session, or an elapsed token idle policy → 0 rows
 *    → not authorized. There is NO independent session TTL, no expires_at, no
 *    refresh. Revoke the token and every bound session dies on the next request.
 *  - Structural parity: a session grants EXACTLY the surfaces the backing token
 *    grants (it resolves to the same owner user_id, consumed at the same two gates
 *    as via:'device'). It can never be upgraded into a better-auth session.
 *  - LRU cap: mint prunes (never refuses) — a valid pairing is never stranded by a
 *    cap. Eviction is by last_seen_at (least-recently-USED), not created_at, so a
 *    live-but-old session (e.g. a share extension) is never the one pruned.
 *
 * @typedef {object} DeviceSessionsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query  async (mint/revoke)
 * @property {object} rawDb  the raw better-sqlite3 handle (sync auth hot path)
 */

import crypto from 'node:crypto';
import { hashTokenSync } from './helpers.js';

const LAST_SEEN_DEBOUNCE_MS = 5 * 60_000;
const MIN_SECRET_LEN = 24; // parity with device_tokens — reject obviously-too-short input
const MAX_SESSIONS_PER_DEVICE = 20; // cap only bounds growth; eviction is LRU, mint never refuses

/** SQLite `datetime('now')` → epoch ms (UTC). Returns 0 on any parse failure. */
function sqliteTsToMs(ts) {
  if (!ts) return 0;
  const ms = Date.parse(String(ts).replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? ms : 0;
}

export function createDeviceSessionsNamespace(deps) {
  if (!deps) throw new TypeError('createDeviceSessionsNamespace: deps required');
  const { d1Query, rawDb } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createDeviceSessionsNamespace: d1Query required');
  if (!rawDb || typeof rawDb.prepare !== 'function') throw new TypeError('createDeviceSessionsNamespace: rawDb (better-sqlite3 handle) required');

  return {
    /**
     * Mint a fresh session bound to a live device token. Returns the RAW secret
     * ONCE — the caller sets it as the HttpOnly cookie and never persists it in the
     * clear. Prunes least-recently-used rows for this device beyond the cap (never
     * refuses). Fail-closed: refuses to mint against an unknown/revoked token.
     * @param {number} deviceTokenId
     * @returns {Promise<{ secret: string, hash: string, id: number }>}
     */
    async mint(deviceTokenId) {
      const tokenId = Number(deviceTokenId);
      if (!Number.isInteger(tokenId) || tokenId <= 0) throw new TypeError('mint: deviceTokenId (positive integer) required');
      // Bind only to a LIVE token — never mint against a revoked/absent one.
      const tok = await d1Query(
        `SELECT id FROM device_tokens WHERE id = ? AND revoked_at IS NULL`,
        [tokenId],
      );
      if (!(tok?.results?.length)) throw new Error('mint: device token is not live');

      const secret = crypto.randomBytes(32).toString('hex'); // 64 hex — matches device-token entropy
      const hash = hashTokenSync(secret);
      const res = await d1Query(
        `INSERT INTO device_sessions (session_hash, device_token_id) VALUES (?, ?)`,
        [hash, tokenId],
      );

      // LRU prune (design §3.5): keep at most MAX_SESSIONS_PER_DEVICE LIVE rows per
      // device; evict the least-recently-USED (last_seen_at, NULL treated oldest),
      // NOT the oldest-created. Never refuses a mint. Best-effort — a prune failure
      // must not fail the mint (the cap is hygiene, not a security boundary).
      try {
        await d1Query(
          `UPDATE device_sessions SET revoked_at = datetime('now')
             WHERE device_token_id = ? AND revoked_at IS NULL
               AND id NOT IN (
                 SELECT id FROM device_sessions
                  WHERE device_token_id = ? AND revoked_at IS NULL
                  ORDER BY COALESCE(last_seen_at, created_at) DESC, id DESC
                  LIMIT ?
               )`,
          [tokenId, tokenId, MAX_SESSIONS_PER_DEVICE],
        );
      } catch { /* prune is best-effort */ }

      return { secret, hash, id: res?.meta?.last_row_id };
    },

    /**
     * SYNCHRONOUS, fail-closed live-session test for the auth gate hot path.
     * VALIDITY == TOKEN-LIVENESS (R0): the JOIN dies with the token.
     * @param {string} secretPlain  the presented cookie secret
     * @returns {string|null} the owner user_id if the session AND its token are live, else null.
     */
    matchSync(secretPlain) {
      try {
        if (typeof secretPlain !== 'string' || secretPlain.length < MIN_SECRET_LEN) return null;
        const hash = hashTokenSync(secretPlain);
        // NOTE on the idle_expires_at predicate below: it is correct, gated
        // ENFORCEMENT (verify:device-session S4 proves an elapsed value kills the
        // session), but NO current code path WRITES idle_expires_at — it is always
        // NULL, so idle-logout does NOT currently run. Idle policy is DEFERRED
        // (design §7). The active shared-computer kill is LOGOUT REVOCATION
        // (POST /auth/logout revokes the backing web token). If idle-logout is later
        // shipped, wire a writer (set on mint, debounced bump on activity); the
        // enforcement here already respects it.
        const row = rawDb
          .prepare(
            `SELECT s.id AS sid, t.id AS token_id, t.user_id AS user_id, s.last_seen_at AS last_seen_at
               FROM device_sessions s
               JOIN device_tokens  t ON t.id = s.device_token_id
              WHERE s.session_hash = ?
                AND s.revoked_at IS NULL
                AND t.revoked_at IS NULL
                AND (t.idle_expires_at IS NULL OR t.idle_expires_at > datetime('now'))`,
          )
          .get(hash);
        if (!row) return null;
        // Debounced last_seen bump (LRU input) — at most once per debounce window,
        // so the hot path is a read. Best-effort; never blocks auth.
        const lastMs = sqliteTsToMs(row.last_seen_at);
        if (Date.now() - lastMs > LAST_SEEN_DEBOUNCE_MS) {
          try {
            rawDb.prepare(`UPDATE device_sessions SET last_seen_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`).run(row.sid);
          } catch { /* telemetry write is best-effort */ }
        }
        return String(row.user_id);
      } catch {
        return null; // fail-closed: any error ⇒ not a valid session
      }
    },

    /**
     * SYNC: resolve a presented session secret to its BACKING device token
     * ({ tokenId, kind }), for the logout kill path. Deliberately NOT liveness-
     * filtered — logout must find the backing token to revoke it even if the session
     * is already revoked/idle (revoke is then an idempotent no-op). Fail-closed.
     * @param {string} secretPlain
     * @returns {{ tokenId: number, kind: string } | null}
     */
    backingTokenSync(secretPlain) {
      try {
        if (typeof secretPlain !== 'string' || secretPlain.length < MIN_SECRET_LEN) return null;
        const hash = hashTokenSync(secretPlain);
        const row = rawDb
          .prepare(
            `SELECT s.device_token_id AS token_id, t.kind AS kind
               FROM device_sessions s
               JOIN device_tokens  t ON t.id = s.device_token_id
              WHERE s.session_hash = ?`,
          )
          .get(hash);
        return row ? { tokenId: Number(row.token_id), kind: String(row.kind) } : null;
      } catch {
        return null; // fail-closed
      }
    },

    /**
     * Revoke EVERY live session bound to a device token (teardown / re-pair).
     * Idempotent — revoking zero rows is fine. Returns the count revoked.
     * @param {number} deviceTokenId
     * @returns {Promise<number>}
     */
    async revokeForToken(deviceTokenId) {
      const res = await d1Query(
        `UPDATE device_sessions SET revoked_at = datetime('now')
           WHERE device_token_id = ? AND revoked_at IS NULL`,
        [Number(deviceTokenId)],
      );
      return Number(res?.meta?.changes || 0);
    },
  };
}

/**
 * Device tokens namespace — per-device bearer credentials for paired phones
 * (docs/PHONE-QR-PAIRING-DESIGN-2026-07-19.md, Unit A).
 *
 * A paired phone (QR-scanned + owner-approved on the Mac) gets its OWN token,
 * minted here and sealed to the phone over the pairing channel (src/portal-pair.js).
 * The shared MYCELIUM_MCP_BEARER is untouched; a lost device is revoked in isolation.
 *
 * SECURITY:
 *  - The raw token is returned by mint() ONCE (the caller seals it to the phone);
 *    only its SHA-256 hash is ever stored (hashTokenSync), like registration_tokens
 *    and agent_tokens. Never logged.
 *  - matchSync() is the AUTH HOT PATH: it is SYNCHRONOUS (backed by the raw
 *    better-sqlite3 handle) so it can slot into the sync makePortalOwnerGate
 *    without changing that gate's contract. Fail-closed: any throw → null.
 *  - Lookups filter `revoked_at IS NULL` — a revoked token authorizes nothing.
 *  - last_seen_at is DEBOUNCED (≥5 min): never a synchronous write on every
 *    authenticated request (v6 adversarial finding).
 *
 * @typedef {object} DeviceTokensNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query   async (mint/list/revoke)
 * @property {object} rawDb  the raw better-sqlite3 handle (sync auth hot path)
 */

import crypto from 'node:crypto';
import { hashTokenSync } from './helpers.js';

const LAST_SEEN_DEBOUNCE_MS = 5 * 60_000;
const MIN_TOKEN_LEN = 24; // parity with static-bearer MIN_BEARER_LEN — reject obviously-too-short input

/** SQLite `datetime('now')` → epoch ms (UTC). Returns 0 on any parse failure. */
function sqliteTsToMs(ts) {
  if (!ts) return 0;
  const ms = Date.parse(String(ts).replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? ms : 0;
}

export function createDeviceTokensNamespace(deps) {
  if (!deps) throw new TypeError('createDeviceTokensNamespace: deps required');
  const { d1Query, rawDb } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createDeviceTokensNamespace: d1Query required');
  if (!rawDb || typeof rawDb.prepare !== 'function') throw new TypeError('createDeviceTokensNamespace: rawDb (better-sqlite3 handle) required');

  return {
    /**
     * Mint a new per-client token. Returns the RAW token ONCE — the caller seals it
     * to the phone (kind='phone') or sets it as the backing token for a web session
     * (kind='web'), and never persists it in the clear. Only the hash is stored.
     * `kind` is a NON-secret label only: it changes no authorization (a 'web' token
     * has exactly the authority of a 'phone' token). Unknown kinds fall back to
     * 'phone' so a bad caller can never widen authority via this field.
     * @returns {Promise<{ token: string, hash: string, id: number }>}
     */
    async mint(deviceLabel, userId, kind = 'phone') {
      const token = crypto.randomBytes(32).toString('hex'); // 64 hex — matches the static-bearer entropy
      const hash = hashTokenSync(token);
      const label = String(deviceLabel == null ? 'device' : deviceLabel).trim().slice(0, 64) || 'device';
      const safeKind = (kind === 'web') ? 'web' : 'phone'; // allowlist — never trust the caller's string
      const res = await d1Query(
        `INSERT INTO device_tokens (token_hash, device_label, user_id, kind) VALUES (?, ?, ?, ?)`,
        [hash, label, String(userId), safeKind],
      );
      return { token, hash, id: res?.meta?.last_row_id };
    },

    /**
     * SYNCHRONOUS, fail-closed live-token test for the auth gate hot path.
     * @param {string} tokenPlain  the presented bearer token
     * @returns {string|null} the owner user_id if the token is live, else null.
     */
    matchSync(tokenPlain) {
      try {
        if (typeof tokenPlain !== 'string' || tokenPlain.length < MIN_TOKEN_LEN) return null;
        const hash = hashTokenSync(tokenPlain);
        const row = rawDb
          .prepare(`SELECT id, user_id, last_seen_at FROM device_tokens WHERE token_hash = ? AND revoked_at IS NULL`)
          .get(hash);
        if (!row) return null;
        // Single-owner vault: the gates use this return boolean-ishly (truthy = a
        // LIVE token exists). We return the row's user_id for symmetry/audit, but
        // an empty user_id would be falsy → not authorized (fail-closed).
        // Debounced last_seen bump — at most once per LAST_SEEN_DEBOUNCE_MS per token,
        // so the hot path is a read; the write is rare. Best-effort: never block auth.
        const lastMs = sqliteTsToMs(row.last_seen_at);
        if (Date.now() - lastMs > LAST_SEEN_DEBOUNCE_MS) {
          try {
            rawDb.prepare(`UPDATE device_tokens SET last_seen_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`).run(row.id);
          } catch { /* telemetry write is best-effort */ }
        }
        return String(row.user_id);
      } catch {
        return null; // fail-closed: any error ⇒ not a valid device token
      }
    },

    /**
     * SYNCHRONOUS, fail-closed lookup of the LIVE token's numeric id for a presented
     * token — used to BIND a device session to its backing token (device-sessions.js).
     * Returns null for an unknown / revoked / too-short token. Does NOT bump last_seen
     * (binding is not "use"); matchSync remains the hot-path authorizer.
     * @param {string} tokenPlain
     * @returns {number|null}
     */
    matchIdSync(tokenPlain) {
      try {
        if (typeof tokenPlain !== 'string' || tokenPlain.length < MIN_TOKEN_LEN) return null;
        const hash = hashTokenSync(tokenPlain);
        const row = rawDb
          .prepare(`SELECT id FROM device_tokens WHERE token_hash = ? AND revoked_at IS NULL`)
          .get(hash);
        return row ? Number(row.id) : null;
      } catch {
        return null; // fail-closed
      }
    },

    /** Owner-visible list — NEVER returns the token hash. Surfaces `kind` so the
     *  devices UI can distinguish a paired phone from a signed-in web browser. */
    async list() {
      const result = await d1Query(
        `SELECT id, device_label, kind, created_at, last_seen_at, revoked_at
         FROM device_tokens ORDER BY (revoked_at IS NULL) DESC, created_at DESC`,
        [],
      );
      return result.results || [];
    },

    /** Revoke a device token by id (idempotent — no-op if already revoked/absent). */
    async revoke(id) {
      await d1Query(
        `UPDATE device_tokens SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`,
        [Number(id)],
      );
    },
  };
}

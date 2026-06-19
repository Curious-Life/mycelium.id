/**
 * identity_channels namespace — single source of truth for
 * (channel_kind, channel_value) → owner_user_id binding.
 *
 * Per IDENTITY-CHANNELS.md §3.2 (schema) and §3.4 (registry semantics).
 *
 * Operations partition cleanly:
 *   - Identity-write:  upsert (refresh verified_at + last_seen_at)
 *   - Owner-write:     bindToUser, revoke (state transitions)
 *   - Flag-write:      setFlag (per-channel auth/delivery/aka_published)
 *   - Read:            getByChannel, listByOwner, listByKind
 *
 * Callers should not bypass this namespace — all SQL on identity_channels
 * lives here so the (kind, value, owner) invariants stay enforceable.
 *
 * @typedef {object} IdentityChannelsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 * @property {() => Date} [now] — test seam for verified_at / last_seen_at
 */

const VALID_FLAGS = new Set(['auth_enabled', 'delivery_enabled', 'aka_published']);

export function createIdentityChannelsNamespace(deps) {
  if (!deps) throw new TypeError('createIdentityChannelsNamespace: deps required');
  const { d1Query, firstRow, now = () => new Date() } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createIdentityChannelsNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createIdentityChannelsNamespace: firstRow required');

  return {
    /** Returns the (kind, value) row including revoked rows. NULL if missing. */
    async getByChannel(channel_kind, channel_value) {
      const result = await d1Query(
        `SELECT channel_kind, channel_value, owner_user_id, display_name, evidence_json,
                verified_at, last_seen_at, auth_enabled, delivery_enabled, aka_published,
                revoked_at, created_at
         FROM identity_channels
         WHERE channel_kind = ? AND channel_value = ?`,
        [channel_kind, channel_value],
      );
      return firstRow(result) || null;
    },

    /**
     * Upsert a channel binding. On conflict refreshes verified_at + last_seen_at
     * and merges evidence/display_name. Does NOT touch owner_user_id (use
     * bindToUser for that) or revoked_at.
     *
     * params: { channel_kind, channel_value, owner_user_id?, display_name?, evidence_json? }
     */
    async upsert(params) {
      const ts = now().toISOString();
      await d1Query(
        `INSERT INTO identity_channels
           (channel_kind, channel_value, owner_user_id, display_name, evidence_json,
            verified_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (channel_kind, channel_value) DO UPDATE SET
           verified_at = excluded.verified_at,
           last_seen_at = excluded.last_seen_at,
           evidence_json = COALESCE(excluded.evidence_json, identity_channels.evidence_json),
           display_name = COALESCE(excluded.display_name, identity_channels.display_name)`,
        [
          params.channel_kind,
          params.channel_value,
          params.owner_user_id || null,
          params.display_name || null,
          params.evidence_json || null,
          ts,
          ts,
        ],
      );
    },

    /**
     * Set owner_user_id on an existing row. Returns true if bound, false if
     * the row already has a DIFFERENT owner (caller should treat as Conflict).
     * If the row already has THIS owner, returns true (idempotent).
     */
    async bindToUser(channel_kind, channel_value, user_id) {
      const result = await d1Query(
        `UPDATE identity_channels
         SET owner_user_id = ?, last_seen_at = ?
         WHERE channel_kind = ? AND channel_value = ?
           AND (owner_user_id IS NULL OR owner_user_id = ?)
           AND revoked_at IS NULL`,
        [user_id, now().toISOString(), channel_kind, channel_value, user_id],
      );
      return (result?.meta?.changes ?? 0) > 0;
    },

    /** Soft-revoke. Channel row persists for audit; queries filter on revoked_at IS NULL. */
    async revoke(channel_kind, channel_value) {
      await d1Query(
        `UPDATE identity_channels SET revoked_at = ? WHERE channel_kind = ? AND channel_value = ? AND revoked_at IS NULL`,
        [now().toISOString(), channel_kind, channel_value],
      );
    },

    /** All non-revoked, delivery-enabled channels of a kind (e.g. authorized discord channels). */
    async listByKind(channel_kind) {
      const result = await d1Query(
        `SELECT channel_kind, channel_value, display_name, verified_at, last_seen_at, delivery_enabled
         FROM identity_channels
         WHERE channel_kind = ? AND revoked_at IS NULL AND delivery_enabled = 1
         ORDER BY verified_at DESC`,
        [channel_kind],
      );
      return result.results || [];
    },

    /** All non-revoked channels owned by a user. Used by Settings → Channels (Phase 7). */
    async listByOwner(user_id) {
      const result = await d1Query(
        `SELECT channel_kind, channel_value, display_name, verified_at, last_seen_at,
                auth_enabled, delivery_enabled, aka_published
         FROM identity_channels
         WHERE owner_user_id = ? AND revoked_at IS NULL
         ORDER BY verified_at DESC`,
        [user_id],
      );
      return result.results || [];
    },

    /** Toggle a single capability flag. */
    async setFlag(channel_kind, channel_value, flag, on) {
      if (!VALID_FLAGS.has(flag)) throw new TypeError(`identity_channels.setFlag: invalid flag ${flag}`);
      await d1Query(
        `UPDATE identity_channels SET ${flag} = ? WHERE channel_kind = ? AND channel_value = ? AND revoked_at IS NULL`,
        [on ? 1 : 0, channel_kind, channel_value],
      );
    },
  };
}

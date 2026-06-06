/**
 * channel_access namespace — per-channel access policy (who, within an authorized
 * group/channel, the bot responds to). Separate from authorization (channel
 * on/off). See migrations/0011_channel_access.sql.
 *
 *   mode 'owner'     → only the operator
 *   mode 'allowlist' → operator + allowed_senders
 *   mode 'open'      → anyone (default; preserves pre-policy behavior)
 *
 * allowed_senders_json is encrypted at rest (ENCRYPTED_FIELDS.channel_access); the
 * adapter auto-encrypts on write + auto-decrypts on read. The (kind,value) PK is
 * plaintext so get() is a direct keyed lookup (no decrypt-to-match).
 *
 * @typedef {object} ChannelAccessDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 * @property {(result: any) => any} firstRow
 */

const VALID_MODES = new Set(['owner', 'allowlist', 'open']);

/**
 * Pure access decision — exported so the vault decision endpoint AND tests can
 * use it without a db. Owner is implicitly allowed in EVERY mode (can't lock
 * yourself out). A missing policy defaults to 'open' (the channel was authorized;
 * the operator hasn't tightened it).
 * @param {{mode?:string, allowedSenders?:string[]}|null} policy
 * @param {string|number} sender
 * @param {string|number} ownerId
 * @returns {{respond:boolean, mode:string, reason:string}}
 */
export function decideAccess(policy, sender, ownerId) {
  const mode = policy?.mode && VALID_MODES.has(policy.mode) ? policy.mode : 'open';
  const s = sender == null ? null : String(sender);
  const isOwner = ownerId != null && s != null && s === String(ownerId);
  if (mode === 'open') return { respond: true, mode, reason: 'open' };
  if (isOwner) return { respond: true, mode, reason: 'owner' };
  if (mode === 'owner') return { respond: false, mode, reason: 'owner-only' };
  // allowlist
  const allowed = Array.isArray(policy?.allowedSenders) && policy.allowedSenders.map(String).includes(s);
  return allowed ? { respond: true, mode, reason: 'allowlisted' } : { respond: false, mode, reason: 'not-allowlisted' };
}

export function createChannelAccessNamespace(deps) {
  if (!deps) throw new TypeError('createChannelAccessNamespace: deps required');
  const { d1Query, firstRow } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createChannelAccessNamespace: d1Query required');
  if (typeof firstRow !== 'function') throw new TypeError('createChannelAccessNamespace: firstRow required');

  return {
    /** Returns { mode, allowedSenders[] } or null. */
    async get(channel_kind, channel_value) {
      const r = await d1Query(
        `SELECT mode, allowed_senders_json FROM channel_access WHERE channel_kind = ? AND channel_value = ?`,
        [channel_kind, String(channel_value)],
      );
      const row = firstRow(r);
      if (!row) return null;
      let allowedSenders = [];
      if (row.allowed_senders_json) { try { allowedSenders = JSON.parse(row.allowed_senders_json) || []; } catch { allowedSenders = []; } }
      return { mode: row.mode || 'open', allowedSenders };
    },

    /** Upsert the policy. mode validated; allowedSenders normalized to string[]. */
    async set(channel_kind, channel_value, { mode = 'open', allowedSenders = [] } = {}) {
      if (!VALID_MODES.has(mode)) throw new TypeError(`channel-access.set: invalid mode ${mode}`);
      const json = JSON.stringify((Array.isArray(allowedSenders) ? allowedSenders : []).map(String));
      // INSERT OR REPLACE keeps the encrypted-column contract simple (no ON
      // CONFLICT DO UPDATE on an encrypted col, mirroring the connectors note).
      await d1Query(
        `INSERT OR REPLACE INTO channel_access (channel_kind, channel_value, mode, allowed_senders_json, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
        [channel_kind, String(channel_value), mode, json],
      );
    },

    /** Resolve the full decision for a sender (policy + owner). */
    async decide(channel_kind, channel_value, sender, ownerId) {
      const policy = await this.get(channel_kind, channel_value);
      return decideAccess(policy, sender, ownerId);
    },
  };
}

// Per-connector persistence. As of Tier 2b, OPERATIONAL STATE lives in the
// dedicated `connectors` table (db.connectors, migration 0008) — queryable +
// no O(all-secrets) decrypt to enumerate. TOKENS and the transient OAuth
// handshake fields stay in the encrypted `secrets` table (SYSTEM_KEY at rest):
//   connector:<id>:tokens → JSON { access_token, refresh_token, token_type, scope, expires_at }
//   connector:<id>:oauth  → JSON { oauthState, pkceVerifier } (only while connecting)
//
// The public store API is UNCHANGED (getTokens/setTokens/getState/setState/
// patchState/remove/listIds) so the runner (scheduler.js) is untouched.
// getState transparently merges the transient OAuth fields back in; setState
// splits them out — so callers keep treating state as one object. `status` ∈
// disconnected | connecting | connected | syncing | error. Tokens + the PKCE
// verifier are NEVER surfaced by status()/list() (see scheduler.js status()).

import { getAdapter } from './registry.js';

const TOKENS = (id) => `connector:${id}:tokens`;
const OAUTH = (id) => `connector:${id}:oauth`;
const LEGACY_STATE = (id) => `connector:${id}:state`; // pre-2b blob (backfilled away)

const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

/** state (camelCase JSON) → connectors table columns (snake_case). */
function toColumns(s) {
  return {
    account_label: s.accountLabel ?? s.account_label ?? null,
    status: s.status ?? 'disconnected',
    cursor: s.cursor ?? null,
    connected_at: s.connectedAt ?? null,
    last_sync_at: s.lastSyncAt ?? null,
    last_ok_at: s.lastOkAt ?? null,
    last_error_at: s.lastErrorAt ?? null,
    last_error: s.lastError ?? null,
    idle_streak: Number.isFinite(s.idleStreak) ? s.idleStreak : null,
    items_last_sync: Number.isFinite(s.itemsLastSync) ? s.itemsLastSync : null,
    items_created: Number.isFinite(s.itemsCreated) ? s.itemsCreated : null,
    items_updated: Number.isFinite(s.itemsUpdated) ? s.itemsUpdated : null,
    items_deduped: Number.isFinite(s.itemsDeduped) ? s.itemsDeduped : null,
    budget_date: s.budgetDate ?? null,
    items_today: Number.isFinite(s.itemsToday) ? s.itemsToday : null,
    recent_runs: Array.isArray(s.recentRuns) ? JSON.stringify(s.recentRuns) : null,
  };
}

/** connectors table row → state (camelCase JSON). lastRun is derived (== recentRuns[0]). */
function fromColumns(r) {
  const recentRuns = parse(r.recent_runs) || [];
  return {
    status: r.status || 'disconnected',
    cursor: r.cursor ?? null,
    accountLabel: r.account_label ?? null,
    connectedAt: r.connected_at ?? null,
    lastSyncAt: r.last_sync_at ?? null,
    lastOkAt: r.last_ok_at ?? null,
    lastErrorAt: r.last_error_at ?? null,
    lastError: r.last_error ?? null,
    idleStreak: r.idle_streak ?? 0,
    itemsLastSync: r.items_last_sync ?? null,
    itemsCreated: r.items_created ?? null,
    itemsUpdated: r.items_updated ?? null,
    itemsDeduped: r.items_deduped ?? null,
    budgetDate: r.budget_date ?? null,
    itemsToday: r.items_today ?? null,
    recentRuns,
    lastRun: recentRuns[0] ?? null,
  };
}

export function createConnectorStore({ db, userId }) {
  if (!db?.secrets) throw new TypeError('createConnectorStore: db.secrets required');
  if (!db?.connectors) throw new TypeError('createConnectorStore: db.connectors required');
  if (!userId) throw new TypeError('createConnectorStore: userId required');

  return {
    async getTokens(id) { return parse(await db.secrets.get(userId, TOKENS(id))); },
    async setTokens(id, tokens) {
      await db.secrets.set(userId, { key: TOKENS(id), value: JSON.stringify(tokens), scope: 'personal', description: `OAuth tokens for connector ${id}` });
    },

    async getState(id) {
      const row = await db.connectors.get(userId, id);
      if (!row) return null;
      const state = fromColumns(row);
      const oauth = parse(await db.secrets.get(userId, OAUTH(id)));
      if (oauth) {
        state.oauthState = oauth.oauthState ?? null;
        state.pkceVerifier = oauth.pkceVerifier ?? null;
      }
      return state;
    },

    /**
     * Full-replace the connector state. Splits the transient OAuth fields into an
     * encrypted secret (kept out of the table) and writes the rest to the
     * connectors table. Absent table columns are persisted as NULL (full replace,
     * matching the old secret-blob semantics).
     */
    async setState(id, state) {
      const { oauthState = null, pkceVerifier = null, ...rest } = state || {};
      if (oauthState || pkceVerifier) {
        await db.secrets.set(userId, {
          key: OAUTH(id),
          value: JSON.stringify({ oauthState, pkceVerifier }),
          scope: 'personal',
          description: `OAuth handshake for connector ${id}`,
        });
      } else {
        await db.secrets.delete(userId, OAUTH(id));
      }
      const cols = toColumns(rest);
      cols.provider = getAdapter(id)?.provider || id; // forward-compat (2c connection-shaping)
      await db.connectors.put(userId, id, cols);
    },

    async patchState(id, patch) {
      const cur = (await this.getState(id)) || {};
      const next = { ...cur, ...patch };
      await this.setState(id, next);
      return next;
    },

    async remove(id) {
      await db.secrets.delete(userId, TOKENS(id));
      await db.secrets.delete(userId, OAUTH(id));
      await db.connectors.remove(userId, id);
    },

    /** Connector ids that have any persisted state. */
    async listIds() {
      return db.connectors.listIds(userId);
    },

    /**
     * One-time migration of any pre-2b `connector:<id>:state` secret blobs into
     * the connectors table. Idempotent: a connector already in the table just has
     * its legacy secret dropped; the legacy blob's transient oauthState/
     * pkceVerifier are re-split into the `:oauth` secret by setState. Safe to call
     * on every boot. Returns { migrated, dropped }.
     */
    async backfillLegacyState() {
      const metas = await db.secrets.list(userId, { prefix: 'connector:' });
      let migrated = 0; let dropped = 0;
      for (const m of metas) {
        const mm = /^connector:(.+):state$/.exec(m.key || '');
        if (!mm) continue;
        const id = mm[1];
        const existing = await db.connectors.get(userId, id);
        if (!existing) {
          const legacy = parse(await db.secrets.get(userId, LEGACY_STATE(id)));
          if (legacy) { await this.setState(id, legacy); migrated += 1; }
        } else {
          dropped += 1;
        }
        await db.secrets.delete(userId, LEGACY_STATE(id));
      }
      return { migrated, dropped };
    },
  };
}

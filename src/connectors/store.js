// Per-connector token + state persistence, backed by the encrypted secrets
// namespace (db.secrets → SYSTEM_KEY at rest). Two secrets per connector:
//   connector:<id>:tokens → JSON { access_token, refresh_token, token_type, scope, expires_at }
//   connector:<id>:state  → JSON { status, cursor, lastSyncAt, lastError, connectedAt, ... }
//
// `status` ∈ disconnected | connecting | connected | syncing | error.
// Tokens and the OAuth PKCE verifier live ONLY in the encrypted store and are
// never surfaced by status()/list() (see scheduler.js status()).

const TOKENS = (id) => `connector:${id}:tokens`;
const STATE = (id) => `connector:${id}:state`;

export function createConnectorStore({ db, userId }) {
  if (!db?.secrets) throw new TypeError('createConnectorStore: db.secrets required');
  if (!userId) throw new TypeError('createConnectorStore: userId required');

  const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

  return {
    async getTokens(id) { return parse(await db.secrets.get(userId, TOKENS(id))); },
    async setTokens(id, tokens) {
      await db.secrets.set(userId, { key: TOKENS(id), value: JSON.stringify(tokens), scope: 'personal', description: `OAuth tokens for connector ${id}` });
    },
    async getState(id) { return parse(await db.secrets.get(userId, STATE(id))); },
    async setState(id, state) {
      await db.secrets.set(userId, { key: STATE(id), value: JSON.stringify(state), scope: 'personal', description: `State for connector ${id}` });
    },
    async patchState(id, patch) {
      const cur = (await this.getState(id)) || {};
      const next = { ...cur, ...patch };
      await this.setState(id, next);
      return next;
    },
    async remove(id) {
      await db.secrets.delete(userId, TOKENS(id));
      await db.secrets.delete(userId, STATE(id));
    },
    /** Connector ids that have any persisted state (connected/connecting/error). */
    async listIds() {
      const metas = await db.secrets.list(userId, { prefix: 'connector:' });
      const ids = new Set();
      for (const m of metas) {
        const mm = /^connector:(.+):state$/.exec(m.key);
        if (mm) ids.add(mm[1]);
      }
      return [...ids];
    },
  };
}

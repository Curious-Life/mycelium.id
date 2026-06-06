/**
 * Vault HTTP client — the daemon reaches the vault ONLY over loopback HTTP, so
 * the vault stays the single DB writer and single key-holder (CLAUDE.md §4).
 * The daemon never opens the SQLite file or holds the master key.
 *
 * Three calls, all against the REST surface on MYCELIUM_API_URL:
 *   - captureMessage         POST /api/v1/captureMessage      (BUILT — src/tools/ingest.js)
 *   - recordEgress           POST /api/v1/internal/egress-audit   (added Phase 0 — src/internal-router.js)
 *   - checkChannelAuthority  GET  /api/v1/internal/channel-authority?kind=&id=  (added Phase 0)
 *
 * Localhost REST is no-auth by design (same-machine trust boundary). If the
 * daemon and vault ever split hosts this base URL MUST become the OAuth-HTTP
 * surface (Bearer + TLS) — see docs/CONNECTORS.md security notes.
 *
 * Every call is soft-fail: audit/authority/persist failures are logged and
 * surfaced as a typed result, never thrown, so a vault hiccup never crashes a
 * delivery in progress. (Authority failure still fails CLOSED — see the
 * chokepoint: an indeterminate authority result denies the send.)
 */

/**
 * @param {object} deps
 * @param {string} deps.baseUrl           e.g. http://127.0.0.1:8787  (NO trailing /api/v1)
 * @param {typeof fetch} [deps.fetch]
 * @param {number} [deps.timeoutMs]
 */
export function createVaultClient({ baseUrl, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  if (!baseUrl || typeof baseUrl !== 'string') throw new TypeError('createVaultClient: baseUrl required');
  if (typeof fetchImpl !== 'function') throw new TypeError('createVaultClient: fetch required');
  const root = baseUrl.replace(/\/+$/, '');

  async function post(path, body) {
    const res = await fetchImpl(`${root}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${path} → http ${res.status}`);
    return res.json().catch(() => ({}));
  }

  return {
    /** Persist a message into the vault (auto-encrypted at rest). Idempotent on id. */
    async captureMessage(args) {
      return post('/api/v1/captureMessage', args);
    },

    /** Fire-and-forget egress audit. Soft-fail: returns {ok:false} instead of throwing. */
    async recordEgress(entry) {
      try {
        await post('/api/v1/internal/egress-audit', entry);
        return { ok: true };
      } catch (e) {
        console.error('[channel-daemon] egress-audit write failed:', e.message);
        return { ok: false };
      }
    },

    /**
     * Channel-authority check. Returns { allowed, reason, ownerUserId? }.
     * Fail-closed: any error → { allowed:false, reason:'authority-unavailable' }.
     */
    async checkChannelAuthority({ kind, id }) {
      try {
        const qs = new URLSearchParams({ kind: String(kind), id: String(id) });
        const res = await fetchImpl(`${root}/api/v1/internal/channel-authority?${qs}`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return { allowed: false, reason: `authority-http-${res.status}` };
        const j = await res.json();
        return { allowed: !!j.allowed, reason: j.reason || null, ownerUserId: j.ownerUserId || null };
      } catch (e) {
        console.error('[channel-daemon] channel-authority check failed:', e.message);
        return { allowed: false, reason: 'authority-unavailable' };
      }
    },
  };
}

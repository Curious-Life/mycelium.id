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

    /**
     * Store raw file bytes as an ENCRYPTED attachment (vault-side blob store +
     * attachments row). Returns { attachmentId } or null on failure (caller
     * falls back to a placeholder — media must never block the text turn).
     * @param {Buffer} bytes
     * @param {{fileName?:string, fileType?:string, timeoutMs?:number}} [opts]
     */
    async uploadAttachment(bytes, { fileName, fileType, timeoutMs: uploadTimeoutMs } = {}) {
      try {
        const qs = new URLSearchParams({
          ...(fileName ? { filename: fileName } : {}),
          ...(fileType ? { type: fileType } : {}),
        });
        const res = await fetchImpl(`${root}/api/v1/upload?${qs}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
          // a 20MB body + encrypt + fsync needs more than the JSON default
          signal: AbortSignal.timeout(uploadTimeoutMs || Math.max(timeoutMs, 60_000)),
        });
        if (!res.ok) return null;
        const j = await res.json().catch(() => null);
        const attachmentId = j?.result?.attachmentId || null;
        return attachmentId ? { attachmentId } : null;
      } catch (e) {
        console.error('[channel-daemon] attachment upload failed:', e.message);
        return null;
      }
    },

    /**
     * Derive turn-visible text from a stored attachment (vault-side LOCAL
     * vision/transcription/decode — src/internal-router.js attachment-context).
     * Returns the contextText string or null (fail-soft; extraction on a cold
     * local model can take minutes, hence the generous budget).
     * @param {{attachmentId:string, kind?:string, timeoutMs?:number}} a
     */
    async attachmentContext({ attachmentId, kind, timeoutMs: ctxTimeoutMs }) {
      try {
        const res = await fetchImpl(`${root}/api/v1/internal/attachment-context`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attachmentId, ...(kind ? { kind } : {}) }),
          // must exceed the vault's transcription budget (300s) or the daemon
          // gives up while the vault is still mid-transcribe.
          signal: AbortSignal.timeout(ctxTimeoutMs || 420_000),
        });
        if (!res.ok) return null;
        const j = await res.json().catch(() => null);
        return typeof j?.contextText === 'string' && j.contextText ? j.contextText : null;
      } catch (e) {
        console.error('[channel-daemon] attachment-context failed:', e.message);
        return null;
      }
    },

    /** Record an auto-router inference-egress decision (hash-only). Soft-fail. */
    async recordInferenceEgress(entry) {
      try { await post('/api/v1/internal/inference-egress', entry); return { ok: true }; }
      catch (e) { console.error('[channel-daemon] inference-egress audit failed:', e.message); return { ok: false }; }
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
     * Fetch the daemon's vault-managed config (decrypted, loopback). null on
     * error so the daemon falls back to its own env. See the vault's
     * /api/v1/internal/channel-config.
     */
    async getChannelConfig() {
      try {
        const res = await fetchImpl(`${root}/api/v1/internal/channel-config`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return null;
        return await res.json();
      } catch (e) {
        console.error('[channel-daemon] channel-config fetch failed (using env):', e.message);
        return null;
      }
    },

    /** Tool names the vault MCP currently advertises (REST mirror). null on error. */
    async listToolNames() {
      try {
        const res = await fetchImpl(`${root}/api/v1/tools`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return null;
        const j = await res.json();
        return Array.isArray(j.tools) ? j.tools.map((t) => t.name) : null;
      } catch { return null; }
    },

    /** Is this Telegram group authorized (active)? Fail-closed on error. */
    async getTelegramGroup(id) {
      try {
        const res = await fetchImpl(`${root}/api/v1/internal/telegram-group?id=${encodeURIComponent(String(id))}`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return { authorized: false };
        return await res.json();
      } catch (e) {
        console.error('[channel-daemon] telegram-group lookup failed:', e.message);
        return { authorized: false };
      }
    },

    /** Authorize a Telegram group for delivery + inbound. */
    async authorizeTelegramGroup({ id, title }) {
      try { await post('/api/v1/internal/telegram-group', { id, title }); return { ok: true }; }
      catch (e) { console.error('[channel-daemon] authorize group failed:', e.message); return { ok: false }; }
    },

    /** Revoke a Telegram group. */
    async revokeTelegramGroup(id) {
      try {
        const res = await fetchImpl(`${root}/api/v1/internal/telegram-group?id=${encodeURIComponent(String(id))}`, { method: 'DELETE', signal: AbortSignal.timeout(timeoutMs) });
        return { ok: res.ok };
      } catch (e) { console.error('[channel-daemon] revoke group failed:', e.message); return { ok: false }; }
    },

    /**
     * Per-channel sender access decision. Returns { respond, mode, reason }.
     * Fail-closed: any error → { respond:false }.
     */
    async checkChannelAccess({ kind, id, sender }) {
      try {
        const qs = new URLSearchParams({ kind: String(kind), id: String(id), ...(sender != null ? { sender: String(sender) } : {}) });
        const res = await fetchImpl(`${root}/api/v1/internal/channel-access?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return { respond: false, reason: `access-http-${res.status}` };
        return await res.json();
      } catch (e) {
        console.error('[channel-daemon] channel-access check failed:', e.message);
        return { respond: false, reason: 'access-unavailable' };
      }
    },

    /** Authorize (on=true) or disallow (on=false) a Discord channel. */
    async setDiscordChannel({ id, name, on }) {
      try { await post('/api/v1/internal/discord-channel', { id, name, on }); return { ok: true }; }
      catch (e) { console.error('[channel-daemon] discord-channel set failed:', e.message); return { ok: false }; }
    },

    /** List authorized Discord channels. */
    async listDiscordChannels() {
      try {
        const res = await fetchImpl(`${root}/api/v1/internal/discord-channels`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return [];
        return (await res.json()).channels || [];
      } catch (e) { console.error('[channel-daemon] list discord-channels failed:', e.message); return []; }
    },

    /** List authorized groups. */
    async listTelegramGroups() {
      try {
        const res = await fetchImpl(`${root}/api/v1/internal/telegram-groups`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return [];
        return (await res.json()).groups || [];
      } catch (e) { console.error('[channel-daemon] list groups failed:', e.message); return []; }
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

/**
 * Handle Client — single chokepoint for VPS-side operator-handle ops.
 *
 * Replaces the three raw-SQL `handle_reservations` SELECTs and one raw
 * INSERT scattered across the codebase. Every read/write goes through
 * the typed Worker endpoints under `/api/handles/*` (see
 * packages/worker/src/handlers/handles.ts), which derive `user_id`
 * from the authenticated bearer token — making it impossible for a
 * compromised tenant to claim/release/read another tenant's row.
 *
 * Usage:
 *   const client = createHandleClient({ workerUrl, ownerHeaders });
 *   await client.mine();              // current handle, cached 5min
 *   await client.claim('alice');      // throws HandleTakenError on 409
 *   await client.release('alice');
 *   await client.check('candidate');  // { available, reason? }
 *
 * Caching:
 *   - mine() positive cache: 5 min — handles change rarely.
 *   - mine() negative cache: 30 s — operator hasn't claimed yet, but
 *     re-checking once per publish event would still hammer the Worker.
 *   - Single-flight: parallel mine() calls dedup to one network fetch.
 *   - claim() and release() invalidate the mine() cache for the
 *     authenticated user immediately.
 *
 * Failure semantics:
 *   - mine(): if Worker unreachable, returns last cached value (any),
 *     otherwise rethrows. Caller (publish hook) treats null/throw the
 *     same: skip render. This is the same risk-profile as the
 *     pre-fix code, but with one-network-hop savings.
 *   - claim(): fail-closed. If the Worker is unreachable, throws.
 *     Replaces the pre-fix `setHandle` Step-3-fallthrough that wrote
 *     to the local cache only — actively misleading UX.
 *   - 409 → typed `HandleTakenError` so portal can branch without
 *     parsing the message.
 *
 * See docs/architecture/HANDLE-REGISTRY-FIX.md §PR-3.
 */

const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;

export class HandleTakenError extends Error {
  constructor(handle) {
    super(`Handle '${handle}' is already claimed`);
    this.name = 'HandleTakenError';
    this.handle = handle;
    this.code = 'already_claimed';
  }
}

export class HandleInvalidError extends Error {
  constructor(handle, reason) {
    super(`Handle '${handle}' invalid: ${reason}`);
    this.name = 'HandleInvalidError';
    this.handle = handle;
    this.reason = reason;
    this.code = 'invalid_handle';
  }
}

/**
 * @typedef {object} HandleClientDeps
 * @property {() => string} workerUrl       — returns the current worker base URL
 * @property {() => Record<string, string>} ownerHeaders — Authorization etc.
 * @property {(url: string, init?: any) => Promise<Response>} [fetch]
 *
 * @returns {{
 *   mine: () => Promise<string|null>,
 *   claim: (handle: string) => Promise<{ handle: string }>,
 *   release: (handle: string) => Promise<void>,
 *   check: (handle: string) => Promise<{ available: boolean, reason?: string }>,
 *   clearCache: () => void,
 * }}
 */
export function createHandleClient(deps) {
  if (!deps) throw new TypeError('createHandleClient: deps required');
  const { workerUrl, ownerHeaders, fetch: fetchImpl = globalThis.fetch } = deps;
  if (typeof workerUrl !== 'function') throw new TypeError('createHandleClient: workerUrl required');
  if (typeof ownerHeaders !== 'function') throw new TypeError('createHandleClient: ownerHeaders required');

  // Per-process cache. The VPS only ever asks "what's MY handle?" so a
  // single slot is sufficient; we don't key by user_id because the
  // bearer token's identity already determines that server-side.
  let cached = null;             // { handle: string|null, expiresAt: number }
  let inflightMine = null;        // Promise<string|null> — single-flight dedup

  function isFresh() {
    return cached && Date.now() < cached.expiresAt;
  }

  function setCache(handle) {
    const ttl = handle ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    cached = { handle, expiresAt: Date.now() + ttl };
  }

  async function workerRequest(path, init = {}) {
    const url = `${workerUrl()}${path}`;
    const headers = { ...ownerHeaders(), ...(init.headers || {}) };
    const res = await fetchImpl(url, {
      ...init,
      headers,
      // Bound the request — the Worker handlers respond fast (<200ms);
      // anything longer is almost certainly a network hang we want to
      // surface, not silently wait on.
      signal: init.signal || AbortSignal.timeout(10_000),
    });
    return res;
  }

  // ── mine() — caller's current handle, with cache + single-flight ───

  async function mineUncached() {
    const res = await workerRequest('/api/handles/mine', { method: 'GET' });
    if (!res.ok) {
      throw new Error(`handle-client.mine: ${res.status} ${await res.text().catch(() => '')}`);
    }
    const data = await res.json();
    return data?.handle ?? null;
  }

  async function mine() {
    if (isFresh()) return cached.handle;
    if (inflightMine) return inflightMine;
    inflightMine = (async () => {
      try {
        const handle = await mineUncached();
        setCache(handle);
        return handle;
      } catch (err) {
        // On network/Worker failure, fall back to last-known cached
        // value if any (even expired). Better stale than 500.
        if (cached) return cached.handle;
        throw err;
      } finally {
        inflightMine = null;
      }
    })();
    return inflightMine;
  }

  // ── claim() — fail-closed, invalidates mine() cache ────────────────

  async function claim(handle) {
    if (typeof handle !== 'string' || !handle) {
      throw new HandleInvalidError(String(handle), 'missing');
    }
    const res = await workerRequest('/api/handles/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    });
    if (res.status === 409) {
      throw new HandleTakenError(handle);
    }
    if (res.status === 400) {
      const body = await res.json().catch(() => ({}));
      throw new HandleInvalidError(handle, body.reason || 'invalid');
    }
    if (!res.ok) {
      // Fail-closed: do NOT update cache; do NOT silently succeed.
      const body = await res.text().catch(() => '');
      throw new Error(`handle-client.claim failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    // Successful claim — invalidate cache so the next mine() reflects.
    cached = null;
    return { handle: data.handle };
  }

  // ── release() — fail-closed, invalidates cache ─────────────────────

  async function release(handle) {
    if (typeof handle !== 'string' || !handle) {
      throw new HandleInvalidError(String(handle), 'missing');
    }
    const res = await workerRequest('/api/handles/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    });
    if (res.status === 404) {
      // Not the owner (or already released). Surface as Error so the
      // caller can decide; the message is unambiguous.
      throw new Error(`handle-client.release: not the owner of '${handle}'`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`handle-client.release failed (${res.status}): ${body.slice(0, 200)}`);
    }
    cached = null;
  }

  // ── check() — uncached availability probe ──────────────────────────

  async function check(handle) {
    if (typeof handle !== 'string' || !handle) {
      return { available: false, reason: 'missing' };
    }
    const res = await workerRequest(
      `/api/handles/check?handle=${encodeURIComponent(handle)}`,
      { method: 'GET' },
    );
    // 400 + 200 + 429 all carry a JSON body with available/reason —
    // surface them uniformly.
    const data = await res.json().catch(() => ({}));
    if (typeof data.available === 'boolean') return data;
    return { available: false, reason: data.reason || `http_${res.status}` };
  }

  return {
    mine,
    claim,
    release,
    check,
    /** Test seam: drop in-process cache + any single-flight promise. */
    clearCache() {
      cached = null;
      inflightMine = null;
    },
  };
}

// nonce.js — single-use, short-TTL challenge nonces (replay protection). The
// client GETs /v1/challenge, signs action|handle|nonce, and POSTs the claim; the
// nonce is consumed on first use so a captured claim cannot be replayed.
//
// Hardened: bounded Map size + sweep-on-issue + a periodic sweeper, so a flood of
// un-consumed /challenge calls cannot grow memory without limit (OOM defense).
// In-memory for V1 (a single control-plane instance); back it with the registry
// DB for HA.
import crypto from 'node:crypto';

export function createNonceStore({ ttlMs = 5 * 60 * 1000, maxSize = 100000, now = () => Date.now() } = {}) {
  const m = new Map(); // nonce → expiresAt

  function sweep() {
    const t = now();
    for (const [k, v] of m) if (v < t) m.delete(k);
  }

  return {
    issue() {
      if (m.size >= maxSize) sweep();              // reclaim expired under pressure
      if (m.size >= maxSize) {                      // still full → evict oldest (FIFO)
        const oldest = m.keys().next().value;
        if (oldest !== undefined) m.delete(oldest);
      }
      const n = crypto.randomBytes(18).toString('base64url');
      m.set(n, now() + ttlMs);
      return n;
    },
    /** True iff the nonce exists AND is unexpired; always removes it (single-use). */
    consume(n) {
      if (typeof n !== 'string') return false;
      const exp = m.get(n);
      if (exp === undefined) return false;
      m.delete(n);
      return exp >= now();
    },
    sweep,
    /** Periodic expiry sweep so idle entries don't accumulate. Unref'd. */
    startSweeper(intervalMs = 60000) {
      const t = setInterval(sweep, intervalMs);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    },
    size() { return m.size; },
  };
}

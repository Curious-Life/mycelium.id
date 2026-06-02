// nonce.js — single-use, short-TTL challenge nonces (replay protection). The
// client GETs /v1/challenge, signs handle|nonce, and POSTs the claim; the nonce
// is consumed on first use so a captured claim cannot be replayed. In-memory for
// V1 (a single control-plane instance); back it with the registry DB for HA.
import crypto from 'node:crypto';

export function createNonceStore({ ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  const m = new Map(); // nonce → expiresAt

  return {
    issue() {
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
    sweep() {
      const t = now();
      for (const [k, v] of m) if (v < t) m.delete(k);
    },
    size() { return m.size; },
  };
}

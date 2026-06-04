// ratelimit.js — abuse controls for the unauthenticated control-plane endpoints.
//   createRateLimiter: a per-IP token bucket (bounds request rate; the ed25519
//     signature gate is free to satisfy with a throwaway key, so rate is the
//     real control). Bounded Map (evict-oldest) so the limiter itself can't OOM.
//   createDailyCap: a global counter of NEW handles/day, so the control-plane
//     self-throttles to stay UNDER the CA's per-registered-domain weekly cap
//     (Let's Encrypt: 50 certs / mycelium.id / 7 days) rather than trusting demand.
// In-memory, single-instance V1; back with a shared store for HA.

export function createRateLimiter({ capacity = 20, refillPerMin = 20, maxIps = 50000, now = () => Date.now() } = {}) {
  const buckets = new Map(); // ip → { tokens, last }
  const ratePerMs = refillPerMin / 60000;
  return {
    allow(ip) {
      const key = ip || 'unknown';
      const t = now();
      let b = buckets.get(key);
      if (!b) {
        if (buckets.size >= maxIps) {
          const oldest = buckets.keys().next().value; // bound memory
          if (oldest !== undefined) buckets.delete(oldest);
        }
        b = { tokens: capacity, last: t };
        buckets.set(key, b);
      }
      b.tokens = Math.min(capacity, b.tokens + (t - b.last) * ratePerMs);
      b.last = t;
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    },
    size() { return buckets.size; },
  };
}

export function createDailyCap({ max = 40, now = () => Date.now() } = {}) {
  let day = null;
  let count = 0;
  const bucket = () => Math.floor(now() / 86400000);
  return {
    tryConsume() {
      const d = bucket();
      if (d !== day) { day = d; count = 0; }
      if (count >= max) return false;
      count += 1;
      return true;
    },
    refund() { if (count > 0) count -= 1; }, // on a failed provision, give the slot back
    remaining() { return bucket() !== day ? max : Math.max(0, max - count); },
  };
}

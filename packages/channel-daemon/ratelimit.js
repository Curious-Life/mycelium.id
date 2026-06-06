/**
 * Outbound rate limiter (Phase 3 hardening) — platform-agnostic, per-target.
 *
 * A fixed-window cap on sends to a single target. Telegram is lenient by default
 * (a real person's chat won't hit it); the value is the backstop against a
 * runaway agent loop spamming a chat, and it's exactly the gate Discord needs
 * (per-channel hourly budgets). The chokepoint consults it as one more gate; an
 * over-limit send is audited 'denied' (reason rate-limited) and returns 429, so
 * the reply tool surfaces errorCode 'rate-limited' and the agent does NOT retry.
 *
 * Fixed-window (not token-bucket) for legibility: counts within the current
 * window per target; resets when the window rolls over.
 */

const DEFAULT_MAX = 20;
const DEFAULT_WINDOW_MS = 60_000;

/**
 * @param {object} [opts]
 * @param {number} [opts.maxPerWindow]
 * @param {number} [opts.windowMs]
 * @param {()=>number} [opts.now]  test seam
 */
export function createRateLimiter({ maxPerWindow = DEFAULT_MAX, windowMs = DEFAULT_WINDOW_MS, now = () => Date.now() } = {}) {
  /** @type {Map<string, {count:number, windowStart:number}>} */
  const buckets = new Map();

  return {
    /**
     * Record an intent to send to `target` and report whether it's allowed.
     * Call once per send attempt (it increments on allow). Returns
     * { allowed, retryAfterMs }.
     */
    take(target) {
      const key = String(target);
      const t = now();
      let b = buckets.get(key);
      if (!b || t - b.windowStart >= windowMs) {
        b = { count: 0, windowStart: t };
        buckets.set(key, b);
      }
      if (b.count >= maxPerWindow) {
        return { allowed: false, retryAfterMs: b.windowStart + windowMs - t };
      }
      b.count++;
      return { allowed: true, retryAfterMs: 0 };
    },

    _state(target) { return buckets.get(String(target)) || null; },
  };
}

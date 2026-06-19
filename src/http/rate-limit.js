// src/http/rate-limit.js — a global, IP-independent request throttle for a
// single-user box's relay-exposed auth endpoints (gap review, 2026-06-06).
//
// better-auth's built-in rate limiter keys by client IP, which behind the on-Mac
// Caddy resolves to 127.0.0.1 (so it can't distinguish callers) and would only
// work if we trusted X-Forwarded-For — which an attacker can spoof to mint fresh
// buckets and evade the limit. For a SINGLE-USER vault the right control is a
// GLOBAL bucket per protected path: an attacker cannot evade it by rotating any
// header, and the mild self-throttle during an attack window is an accepted trade
// for un-evadable brute-force protection on the operator password.

/**
 * @param {{ method?: string, path: string, max?: number, windowMs?: number }} opts
 * @returns {import('express').RequestHandler}
 */
export function createPathThrottle({ method = 'POST', path, max = 5, windowMs = 60_000 }) {
  const wantMethod = method.toUpperCase();
  let hits = []; // timestamps within the window (global bucket for this path)
  return (req, res, next) => {
    if (req.method !== wantMethod || req.path !== path) return next();
    const now = Date.now();
    hits = hits.filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      const retryMs = windowMs - (now - hits[0]);
      res.set('Retry-After', String(Math.ceil(retryMs / 1000)));
      return res.status(429).json({ error: 'too_many_requests' });
    }
    hits.push(now);
    return next();
  };
}

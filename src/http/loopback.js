// src/http/loopback.js — the single trust boundary for "did this request arrive
// as a genuine local (owner) request, or through the relay / a reverse proxy?"
//
// SECURITY (fixes V-1 — see docs/DESIGN-portal-auth-relay-2026-06-05.md).
// Control surfaces that mint/return the master key (/api/v1/account) or set the
// operator password (/api/v1/remote), and the portal data gate, must tell a true
// loopback caller apart from a request that Caddy/the relay reverse-proxied in.
// The socket peer is loopback in BOTH cases — Caddy connects to the local server
// from 127.0.0.1 — so the peer IP ALONE is not sufficient. That was the V-1 hole:
// account/router.js + remote/router.js gated on loopback-IP only, so once the
// portal server is exposed through the relay, an internet request would read as
// local and could pull the recovery key / reset the operator password.
//
// The linchpin: a reverse proxy ALWAYS injects X-Forwarded-For, and a remote
// attacker can ADD that header but can never REMOVE the one Caddy adds. So a
// request is trusted-local IFF its socket peer is loopback AND it carries no
// X-Forwarded-For. The portal/REST server binds 127.0.0.1, so the only callers
// that reach it without an XFF are local processes — the pre-existing trust
// model. Fail closed: anything else is treated as networked and must authenticate.
//
// NB: keyed on req.socket.remoteAddress (the raw socket peer), NOT req.ip —
// req.ip is derived from X-Forwarded-For when Express `trust proxy` is enabled,
// which would invert this check. And XFF is tested by PRESENCE, not truthiness:
// an empty `X-Forwarded-For:` header still signals a proxy hop.

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Any of these present ⇒ the request traversed a proxy ⇒ NOT a genuine local
// request. Caddy (our relay edge) sets X-Forwarded-For; the others are included
// for defence in depth so the trust does not hinge on a single header / a
// specific proxy. Presence — not truthiness — counts (an empty value still
// signals a hop). A remote attacker can ADD these but never REMOVE the one the
// proxy injects, so the check cannot be cleared from outside.
const FORWARD_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host'];

/**
 * @param {import('express').Request} req
 * @returns {boolean} true iff this is a genuine same-host (owner) request.
 */
export function isTrustedLoopback(req) {
  const peer = req?.socket?.remoteAddress || '';
  if (!LOOPBACK_PEERS.has(peer)) return false;
  const headers = req?.headers || {};
  for (const name of FORWARD_HEADERS) {
    if (headers[name] !== undefined) return false;
  }
  return true;
}

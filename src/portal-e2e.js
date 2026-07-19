// src/portal-e2e.js — the box side of the E2E REST transport
// (docs/E2E-REACHABILITY-DESIGN-2026-07-19.md §2.1/§2.2, Phase 2b).
//
// Two PUBLIC endpoints (the phone is unauthenticated at the HTTP layer — auth lives
// INSIDE the session), mounted at root outside /api like the pairing claim/result:
//   POST /e2e/handshake — the phone's msg1 → validate its device token → msg2 + a
//                         session id (sid). Establishes a forward-secret channel.
//   POST /e2e/rpc       — { sid, frame } → open the frame (a sealed REST envelope) →
//                         DISPATCH it through the box's OWN gate as a networked,
//                         device-token-authed loopback call → seal the response.
//
// Why dispatch through the gate (not a trusted-loopback bypass): the envelope is
// replayed to 127.0.0.1 with an X-Forwarded-For header (so isTrustedLoopback is
// FALSE → the request is treated as networked) plus the session's device-token as a
// Bearer. It therefore traverses the SAME auth boundary as a direct remote phone:
//   • portal data routes authorize via the device-token path (Unit A);
//   • a REVOKED token → 401 automatically (the gate re-checks every request);
//   • control surfaces (/api/v1/account, /api/v1/remote) self-gate loopback-only →
//     a networked E2E request can NEVER reach them.
// So the E2E layer adds CONFIDENTIALITY only; authorization is unchanged + reused.
//
// The relay/Cloudflare in front of this sees only { sid, sealed frame } — no path,
// no token, no plaintext.

import express from 'express';
import crypto from 'node:crypto';
import { openClientAuth, completeServer } from './crypto/e2e-session.js';

const SESSION_TTL_MS = 60 * 60_000; // 1h idle
const MAX_SESSIONS = 50;
const MAX_BODY = '2mb';
// Only portal data paths may be carried. Belt-and-suspenders on top of the gate's
// own control-surface loopback-gating (defence in depth).
const ALLOWED_PREFIX = '/api/v1/portal/';
// The device-pairing CEREMONY (mint/approve/revoke device tokens) is loopback-only
// by design — it lives under the portal prefix, so it must be EXCLUDED here so the
// E2E/relay path cannot reach it at all. Without this, a paired phone could aim
// /api/v1/portal/pair/approve through the tunnel and the ONLY thing stopping it would
// be the ceremony's own isTrustedLoopback guard — a single layer. This deny makes it
// two independent layers (CLAUDE.md §2), so a paired device can never approve a NEW
// device or revoke a sibling remotely even if the loopback guard were ever weakened.
const DENIED_PREFIX = '/api/v1/portal/pair/';

/**
 * @param {{ db, identity, restPort:number, userId?:string,
 *           fetchImpl?:Function }} deps  identity exposes keyAgreementSharedSecret +
 *           keyAgreementPublicKeyB64 (the responder static key); restPort = the local
 *           REST port for loopback dispatch; fetchImpl injectable for tests.
 */
export function createE2ERouter({ db, identity, restPort, userId = 'local-user', fetchImpl } = {}) {
  if (!db?.deviceTokens) throw new Error('createE2ERouter: db.deviceTokens required');
  if (!identity?.keyAgreementSharedSecret) throw new Error('createE2ERouter: box identity required');
  const doFetch = fetchImpl || globalThis.fetch;
  const sessions = new Map(); // sid -> { session, token, lastSeen }

  function prune() {
    const now = Date.now();
    for (const [sid, s] of sessions) if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(sid);
  }

  const router = express.Router();
  // Body parser is attached PER-ROUTE (not router-wide via .use) because this router
  // is mounted at ROOT (v.use(router)) — a router-wide express.json would run for
  // EVERY request flowing through, including large-body routes like importMessages
  // (64mb), and 413 them before they reach their own parser. Per-route scoping means
  // the parser only runs when an /e2e/* route actually matches (audit: body-parser
  // shadowing found by verify:portal P8).
  const jsonBody = express.json({ limit: MAX_BODY });

  router.post('/e2e/handshake', jsonBody, (req, res) => {
    prune();
    if (sessions.size >= MAX_SESSIONS) return res.status(429).json({ error: 'too many sessions' });
    try {
      const opened = openClientAuth(identity, req.body?.msg1); // throws on bad ECDH / tampered auth
      const uid = db.deviceTokens.matchSync(opened.deviceToken);
      if (!uid) return res.status(401).json({ error: 'unauthorized' }); // unknown/revoked token
      const { msg2, session } = completeServer(opened);
      const sid = crypto.randomBytes(16).toString('base64url');
      sessions.set(sid, { session, token: opened.deviceToken, lastSeen: Date.now() });
      res.json({ sid, msg2 });
    } catch {
      res.status(400).json({ error: 'handshake failed' }); // no detail leaked
    }
  });

  router.post('/e2e/rpc', jsonBody, async (req, res) => {
    prune();
    const ses = sessions.get(req.body?.sid);
    if (!ses) return res.status(404).json({ error: 'no session' });
    let envelope;
    try { envelope = JSON.parse(ses.session.open(req.body.frame).toString('utf8')); }
    catch { return res.status(400).json({ error: 'bad frame' }); } // AEAD/seq failure
    const out = await dispatch(envelope, ses.token);
    ses.lastSeen = Date.now();
    // Seal the response inside the session (relay sees only ciphertext).
    res.json({ frame: ses.session.seal(JSON.stringify(out)) });
  });

  /** Replay one envelope through the box's own gate as a networked device-token call. */
  const blocked = () => ({ status: 403, body: '{"error":"path not allowed"}' });
  async function dispatch({ method, path, headers, body } = {}, token) {
    const m = String(method || 'GET').toUpperCase();
    const origin = `http://127.0.0.1:${restPort}`;
    // NORMALIZE FIRST, then validate the RESOLVED target — a raw string check misses
    // `%2e%2e` / `..` traversal (WHATWG URL decodes them → e.g. /api/v1/account) and
    // absolute-URL SSRF (http://evil, //evil). Require same-origin + a resolved
    // pathname under the portal allowlist. (Defence-in-depth on top of the fact that
    // control surfaces are loopback-only and this dispatch is networked.)
    let target;
    try { target = new URL(String(path || ''), origin); } catch { return blocked(); }
    // Compare the allow/deny prefixes against a LOWERCASED pathname: Express routes
    // case-INSENSITIVELY (no caseSensitive option is set), so `/api/v1/portal/PAIR/…`
    // would otherwise escape the case-sensitive DENIED_PREFIX yet still reach the
    // ceremony handler — defeating the second layer this deny exists to provide. Only
    // the guard's view is lowercased; the forwarded URL (target.href) keeps its original
    // case so downstream case-sensitive path segments are untouched.
    const guardPath = target.pathname.toLowerCase();
    if (target.origin !== origin || !guardPath.startsWith(ALLOWED_PREFIX)) return blocked();
    if (guardPath.startsWith(DENIED_PREFIX)) return blocked(); // pairing ceremony is loopback-only (2nd layer, CLAUDE.md §2)
    // Forward only safe, non-hop headers from the phone; the box sets auth + XFF itself.
    const fwd = {};
    for (const [k, v] of Object.entries(headers || {})) {
      const key = k.toLowerCase();
      if (['content-type', 'accept'].includes(key)) fwd[key] = String(v);
    }
    fwd['authorization'] = `Bearer ${token}`; // device token → gate authorizes / revokes
    fwd['x-forwarded-for'] = '127.0.0.1';      // mark as networked → gate applies (not loopback bypass)
    try {
      const r = await doFetch(target.href, {
        method: m,
        headers: fwd,
        body: m === 'GET' || m === 'HEAD' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
      });
      return { status: r.status, body: await r.text() };
    } catch {
      return { status: 502, body: '{"error":"upstream"}' };
    }
  }

  return { router, _sessions: sessions };
}

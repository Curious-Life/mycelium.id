// src/http/require-vault-auth.js — the fail-closed per-request gate for the
// portal/REST vault-data surface (Phase 1, step 1.2 of the mobile plan; design:
// docs/DESIGN-portal-auth-relay-2026-06-05.md).
//
// V1 history: the portal+REST server (:8787) had NO per-request auth — it was
// "always signed in" and bound to localhost. To reach it from a phone over the
// relay we must authenticate every NETWORKED request while leaving the local
// desktop (loopback) path untouched.
//
// Trust order (fail closed): trusted loopback (desktop/local) → static Bearer
// (future native client) → browser session cookie (the webview). The cookie is
// validated by FORWARDING it to the local OAuth/MCP server (:4711)'s better-auth
// /api/auth/get-session — :4711 owns auth.db and stays the single auth authority,
// so server-rest never opens it (no second writer, no shared-SQLite race). The
// in-process auth.api.getSession was confirmed to work + fail-closed by Spike #1;
// HTTP-forward is the chosen path for the cleaner trust boundary.

import crypto from 'node:crypto';
import { isTrustedLoopback } from './loopback.js';
import { matchStaticBearer } from '../gateway/static-bearer.js';
import { readRemoteConfig, resolveMcpBearer } from '../remote/config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_COOKIE = 'mycelium_csrf';
const VALIDATE_TIMEOUT_MS = 5000;

// The Bearer the native app authenticates with. matchStaticBearer is env-first
// (MYCELIUM_MCP_BEARER) but ALSO accepts the auto-provisioned/persisted bearer —
// the value GET /portal/mcp-bearer surfaces in the "Connect a phone" panel — so a
// token copied from that panel works with ZERO env setup (a GUI app can't easily
// inject env into the spawned vault). resolveMcpBearer() is env-first→persisted,
// identical to what the panel shows. Resolved once + cached (one auth.db read);
// fail-soft to null (→ bearer path simply disabled, loopback/cookie unaffected).
let _expectedBearer;
function expectedBearer() {
  if (_expectedBearer === undefined) {
    try { _expectedBearer = resolveMcpBearer() || null; } catch { _expectedBearer = null; }
  }
  return _expectedBearer;
}

export function parseCookies(req) {
  const out = {};
  const raw = req?.headers?.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Default session validator: forward the browser Cookie to :4711's better-auth
 * /api/auth/get-session. Fail-closed: non-200 / missing user / :4711 down → null.
 * @returns {Promise<string|null>} the authenticated user id, or null.
 */
export function defaultValidateSession(cookieHeader) {
  if (!cookieHeader) return Promise.resolve(null);
  const base = process.env.MYCELIUM_AUTH_URL
    || `http://127.0.0.1:${process.env.MYCELIUM_PORT || 4711}`;
  // Bounded: a hung/slow :4711 must not stall every networked request — abort and
  // fail closed (→ 401) rather than hang.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VALIDATE_TIMEOUT_MS);
  // Defence in depth (audit): pin the session to the SINGLE vault owner. Even if
  // some path ever minted a non-owner better-auth account, its session must NOT
  // authorize into the owner's vault. The owner email is the CANONICAL one the
  // operator account was created with — readRemoteConfig().operatorEmail folds in
  // MYCELIUM_USER_EMAIL → remote.json operatorEmail → default, the exact same chain
  // setOperatorPassword/ensureOperatorUser use — so a custom-email operator is NOT
  // locked out. (Falls back to the default if remote.json can't be read.)
  let ownerEmail = 'operator@mycelium.local';
  try { ownerEmail = (readRemoteConfig().operatorEmail || ownerEmail); } catch { /* default */ }
  ownerEmail = ownerEmail.toLowerCase();
  return fetch(`${base}/api/auth/get-session`, { headers: { cookie: cookieHeader }, signal: ctrl.signal })
    .then(async (r) => {
      if (!r.ok) return null;
      const body = await r.json().catch(() => null);
      const id = body?.user?.id || body?.session?.userId || null;
      const email = body?.user?.email ? String(body.user.email).toLowerCase() : null;
      if (!id || email !== ownerEmail) return null; // not the owner → deny
      return String(id);
    })
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

/**
 * Resolve who a request is, fail-closed. Returns { id, via } | null.
 */
export async function resolveRequester(req, { userId, validateSession = defaultValidateSession }) {
  if (isTrustedLoopback(req)) return { id: userId, via: 'loopback' };
  const authz = req?.headers?.authorization;
  if (authz && matchStaticBearer(authz, process.env, expectedBearer())) return { id: userId, via: 'bearer' };
  // Bearer presented as a cookie — the in-app WKWebView "window into the portal"
  // sets an HttpOnly `mycelium_bearer` cookie so the portal SPA's same-origin
  // fetches authenticate without an Authorization header (WKWebView can't add one
  // to XHR). Same authority as the header Bearer; treated as via:'bearer' (no
  // ambient browser credential to forge → CSRF-exempt, like the header path).
  const bearerCookie = parseCookies(req).mycelium_bearer;
  if (bearerCookie && matchStaticBearer(`Bearer ${bearerCookie}`, process.env, expectedBearer())) {
    return { id: userId, via: 'bearer' };
  }
  const cookieHeader = req?.headers?.cookie;
  if (cookieHeader) {
    const id = await validateSession(cookieHeader);
    if (id) return { id, via: 'cookie' };
  }
  return null;
}

/** True iff the request is authorized (any of the three paths). */
export async function isAuthorized(req, opts) {
  return Boolean(await resolveRequester(req, opts));
}

function timingEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Double-submit CSRF cookie. Set once if absent; NOT HttpOnly by design (the SPA
 * reads it and echoes it as X-CSRF-Token — see portal-app/src/lib/api.ts). The
 * gate enforces it on cookie-authed unsafe methods; SameSite=Lax is the primary
 * defense. (No `Secure` so it also works over loopback http during local dev; the
 * relay is https end-to-end where the browser still sends it.)
 */
export function csrfCookieMiddleware(req, res, next) {
  if (!parseCookies(req)[CSRF_COOKIE]) {
    const token = crypto.randomBytes(16).toString('hex');
    // Secure over the relay (https end-to-end), flagless on loopback http (local
    // dev / desktop). NOT HttpOnly by design — the SPA reads it for double-submit.
    const https = req.secure === true || String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    res.append('Set-Cookie', `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax${https ? '; Secure' : ''}`);
    // Make it visible to handlers within THIS request too (double-submit on the
    // very first unsafe call would otherwise lack the cookie side).
    req.headers.cookie = (req.headers.cookie ? req.headers.cookie + '; ' : '') + `${CSRF_COOKIE}=${token}`;
  }
  next();
}

/**
 * The gate. Mounted FIRST inside the vault sub-app. Only enforces on
 * vault-data paths (SPA navigation falls through to static). Loopback bypasses;
 * every networked request needs a valid session cookie or static Bearer, and a
 * cookie-authed unsafe method additionally needs the matching CSRF header.
 *
 * @param {{ userId: string, validateSession?: (cookie:string)=>Promise<string|null> }} opts
 */
/**
 * Sync owner-gate for the per-router `authenticatePortalRequest` on the SENSITIVE
 * portal routers (chat / measurement / claims / activity / usage / transcription).
 * Those routers decrypt vault plaintext, so they gate INDEPENDENTLY of the global
 * `/api` vaultAuth middleware (defence in depth). Historically loopback-only; this
 * adds the owner's static Bearer so the native app (over Tailscale, incl. the
 * native-TLS listener) can reach them — the SAME bearer authority the global gate
 * already trusts (`matchStaticBearer`, env `MYCELIUM_MCP_BEARER`, fail-closed). It
 * deliberately does NOT honor the cookie/relay path here. Fail-closed: returns
 * null for anything that is neither trusted-loopback nor the owner's valid Bearer.
 *
 * @param {{ userId: string }} opts
 * @returns {(req) => ({ id: string } | null)}
 */
export function makePortalOwnerGate({ userId }) {
  return (req) => {
    if (isTrustedLoopback(req)) return { id: userId };
    const authz = req?.headers?.authorization;
    if (authz && matchStaticBearer(authz, process.env, expectedBearer())) return { id: userId };
    // Bearer-as-cookie (the in-app WKWebView portal) — same authority, so the SPA's
    // same-origin fetches reach the sensitive routers too (chat/measurement/…).
    const bearerCookie = parseCookies(req).mycelium_bearer;
    if (bearerCookie && matchStaticBearer(`Bearer ${bearerCookie}`, process.env, expectedBearer())) return { id: userId };
    return null;
  };
}

export function createVaultAuthMiddleware({ userId, validateSession = defaultValidateSession }) {
  // NB: mounted at `/api` in the vault sub-app (see server-rest.js), so Express's
  // own route matching — the SAME matcher the data routers use — decides what is
  // gated. This avoids any divergence between a hand-rolled path check and the
  // router (encoding / `//` normalization bypasses). SPA navigation is not under
  // `/api`, so it never reaches this gate.
  return async (req, res, next) => {
    try {
      const who = await resolveRequester(req, { userId, validateSession });
      if (!who) return res.status(401).json({ error: 'unauthorized' });
      if (who.via === 'cookie' && !SAFE_METHODS.has(req.method)) {
        const csrf = parseCookies(req)[CSRF_COOKIE];
        if (!csrf || !timingEqual(req.headers['x-csrf-token'], csrf)) {
          return res.status(403).json({ error: 'csrf' });
        }
      }
      req.requester = who;
      return next();
    } catch {
      return res.status(401).json({ error: 'unauthorized' }); // fail closed
    }
  };
}

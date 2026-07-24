import crypto from 'node:crypto';
import express from 'express';
import { isTrustedLoopback } from './http/loopback.js';
import { parseCookies } from './http/require-vault-auth.js';

// The unified device-session cookie (U7). Server-set only — HttpOnly (so it is not
// JS-readable and not client-injectable) with validity derived per request from the
// backing device token (no independent TTL — R0). See src/db/device-sessions.js +
// docs/UNIFIED-AUTH-DESIGN-2026-07-24.md.
const DEVICE_SESSION_COOKIE = 'mycelium_device_session';
const CSRF_COOKIE = 'mycelium_csrf';
const SESSION_COOKIE_MAX_AGE = 34560000; // 400 d — persistent by design; the token binding is the lifetime

/** Extract the raw token from `Authorization: Bearer <token>`, else null. */
function bearerToken(authz) {
  const m = /^Bearer\s+(.+)$/i.exec(String(authz || '').trim());
  return m ? m[1].trim() : null;
}

/** Constant-time string compare (fail-closed on length mismatch / empty). */
function timingEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Secure iff the request arrived over TLS — the EXACT predicate the CSRF cookie
 *  uses (require-vault-auth.js). Omitted on a plain-http LAN vault (A12) so the
 *  cookie is still sent; HttpOnly + SameSite are applied unconditionally. */
function isHttps(req) {
  return req?.secure === true
    || String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setSessionCookie(req, res, secret) {
  const secure = isHttps(req) ? '; Secure' : '';
  // NO Domain= EVER (host-only) — a domain-scoped cookie survives the iOS host-keyed
  // logout purge, re-creating the logout-bypass bug with a longer-lived credential.
  res.append('Set-Cookie', `${DEVICE_SESSION_COOKIE}=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE}${secure}`);
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', `${DEVICE_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** A non-secret, owner-visible label for a web browser, from its User-Agent. */
function webLabel(ua) {
  const s = String(ua || '');
  let browser = 'Browser';
  if (/edg\//i.test(s)) browser = 'Edge';
  else if (/chrome\//i.test(s) && !/edg\//i.test(s)) browser = 'Chrome';
  else if (/firefox\//i.test(s)) browser = 'Firefox';
  else if (/safari\//i.test(s) && !/chrome\//i.test(s)) browser = 'Safari';
  let os = '';
  if (/mac os x|macintosh/i.test(s)) os = 'macOS';
  else if (/windows/i.test(s)) os = 'Windows';
  else if (/android/i.test(s)) os = 'Android';
  else if (/iphone|ipad|ios/i.test(s)) os = 'iOS';
  else if (/linux/i.test(s)) os = 'Linux';
  return (`Web — ${browser}${os ? ' on ' + os : ''}`).slice(0, 64);
}

/**
 * authShimRouter — local "always signed in" auth surface for V1.
 *
 * The canonical portal was built for the cloud product, where every page
 * validates a session via `/auth/session` (portal-app root +layout.svelte) and
 * falls back to a passkey/Telegram login at `/login`. V1 is fundamentally
 * different: it is single-user and the vault is ALREADY UNLOCKED the moment the
 * server boots — the master keys are read at startup from the key source
 * (env / macOS Keychain / 1Password, see src/crypto/key-source.js) and the
 * process refuses to start without them (boot-time KCV gate, src/crypto/keys.js).
 * The REST surface has no per-request auth and binds localhost-only by design.
 *
 * So there is nothing for a browser "login" to unlock — the Keychain/1Password
 * integration lives on the SERVER (key source), not in the browser. This shim
 * makes the portal's session check succeed ("you are signed in") so the app
 * opens straight to the workspace instead of bouncing to a /login page V1 has
 * no backend for. It deliberately does NOT implement passkey/OAuth ceremonies.
 *
 * Mounted at `/auth`. Security note: this grants no new access — the data
 * surface already had no auth and is localhost-only (Phase 4 adds real auth for
 * any networked deployment). This only stops the UI demanding a login.
 *
 * @param {object} deps
 * @param {string} deps.userId  the single V1 owner id
 * @param {string} [deps.handle]  static fallback handle (legacy/tests)
 * @param {() => (string|null)} [deps.getHandle]  live handle source (the vault's
 *   tag, derived from publicHost). Read per-request so a handle claimed after boot
 *   is reflected without a restart, and returns null when no handle is set yet —
 *   the login UI then shows a generic "your vault" instead of a placeholder. When
 *   provided it is authoritative over `handle`.
 * @param {(req: import('express').Request) => boolean | Promise<boolean>} [deps.resolveAuthorized]
 *   Optional gate for `/session`: when provided, a request that is NOT authorized
 *   gets 401 (so a networked browser bounces to /login). Default (loopback-only
 *   V1) is "always authorized" — desktop behavior is unchanged.
 * @returns {import('express').Router}
 */
export function authShimRouter({ userId, handle = 'local', getHandle, getRequirePasskey, resolveAuthorized, getDb, validateSession }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  // Lazy db accessor — the vault handle is populated at completeBoot, after this
  // router is constructed (matching the resolveAuthorized closure). Absent handle /
  // namespaces ⇒ the endpoint 503s, never fails open.
  const db = () => { try { return (typeof getDb === 'function') ? getDb() : null; } catch { return null; } };

  // Whether web sign-in requires a passkey (the EFFECTIVE policy: enabled AND a
  // passkey enrolled). Read live. The SPA login reads this from /setup-status to
  // render passkey-only — /api/v1/remote/status is edge-denied over the relay, so
  // this shim (portal-served) is how the relay browser learns the policy.
  const requirePasskey = () => { if (!getRequirePasskey) return false; try { return getRequirePasskey() === true; } catch { return false; } };

  // The vault's tag. getHandle (when supplied) is authoritative and live — it may
  // return null (no remote handle configured yet) → the login UI shows a generic
  // identity rather than a misleading placeholder. Falls back to the static handle.
  const currentHandle = () => {
    if (getHandle) { try { const h = getHandle(); return (typeof h === 'string' && h) ? h : null; } catch { return null; } }
    return handle;
  };
  const userOf = () => ({ id: userId, handle: currentHandle(), display_name: 'You', avatar_url: null });

  // NOTE: mounted under '/auth' (see server-rest.js), so routes are relative —
  // this keeps the express.json parser scoped to /auth/* (it must not touch the
  // raw-bytes /api/v1/upload route).

  // The root layout calls this on every page; returning a user keeps the app
  // out of the /login redirect. For a networked client (over the relay) we gate
  // on resolveAuthorized so an unauthenticated browser gets 401 → /login.
  router.get('/session', async (req, res) => {
    if (resolveAuthorized) {
      try {
        if (!(await resolveAuthorized(req))) return res.status(401).json({ error: 'unauthorized' });
      } catch { return res.status(401).json({ error: 'unauthorized' }); }
    }
    res.json({ user: userOf() });
  });

  // The /login page reads this to brand the sign-in with the vault's @handle (and
  // to decide its flow). handle is null when none is configured → generic UI.
  router.get('/setup-status', (_req, res) =>
    res.json({ setupRequired: false, hasPasskeys: false, handle: currentHandle(), requirePasskey: requirePasskey() }));

  // Logout. Loopback (desktop) is "always signed in" — nothing to revoke; no-op.
  // A NETWORKED client (over the relay) holds a REAL better-auth session, so a
  // no-op would be a FALSE logout (the cookie stays valid). Forward to :4711's
  // better-auth /api/auth/sign-out to actually revoke the session, and relay its
  // Set-Cookie so the browser cookie is cleared too. Best-effort + fail-safe:
  // always report ok so the UI completes the logout UX.
  router.post('/logout', async (req, res) => {
    // U7 — KILL the unified device-session on logout. Without this, the
    // mycelium_device_session cookie (HttpOnly, Max-Age 400 d) SURVIVES "Log out":
    // its backing token stays live, deviceSessions.matchSync still JOINs and returns
    // the owner, and the next person on a shared/public browser has full read/write
    // to the vault via all 13 owner-gated routers. That is the exact logout-bypass
    // class the no-`Domain=` cookie choice was meant to prevent, reached another way.
    // The R0-consistent kill is to REVOKE THE BACKING TOKEN (token dies → session
    // dies on the next request), scoped to kind='web' so a browser logout never
    // un-pairs a PHONE (a phone tears down via DELETE /auth/device-session instead).
    // Runs regardless of loopback: the cookie must die on this browser either way.
    try {
      const h = db();
      const secret = parseCookies(req)[DEVICE_SESSION_COOKIE];
      if (secret && h?.deviceSessions) {
        const backing = h.deviceSessions.backingTokenSync(secret);
        if (backing && backing.kind === 'web' && h.deviceTokens) {
          await h.deviceTokens.revoke(backing.tokenId); // idempotent
        }
      }
    } catch { /* best-effort; the cookie clear below still fires */ }

    if (!isTrustedLoopback(req) && req.headers.cookie) {
      const base = process.env.MYCELIUM_AUTH_URL || `http://127.0.0.1:${process.env.MYCELIUM_PORT || 4711}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        // Forward the browser's Origin too — better-auth's CSRF guard rejects a
        // POST whose Origin is not trusted, so without it sign-out would no-op.
        const headers = { cookie: req.headers.cookie };
        if (req.headers.origin) headers.origin = req.headers.origin;
        const r = await fetch(`${base}/api/auth/sign-out`, {
          method: 'POST', headers, signal: ctrl.signal,
        });
        const setCookie = r.headers.get('set-cookie');
        if (setCookie) res.setHeader('Set-Cookie', setCookie); // clear the better-auth session cookie
      } catch { /* revoke is best-effort; still report ok */ }
      finally { clearTimeout(timer); }
    }
    // Clear the device-session cookie from THIS browser immediately (append, so it
    // coexists with any better-auth clear set above via setHeader).
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // ─── Unified device-session cookie (U7) — one mechanism, two on-ramps ──────────
  // docs/UNIFIED-AUTH-DESIGN-2026-07-24.md. The session is a vault-local cookie
  // BOUND to a device_tokens row: validity==token-liveness, no independent TTL (R0).
  // Every failure returns JSON, NEVER a redirect and NEVER a Set-Cookie, so the iOS
  // navigation delegate can distinguish "revoked" (401) from transient (503) and
  // route deterministically. Every success Location is a BYTE-LITERAL constant (no
  // request input reaches it) — the Authorization header rides the redirect, so an
  // input-derived Location would exfiltrate the device token (#337 P0-1).
  //
  // No createPathThrottle-style bucket exists on these routes: /auth/* is reachable
  // by an unauthenticated internet caller over the relay, and a pre-auth global
  // bucket would let one such caller 429 the whole fleet. A live token therefore
  // always exchanges regardless of unauthenticated volume (invariant M4).

  // MOBILE on-ramp: authenticate the DEVICE TOKEN in the header, mint a session.
  router.post('/device-session', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const h = db();
    const dTokens = h?.deviceTokens, dSessions = h?.deviceSessions;
    if (!dTokens || !dSessions) return res.status(503).json({ error: 'vault_not_initialized' }); // fail-closed, no cookie
    const token = bearerToken(req.headers.authorization); // header ONLY — no cookie, no bearer, no loopback bypass
    const tokenId = token ? dTokens.matchIdSync(token) : null;
    if (!tokenId) return res.status(401).json({ error: 'unauthorized' }); // dead/absent token → terminal .revoked on the client
    let secret;
    try { ({ secret } = await dSessions.mint(tokenId)); }
    catch { return res.status(401).json({ error: 'unauthorized' }); } // token revoked between lookup and mint → still terminal
    setSessionCookie(req, res, secret);
    return res.redirect(303, '/auth/device-session/landing'); // byte-literal
  });

  // The landing hop AUTHENTICATES NOTHING — it observes whether the cookie we just
  // set came back on the very next request. Its only purpose: turn the
  // "Secure cookie on a plain-http vault" case (stored, never sent) into an
  // immediate, truthful, NON-terminal client error instead of an invisible loop.
  router.get('/device-session/landing', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (parseCookies(req)[DEVICE_SESSION_COOKIE]) return res.redirect(303, '/'); // byte-literal
    return res.status(200).json({ error: 'cookie_not_stored' }); // NO redirect (cannot loop), NO cookie
  });

  // Teardown (logout / re-pair): authenticate the DEVICE TOKEN header (NOT the cookie
  // being torn down — that would be circular + CSRF-shaped). Revokes EVERY session
  // bound to that token. Idempotent.
  router.delete('/device-session', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const h = db();
    const dTokens = h?.deviceTokens, dSessions = h?.deviceSessions;
    if (!dTokens || !dSessions) return res.status(503).json({ error: 'vault_not_initialized' });
    const token = bearerToken(req.headers.authorization); // header ONLY
    const tokenId = token ? dTokens.matchIdSync(token) : null;
    if (!tokenId) return res.status(401).json({ error: 'unauthorized' });
    try { await dSessions.revokeForToken(tokenId); } catch { /* best-effort; still clear the client cookie */ }
    clearSessionCookie(res);
    return res.status(204).end();
  });

  // WEB on-ramp: authenticate the OWNER better-auth session (ambient → CSRF-enforced),
  // then mint a NARROWER web-kind device token + a session bound to it. This is a
  // DE-ESCALATION (consume a full-owner session to mint a data-only credential), the
  // safe inverse of "mint a better-auth session as the device session". The minted
  // token's user_id is the canonical single vault owner (userId), not the better-auth
  // id — validateSession has already proven this request IS the owner.
  router.post('/device-session/web', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const h = db();
    const dTokens = h?.deviceTokens, dSessions = h?.deviceSessions;
    if (!dTokens || !dSessions) return res.status(503).json({ error: 'vault_not_initialized' });
    // Ambient credential (the better-auth cookie) ⇒ mandatory double-submit CSRF.
    // 403 (not 401) so a CSRF fault never redirects the SPA to /login (auth loop).
    const csrf = parseCookies(req)[CSRF_COOKIE];
    if (!csrf || !timingEqual(req.headers['x-csrf-token'], csrf)) return res.status(403).json({ error: 'csrf' });
    let ownerId = null;
    try { ownerId = req.headers.cookie && typeof validateSession === 'function' ? await validateSession(req.headers.cookie) : null; }
    catch { ownerId = null; }
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' }); // not a live owner session
    let secret;
    try {
      const { id: tokenId } = await dTokens.mint(webLabel(req.headers['user-agent']), userId, 'web');
      if (!tokenId) throw new Error('mint returned no id');
      ({ secret } = await dSessions.mint(tokenId));
    } catch { return res.status(500).json({ error: 'mint_failed' }); }
    setSessionCookie(req, res, secret);
    return res.redirect(303, '/'); // byte-literal
  });

  return router;
}

export default authShimRouter;

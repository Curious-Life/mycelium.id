#!/usr/bin/env node
// verify-device-session.mjs — U7 gate (the unified-auth design +
// the webview session-exchange design).
//
// Exercises the REAL migrations (0052/0057 device_tokens, 0056 device_sessions) +
// the REAL device-sessions/device-tokens namespaces + the REAL auth gate functions
// (resolveRequester / makePortalOwnerGate / createVaultAuthMiddleware / isCsrfDeny)
// + the REAL auth-shim endpoints over HTTP. No stubs of the code under test.
//
// The one mechanism, two on-ramps: a mycelium_device_session cookie whose validity
// is derived per request from a live backing device token (validity==token-liveness,
// R0), accepted at both gates as via:'device-session', CSRF-enforced because ambient.
//
// Each MUTATION-TESTED record below was ACTUALLY RUN (scratchpad mutate runner):
// the break was applied, the named check flipped PASS→FAIL, then restore → GREEN.
// MUTATION-TESTED: remove the via:'device-session' branch in resolveRequester → S1a REDs
// MUTATION-TESTED: drop `AND t.revoked_at IS NULL` from device-sessions matchSync JOIN → S2a REDs
// MUTATION-TESTED: drop the idle predicate from the device-sessions matchSync JOIN → S4b REDs
// MUTATION-TESTED: revert AMBIENT_VIA to the 'cookie' literal in createVaultAuthMiddleware → S6a REDs
// MUTATION-TESTED: delete the owner-gate inline CSRF check (return {id} unconditionally) → S6b REDs
// MUTATION-TESTED: derive the mint Location from req input instead of the byte-literal → E4 REDs
// MUTATION-TESTED: drop HttpOnly from setSessionCookie → E1c REDs
// MUTATION-TESTED: accept the /device-session/web owner session without the CSRF check → W2a REDs
// MUTATION-TESTED: remove the backing-token revoke in POST /auth/logout → L1 REDs (session still authenticates after logout)

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import { createDeviceTokensNamespace } from '../src/db/device-tokens.js';
import { createDeviceSessionsNamespace } from '../src/db/device-sessions.js';
import {
  resolveRequester, makePortalOwnerGate, createVaultAuthMiddleware, csrfCookieMiddleware, isCsrfDeny,
} from '../src/http/require-vault-auth.js';
import { authShimRouter } from '../src/auth-shim.js';
import { IMPORT_TABLE_POLICY } from '../src/ingest/import-credential-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ledger = [];
const rec = (name, pass, detail = '') => {
  ledger.push(Boolean(pass));
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// ---- Real migrations → in-memory DB + a minimal d1Query shim ------------------
const raw = new Database(':memory:');
raw.exec(fs.readFileSync(path.join(ROOT, 'migrations/0052_device_tokens.sql'), 'utf8'));
raw.exec(fs.readFileSync(path.join(ROOT, 'migrations/0057_device_token_web.sql'), 'utf8'));
raw.exec(fs.readFileSync(path.join(ROOT, 'migrations/0056_device_sessions.sql'), 'utf8'));
raw.pragma('foreign_keys = ON');
const d1Query = async (sql, params = []) => {
  const stmt = raw.prepare(sql);
  if (/^\s*select/i.test(sql)) return { results: stmt.all(...params) };
  const info = stmt.run(...params);
  return { meta: { last_row_id: info.lastInsertRowid, changes: info.changes } };
};
const dt = createDeviceTokensNamespace({ d1Query, rawDb: raw });
const ds = createDeviceSessionsNamespace({ d1Query, rawDb: raw });

const USER = 'owner-user';
process.env.MYCELIUM_MCP_BEARER = 'S'.repeat(48);
const dtMatch = (t) => dt.matchSync(t);
const dsMatch = (s) => ds.matchSync(s);

const netReq = (headers = {}, method = 'GET') => ({ socket: { remoteAddress: '10.0.0.5' }, method, headers });
const cookieHdr = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');

async function main() {
  // ═══ Shared mechanism (namespaces + gate functions) ══════════════════════════
  const { token: phoneTok, id: phoneTokId } = await dt.mint('Pixel 9', USER, 'phone');
  const { secret: sess } = await ds.mint(phoneTokId);

  // S1 — a session minted from a live token authorizes at BOTH gates as device-session
  const rr = await resolveRequester(netReq({ cookie: cookieHdr({ mycelium_device_session: sess }) }), { userId: USER, deviceTokenMatch: dtMatch, deviceSessionMatch: dsMatch });
  rec('S1a resolveRequester: device-session cookie → via:device-session', rr && rr.id === USER && rr.via === 'device-session', JSON.stringify(rr));
  const og = makePortalOwnerGate({ userId: USER, deviceTokenMatch: dtMatch, deviceSessionMatch: dsMatch })(netReq({ cookie: cookieHdr({ mycelium_device_session: sess }) }));
  rec('S1b owner gate: device-session cookie (GET) → owner', og && og.id === USER, JSON.stringify(og));

  // S10 — structural parity: session resolves to the SAME owner id as via:'device'
  const rrTok = await resolveRequester(netReq({ authorization: `Bearer ${phoneTok}` }), { userId: USER, deviceTokenMatch: dtMatch, deviceSessionMatch: dsMatch });
  rec('S10 parity: accepts(device-session) ⇒ same owner as accepts(device)', rrTok && rr && rrTok.id === rr.id);

  // S2 — R0: revoking the BACKING token kills the session on the next call (both gates)
  await dt.revoke(phoneTokId);
  rec('S2a revoked token → session matchSync null (JOIN dies with token)', dsMatch(sess) === null);
  const rr2 = await resolveRequester(netReq({ cookie: cookieHdr({ mycelium_device_session: sess }) }), { userId: USER, deviceTokenMatch: dtMatch, deviceSessionMatch: dsMatch, validateSession: async () => null });
  rec('S2b revoked token → resolveRequester denies', rr2 === null);
  rec('S2c revoked token → owner gate denies', makePortalOwnerGate({ userId: USER, deviceSessionMatch: dsMatch })(netReq({ cookie: cookieHdr({ mycelium_device_session: sess }) })) === null);

  // S3 — a session whose OWN revoked_at is set authorizes nothing
  const { id: tokB } = await dt.mint('iPad', USER, 'phone');
  const { secret: sessB } = await ds.mint(tokB);
  rec('S3a live session authorizes', dsMatch(sessB) === USER);
  await ds.revokeForToken(tokB);
  rec('S3b own-revoked session → null', dsMatch(sessB) === null);

  // S4 — R0 idle: a token whose idle_expires_at is in the past → session dead
  const { id: tokC } = await dt.mint('Chrome', USER, 'web');
  const { secret: sessC } = await ds.mint(tokC);
  rec('S4a fresh session authorizes', dsMatch(sessC) === USER);
  raw.prepare(`UPDATE device_tokens SET idle_expires_at = datetime('now','-1 hour') WHERE id = ?`).run(tokC);
  rec('S4b idle-expired token → session dead (validity==token-liveness)', dsMatch(sessC) === null);
  raw.prepare(`UPDATE device_tokens SET idle_expires_at = datetime('now','+1 hour') WHERE id = ?`).run(tokC);
  rec('S4c idle bumped forward → session live again', dsMatch(sessC) === USER);

  // S5 — no cross-credential confusion
  const { token: tokD, id: tokDId } = await dt.mint('Nexus', USER, 'phone');
  const { secret: sessD } = await ds.mint(tokDId);
  // a raw DEVICE TOKEN presented in the device_session cookie authorizes nothing
  const rrCross1 = await resolveRequester(netReq({ cookie: cookieHdr({ mycelium_device_session: tokD }) }), { userId: USER, deviceTokenMatch: dtMatch, deviceSessionMatch: dsMatch, validateSession: async () => null });
  rec('S5a raw device token in the session cookie → NOT accepted', rrCross1 === null);
  // a SESSION secret presented as a Bearer header authorizes nothing (deviceTokenMatch rejects it)
  rec('S5b session secret as a device-token bearer → NOT accepted', dtMatch(sessD) === null);

  // S6 — CSRF for the ambient device-session cookie
  // (a) global /api middleware: POST without X-CSRF-Token → 403
  const mw = createVaultAuthMiddleware({ userId: USER, deviceTokenMatch: dtMatch, deviceSessionMatch: dsMatch, validateSession: async () => null });
  const capture = () => { const r = { code: 0, body: null }; return { r, res: { status(c) { r.code = c; return this; }, json(b) { r.body = b; return this; } } }; };
  let c = capture(); let nextCalled = false;
  await mw(netReq({ cookie: cookieHdr({ mycelium_device_session: sessD }) }, 'POST'), c.res, () => { nextCalled = true; });
  rec('S6a /api gate: device-session POST without CSRF → 403 (AMBIENT_VIA)', c.r.code === 403 && c.r.body?.error === 'csrf' && !nextCalled, JSON.stringify(c.r));
  // with a matching double-submit → passes
  c = capture(); nextCalled = false;
  await mw(netReq({ cookie: cookieHdr({ mycelium_device_session: sessD, mycelium_csrf: 'tok123' }), 'x-csrf-token': 'tok123' }, 'POST'), c.res, () => { nextCalled = true; });
  rec('S6a2 /api gate: device-session POST WITH matching CSRF → next()', nextCalled && c.r.code === 0);
  // GET is exempt (safe method)
  c = capture(); nextCalled = false;
  await mw(netReq({ cookie: cookieHdr({ mycelium_device_session: sessD }) }, 'GET'), c.res, () => { nextCalled = true; });
  rec('S6a3 /api gate: device-session GET → exempt (next)', nextCalled);
  // (b) owner gate: POST without CSRF → {deny:'csrf'} (→ 403 at the router), NOT {id} and NOT null(401)
  const ownerGate = makePortalOwnerGate({ userId: USER, deviceSessionMatch: dsMatch });
  const denyRes = ownerGate(netReq({ cookie: cookieHdr({ mycelium_device_session: sessD }) }, 'POST'));
  rec('S6b owner gate: device-session POST without CSRF → {deny:csrf} (not authed, not 401-null)', isCsrfDeny(denyRes) && !denyRes.id && denyRes !== null, JSON.stringify(denyRes));
  const okRes = ownerGate(netReq({ cookie: cookieHdr({ mycelium_device_session: sessD, mycelium_csrf: 'z9' }), 'x-csrf-token': 'z9' }, 'POST'));
  rec('S6b2 owner gate: device-session POST WITH matching CSRF → owner', okRes && okRes.id === USER);
  rec('S6c isCsrfDeny: {deny:csrf}→true, {id}→false, null→false', isCsrfDeny({ deny: 'csrf' }) === true && isCsrfDeny({ id: USER }) === false && isCsrfDeny(null) === false);

  // S8 — hash-at-rest + fail-closed matcher
  const storedHash = raw.prepare('SELECT session_hash FROM device_sessions ORDER BY id LIMIT 1').get()?.session_hash;
  rec('S8a device_sessions stores a 64-hex sha256, never the raw secret', /^[0-9a-f]{64}$/.test(storedHash || '') && storedHash !== sess);
  rec('S8b matchSync fail-closed on short/garbage input', dsMatch('') === null && dsMatch('x') === null && dsMatch(12345) === null);

  // S9 — no matcher ⇒ device-session path disabled, not fail-open
  const rrNoDs = await resolveRequester(netReq({ cookie: cookieHdr({ mycelium_device_session: sessC }) }), { userId: USER, deviceSessionMatch: null, validateSession: async () => null });
  rec('S9 null deviceSessionMatch ⇒ session path disabled (fail-closed)', rrNoDs === null);

  // De-escalation / independence: a device-session authorizes even when the
  // better-auth validateSession ALWAYS returns null → it is NOT a better-auth session.
  const rrIndep = await resolveRequester(netReq({ cookie: cookieHdr({ mycelium_device_session: sessC }) }), { userId: USER, deviceSessionMatch: dsMatch, validateSession: async () => { throw new Error('better-auth must not be consulted'); } });
  rec('S11 device-session is independent of better-auth (authorizes without validateSession)', rrIndep && rrIndep.via === 'device-session');

  // ═══ Import policy — device_sessions is a credential table, denied ════════════
  rec('IMP device_sessions verdict === deny (bundle-chosen session_hash cannot import)', IMPORT_TABLE_POLICY.device_sessions?.verdict === 'deny');
  rec('IMP device_tokens verdict === deny', IMPORT_TABLE_POLICY.device_tokens?.verdict === 'deny');

  // ═══ Real auth-shim endpoints over HTTP ══════════════════════════════════════
  const app = express();
  app.use(csrfCookieMiddleware);
  const dbHandle = { deviceTokens: dt, deviceSessions: ds };
  // fakeValidate: an owner session iff the cookie carries owner-session=good.
  const fakeValidate = async (cookie) => (/(?:^|;\s*)owner-session=good(?:;|$)/.test(String(cookie || '')) ? USER : null);
  app.use('/auth', authShimRouter({ userId: USER, getDb: () => dbHandle, validateSession: fakeValidate }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const setCookieOf = (res) => res.headers.get('set-cookie') || '';

  // E1 — MOBILE mint: live device-token header → 303 landing + HttpOnly cookie
  const { token: mTok, id: mTokId } = await dt.mint('iPhone', USER, 'phone');
  const e1 = await fetch(`${base}/auth/device-session`, { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${mTok}` } });
  const e1sc = setCookieOf(e1);
  rec('E1a mobile mint → 303', e1.status === 303);
  rec('E1b Location is byte-literal /auth/device-session/landing', e1.headers.get('location') === '/auth/device-session/landing');
  rec('E1c Set-Cookie mycelium_device_session is HttpOnly', /mycelium_device_session=/.test(e1sc) && /HttpOnly/i.test(e1sc));
  rec('E1d cookie is host-only (no Domain=) + SameSite=Lax', !/Domain=/i.test(e1sc) && /SameSite=Lax/i.test(e1sc));
  const mintedSecret = (e1sc.match(/mycelium_device_session=([0-9a-f]+)/) || [])[1];
  rec('E1e minted cookie secret authorizes at the gate as device-session', mintedSecret && dsMatch(mintedSecret) === USER);

  // E2 — bad/absent token → 401 JSON, NO redirect, NO cookie
  const e2 = await fetch(`${base}/auth/device-session`, { method: 'POST', redirect: 'manual', headers: { authorization: 'Bearer ' + 'z'.repeat(64) } });
  rec('E2a bad token → 401', e2.status === 401);
  rec('E2b bad token → NO Set-Cookie for the session', !/mycelium_device_session=[0-9a-f]/.test(setCookieOf(e2)));
  const e2noauth = await fetch(`${base}/auth/device-session`, { method: 'POST', redirect: 'manual' });
  rec('E2c absent token → 401, no session cookie', e2noauth.status === 401 && !/mycelium_device_session=[0-9a-f]/.test(setCookieOf(e2noauth)));

  // E3 — landing hop: with cookie → 303 /; without → 200 cookie_not_stored (no Location)
  const e3has = await fetch(`${base}/auth/device-session/landing`, { redirect: 'manual', headers: { cookie: `mycelium_device_session=${mintedSecret}` } });
  rec('E3a landing WITH cookie → 303 Location:/', e3has.status === 303 && e3has.headers.get('location') === '/');
  const e3no = await fetch(`${base}/auth/device-session/landing`, { redirect: 'manual' });
  rec('E3b landing WITHOUT cookie → 200 cookie_not_stored, no Location', e3no.status === 200 && !e3no.headers.get('location') && (await e3no.json()).error === 'cookie_not_stored');

  // E4 — byte-literal Location: hostile query / Host header cannot move it
  const e4 = await fetch(`${base}/auth/device-session?to=/%5Cevil.com`, { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${mTok}`, host: 'evil.com', 'x-forwarded-host': 'evil.com' } });
  rec('E4 Location stays byte-literal despite ?to= / Host / X-Forwarded-Host', e4.headers.get('location') === '/auth/device-session/landing');

  // E5 — DELETE teardown: device-token header revokes sessions + clears cookie
  const { token: delTok, id: delTokId } = await dt.mint('OldPhone', USER, 'phone');
  const { secret: delSess } = await ds.mint(delTokId);
  rec('E5a session live before teardown', dsMatch(delSess) === USER);
  const e5 = await fetch(`${base}/auth/device-session`, { method: 'DELETE', redirect: 'manual', headers: { authorization: `Bearer ${delTok}` } });
  rec('E5b DELETE → 204 + clearing cookie (Max-Age=0)', e5.status === 204 && /mycelium_device_session=;/.test(setCookieOf(e5)) && /Max-Age=0/i.test(setCookieOf(e5)));
  rec('E5c all sessions for that token revoked', dsMatch(delSess) === null);
  // cookie is NOT accepted for teardown (header-only) — a DELETE with only the cookie 401s
  const e5cookieOnly = await fetch(`${base}/auth/device-session`, { method: 'DELETE', redirect: 'manual', headers: { cookie: `mycelium_device_session=${mintedSecret}` } });
  rec('E5d DELETE with only the session cookie (no header) → 401', e5cookieOnly.status === 401);

  // ═══ WEB on-ramp ═════════════════════════════════════════════════════════════
  // W1 — owner session + CSRF → 303 / + Set-Cookie; mints a kind='web' token
  const w1 = await fetch(`${base}/auth/device-session/web`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: cookieHdr({ 'owner-session': 'good', mycelium_csrf: 'csrf1' }), 'x-csrf-token': 'csrf1' },
  });
  const w1sc = setCookieOf(w1);
  rec('W1a web on-ramp (owner+CSRF) → 303 Location:/', w1.status === 303 && w1.headers.get('location') === '/');
  rec('W1b web on-ramp sets HttpOnly device-session cookie', /mycelium_device_session=/.test(w1sc) && /HttpOnly/i.test(w1sc));
  const webSecret = (w1sc.match(/mycelium_device_session=([0-9a-f]+)/) || [])[1];
  rec('W1c minted web session authorizes at the gate (D-032 fix)', webSecret && dsMatch(webSecret) === USER);
  const webTokRow = raw.prepare(`SELECT kind FROM device_tokens WHERE kind='web' ORDER BY id DESC LIMIT 1`).get();
  rec('W1d backing token is kind=web', webTokRow?.kind === 'web');

  // W3 — a kind='web' session reaches the sensitive-router owner gate (D-032 fix asserted)
  const wog = makePortalOwnerGate({ userId: USER, deviceSessionMatch: dsMatch })(netReq({ cookie: cookieHdr({ mycelium_device_session: webSecret }) }, 'GET'));
  rec('W3 web-kind session → owner at makePortalOwnerGate (sensitive routers reachable)', wog && wog.id === USER);

  // M-U1 — ONE mechanism: the web session resolves to the SAME via as a phone session
  const wResolve = await resolveRequester(netReq({ cookie: cookieHdr({ mycelium_device_session: webSecret }) }), { userId: USER, deviceSessionMatch: dsMatch, validateSession: async () => null });
  rec('M-U1 web + phone sessions share ONE via (device-session), not a distinct web via', wResolve && wResolve.via === 'device-session');

  // W2 — CSRF + owner required, else no cookie
  const w2nocsrf = await fetch(`${base}/auth/device-session/web`, { method: 'POST', redirect: 'manual', headers: { cookie: cookieHdr({ 'owner-session': 'good' }) } });
  rec('W2a web on-ramp WITHOUT CSRF → 403, no cookie', w2nocsrf.status === 403 && !/mycelium_device_session=[0-9a-f]/.test(setCookieOf(w2nocsrf)));
  const w2badsess = await fetch(`${base}/auth/device-session/web`, { method: 'POST', redirect: 'manual', headers: { cookie: cookieHdr({ 'owner-session': 'nope', mycelium_csrf: 'csrf1' }), 'x-csrf-token': 'csrf1' } });
  rec('W2b web on-ramp with a NON-owner session → 401, no cookie', w2badsess.status === 401 && !/mycelium_device_session=[0-9a-f]/.test(setCookieOf(w2badsess)));

  // W6 — a better-auth cookie ALONE still does not reach makePortalOwnerGate directly
  // (only the minted device-session does — proves (A) did not become (B))
  const w6 = makePortalOwnerGate({ userId: USER, deviceSessionMatch: dsMatch })(netReq({ cookie: cookieHdr({ 'better-auth.session_token': 'anything', 'owner-session': 'good' }) }, 'GET'));
  rec('W6 better-auth cookie alone → owner gate denies (only device-session reaches it)', w6 === null);

  // ═══ L — logout kills the device session (BLOCKER #7 fix) ═════════════════════
  // A web session that outlives "Log out" is a full-vault credential on a shared
  // browser. POST /auth/logout must revoke the backing web token (R0 kill) AND clear
  // the cookie. (Test server is 127.0.0.1 so the better-auth forward branch is
  // skipped; the device-session kill runs unconditionally, which is exactly right.)
  const lw = await fetch(`${base}/auth/device-session/web`, { method: 'POST', redirect: 'manual', headers: { cookie: cookieHdr({ 'owner-session': 'good', mycelium_csrf: 'csrfL' }), 'x-csrf-token': 'csrfL' } });
  const lSecret = (setCookieOf(lw).match(/mycelium_device_session=([0-9a-f]+)/) || [])[1];
  rec('L0 fresh web session authorizes before logout', !!lSecret && dsMatch(lSecret) === USER);
  const lo = await fetch(`${base}/auth/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: cookieHdr({ mycelium_device_session: lSecret }) } });
  rec('L1 after logout the session cookie NO LONGER authenticates (backing web token revoked)', dsMatch(lSecret) === null);
  rec('L2 logout clears the device-session cookie (Max-Age=0)', /mycelium_device_session=;/.test(setCookieOf(lo)) && /Max-Age=0/i.test(setCookieOf(lo)));
  // Scope: a PHONE-kind backing token is NOT revoked by a web logout (phones tear
  // down via DELETE). Prove a phone session survives a logout carrying its cookie.
  const { id: phTokId2 } = await dt.mint('Pixel-keep', USER, 'phone');
  const { secret: phSess2 } = await ds.mint(phTokId2);
  await fetch(`${base}/auth/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: cookieHdr({ mycelium_device_session: phSess2 }) } });
  rec('L3 web logout does NOT revoke a phone-kind token (no accidental un-pair)', dsMatch(phSess2) === USER);

  server.close();
  const allPass = ledger.length > 0 && ledger.every(Boolean);
  console.log('\n' + '='.repeat(70));
  console.log(`VERDICT: ${allPass ? 'GO — unified device-session: one mechanism (web+mobile), validity==token-liveness (R0), CSRF-enforced, byte-literal redirect, HttpOnly, D-032 fix asserted, import-denied' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
  console.log('='.repeat(70));
  raw.close();
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-device-session threw:', e); process.exit(1); });

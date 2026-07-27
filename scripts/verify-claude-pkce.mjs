// verify:claude-pkce — the browser PKCE connect (src/inference/claude-pkce.js).
// This is the path that makes a NEW DEVICE (no `claude` CLI) able to connect at all.
//
//   P1  authorize URL carries client_id, S256 challenge, user:inference scope, state
//   P2  parsePastedCode: bare code | full callback URL | #fragment | whitespace
//   P3  exchange happy path → normalized creds (token/refresh/expiresAt/scopes)
//   P4  retry ONLY on 5xx; a 4xx is NOT retried (never burn a rejected code)
//   P5  setup-token artifact (no user:inference) → missing_scope
//   P6  no access_token → no_token
//   P7 🔒 the code + verifier NEVER appear in any thrown error
//   P8  flow store: per-user isolation, single-use, TTL expiry
//
// Pure + injected fetch — never talks to Anthropic.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { startPkceFlow, parsePastedCode, exchangeCode, refreshAccessToken, createPkceFlowStore, CLAUDE_OAUTH, ClaudePkceError } from '../src/inference/claude-pkce.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const noSleep = async () => {};

// ── P0 ⭐ ENDPOINT PIN — token/callback are the LIVE hosts, not the dead console ──────
//    2026-07-18: Anthropic moved OAuth off `console.anthropic.com` (now 404) to
//    `platform.claude.com`, which broke refresh AND web-exchange (both read tokenUrl). The
//    mock-fetch gates below never asserted WHERE the POST goes, so a dead endpoint passed
//    green (VERDICT: GO on a config that 404s live). This pins the value AND captures the
//    URL exchangeCode/refreshAccessToken actually POST to. Falsify: revert tokenUrl to
//    console.anthropic.com → P0 reds.
{
  let exchUrl = null, refrUrl = null;
  const capExch = async (u) => { exchUrl = u; return { ok: true, status: 200, json: async () => ({ access_token: 't', scope: 'user:inference' }) }; };
  const capRefr = async (u) => { refrUrl = u; return { ok: true, status: 200, json: async () => ({ access_token: 't', scope: 'user:inference' }) }; };
  await exchangeCode({ code: 'c', verifier: 'v', fetchImpl: capExch, sleep: noSleep });
  await refreshAccessToken({ refreshToken: 'r', fetchImpl: capRefr, sleep: noSleep });
  const tokenHost = new URL(CLAUDE_OAUTH.tokenUrl).host;
  const cbHost = new URL(CLAUDE_OAUTH.redirectUri).host;
  rec('P0 ⭐ endpoint pinned to platform.claude.com (NOT the dead console.anthropic.com); refresh+exchange POST there',
    CLAUDE_OAUTH.tokenUrl === 'https://platform.claude.com/v1/oauth/token' &&
    tokenHost !== 'console.anthropic.com' &&                                     // compare the parsed host, not a URL substring
    tokenHost === 'platform.claude.com' && cbHost === 'platform.claude.com' &&   // token + callback moved together
    exchUrl === CLAUDE_OAUTH.tokenUrl && refrUrl === CLAUDE_OAUTH.tokenUrl,       // the code POSTs to the pinned URL
    // log booleans, not the OAuth config values — the endpoint URL is public but CodeQL
    // (js/clear-text-logging) treats CLAUDE_OAUTH as sensitive; the outcomes are enough to debug.
    `pinned=${CLAUDE_OAUTH.tokenUrl === 'https://platform.claude.com/v1/oauth/token'} exchOk=${exchUrl === CLAUDE_OAUTH.tokenUrl} refrOk=${refrUrl === CLAUDE_OAUTH.tokenUrl} cbOk=${cbHost === 'platform.claude.com'}`);
}

// ── P1 authorize URL ─────────────────────────────────────────────────────────────
{
  const { url, verifier, state } = startPkceFlow();
  const u = new URL(url);
  const p = u.searchParams;
  rec('P1 authorize URL: S256 challenge + client_id + user:inference scope + state',
    u.origin + u.pathname === CLAUDE_OAUTH.authorizeUrl &&
    p.get('client_id') === CLAUDE_OAUTH.clientId &&
    p.get('code_challenge_method') === 'S256' && !!p.get('code_challenge') &&
    p.get('code_challenge') !== verifier &&                     // challenge is the HASH, not the verifier
    String(p.get('scope')).includes('user:inference') &&
    p.get('state') === state && p.get('response_type') === 'code' &&
    p.get('redirect_uri') === CLAUDE_OAUTH.redirectUri);
}
// ── P2 paste tolerance — and the STATE must be recovered, not discarded ──────────
{
  const bare = parsePastedCode('  abc123  ');
  const full = parsePastedCode('https://console.anthropic.com/oauth/code/callback?code=xyz789&state=s1');
  const frag = parsePastedCode('code=frag456&state=s2');
  const callback = parsePastedCode('abc999#st999');   // what Anthropic's page actually renders
  rec('P2 parsePastedCode recovers code AND state (bare | URL | fragment | code#state)',
    bare.code === 'abc123' && bare.state === null &&
    full.code === 'xyz789' && full.state === 's1' &&
    frag.code === 'frag456' && frag.state === 's2' &&
    callback.code === 'abc999' && callback.state === 'st999',
    JSON.stringify({ bare, full, frag, callback }));
}
// ── P2b ⭐ CSRF: a code from a DIFFERENT sign-in is refused ───────────────────────
{
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, status: 200, json: async () => ({ access_token: 't', scope: 'user:inference' }) }; };
  let code = null;
  try {
    // attacker-supplied code carrying THEIR state; our flow minted 'ours'
    await exchangeCode({ code: 'attackercode#theirstate', verifier: 'v', state: 'ours', fetchImpl, sleep: noSleep });
  } catch (e) { code = e.code; }
  // a matching state still works
  const okc = await exchangeCode({ code: 'good#ours', verifier: 'v', state: 'ours', fetchImpl, sleep: noSleep });
  rec('P2b ⭐ pasted state ≠ our state → state_mismatch, NEVER exchanged (foreign-code binding blocked)',
    code === 'state_mismatch' && calls === 1 && okc.claudeOAuthToken === 't',
    `code=${code} exchanges_attempted=${calls}`);
}
// ── P3 happy path ────────────────────────────────────────────────────────────────
{
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'tok-1', refresh_token: 'ref-1', expires_in: 3600, scope: 'user:inference user:profile' }) });
  const c = await exchangeCode({ code: 'abc', verifier: 'v', fetchImpl, sleep: noSleep, now: () => 1_000_000 });
  rec('P3 exchange → normalized creds (expiresAt computed from expires_in)',
    c.claudeOAuthToken === 'tok-1' && c.refreshToken === 'ref-1' && c.expiresAt === 1_000_000 + 3600_000 && c.scopes.includes('user:inference'),
    JSON.stringify({ ...c, claudeOAuthToken: '<redacted>' }));
}
// ── P4 retry policy ──────────────────────────────────────────────────────────────
{
  let calls = 0;
  const fetch5xx = async () => { calls++; return { ok: false, status: 503, json: async () => ({}), text: async () => 'boom' }; };
  let threw = false;
  try { await exchangeCode({ code: 'a', verifier: 'v', fetchImpl: fetch5xx, sleep: noSleep }); } catch { threw = true; }
  const retried = calls === 3;

  let calls4 = 0;
  const fetch4xx = async () => { calls4++; return { ok: false, status: 400, json: async () => ({}), text: async () => 'bad' }; };
  try { await exchangeCode({ code: 'a', verifier: 'v', fetchImpl: fetch4xx, sleep: noSleep }); } catch { /* expected */ }
  rec('P4 5xx retried 3× · 4xx NOT retried (never burn a rejected code)',
    threw && retried && calls4 === 1, `5xx_calls=${calls} 4xx_calls=${calls4}`);
}
// ── P5 scope guard ───────────────────────────────────────────────────────────────
{
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 't', scope: 'org:create_api_key' }) });
  let code = null;
  try { await exchangeCode({ code: 'a', verifier: 'v', fetchImpl, sleep: noSleep }); } catch (e) { code = e.code; }
  rec('P5 setup-token artifact → missing_scope', code === 'missing_scope');
}
// ── P6 no token ──────────────────────────────────────────────────────────────────
{
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ scope: 'user:inference' }) });
  let code = null;
  try { await exchangeCode({ code: 'a', verifier: 'v', fetchImpl, sleep: noSleep }); } catch (e) { code = e.code; }
  rec('P6 no access_token → no_token', code === 'no_token');
}
// ── P7 🔒 secrets never in errors ─────────────────────────────────────────────────
{
  const CODE = 'SECRET-CODE-abc', VER = 'SECRET-VERIFIER-xyz';
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => `echoed ${CODE} ${VER}` });
  let msg = '';
  try { await exchangeCode({ code: CODE, verifier: VER, fetchImpl, sleep: noSleep }); } catch (e) { msg = String(e.message); }
  rec('P7 🔒 thrown error leaks neither the code nor the verifier (even if the endpoint echoes them)',
    msg.length > 0 && !msg.includes(CODE) && !msg.includes(VER), `msg=${msg}`);
}
// ── P8 flow store ────────────────────────────────────────────────────────────────
{
  let t = 0;
  const store = createPkceFlowStore({ now: () => t, ttlMs: 1000 });
  store.set('userA', { verifier: 'vA' });
  store.set('userB', { verifier: 'vB' });
  const a = store.take('userA');                 // per-user isolation (canonical's P1)
  const bStill = store.take('userB');
  const aAgain = store.take('userA');            // single-use
  store.set('userC', { verifier: 'vC' });
  t = 5000;
  const expired = store.take('userC');           // TTL
  rec('P8 flow store: per-user isolation · single-use · TTL expiry',
    a?.verifier === 'vA' && bStill?.verifier === 'vB' && aAgain === null && expired === null);
}

// ── P9 ⭐ HTTP refresh — NO CLI required (ladder row 3) ───────────────────────────
{
  const fetchImpl = async (_u, opts) => {
    const b = JSON.parse(opts.body);
    if (b.grant_type !== 'refresh_token' || b.refresh_token !== 'ref-old') return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok-new', refresh_token: 'ref-new', expires_in: 3600, scope: 'user:inference' }) };
  };
  const c = await refreshAccessToken({ refreshToken: 'ref-old', fetchImpl, sleep: noSleep, now: () => 5_000_000 });
  rec('P9 ⭐ HTTP refresh works with NO claude CLI (+ honors a rotated refresh token)',
    c.claudeOAuthToken === 'tok-new' && c.refreshToken === 'ref-new' && c.expiresAt === 5_000_000 + 3600_000);
}
// ── P10 ⭐ dead grant vs transient — the caller must re-prompt only on invalid_grant ─
{
  const dead = async () => ({ ok: false, status: 400, json: async () => ({}) });
  let deadCode = null;
  try { await refreshAccessToken({ refreshToken: 'r', fetchImpl: dead, sleep: noSleep }); } catch (e) { deadCode = e.code; }

  let calls = 0;
  const transient = async () => { calls++; return { ok: false, status: 503, json: async () => ({}) }; };
  let transientCode = null;
  try { await refreshAccessToken({ refreshToken: 'r', fetchImpl: transient, sleep: noSleep }); } catch (e) { transientCode = e.code; }

  let noRef = null;
  try { await refreshAccessToken({ refreshToken: null, fetchImpl: dead, sleep: noSleep }); } catch (e) { noRef = e.code; }

  rec('P10 ⭐ 400/401 → invalid_grant (re-auth) · 5xx → refresh_failed (transient, retried) · no token → invalid_grant',
    deadCode === 'invalid_grant' && transientCode === 'refresh_failed' && calls === 3 && noRef === 'invalid_grant',
    `dead=${deadCode} transient=${transientCode} retries=${calls} noRef=${noRef}`);
}
// ── P11 🔒 refresh errors never echo the refresh token ────────────────────────────
{
  const RT = 'SECRET-REFRESH-TOKEN';
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => `echo ${RT}` });
  let msg = '';
  try { await refreshAccessToken({ refreshToken: RT, fetchImpl, sleep: noSleep }); } catch (e) { msg = String(e.message); }
  rec('P11 🔒 refresh error leaks no refresh token', msg.length > 0 && !msg.includes(RT), `msg=${msg}`);
}

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — PKCE connect + CLI-free refresh: paste-tolerant, 5xx-only retry, scope-guarded, dead-grant loud, leak-free');

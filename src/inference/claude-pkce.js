// Claude subscription — browser PKCE connect (the WEB half of the connect ladder).
// Design: the Claude-subscription design §3.1.
//
// WHY: before this, the ONLY way to connect was importing credentials an already
// installed + signed-in `claude` CLI had stored. A fresh machine could not connect
// AT ALL ("not installed, not via web"). This is the floor that always works: the
// user opens an authorize URL in a browser, signs in to their own Claude account,
// and pastes the returned code back. No CLI required, at any point.
//
// PORTED FROM the canonical production implementation
// (portal-auth-claude.js in the hosted product), keeping the
// fixes it earned in production:
//   • the verifier is keyed PER USER — canonical's header records the P1 this fixed:
//     "The single-slot-global version lost User A's verifier as soon as User B
//     clicked Connect." V1 is single-user, but keying it correctly now means V2
//     multi-tenant inherits it for free.
//   • retry ONLY on 5xx — Anthropic's token endpoint emits transient 500s; a 4xx is
//     a real rejection and must not be hammered.
//   • tolerate a pasted full callback URL or fragment, not just a bare code.
//   • reject `claude setup-token` artifacts (no user:inference scope).
//
// PASTE-THE-CODE (not a localhost listener): works headless, over the relay, and on
// a remote box; no port to bind, nothing to firewall. Matches canonical.
//
// SECURITY: `code` and `code_verifier` are PKCE secrets — never logged, never in an
// error message, never persisted beyond the in-flight flow. Talks only to claude.ai
// and the token endpoint. See the design's threat model for the accepted-risk note
// on the undocumented client id + Claude-Code identity.

import crypto from 'node:crypto';

/** Anthropic's Claude-Code OAuth client. Same values as canonical + OpenClaw.
 *  ⚠️ ENDPOINT MIGRATION (2026-07-18): Anthropic moved the OAuth token + callback hosts
 *  off `console.anthropic.com` onto `platform.claude.com`. The old
 *  `console.anthropic.com/v1/oauth/token` now returns 404 for OAuth — which broke BOTH the
 *  HTTP refresh (`refreshAccessToken`) and the web code-exchange (`exchangeCode`), since both
 *  read `tokenUrl` here. User symptom: "Could not refresh the Claude session (404)".
 *  Verified: a POST to `platform.claude.com/v1/oauth/token` returns a proper OAuth
 *  `{"error":"invalid_grant"}`, while `console.anthropic.com` returns 404/generic-API-error.
 *  `authorizeUrl` (claude.ai) and `clientId` are UNCHANGED (still correct).
 *  `redirectUri` moved with the token host to `platform.claude.com/oauth/code/callback`
 *  (mirrors the migration; the OLD callback still 301-redirects). The refresh grant sends NO
 *  `redirect_uri`, so this line only affects the web code-exchange path — smoke-test a fresh
 *  web connect after landing. Evidence: the Claude-subscription OAuth-endpoint notes.
 */
export const CLAUDE_OAUTH = Object.freeze({
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  redirectUri: 'https://platform.claude.com/oauth/code/callback',
  scopes: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
});

export const REQUIRED_SCOPE = 'user:inference';
const FLOW_TTL_MS = 10 * 60 * 1000;   // a pending flow is dead after 10 minutes

export class ClaudePkceError extends Error {
  constructor(message, code) { super(message); this.name = 'ClaudePkceError'; this.code = code; }
}

/**
 * In-memory pending-flow store, keyed by userId. Single-use + TTL.
 * Kept in memory ON PURPOSE: a PKCE verifier is a short-lived secret that must not
 * be persisted (a DB row would outlive the flow and widen at-rest exposure).
 */
export function createPkceFlowStore({ now = () => Date.now(), ttlMs = FLOW_TTL_MS } = {}) {
  const flows = new Map();
  return {
    set(userId, flow) { flows.set(userId, { ...flow, createdAt: now() }); },
    /** Returns the flow and CONSUMES it (single-use). Null if missing/expired. */
    take(userId) {
      const f = flows.get(userId);
      if (!f) return null;
      flows.delete(userId);
      if (now() - f.createdAt > ttlMs) return null;
      return f;
    },
    clear(userId) { flows.delete(userId); },
    get size() { return flows.size; },
  };
}

/**
 * Begin a flow: mint verifier/challenge/state and build the authorize URL.
 * @returns {{ url:string, verifier:string, state:string }}
 */
export function startPkceFlow({ randomBytes = crypto.randomBytes } = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(24).toString('base64url');
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_OAUTH.clientId,
    response_type: 'code',
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    scope: CLAUDE_OAUTH.scopes,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return { url: `${CLAUDE_OAUTH.authorizeUrl}?${params}`, verifier, state };
}

/**
 * Accept what a human actually pastes and RECOVER BOTH parts.
 *
 * Anthropic's callback page renders the result as `<code>#<state>` — so the state
 * is sitting right there in the paste. An earlier cut of this function did
 * `split('#')[0]` and threw it away, which made the CSRF `state` check vacuous:
 * nothing could then detect a code issued for someone ELSE's sign-in. Pasting an
 * attacker-supplied code would bind this vault to the attacker's Claude account,
 * and every subsequent agent turn would ship vault plaintext to it. So we parse
 * the state out and the caller MUST verify it (see exchangeCode).
 *
 * Handles: `<code>#<state>` · a bare code · the full callback URL · a `code=…`
 * fragment (possibly at the very start of the string).
 *
 * @returns {{ code:string, state:string|null }}
 */
export function parsePastedCode(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { code: '', state: null };

  if (s.includes('code=')) {
    try {
      const u = new URL(s);                       // the whole callback URL
      const code = u.searchParams.get('code');
      if (code) return { code: code.split('#')[0].trim(), state: u.searchParams.get('state') || null };
    } catch {
      // A fragment/query slice, not a URL. `code=` may sit at the very START, so
      // anchor on ^ as well as ?/&/# — otherwise a bare fragment parses to itself.
      const cm = s.match(/(?:^|[?&#])code=([^&#]+)/);
      const sm = s.match(/(?:^|[?&#])state=([^&#]+)/);
      if (cm) return { code: cm[1].trim(), state: sm ? sm[1].trim() : null };
    }
  }

  // The common case: exactly what the callback page shows — `<code>#<state>`.
  const [code, state] = s.split('#');
  return { code: (code || '').trim(), state: (state || '').trim() || null };
}

/**
 * Exchange an authorization code for subscription tokens.
 *
 * @param {object} a
 * @param {string} a.code       raw pasted value (URL/fragment tolerated)
 * @param {string} a.verifier   the flow's PKCE verifier
 * @param {string} [a.state]
 * @param {Function} [a.fetchImpl]
 * @param {Function} [a.sleep]  injectable for tests (retry backoff)
 * @returns {Promise<{claudeOAuthToken:string, refreshToken:string|null, expiresAt:number|null, scopes:string[]}>}
 * @throws {ClaudePkceError} 'bad_code' | 'state_mismatch' | 'exchange_failed' | 'no_token' | 'missing_scope'
 */
export async function exchangeCode({
  code, verifier, state, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now,
} = {}) {
  const { code: cleanCode, state: pastedState } = parsePastedCode(code);
  if (!cleanCode) throw new ClaudePkceError('Paste the code from the Claude page to finish connecting.', 'bad_code');
  if (typeof verifier !== 'string' || !verifier) throw new ClaudePkceError('No pending connection. Start again.', 'bad_code');

  // CSRF: the callback carries the state we minted. If the paste has one, it MUST be
  // ours — otherwise the code was issued for a DIFFERENT sign-in and binding it here
  // would attach this vault to someone else's Claude account (every later turn would
  // ship vault plaintext to them). Fail closed on mismatch; tolerate an absent state
  // (a user may hand-copy only the code portion), which is why it is belt-and-braces
  // on top of the PKCE verifier rather than the sole defence.
  if (pastedState && state && pastedState !== state) {
    throw new ClaudePkceError('That code came from a different sign-in attempt. Start the connection again.', 'state_mismatch');
  }

  const body = {
    grant_type: 'authorization_code',
    code: cleanCode,
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    client_id: CLAUDE_OAUTH.clientId,
    code_verifier: verifier,
    ...(state ? { state } : {}),
  };

  // Retry ONLY transient 5xx (canonical: the endpoint emits them). A 4xx means the
  // code is wrong/used/expired — retrying would just burn it.
  let res = null;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await fetchImpl(CLAUDE_OAUTH.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'claude-code/1.0' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // network error — treat like a 5xx (transient)
      lastStatus = 0;
      if (attempt === 3) throw new ClaudePkceError('Could not reach Claude to finish connecting. Check your connection and try again.', 'exchange_failed');
      await sleep(2000 * attempt);
      continue;
    }
    if (res.ok) break;
    lastStatus = res.status;
    if (res.status < 500) break;          // real rejection — stop
    if (attempt < 3) await sleep(2000 * attempt);
  }

  if (!res || !res.ok) {
    // NEVER echo the endpoint's body — it can contain the code/verifier back.
    const hint = lastStatus === 400 || lastStatus === 401
      ? 'That code was rejected (it may be expired or already used). Start again.'
      : `Claude rejected the connection (${lastStatus || 'network error'}). Try again.`;
    throw new ClaudePkceError(hint, 'exchange_failed');
  }

  let tokens;
  try { tokens = await res.json(); } catch { throw new ClaudePkceError('Claude returned an unreadable response.', 'exchange_failed'); }

  const token = (typeof tokens?.access_token === 'string' && tokens.access_token) ? tokens.access_token : null;
  if (!token) throw new ClaudePkceError('Claude did not return an access token.', 'no_token');

  const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean)
    : Array.isArray(tokens.scope) ? tokens.scope.map(String) : [];
  // Reject a `claude setup-token` admin artifact — it cannot run inference.
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw new ClaudePkceError(`This login lacks the ${REQUIRED_SCOPE} scope — it looks like an admin setup-token, not a subscription sign-in.`, 'missing_scope');
  }

  return {
    claudeOAuthToken: token,
    refreshToken: (typeof tokens.refresh_token === 'string' && tokens.refresh_token) ? tokens.refresh_token : null,
    expiresAt: Number.isFinite(tokens.expires_in) ? now() + tokens.expires_in * 1000 : null,
    scopes,
  };
}

/**
 * Refresh an expired subscription token over HTTP — **no `claude` CLI required**.
 *
 * This is the piece that makes the whole thing survive on a machine without the CLI.
 * Neither of our reference implementations has it: this repo's refresh SPAWNS the
 * binary (claude-config-dir.js: `if (!bin) return null` ⇒ no binary, no refresh) and
 * canonical delegates refresh to the CLI entirely. OpenClaw does exactly this grant
 * (src/llm/utils/oauth/anthropic.ts refreshAnthropicToken).
 *
 * Distinguishes a DEAD grant from a TRANSIENT failure — the caller must re-prompt on
 * `invalid_grant` and must NEVER silently downgrade to a local model on either.
 *
 * @returns {Promise<{claudeOAuthToken:string, refreshToken:string|null, expiresAt:number|null, scopes:string[]}>}
 * @throws {ClaudePkceError} 'invalid_grant' (re-auth required) | 'refresh_failed' (transient) | 'no_token'
 */
export async function refreshAccessToken({
  refreshToken, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now,
} = {}) {
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new ClaudePkceError('No refresh token — reconnect your Claude subscription.', 'invalid_grant');
  }
  const body = { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLAUDE_OAUTH.clientId };

  let res = null;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await fetchImpl(CLAUDE_OAUTH.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'claude-code/1.0' },
        body: JSON.stringify(body),
      });
    } catch {
      lastStatus = 0;
      if (attempt === 3) throw new ClaudePkceError('Could not reach Claude to refresh the session.', 'refresh_failed');
      await sleep(2000 * attempt);
      continue;
    }
    if (res.ok) break;
    lastStatus = res.status;
    if (res.status < 500) break;         // 4xx ⇒ the grant itself is rejected
    if (attempt < 3) await sleep(2000 * attempt);
  }

  if (!res || !res.ok) {
    // A 400/401 on a refresh grant means the refresh token is dead (revoked, rotated,
    // or the sub ended) → the user MUST re-auth. Anything else is transient.
    if (lastStatus === 400 || lastStatus === 401) {
      throw new ClaudePkceError('Your Claude session expired and could not be renewed — reconnect your subscription.', 'invalid_grant');
    }
    throw new ClaudePkceError(`Could not refresh the Claude session (${lastStatus || 'network error'}).`, 'refresh_failed');
  }

  let tokens;
  try { tokens = await res.json(); } catch { throw new ClaudePkceError('Claude returned an unreadable refresh response.', 'refresh_failed'); }
  const token = (typeof tokens?.access_token === 'string' && tokens.access_token) ? tokens.access_token : null;
  if (!token) throw new ClaudePkceError('Claude did not return a refreshed access token.', 'no_token');

  const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean)
    : Array.isArray(tokens.scope) ? tokens.scope.map(String) : [];
  return {
    claudeOAuthToken: token,
    // Anthropic may rotate the refresh token; keep the new one when present.
    refreshToken: (typeof tokens.refresh_token === 'string' && tokens.refresh_token) ? tokens.refresh_token : refreshToken,
    expiresAt: Number.isFinite(tokens.expires_in) ? now() + tokens.expires_in * 1000 : null,
    scopes,
  };
}

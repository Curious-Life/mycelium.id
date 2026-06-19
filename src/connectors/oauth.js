// Generic OAuth 2.0 (authorization-code + PKCE) client helpers, shared by the
// real adapters (Gmail, Linear). Config-pointable so the SAME code serves
// shipped Mycelium creds and user-provided creds. fetchImpl is injectable for
// tests. Token endpoints are host-verified (real round-trips can't run in CI).

import crypto from 'node:crypto';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** PKCE verifier + S256 challenge. */
export function createPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/** Opaque anti-CSRF state token. */
export function createState() {
  return b64url(crypto.randomBytes(16));
}

/** Build the provider authorize URL. */
export function buildAuthUrl({ authUrl, clientId, redirectUri, scopes = [], state, codeChallenge, extraParams = {} }) {
  if (!authUrl || !clientId || !redirectUri) throw new Error('buildAuthUrl: authUrl, clientId, redirectUri required');
  const u = new URL(authUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  if (scopes.length) u.searchParams.set('scope', scopes.join(' '));
  if (state) u.searchParams.set('state', state);
  if (codeChallenge) {
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(extraParams)) u.searchParams.set(k, v);
  return u.toString();
}

function normalizeTokenResponse(j) {
  if (!j || typeof j.access_token !== 'string') throw new Error('token response missing access_token');
  const expiresIn = Number(j.expires_in) || 0;
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token || null,
    token_type: j.token_type || 'Bearer',
    scope: j.scope || null,
    // server-runtime Date is fine here (this is not a workflow script).
    expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
  };
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode({ tokenUrl, clientId, clientSecret, redirectUri, code, codeVerifier, fetchImpl = fetch }) {
  if (!tokenUrl || !clientId || !code) throw new Error('exchangeCode: tokenUrl, clientId, code required');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId });
  if (clientSecret) body.set('client_secret', clientSecret);
  if (codeVerifier) body.set('code_verifier', codeVerifier);
  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  return normalizeTokenResponse(await res.json());
}

/** Refresh an access token using a refresh_token. */
export async function refreshAccessToken({ tokenUrl, clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
  if (!tokenUrl || !clientId || !refreshToken) throw new Error('refreshAccessToken: tokenUrl, clientId, refreshToken required');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  if (clientSecret) body.set('client_secret', clientSecret);
  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`token refresh failed (${res.status})`);
  const t = normalizeTokenResponse(await res.json());
  // Providers often omit refresh_token on refresh — keep the prior one.
  if (!t.refresh_token) t.refresh_token = refreshToken;
  return t;
}

/** True when a token is missing or within `skewMs` of expiry. */
export function isExpired(tokens, skewMs = 60_000) {
  if (!tokens?.access_token) return true;
  if (!tokens.expires_at) return false; // no expiry info → assume valid
  return Date.parse(tokens.expires_at) - Date.now() < skewMs;
}

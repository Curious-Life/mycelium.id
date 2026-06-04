// Gmail connector adapter. OAuth (Google, PKCE) + incremental message pull.
// normalize() is pure (CI-tested with fixtures); pull()'s HTTP is host-verified
// against the live Gmail API. ctx.fetchImpl overrides fetch for tests.

import { PROVIDERS, resolveProviderConfig } from '../providers.js';
import { refreshAccessToken, isExpired } from '../oauth.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

const headerVal = (headers, name) =>
  (headers || []).find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

const b64url = (data) => {
  try { return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
  catch { return ''; }
};

/** Depth-first search for a text/plain body, then any decodable body. */
function extractBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return b64url(payload.body.data);
  for (const part of payload.parts || []) {
    const found = extractBody(part);
    if (found) return found;
  }
  if (payload.body?.data) return b64url(payload.body.data);
  return '';
}

/** Gmail message (format=full) → captureMessage args. Pure. */
export function normalize(msg) {
  const headers = msg.payload?.headers || [];
  const subject = headerVal(headers, 'Subject') || '(no subject)';
  const from = headerVal(headers, 'From');
  const date = headerVal(headers, 'Date');
  const body = extractBody(msg.payload) || msg.snippet || '';
  const createdAt = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : undefined;
  return {
    content: `# ${subject}\n\nFrom: ${from}\n\n${body}`.trim(),
    source: 'gmail',
    id: `gmail:${msg.id}`,
    messageType: 'email',
    createdAt,
    metadata: { connector: 'gmail', from, subject, date, threadId: msg.threadId || null },
  };
}

export const gmailAdapter = {
  id: 'gmail',
  label: 'Gmail',
  provider: 'google',
  oauth: PROVIDERS.gmail,
  resolveOAuthConfig: (ctx) => resolveProviderConfig('gmail', ctx),

  async ensureFreshToken(tokens, ctx) {
    if (!isExpired(tokens) || !tokens.refresh_token) return tokens;
    const cfg = await resolveProviderConfig('gmail', ctx);
    if (!cfg?.clientId) return tokens;
    return refreshAccessToken({
      tokenUrl: cfg.tokenUrl, clientId: cfg.clientId, clientSecret: cfg.clientSecret,
      refreshToken: tokens.refresh_token, fetchImpl: ctx.fetchImpl || fetch,
    });
  },

  async pull(ctx, { cursor } = {}) {
    const fetchImpl = ctx.fetchImpl || fetch;
    const access = ctx.tokens?.access_token;
    if (!access) throw new Error('gmail: no access token');
    const auth = { authorization: `Bearer ${access}` };

    // Incremental by internalDate (epoch ms). Gmail's `after:` query is in
    // seconds; first run pulls the last 30 days.
    const sinceMs = cursor ? Number(cursor) : 0;
    const q = sinceMs ? `after:${Math.floor(sinceMs / 1000)}` : 'newer_than:30d';
    const listRes = await fetchImpl(`${API}/messages?maxResults=25&q=${encodeURIComponent(q)}`, { headers: auth });
    if (!listRes.ok) throw new Error(`gmail list failed (${listRes.status})`);
    const list = await listRes.json();

    const items = [];
    let maxInternal = sinceMs;
    for (const { id } of list.messages || []) {
      const r = await fetchImpl(`${API}/messages/${id}?format=full`, { headers: auth });
      if (!r.ok) continue;
      const msg = await r.json();
      items.push(normalize(msg));
      const internal = Number(msg.internalDate) || 0;
      if (internal > maxInternal) maxInternal = internal;
    }
    // +1ms so the next `after:` doesn't re-fetch the boundary message.
    return { items, nextCursor: maxInternal ? String(maxInternal + 1) : (cursor ?? null) };
  },
};

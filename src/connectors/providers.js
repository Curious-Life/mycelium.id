// OAuth provider configs for live connectors.
//
// Endpoints + scopes are public constants. Client CREDENTIALS are operator-
// supplied — the "ship one-click Mycelium creds" choice means Mycelium operates
// the OAuth apps, but the secrets themselves are live-infra (parallel to the
// remote-connect managed stack): dropped in via env (MYCELIUM_<P>_CLIENT_ID/
// _SECRET) or the encrypted secrets store (user-provided override), never
// hardcoded. The flow + UX are complete in code; going live needs the operator
// to set the creds. Until then connect() surfaces 'oauth_not_configured'.

const redirectBase = () =>
  process.env.MYCELIUM_PUBLIC_BASE_URL
  || `http://${process.env.MYCELIUM_REST_HOST || '127.0.0.1'}:${process.env.MYCELIUM_REST_PORT || 8787}`;

export const PROVIDERS = {
  gmail: {
    provider: 'google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    usePKCE: true, // Google "Desktop app" PKCE flow (client_secret non-confidential)
    extraAuthParams: { access_type: 'offline', prompt: 'consent' }, // ensures a refresh_token
    envClientId: 'MYCELIUM_GMAIL_CLIENT_ID',
    envClientSecret: 'MYCELIUM_GMAIL_CLIENT_SECRET',
  },
  linear: {
    provider: 'linear',
    authUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    scopes: ['read'],
    usePKCE: false, // Linear is a confidential client (no public PKCE flow)
    extraAuthParams: {},
    envClientId: 'MYCELIUM_LINEAR_CLIENT_ID',
    envClientSecret: 'MYCELIUM_LINEAR_CLIENT_SECRET',
  },
};

/**
 * Full OAuth config for a connector id (env first, then encrypted secrets
 * override). clientId/clientSecret are null when unconfigured.
 */
export async function resolveProviderConfig(id, { db, userId } = {}) {
  const p = PROVIDERS[id];
  if (!p) return null;
  let clientId = process.env[p.envClientId] || null;
  let clientSecret = process.env[p.envClientSecret] || null;
  if ((!clientId || !clientSecret) && db?.secrets && userId) {
    clientId = clientId || (await db.secrets.get(userId, `connector:${id}:client_id`));
    clientSecret = clientSecret || (await db.secrets.get(userId, `connector:${id}:client_secret`));
  }
  return {
    authUrl: p.authUrl,
    tokenUrl: p.tokenUrl,
    scopes: p.scopes,
    usePKCE: p.usePKCE,
    extraAuthParams: p.extraAuthParams,
    clientId,
    clientSecret,
    redirectUri: `${redirectBase()}/api/v1/portal/connectors/${id}/callback`,
  };
}

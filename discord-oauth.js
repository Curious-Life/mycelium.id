/**
 * Discord OAuth2 - Handle Discord authentication for identity linking
 *
 * Allows users to link their Discord account to their MYA account.
 * Uses the OAuth2 authorization code flow.
 *
 * Required env vars:
 * - process.env.DISCORD_CLIENT_ID (from Discord Developer Portal)
 * - process.env.DISCORD_CLIENT_SECRET (from Discord Developer Portal)
 */

import crypto from 'crypto';

// Read lazily — bootstrap-secrets populates process.env before first use
const DISCORD_API_BASE = 'https://discord.com/api/v10';

// Scopes for user identity
const SCOPES = ['identify'];

/**
 * Generate a secure random state for CSRF protection
 */
export function generateState() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Get the Discord OAuth2 authorization URL
 * @param {string} redirectUri - Where to redirect after auth
 * @param {string} state - CSRF protection state
 */
export function getAuthUrl(redirectUri, state) {
  if (!process.env.DISCORD_CLIENT_ID) {
    throw new Error('process.env.DISCORD_CLIENT_ID not configured');
  }

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state: state,
    prompt: 'consent'  // Always show consent screen
  });

  return `https://discord.com/oauth2/authorize?${params}`;
}

/**
 * Exchange authorization code for access token
 * @param {string} code - Authorization code from callback
 * @param {string} redirectUri - Must match the original redirect URI
 */
export async function exchangeCodeForToken(code, redirectUri) {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    throw new Error('Discord OAuth not configured');
  }

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    client_secret: process.env.DISCORD_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: redirectUri
  });

  const response = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error_description || data.error);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    tokenType: data.token_type,
    scope: data.scope
  };
}

/**
 * Get Discord user info using access token
 * @param {string} accessToken - OAuth access token
 */
export async function getUser(accessToken) {
  const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error('Failed to fetch Discord user');
  }

  const user = await response.json();

  return {
    id: user.id,
    username: user.username,
    displayName: user.global_name || user.username,
    avatar: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/${parseInt(user.id) % 5}.png`,
    discriminator: user.discriminator,
    email: user.email,  // Only if email scope requested
    verified: user.verified
  };
}

/**
 * Revoke an access token (for unlinking)
 * @param {string} accessToken - Token to revoke
 */
export async function revokeToken(accessToken) {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
    return;
  }

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    client_secret: process.env.DISCORD_CLIENT_SECRET,
    token: accessToken
  });

  await fetch(`${DISCORD_API_BASE}/oauth2/token/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });
}

export default {
  generateState,
  getAuthUrl,
  exchangeCodeForToken,
  getUser,
  revokeToken
};

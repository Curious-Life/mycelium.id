/**
 * Google Auth — Token Management
 *
 * Supports two auth modes via priority chain:
 *   1. Service Account (GOOGLE_SERVICE_ACCOUNT_FILE) → JWT → access token
 *   2. OAuth token file (.google-tokens/{accountId}.json) → refresh → access token
 *   3. OAuth env var (GOOGLE_REFRESH_TOKEN) → refresh → access token
 *
 * No external dependencies — uses Node crypto for JWT signing and fetch for token exchange.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TOKENS_DIR = path.join(PROJECT_ROOT, '.google-tokens');

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// Cache access tokens in memory (per account)
const tokenCache = new Map();

/**
 * Create a Google auth instance for a given account.
 * @param {string} [accountId='default'] — account identifier for multi-account support
 * @returns {GoogleAuth}
 */
export function createGoogleAuth(accountId = 'default') {
  return new GoogleAuth(accountId);
}

class GoogleAuth {
  constructor(accountId) {
    this.accountId = accountId;
    this._resolved = null; // lazy-resolved config
  }

  /**
   * Check if any auth method is available.
   */
  isConfigured() {
    try {
      const config = this._resolveConfig();
      return config !== null;
    } catch {
      return false;
    }
  }

  /**
   * Get auth info (type, account, scopes).
   */
  getInfo() {
    const config = this._resolveConfig();
    if (!config) return { configured: false };
    return {
      configured: true,
      type: config.type,
      account: this.accountId,
      ...(config.subject && { subject: config.subject }),
    };
  }

  /**
   * Get a valid access token. Caches and auto-refreshes.
   * @returns {Promise<string>} access token
   */
  async getAccessToken() {
    const cacheKey = this.accountId;
    const cached = tokenCache.get(cacheKey);

    // Return cached token if still valid (with 60s buffer)
    if (cached && Date.now() < cached.expiresAt - 60_000) {
      return cached.accessToken;
    }

    const config = this._resolveConfig();
    if (!config) {
      throw new Error('Google auth not configured. Run: node scripts/google-auth-setup.js');
    }

    let result;
    if (config.type === 'service_account') {
      result = await this._getServiceAccountToken(config);
    } else {
      result = await this._refreshOAuthToken(config);
    }

    tokenCache.set(cacheKey, {
      accessToken: result.access_token,
      expiresAt: Date.now() + (result.expires_in || 3600) * 1000,
    });

    return result.access_token;
  }

  /**
   * Resolve auth config from priority chain (synchronous check, lazy-loaded).
   * Returns null if nothing configured.
   */
  _resolveConfig() {
    if (this._resolved !== undefined) return this._resolved;

    // 1. Service Account file
    const saFile = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
    if (saFile) {
      try {
        const raw = require('fs').readFileSync(saFile, 'utf-8');
        const key = JSON.parse(raw);
        if (key.type === 'service_account' && key.private_key && key.client_email) {
          this._resolved = {
            type: 'service_account',
            key,
            subject: process.env.GOOGLE_IMPERSONATE_EMAIL || null,
          };
          return this._resolved;
        }
      } catch {
        // Invalid file, fall through
      }
    }

    // 2. OAuth token file
    try {
      const tokenPath = path.join(TOKENS_DIR, `${this.accountId}.json`);
      const raw = require('fs').readFileSync(tokenPath, 'utf-8');
      const tokens = JSON.parse(raw);

      if (tokens.type === 'service_account') {
        // Token file can also reference a service account
        const keyRaw = require('fs').readFileSync(tokens.key_file, 'utf-8');
        const key = JSON.parse(keyRaw);
        this._resolved = {
          type: 'service_account',
          key,
          subject: tokens.subject || null,
        };
        return this._resolved;
      }

      if (tokens.refresh_token) {
        this._resolved = {
          type: 'oauth',
          refreshToken: tokens.refresh_token,
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        };
        return this._resolved;
      }
    } catch {
      // No token file, fall through
    }

    // 3. OAuth env var
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    if (refreshToken && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
      this._resolved = {
        type: 'oauth',
        refreshToken,
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      };
      return this._resolved;
    }

    this._resolved = null;
    return null;
  }

  /**
   * Service Account: Create JWT and exchange for access token.
   */
  async _getServiceAccountToken(config) {
    const { key, subject } = config;
    const now = Math.floor(Date.now() / 1000);

    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar',
      aud: TOKEN_ENDPOINT,
      iat: now,
      exp: now + 3600,
      ...(subject && { sub: subject }),
    };

    const segments = [
      base64url(JSON.stringify(header)),
      base64url(JSON.stringify(claims)),
    ];

    const signingInput = segments.join('.');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signingInput);
    const signature = sign.sign(key.private_key);
    segments.push(base64url(signature));

    const jwt = segments.join('.');

    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Service account token exchange failed (${res.status}): ${error}`);
    }

    return res.json();
  }

  /**
   * OAuth: Use refresh token to get a new access token.
   */
  async _refreshOAuthToken(config) {
    const { refreshToken, clientId, clientSecret } = config;

    if (!clientId || !clientSecret) {
      throw new Error('OAuth requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars');
    }

    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`OAuth token refresh failed (${res.status}): ${error}`);
    }

    return res.json();
  }
}

/**
 * Base64url encode (no padding, URL-safe).
 * Accepts string or Buffer.
 */
function base64url(input) {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

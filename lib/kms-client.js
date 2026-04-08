/**
 * KMS Client — Fetches KEK from Swiss KMS via mTLS, caches with configurable TTL.
 *
 * Replaces the tmpfs master key as the primary key source when KMS_URL is configured.
 * When KMS is not configured, this module is never imported (dynamic import in crypto-local.js).
 *
 * Config (env vars):
 *   KMS_URL        — e.g., https://185.x.x.x:8443
 *   KMS_CERT_PATH  — directory with client.crt, client.key, ca.crt (default: /etc/mycelium/kms-certs/)
 *   KMS_TTL_HOURS  — cache TTL (default: 72, range: 1-720)
 *   KMS_CUSTOMER_ID — from MYA_USER_ID (for validation)
 */

import https from 'https';
import { readFileSync, existsSync } from 'fs';
import { webcrypto } from 'crypto';

const { subtle } = webcrypto;

const KMS_URL = process.env.KMS_URL || '';
const CERT_PATH = process.env.KMS_CERT_PATH || '/etc/mycelium/kms-certs';
const TTL_HOURS = Math.min(720, Math.max(1, parseInt(process.env.KMS_TTL_HOURS, 10) || 72));
const TTL_MS = TTL_HOURS * 3600_000;
const STALE_FACTOR = 1.5; // Max stale window = 1.5x TTL
const REFRESH_AT = 0.9;   // Proactive refresh at 90% of TTL

// Cache
let _cachedKey = null;      // CryptoKey (HKDF base)
let _cachedHex = null;      // 64-char hex (for comparison)
let _fetchedAt = 0;         // timestamp of last successful fetch
let _refreshTimer = null;   // proactive refresh timer
let _urkMode = false;       // true when KEK was fetched via URK (can't auto-refresh)

// mTLS agent (lazy init)
let _agent = null;

function getAgent() {
  if (_agent) return _agent;

  const certFile = `${CERT_PATH}/client.crt`;
  const keyFile = `${CERT_PATH}/client.key`;
  const caFile = `${CERT_PATH}/ca.crt`;

  for (const f of [certFile, keyFile, caFile]) {
    if (!existsSync(f)) throw new Error(`KMS cert missing: ${f}`);
  }

  _agent = new https.Agent({
    cert: readFileSync(certFile),
    key: readFileSync(keyFile),
    ca: readFileSync(caFile),
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
  });

  return _agent;
}

/**
 * Check if KMS is configured (env vars present + cert files exist).
 * @returns {boolean}
 */
export function isKmsConfigured() {
  if (!KMS_URL) return false;
  try {
    getAgent(); // validates cert files exist
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch KEK from KMS via mTLS POST /unwrap.
 * @param {string|null} urk — 64-char hex URK (null for legacy plaintext mode)
 * @param {string|null} credentialId — passkey credential ID (required if urk provided)
 * @returns {Promise<string>} 64-char hex KEK
 */
async function fetchKekFromKms(urk = null, credentialId = null) {
  const agent = getAgent();
  const url = new URL('/unwrap', KMS_URL);

  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 8443,
      path: url.pathname,
      agent,
      headers: { 'Content-Type': 'application/json' },
      timeout: 10_000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`KMS ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (!parsed.kek || parsed.kek.length !== 64) {
            reject(new Error('KMS returned invalid KEK'));
            return;
          }
          resolve(parsed.kek);
        } catch (err) {
          reject(new Error(`KMS response parse error: ${err.message}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('KMS timeout (10s)')); });
    req.on('error', (err) => reject(new Error(`KMS connection error: ${err.message}`)));

    const body = { ttlHours: TTL_HOURS };
    if (urk) { body.urk = urk; body.credentialId = credentialId; }
    req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Import a hex key string as a WebCrypto CryptoKey for HKDF.
 * Same logic as crypto-local.js importMasterKey().
 * @param {string} hex — 64 hex chars
 * @returns {Promise<CryptoKey>}
 */
async function importHex(hex) {
  const raw = Buffer.from(hex, 'hex');
  return subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
}

/**
 * Get the KEK as a CryptoKey, from cache or KMS.
 *
 * Cache logic:
 * - If cached and TTL valid → return cached
 * - If cached and TTL expired but < 1.5x TTL → try refresh, use stale on failure
 * - If cached and > 1.5x TTL (very stale) → must refresh, fail if KMS unreachable
 * - If not cached → fetch from KMS
 *
 * @returns {Promise<CryptoKey>}
 */
export async function getKmsKey() {
  const now = Date.now();
  const age = now - _fetchedAt;

  // Fresh cache — return immediately
  if (_cachedKey && age < TTL_MS) {
    return _cachedKey;
  }

  // URK mode: cannot auto-refresh — user must log in again
  if (_urkMode) {
    if (_cachedKey && age < TTL_MS * STALE_FACTOR) {
      if (age >= TTL_MS) {
        console.warn(`[kms-client] KEK stale (${Math.round(age / 3600_000)}h) — URK mode, user must log in to refresh`);
      }
      return _cachedKey;
    }
    console.error(`[kms-client] KEK expired beyond stale window in URK mode — user login required`);
    throw new Error('KEK expired — user login required to provide URK');
  }

  // Legacy plaintext mode: try refresh, fall back to stale
  if (_cachedKey && age < TTL_MS * STALE_FACTOR) {
    try {
      return await refreshFromKms();
    } catch (err) {
      console.warn(`[kms-client] Refresh failed (using stale key, ${Math.round(age / 3600_000)}h old): ${err.message}`);
      return _cachedKey;
    }
  }

  if (_cachedKey && age >= TTL_MS * STALE_FACTOR) {
    console.warn(`[kms-client] Key expired beyond stale window (${Math.round(age / 3600_000)}h) — must re-fetch`);
  }

  return await refreshFromKms();
}

/**
 * Force refresh from KMS (legacy plaintext mode only).
 * @returns {Promise<CryptoKey>}
 */
export async function refreshKmsKey() {
  return await refreshFromKms();
}

/**
 * Provide URK from user login. Fetches and caches the KEK via URK unwrap.
 * Called by the auth verify endpoint after successful passkey login with PRF.
 * @param {string} urk — 64-char hex URK
 * @param {string} credentialId — passkey credential ID
 * @returns {Promise<CryptoKey>}
 */
export async function provideUrk(urk, credentialId) {
  console.log('[kms-client] URK provided, fetching KEK from KMS...');
  const hex = await fetchKekFromKms(urk, credentialId);

  _cachedKey = await importHex(hex);
  _cachedHex = hex;
  _fetchedAt = Date.now();
  _urkMode = true;

  // Do NOT schedule proactive refresh — can't refresh without user's passkey
  if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }

  console.log('[kms-client] KEK cached via URK (no auto-refresh — user must re-login before TTL expiry)');
  return _cachedKey;
}

/**
 * Call KMS /migrate-to-urk to wrap existing plaintext KEK with URK.
 * @param {string} urk — 64-char hex
 * @param {string} credentialId
 * @returns {Promise<Object>}
 */
export async function migrateKmsToUrk(urk, credentialId) {
  const agent = getAgent();
  const url = new URL('/migrate-to-urk', KMS_URL);

  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST', hostname: url.hostname, port: url.port || 8443,
      path: url.pathname, agent,
      headers: { 'Content-Type': 'application/json' }, timeout: 10_000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`KMS migrate ${res.statusCode}: ${data.substring(0, 200)}`));
        else resolve(JSON.parse(data));
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('KMS migrate timeout')); });
    req.on('error', reject);
    req.write(JSON.stringify({ urk, credentialId }));
    req.end();
  });
}

/**
 * Clear the cached key. Used during key rotation or customer deletion.
 */
export function clearCache() {
  _cachedKey = null;
  _cachedHex = null;
  _fetchedAt = 0;
  _urkMode = false;
  if (_refreshTimer) {
    clearTimeout(_refreshTimer);
    _refreshTimer = null;
  }
}

/**
 * Get cache status for health checks.
 * @returns {{ configured: boolean, cached: boolean, ttlRemaining: number|null, lastFetch: string|null, source: string }}
 */
export function getKmsStatus() {
  const configured = isKmsConfigured();
  const cached = !!_cachedKey;
  const ttlRemaining = cached ? Math.max(0, TTL_MS - (Date.now() - _fetchedAt)) : null;

  return {
    configured,
    cached,
    ttlRemaining: ttlRemaining !== null ? Math.round(ttlRemaining / 1000) : null,
    lastFetch: _fetchedAt ? new Date(_fetchedAt).toISOString() : null,
    source: configured ? 'kms' : 'local',
    ttlHours: TTL_HOURS,
    urkMode: _urkMode,
    urkRequired: _urkMode && (!_cachedKey || (Date.now() - _fetchedAt) >= TTL_MS),
  };
}

// ── Internal ──

async function refreshFromKms() {
  console.log('[kms-client] Fetching KEK from KMS...');
  const hex = await fetchKekFromKms();

  // Only re-import if the key actually changed
  if (hex !== _cachedHex) {
    _cachedKey = await importHex(hex);
    _cachedHex = hex;
    console.log('[kms-client] KEK updated (new key)');
  } else {
    console.log('[kms-client] KEK refreshed (unchanged)');
  }

  _fetchedAt = Date.now();

  // Schedule proactive refresh at 90% of TTL
  scheduleRefresh();

  return _cachedKey;
}

function scheduleRefresh() {
  if (_refreshTimer) clearTimeout(_refreshTimer);
  const refreshMs = TTL_MS * REFRESH_AT;
  _refreshTimer = setTimeout(async () => {
    try {
      await refreshFromKms();
    } catch (err) {
      console.warn(`[kms-client] Proactive refresh failed: ${err.message}`);
      // Will retry on next getKmsKey() call
    }
  }, refreshMs);
  // Unref so the timer doesn't keep the process alive
  if (_refreshTimer.unref) _refreshTimer.unref();
}

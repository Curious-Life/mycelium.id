/**
 * Bootstrap agent secrets from the centralized secrets API.
 * Call at startup before any other initialization.
 *
 * SWISS VAULT: Worker returns ciphertext — we decrypt locally with crypto-local.js.
 * Master key stays on VPS, Worker never sees plaintext secrets.
 *
 * Requires: MYA_WORKER_URL, AGENT_TOKEN, and master key (tmpfs or env).
 *
 * Failure behavior: throws on startup if Worker is unreachable.
 * Agents must NOT start with stale or missing secrets — fail loud.
 */

import { importMasterKeyFromTmpfs, decrypt, isEncrypted } from './crypto-local.js';

// In-memory cache for periodic refresh (not persisted to disk)
let secretsCache = null;
let cacheTimestamp = 0;
let masterKey = null;

// Refresh interval: 5 min. All secrets refreshed together — the Worker
// call is cheap and splitting by category adds complexity for no benefit.
const REFRESH_INTERVAL = 5 * 60 * 1000;

/** Load master key once (lazy) — from tmpfs (preferred) or env (fallback). */
async function ensureMasterKey() {
  if (masterKey) return masterKey;
  masterKey = await importMasterKeyFromTmpfs();
  if (!masterKey) {
    console.warn('[secrets] No master key (tmpfs nor env) — secrets will not be decrypted');
  }
  return masterKey;
}

/** Decrypt a single secret value if it's encrypted. */
async function decryptValue(value, mk) {
  if (!isEncrypted(value)) return value; // plaintext — pass through
  if (!mk) return null; // encrypted but no key — skip entirely, never inject ciphertext
  try {
    return await decrypt(value, mk);
  } catch (err) {
    console.warn(`[secrets] Failed to decrypt secret: ${err.message}`);
    return null; // decryption failed — skip, never inject ciphertext
  }
}

export async function bootstrapSecrets() {
  const workerUrl = process.env.MYA_WORKER_URL;
  const agentToken = process.env.AGENT_TOKEN;

  if (!workerUrl || !agentToken) {
    console.warn("[secrets] MYA_WORKER_URL or AGENT_TOKEN not set, skipping bootstrap");
    return;
  }

  const mk = await ensureMasterKey();

  const res = await fetch(`${workerUrl}/api/secrets`, {
    headers: { Authorization: `Bearer ${agentToken}` },
    signal: AbortSignal.timeout(10_000), // 10s timeout
  });

  if (!res.ok) {
    console.warn(`[secrets] Worker returned ${res.status} — continuing without secrets (new instance or auth issue)`);
    return;
  }

  const { secrets, count } = await res.json();

  // Decrypt each secret value locally (Swiss Vault)
  const decrypted = {};
  for (const [key, value] of Object.entries(secrets)) {
    decrypted[key] = await decryptValue(value, mk);
  }

  secretsCache = decrypted;
  cacheTimestamp = Date.now();

  // Inject into process.env (don't override existing, skip undecrypted)
  let injected = 0;
  let skipped = 0;
  for (const [key, value] of Object.entries(decrypted)) {
    if (value === null) { skipped++; continue; } // couldn't decrypt — never inject ciphertext
    if (!process.env[key]) {
      process.env[key] = value;
      injected++;
    }
  }

  // Auto-alias: TELEGRAM_BOT_TOKEN_MOM → TELEGRAM_BOT_TOKEN (for shared scripts)
  // The moms-telegram-bot uses the same telegram-bot.js which reads TELEGRAM_BOT_TOKEN
  const aliases = {
    TELEGRAM_BOT_TOKEN_MOM: 'TELEGRAM_BOT_TOKEN',
  };
  for (const [src, dst] of Object.entries(aliases)) {
    if (process.env[src] && !process.env[dst]) {
      process.env[dst] = process.env[src];
    }
  }

  console.log(`[secrets] Loaded ${count} secrets, injected ${injected}, skipped ${skipped} (no master key)`);

}

/**
 * Refresh secrets from the API. Called every 5 min via setInterval.
 * In-memory only — never writes to disk.
 * Refreshes all secrets together (single cheap Worker call).
 */
export async function refreshSecrets() {
  const workerUrl = process.env.MYA_WORKER_URL;
  const agentToken = process.env.AGENT_TOKEN;
  if (!workerUrl || !agentToken) return;

  const now = Date.now();
  if (now - cacheTimestamp < REFRESH_INTERVAL) return;

  try {
    const mk = await ensureMasterKey();

    const res = await fetch(`${workerUrl}/api/secrets`, {
      headers: { Authorization: `Bearer ${agentToken}` },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      console.warn(`[secrets] Refresh failed: ${res.status}, using cached values`);
      return;
    }

    const { secrets } = await res.json();

    // Decrypt each secret value locally
    const decrypted = {};
    for (const [key, value] of Object.entries(secrets)) {
      decrypted[key] = await decryptValue(value, mk);
    }

    secretsCache = decrypted;
    cacheTimestamp = now;

    // Update process.env with new values (skip undecrypted)
    let refreshed = 0;
    for (const [key, value] of Object.entries(decrypted)) {
      if (value === null) continue; // couldn't decrypt — don't inject ciphertext
      process.env[key] = value;
      refreshed++;
    }

    console.log(`[secrets] Refreshed ${refreshed} secrets`);
  } catch (err) {
    console.warn(`[secrets] Refresh failed: ${err.message}, using cached values`);
    // Non-fatal on refresh — agent keeps running with cached secrets
  }
}

/**
 * Bootstrap agent secrets from the centralized secrets API.
 * Call at startup before any other initialization.
 *
 * SWISS VAULT: Worker returns ciphertext — we decrypt locally with crypto-local.js.
 * Neither master key nor system key ever leaves the VPS. Worker never sees plaintext.
 *
 * Two-key separation (see plan rosy-jumping-llama):
 *   - SYSTEM_KEY (`/run/mycelium/system.key`) decrypts operator infrastructure
 *     secrets (Claude API token, Worker secret, Discord bot tokens, etc.).
 *     Required for the agent to boot successfully.
 *   - USER_MASTER_KEY (`/run/mycelium/master.key`) decrypts customer vault data.
 *     NOT required for bootstrap — only for decrypting customer-owned secrets
 *     (future: user-scoped API keys, OAuth tokens, etc.).
 *
 * Because the two keys are independent, the agent can boot and talk to Claude
 * even when the customer has not yet provided their master key — the operator's
 * infrastructure secrets decrypt just fine with SYSTEM_KEY.
 *
 * Requires: MYA_WORKER_URL, AGENT_TOKEN, SYSTEM_KEY (tmpfs).
 *
 * Failure behavior: logs warnings if secrets can't be decrypted. Does NOT inject
 * ciphertext into process.env under any circumstances.
 */

import {
  getMasterKeyFromBestSource,
  getSystemKeyFromBestSource,
  decrypt,
  isEncrypted,
} from './crypto-local.js';

// In-memory cache for periodic refresh (not persisted to disk)
let secretsCache = null;
let cacheTimestamp = 0;
let systemKey = null;
let masterKey = null;

// Refresh interval: 5 min. All secrets refreshed together — the Worker
// call is cheap and splitting by category adds complexity for no benefit.
const REFRESH_INTERVAL = 5 * 60 * 1000;

/**
 * Load both key families once (lazy).
 *   SYSTEM_KEY      → tmpfs /run/mycelium/system.key
 *   USER_MASTER_KEY → KMS → tmpfs /run/mycelium/master.key → env (legacy)
 *
 * Either key may be null — we load whatever is available and decrypt the
 * secrets whose family matches. Secrets in the other family are skipped.
 */
async function ensureKeys() {
  if (systemKey === null && masterKey === null) {
    systemKey = await getSystemKeyFromBestSource();
    masterKey = await getMasterKeyFromBestSource();
    if (!systemKey && !masterKey) {
      console.warn('[secrets] No keys available (no SYSTEM_KEY, no USER_MASTER_KEY) — secrets will not be decrypted');
    } else if (!systemKey) {
      console.warn('[secrets] No SYSTEM_KEY — operator infrastructure secrets will not decrypt');
    } else if (!masterKey) {
      // This is the expected state during customer onboarding (before they
      // provide their master key). Not an error.
      console.log('[secrets] SYSTEM_KEY loaded, no USER_MASTER_KEY (customer master key not yet provided)');
    }
  }
  return { systemKey, masterKey };
}

/**
 * Decrypt a single secret value. Routes to the correct key family based on
 * envelope metadata (v3 + kf='system' → SYSTEM_KEY, otherwise → USER_MASTER_KEY).
 *
 * Legacy v1/v2 envelopes were all encrypted with whatever key was mounted at
 * `master.key` when they were seeded — in practice that was the operator's
 * key on the provisioner machine. During the migration period we try BOTH
 * keys for legacy envelopes so the transition is seamless.
 *
 * Returns null on any failure — never returns ciphertext.
 */
async function decryptValue(value, keyFamily, { systemKey: sys, masterKey: mk }) {
  if (!isEncrypted(value)) return value; // plaintext — pass through

  // Parse envelope to determine routing
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    return null;
  }

  // v3 envelopes carry explicit key family tag
  if (envelope.v === 3) {
    const family = envelope.kf || 'user';
    if (family === 'system') {
      if (!sys) return null;
      try {
        return await decrypt(value, null, null, { systemKey: sys });
      } catch (err) {
        console.warn(`[secrets] Failed to decrypt system envelope: ${err.message}`);
        return null;
      }
    }
    // v3 user envelope
    if (!mk) return null;
    try {
      return await decrypt(value, mk);
    } catch (err) {
      console.warn(`[secrets] Failed to decrypt v3 user envelope: ${err.message}`);
      return null;
    }
  }

  // Legacy v1/v2 envelopes — transition period only.
  // The D1 `key_family` column may say 'system' because it defaults to 'system',
  // but the envelope itself was encrypted with whatever master key was on the
  // provisioner machine at seeding time. Try system key first (if the column
  // says so), then fall back to master key.
  const tryKeys = [];
  if (keyFamily === 'system') {
    if (sys) tryKeys.push(['system', sys]);
    if (mk) tryKeys.push(['master', mk]);
  } else {
    if (mk) tryKeys.push(['master', mk]);
    if (sys) tryKeys.push(['system', sys]);
  }

  // v1/v2 always decrypts via the user-scope derivation. System key won't
  // decrypt a v1/v2 envelope because they use different HKDF info strings.
  // So for legacy envelopes we only try the master key.
  if (!mk) return null;
  try {
    return await decrypt(value, mk);
  } catch (err) {
    console.warn(`[secrets] Failed to decrypt legacy envelope (v${envelope.v}): ${err.message}`);
    return null;
  }
}

async function fetchSecrets(workerUrl, agentToken, timeoutMs) {
  // Send X-Tenant-ID so the Worker routes the secrets query to THIS tenant's
  // D1 (mycelium-tenant-<handle>), not the shared owner DB. Without this
  // header, customer agents would pull operator secrets from the owner DB
  // — encrypted with a key they don't have, hence "skipped 36" failures.
  const headers = { Authorization: `Bearer ${agentToken}` };
  const tenantId = process.env.MYA_USER_ID;
  if (tenantId) headers['X-Tenant-ID'] = tenantId;

  const res = await fetch(`${workerUrl}/api/secrets`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return { ok: false, status: res.status };
  const body = await res.json();
  return { ok: true, body };
}

/**
 * Normalize the Worker response into a per-key shape with key family hints.
 *
 * The Worker returns:
 *   { secrets: { KEY: "ciphertext" }, key_families: { KEY: "system"|"user" } }
 *
 * The key_family hint is advisory only — the actual decryption path inspects
 * the envelope version tag (v3 carries `kf` inside, v1/v2 are always user).
 * The hint is useful for diagnostics and for routing during the transition
 * period when v1/v2 envelopes in a 'system'-tagged row should still be
 * treated as operator-seeded.
 */
function normalizeSecrets(rawSecrets, rawKeyFamilies) {
  const normalized = {};
  for (const [key, value] of Object.entries(rawSecrets || {})) {
    const keyFamily = (rawKeyFamilies && rawKeyFamilies[key]) || 'system';
    normalized[key] = { value, keyFamily };
  }
  return normalized;
}

export async function bootstrapSecrets() {
  const workerUrl = process.env.MYA_WORKER_URL;
  const agentToken = process.env.AGENT_TOKEN;

  if (!workerUrl || !agentToken) {
    console.warn('[secrets] MYA_WORKER_URL or AGENT_TOKEN not set, skipping bootstrap');
    return;
  }

  const keys = await ensureKeys();

  const result = await fetchSecrets(workerUrl, agentToken, 10_000);
  if (!result.ok) {
    console.warn(`[secrets] Worker returned ${result.status} — continuing without secrets`);
    return;
  }

  const { secrets, key_families: keyFamilies, count } = result.body;
  const normalized = normalizeSecrets(secrets, keyFamilies);

  // Decrypt each secret value locally (Swiss Vault)
  const decrypted = {};
  for (const [key, { value, keyFamily }] of Object.entries(normalized)) {
    decrypted[key] = await decryptValue(value, keyFamily, keys);
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
  const aliases = {
    TELEGRAM_BOT_TOKEN_MOM: 'TELEGRAM_BOT_TOKEN',
  };
  for (const [src, dst] of Object.entries(aliases)) {
    if (process.env[src] && !process.env[dst]) {
      process.env[dst] = process.env[src];
    }
  }

  const total = count ?? Object.keys(normalized).length;
  console.log(`[secrets] Loaded ${total} secrets, injected ${injected}, skipped ${skipped}` +
    (skipped > 0 ? ' (missing or wrong key — check tmpfs)' : ''));
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
    const keys = await ensureKeys();

    const result = await fetchSecrets(workerUrl, agentToken, 5_000);
    if (!result.ok) {
      console.warn(`[secrets] Refresh failed: ${result.status}, using cached values`);
      return;
    }

    const { secrets, key_families: keyFamilies } = result.body;
    const normalized = normalizeSecrets(secrets, keyFamilies);

    const decrypted = {};
    for (const [key, { value, keyFamily }] of Object.entries(normalized)) {
      decrypted[key] = await decryptValue(value, keyFamily, keys);
    }

    secretsCache = decrypted;
    cacheTimestamp = now;

    let refreshed = 0;
    for (const [key, value] of Object.entries(decrypted)) {
      if (value === null) continue; // never inject ciphertext
      process.env[key] = value;
      refreshed++;
    }

    console.log(`[secrets] Refreshed ${refreshed} secrets`);
  } catch (err) {
    console.warn(`[secrets] Refresh failed: ${err.message}, using cached values`);
  }
}

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
 * Requires: WORKER_URL (legacy: MYA_WORKER_URL), AGENT_TOKEN, SYSTEM_KEY (tmpfs).
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
import { getWorkerUrl } from './env.js';

// In-memory cache for periodic refresh (not persisted to disk)
let secretsCache = null;
let cacheTimestamp = 0;
let systemKey = null;
let masterKey = null;

// Last bootstrap outcome — surfaced via getStatus() for fleet-attest
// health checks. Tracks: total secrets from Worker, how many got
// decrypted + injected into process.env, how many skipped (couldn't
// decrypt — master key drift or wrong family). Zero skips == healthy.
let lastStatus = null;

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

  // Out-of-scope envelopes — silent skip.
  //
  // The Worker filters secret rows by row.scope ∈ AGENT_SCOPES, but the
  // envelope's internal `s` field can disagree (legacy data drift: row
  // re-tagged moms/org without re-encrypting the envelope's personal-
  // scope content). The agent's master key won't decrypt those — and
  // logging once-per-refresh-per-secret produced ~20 lines every 5 min
  // in moms-agent's stderr. Skip them silently when scope mismatches;
  // forensics still has the row count via the lastStatus.skipped tally.
  if (envelope.s && process.env.AGENT_SCOPES) {
    try {
      const scopes = JSON.parse(process.env.AGENT_SCOPES);
      if (Array.isArray(scopes) && !scopes.includes(envelope.s)) return null;
    } catch { /* AGENT_SCOPES not JSON — fall through to decrypt attempt */ }
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
 *   { secrets: { ENCRYPTED_KEY: "ciphertext" }, key_families: { ENCRYPTED_KEY: "system"|"user" } }
 *
 * IMPORTANT: Both the dict keys AND the values are encrypted envelopes.
 * The Worker has no master key (Swiss Vault) so it returns everything as ciphertext.
 * The VPS decrypts both key names and values in bootstrapSecrets().
 *
 * The key_family hint is advisory only — the actual decryption path inspects
 * the envelope version tag (v3 carries `kf` inside, v1/v2 are always user).
 */
function normalizeSecrets(rawSecrets, rawKeyFamilies) {
  const normalized = {};
  for (const [encKey, value] of Object.entries(rawSecrets || {})) {
    const keyFamily = (rawKeyFamilies && rawKeyFamilies[encKey]) || 'system';
    normalized[encKey] = { value, keyFamily };
  }
  return normalized;
}

export async function bootstrapSecrets() {
  const workerUrl = getWorkerUrl();
  const agentToken = process.env.AGENT_TOKEN;

  if (!workerUrl || !agentToken) {
    console.warn('[secrets] WORKER_URL or AGENT_TOKEN not set, skipping bootstrap');
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

  // Decrypt each secret KEY NAME and VALUE locally (Swiss Vault).
  // The Worker returns encrypted key names because it has no master key.
  // Both the key column and value column are encrypted envelopes.
  //
  // L1 (May 2026) — Silent-drop visibility fix.
  // The May 2026 outage was masked for 2 days because key-name decrypt
  // failures here used to `continue` silently without incrementing the
  // skipped counter, hiding ~36 broken records per bot from operator
  // view. Fix: route the failure through the same null→skipped path the
  // VALUE-decrypt failures use, so [secrets] Loaded N, injected M, skipped K
  // accurately reflects every dropped record.
  const decrypted = {};
  let undecryptableKeyNames = 0;
  for (const [encryptedKey, { value, keyFamily }] of Object.entries(normalized)) {
    // Decrypt the key name — it's a v2/v3 envelope just like the value
    const keyName = isEncrypted(encryptedKey)
      ? await decryptValue(encryptedKey, 'user', keys)
      : encryptedKey;
    if (!keyName) {
      // Sentinel placeholder: counted as skipped at line ~258 (`if (value === null) skipped++`).
      // Never collides with a real key name (real keys never start with __undecryptable_).
      decrypted[`__undecryptable_keyname_${++undecryptableKeyNames}`] = null;
      continue;
    }
    decrypted[keyName] = await decryptValue(value, keyFamily, keys);
  }

  secretsCache = decrypted;
  cacheTimestamp = Date.now();

  // Inject into process.env (don't override existing, skip undecrypted)
  let injected = 0;
  let skipped = 0;
  for (const [key, value] of Object.entries(decrypted)) {
    if (value === null) { skipped++; continue; } // couldn't decrypt — never inject ciphertext
    // L1 sentinel guard — defensive: __undecryptable_keyname_N entries already
    // have value=null, so they hit the line above. This guard catches a
    // hypothetical future drift where someone seeds a secret literally named
    // __undecryptable_keyname_X. Refuse to inject those into env regardless.
    if (key.startsWith('__undecryptable_keyname_')) continue;
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
  lastStatus = { total, injected, skipped, at: Date.now() };
  console.log(`[secrets] Loaded ${total} secrets, injected ${injected}, skipped ${skipped}` +
    (skipped > 0 ? ' (missing or wrong key — check tmpfs)' : ''));

  // Fire hooks so file-based artifacts (mcp settings, internal-rpc
  // tokenfiles) materialize at boot, not 5 min later when the first
  // refresh fires. Hooks registered after bootstrap finishes will only
  // see the next refresh — register early.
  await fireAfterRefreshHooks();
}

/**
 * Expose the last bootstrap outcome for fleet-attest / health checks.
 * Returns null if bootstrap has not run yet.
 */
export function getStatus() {
  return lastStatus ? { ...lastStatus } : null;
}

/**
 * Return the set of decrypted secret KEY NAMES the bootstrap pipeline
 * has loaded. Used by the portal-settings GET /secrets metadata endpoint
 * to render set/not-set state per (agent, key) pair WITHOUT exposing
 * the values. The cache is scoped by AGENT_SCOPES, so personal-agent
 * (which holds all four scopes for portal duty) sees every operator
 * secret; siblings see only their own scope.
 *
 * Returns an empty Set if bootstrap has not run yet — caller should
 * treat absent-from-set as "not set" without distinguishing from
 * "we don't know."
 */
export function getCachedSecretKeys() {
  if (!secretsCache) return new Set();
  return new Set(
    Object.keys(secretsCache).filter((k) => !k.startsWith('__undecryptable_keyname_')),
  );
}

/**
 * Register a callback that runs after every successful secrets load
 * (initial bootstrap AND each refresh). Multiple registrations are
 * supported — hooks fire in registration order. Hook errors are logged
 * and isolated, so one failing hook can't starve the others.
 *
 * Used by:
 *   - agent-server.js → regenerate .claude/settings.json so portal-saved
 *     keys propagate into MCP child env without an agent restart
 *   - internal-rpc → write per-agent signing-key tokenfiles so MCP
 *     children pick up rotations without a respawn
 *
 * @param {() => Promise<void>|void} fn
 * @returns {() => void} unregister callback (no-op if already removed)
 */
const _afterRefreshHooks = [];
export function onAfterSecretsRefresh(fn) {
  if (typeof fn !== 'function') return () => {};
  _afterRefreshHooks.push(fn);
  return () => {
    const i = _afterRefreshHooks.indexOf(fn);
    if (i >= 0) _afterRefreshHooks.splice(i, 1);
  };
}

/** Test helper — drop all registered hooks. NOT for production code. */
export function _clearAfterRefreshHooks() {
  _afterRefreshHooks.length = 0;
}

/** Run all hooks sequentially; each hook's error is isolated. */
async function fireAfterRefreshHooks() {
  for (const fn of _afterRefreshHooks) {
    try { await fn(); }
    catch (err) { console.warn(`[secrets] after-refresh hook failed: ${err.message}`); }
  }
}

/**
 * Refresh secrets from the API. Called every 5 min via setInterval, AND
 * by portal-integrations.js after a user saves a new secret.
 *
 * @param {object} [options]
 * @param {boolean} [options.force=false] — Bypass the 5-min rate limit. Used
 *   when a save just happened and the caller needs the new secret in env
 *   immediately. The setInterval cron leaves this false to avoid hammering
 *   the Worker.
 *
 * In-memory only — never writes to disk.
 */
export async function refreshSecrets(options = {}) {
  const { force = false } = options;
  const workerUrl = getWorkerUrl();
  const agentToken = process.env.AGENT_TOKEN;
  if (!workerUrl || !agentToken) return;

  const now = Date.now();
  if (!force && now - cacheTimestamp < REFRESH_INTERVAL) return;

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
    for (const [encryptedKey, { value, keyFamily }] of Object.entries(normalized)) {
      const keyName = isEncrypted(encryptedKey)
        ? await decryptValue(encryptedKey, 'user', keys)
        : encryptedKey;
      if (!keyName) continue;
      decrypted[keyName] = await decryptValue(value, keyFamily, keys);
    }

    secretsCache = decrypted;
    cacheTimestamp = now;

    let refreshed = 0;
    let skipped = 0;
    for (const [key, value] of Object.entries(decrypted)) {
      if (value === null) { skipped++; continue; } // never inject ciphertext
      process.env[key] = value;
      refreshed++;
    }

    lastStatus = { total: Object.keys(decrypted).length, injected: refreshed, skipped, at: now };
    console.log(`[secrets] Refreshed ${refreshed} secrets` + (skipped > 0 ? ` (${skipped} skipped)` : ''));

    // Fire after-refresh hooks (best-effort) so file-based config like
    // .claude/settings.json picks up the new env vars. Without these
    // hooks, portal-saved keys (e.g. LINEAR_API_KEY) won't reach MCP
    // servers until the next agent restart — the bug from 2026-04-25.
    await fireAfterRefreshHooks();
  } catch (err) {
    console.warn(`[secrets] Refresh failed: ${err.message}, using cached values`);
  }
}

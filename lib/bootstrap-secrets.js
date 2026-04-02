/**
 * Bootstrap agent secrets from the centralized secrets API.
 * Call at startup before any other initialization.
 *
 * Requires: MYA_WORKER_URL and AGENT_TOKEN in environment.
 *
 * Failure behavior: throws on startup if Worker is unreachable.
 * Agents must NOT start with stale or missing secrets — fail loud.
 */

// In-memory cache for periodic refresh (not persisted to disk)
let secretsCache = null;
let cacheTimestamp = 0;

// Refresh interval: 5 min. All secrets refreshed together — the Worker
// call is cheap and splitting by category adds complexity for no benefit.
const REFRESH_INTERVAL = 5 * 60 * 1000;

export async function bootstrapSecrets() {
  const workerUrl = process.env.MYA_WORKER_URL;
  const agentToken = process.env.AGENT_TOKEN;

  if (!workerUrl || !agentToken) {
    console.warn("[secrets] MYA_WORKER_URL or AGENT_TOKEN not set, skipping bootstrap");
    return;
  }

  const res = await fetch(`${workerUrl}/api/secrets`, {
    headers: { Authorization: `Bearer ${agentToken}` },
    signal: AbortSignal.timeout(10_000), // 10s timeout
  });

  if (!res.ok) {
    throw new Error(`[secrets] Worker returned ${res.status} — agent cannot start without secrets`);
  }

  const { secrets, count } = await res.json();
  secretsCache = secrets;
  cacheTimestamp = Date.now();

  // Inject into process.env (don't override existing values)
  let injected = 0;
  for (const [key, value] of Object.entries(secrets)) {
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

  console.log(`[secrets] Loaded ${count} secrets, injected ${injected} new env vars`);
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
    const res = await fetch(`${workerUrl}/api/secrets`, {
      headers: { Authorization: `Bearer ${agentToken}` },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      console.warn(`[secrets] Refresh failed: ${res.status}, using cached values`);
      return;
    }

    const { secrets } = await res.json();
    secretsCache = secrets;
    cacheTimestamp = now;

    // Update process.env with new values
    for (const [key, value] of Object.entries(secrets)) {
      process.env[key] = value;
    }

    console.log(`[secrets] Refreshed ${Object.keys(secrets).length} secrets`);
  } catch (err) {
    console.warn(`[secrets] Refresh failed: ${err.message}, using cached values`);
    // Non-fatal on refresh — agent keeps running with cached secrets
  }
}

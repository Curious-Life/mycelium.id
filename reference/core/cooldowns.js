/**
 * Auth Profile Cooldowns
 *
 * Manages cooldowns for API profiles (rate limits, auth failures).
 * Stores state in ~/agents/.shared/cooldowns.json (shared across all agents)
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Shared across all agents
const AGENTS_ROOT = process.env.AGENTS_ROOT || path.join(os.homedir(), 'agents');
const SHARED_DIR = path.join(AGENTS_ROOT, '.shared');
const COOLDOWN_FILE = path.join(SHARED_DIR, 'cooldowns.json');

// In-memory cache
let cooldownCache = null;
let cacheLoadTime = 0;
const CACHE_TTL = 5000; // 5 seconds

/**
 * Load cooldowns from disk (with caching)
 */
async function loadCooldowns() {
  const now = Date.now();
  if (cooldownCache && (now - cacheLoadTime) < CACHE_TTL) {
    return cooldownCache;
  }

  try {
    const data = await fs.readFile(COOLDOWN_FILE, 'utf-8');
    cooldownCache = JSON.parse(data);
    cacheLoadTime = now;
    return cooldownCache;
  } catch {
    cooldownCache = {};
    cacheLoadTime = now;
    return cooldownCache;
  }
}

/**
 * Save cooldowns to disk
 */
async function saveCooldowns(cooldowns) {
  try {
    await fs.mkdir(SHARED_DIR, { recursive: true });
    await fs.writeFile(COOLDOWN_FILE, JSON.stringify(cooldowns, null, 2));
    cooldownCache = cooldowns;
    cacheLoadTime = Date.now();
  } catch (error) {
    console.error('[Cooldowns] Failed to save:', error.message);
  }
}

/**
 * Check if a profile is in cooldown
 * @param {string} profileId - Profile identifier (e.g., 'claude-main', 'openai-backup')
 * @returns {Promise<{ inCooldown: boolean, reason?: string, until?: string }>}
 */
export async function isProfileInCooldown(profileId) {
  const store = await loadCooldowns();
  const entry = store[profileId];

  if (!entry) {
    return { inCooldown: false };
  }

  // Permanently broken (auth/billing issues)
  if (entry.broken) {
    return {
      inCooldown: true,
      reason: entry.reason,
      permanent: true,
      since: entry.at,
    };
  }

  // Temporary cooldown (rate limit)
  if (entry.cooldownUntil && Date.now() < entry.cooldownUntil) {
    return {
      inCooldown: true,
      reason: entry.reason,
      until: new Date(entry.cooldownUntil).toISOString(),
      remaining: entry.cooldownUntil - Date.now(),
    };
  }

  // Cooldown expired
  return { inCooldown: false };
}

/**
 * Mark a profile as failed
 * @param {string} profileId - Profile identifier
 * @param {string} reason - Error reason (from ErrorReason enum)
 * @param {boolean} permanent - Whether this is a permanent failure
 */
export async function markProfileFailure(profileId, reason, permanent = false) {
  const store = await loadCooldowns();

  if (permanent) {
    // Permanent until manual fix (auth/billing)
    store[profileId] = {
      broken: true,
      reason,
      at: Date.now(),
    };
    console.log(`[Cooldowns] Profile ${profileId} marked as BROKEN: ${reason}`);
  } else {
    // Temporary with exponential backoff
    const existing = store[profileId];
    const currentBackoff = existing?.backoffMs || 60000; // Start at 1 min
    const nextBackoff = Math.min(currentBackoff * 2, 3600000); // Max 1 hour

    store[profileId] = {
      cooldownUntil: Date.now() + currentBackoff,
      backoffMs: nextBackoff,
      reason,
      failureCount: (existing?.failureCount || 0) + 1,
    };
    console.log(`[Cooldowns] Profile ${profileId} in cooldown for ${currentBackoff / 1000}s: ${reason}`);
  }

  await saveCooldowns(store);
}

/**
 * Mark a profile as good (clear cooldowns)
 * @param {string} profileId - Profile identifier
 */
export async function markProfileGood(profileId) {
  const store = await loadCooldowns();

  if (store[profileId]) {
    // Only log if there was a previous issue
    if (store[profileId].broken || store[profileId].cooldownUntil) {
      console.log(`[Cooldowns] Profile ${profileId} recovered, clearing cooldown`);
    }
    delete store[profileId];
    await saveCooldowns(store);
  }
}

/**
 * Get all profiles in cooldown (for diagnostics)
 */
export async function getCooldownStatus() {
  const store = await loadCooldowns();
  const result = {};

  for (const [profileId, entry] of Object.entries(store)) {
    if (entry.broken) {
      result[profileId] = {
        status: 'broken',
        reason: entry.reason,
        since: new Date(entry.at).toISOString(),
      };
    } else if (entry.cooldownUntil && Date.now() < entry.cooldownUntil) {
      result[profileId] = {
        status: 'cooldown',
        reason: entry.reason,
        until: new Date(entry.cooldownUntil).toISOString(),
        remaining: Math.round((entry.cooldownUntil - Date.now()) / 1000) + 's',
      };
    }
  }

  return result;
}

/**
 * Reset a profile (manual intervention)
 * @param {string} profileId - Profile identifier
 */
export async function resetProfile(profileId) {
  const store = await loadCooldowns();
  delete store[profileId];
  await saveCooldowns(store);
  console.log(`[Cooldowns] Profile ${profileId} manually reset`);
}

export default {
  isProfileInCooldown,
  markProfileFailure,
  markProfileGood,
  getCooldownStatus,
  resetProfile,
};

/**
 * Portal settings router (Phase 10 PR 7D, Wave 1.2).
 *
 * Owns the user-settings surface:
 *
 *   GET  /portal/settings            — return timezone + settings object
 *   PUT  /portal/settings            — update timezone + vault_name
 *   GET  /portal/settings/secrets    — per-agent set/not-set state for allowed keys
 *   PUT  /portal/settings/secret     — set a per-agent allow-listed bot secret
 *   DELETE /portal/settings/secret   — clear a per-agent allow-listed secret
 *
 * The secret endpoints write to the Worker's encrypted secrets API when
 * available and fall back to `.env` on disk for self-hosted / offline
 * customer VPSes. After writing/deleting a key, the bot processes whose
 * tokens depend on it are best-effort restarted under PM2 so the change
 * takes effect without manual intervention.
 *
 * Allow-list is derived per-agent from {@link allowedKeysForAgent}, which
 * reads agents/*.json's {discord,telegram}BotTokenEnv fields. PM2 restart
 * targets are derived from {@link pmProcessNamesForKey} → the
 * *ProcessName fields. The encryption scope per agent comes from
 * {@link scopeForAgent} reading agents/*.json's memoryScope.
 *
 * Backward compat: legacy callers (ConnectionsChecklist, OnboardingGuide)
 * send `{key, value, scope?}` with no agentId. The router defaults
 * agentId to 'personal-agent', preserving the prior hardcoded behavior.
 *
 * Security:
 *   - Secret values are never returned by GET — only the binary
 *     "is this key set?" bit, derived from the bootstrap-secrets cache.
 *   - The allow-list is computed server-side from declarative agent
 *     metadata; the body's `key` is matched against that list. Keys
 *     not declared in any agent's policy are rejected.
 *   - `agentId` validation closes a confused-deputy class: only known
 *     agents in the operator's fleet can have secrets written for them.
 */

import { Router } from 'express';
import {
  allowedKeysForAgent,
  pmProcessNamesForKey,
  scopeForAgent,
} from '@mycelium/core/agent-secret-policy.js';

/**
 * @typedef {object} CreatePortalSettingsRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {(opts: {key:string, value:string, scope:string, agent:string, description?:string}) => Promise<void>} putEncryptedSecret
 * @property {(opts: {key:string, agent:string}) => Promise<void>} [deleteSecretForAgent] — optional; DELETE returns 503 without it
 * @property {() => Set<string>}  [getCachedSecretKeys] — optional; defaults to empty Set
 * @property {object}             [policy]      — AgentSecretPolicyMap from loadAgentSecretPolicy()
 * @property {string[]}           [knownAgents] — agentIds the operator's fleet recognizes
 * @property {object} config  — { LOG_PREFIX, REPO_ROOT }
 * @property {object} [log]
 */

export function createPortalSettingsRouter(deps) {
  if (!deps) throw new TypeError('createPortalSettingsRouter: deps required');
  const {
    authenticatePortalRequest,
    tryGetDb,
    putEncryptedSecret,
    deleteSecretForAgent,
    getCachedSecretKeys,
    policy,
    knownAgents,
    config,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalSettingsRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalSettingsRouter: tryGetDb required');
  }
  if (typeof putEncryptedSecret !== 'function') {
    throw new TypeError('createPortalSettingsRouter: putEncryptedSecret required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalSettingsRouter: config.LOG_PREFIX required');
  }
  if (!config?.REPO_ROOT) {
    throw new TypeError('createPortalSettingsRouter: config.REPO_ROOT required');
  }

  const { LOG_PREFIX, REPO_ROOT } = config;
  const logger = log || console;
  const router = Router();
  const policyMap = policy || {};
  const agents = Array.isArray(knownAgents) ? knownAgents : [];
  const cachedKeys = typeof getCachedSecretKeys === 'function'
    ? getCachedSecretKeys
    : () => new Set();

  router.get('/portal/settings', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      res.json({ settings: { timezone: user.timezone, ...user.settings } });
    } catch {
      res.status(500).json({ error: 'Failed to load settings' });
    }
  });

  router.put('/portal/settings', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const { timezone, vault_name } = req.body || {};
      if (timezone && typeof timezone === 'string') {
        await db.users?.updateTimezone?.(user.id, timezone);
      }
      if (vault_name !== undefined && typeof vault_name === 'string') {
        const current = await db.users.getSettings(user.id);
        current.vault_name = vault_name.trim().substring(0, 60);
        await db.users.updateSettings(user.id, current);
      }
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  // ── GET /portal/settings/secrets — metadata only, never values ──────────
  router.get('/portal/settings/secrets', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const cache = cachedKeys();
      /** @type {Array<{agentId:string, key:string, set:boolean}>} */
      const out = [];
      for (const agentId of agents) {
        const allowed = allowedKeysForAgent(policyMap, agentId);
        for (const key of allowed) {
          out.push({ agentId, key, set: cache.has(key) });
        }
      }
      res.json({ secrets: out });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] GET /portal/settings/secrets failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to load secret state' });
    }
  });

  router.put('/portal/settings/secret', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { key, value, scope: bodyScope, agentId: bodyAgentId } = req.body || {};
      if (!key || !value) return res.status(400).json({ error: 'key and value required' });

      // Default to personal-agent so legacy callers (ConnectionsChecklist,
      // OnboardingGuide) that don't send agentId continue to work.
      const agentId = bodyAgentId || 'personal-agent';

      // Validate agentId against the operator's fleet. Empty knownAgents
      // (e.g. tests without the dep) skips this check — the allowlist
      // below still gates the request closed.
      if (agents.length > 0 && !agents.includes(agentId)) {
        return res.status(400).json({ error: 'unknown-agent' });
      }

      // Per-agent key allowlist. Keys not in any agent's policy are
      // rejected here; the legacy global allowlist is now derived
      // per-agent from agents/*.json.
      const allowed = allowedKeysForAgent(policyMap, agentId);
      if (!allowed.includes(key)) {
        return res.status(400).json({ error: 'key-not-allowed-for-agent' });
      }

      // Encryption scope: prefer the body's value (legacy compat), then
      // fall back to the agent's memoryScope, then 'personal' (legacy
      // hardcode preserved by scopeForAgent's default).
      const scope = bodyScope || scopeForAgent(policyMap, agentId);

      let saved = false;
      try {
        await putEncryptedSecret({
          key, value,
          scope,
          agent: agentId,
          description: `Set via portal by ${user.id}`,
        });
        saved = true;
        (logger.info ? logger.info.bind(logger) : console.log)(
          `[Settings] Secret saved to Worker: ${key} (agent=${agentId}, scope=${scope})`,
        );
      } catch (e) {
        (logger.warn ? logger.warn.bind(logger) : console.warn)(
          `[Settings] Worker secrets failed (${e.message}), saving to .env`,
        );
        const fs = await import('fs');
        const path = await import('path');
        const envPath = path.join(REPO_ROOT, '.env');
        try {
          let envContent = await fs.promises.readFile(envPath, 'utf-8').catch(() => '');
          const regex = new RegExp(`^${key}=.*$`, 'm');
          if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
          } else {
            envContent += `\n${key}=${value}\n`;
          }
          await fs.promises.writeFile(envPath, envContent);
          process.env[key] = value;
          saved = true;
          (logger.info ? logger.info.bind(logger) : console.log)(`[Settings] Secret saved to .env: ${key}`);
        } catch (fileErr) {
          (logger.error ? logger.error.bind(logger) : console.error)(
            `[Settings] .env write failed: ${fileErr.message}`,
          );
          throw new Error('Failed to save secret');
        }
      }

      // Best-effort PM2 restart for every process whose token depends on
      // this (agent, key). pmProcessNamesForKey returns [] for unknown
      // bindings — no-op. Failure here doesn't fail the request because
      // the secret has already been persisted.
      if (saved) {
        const procNames = pmProcessNamesForKey(policyMap, agentId, key);
        for (const procName of procNames) {
          await pm2RestartBestEffort(procName, REPO_ROOT, logger);
        }
      }

      res.json({ ok: true });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)('[Settings] Secret save error:', e.message);
      res.status(500).json({ error: e.message || 'Failed to save secret' });
    }
  });

  // ── DELETE /portal/settings/secret — clear a per-agent secret ───────────
  router.delete('/portal/settings/secret', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      if (typeof deleteSecretForAgent !== 'function') {
        return res.status(503).json({ error: 'delete not configured' });
      }

      const { key, agentId: bodyAgentId } = req.body || {};
      if (!key) return res.status(400).json({ error: 'key required' });

      const agentId = bodyAgentId || 'personal-agent';
      if (agents.length > 0 && !agents.includes(agentId)) {
        return res.status(400).json({ error: 'unknown-agent' });
      }
      const allowed = allowedKeysForAgent(policyMap, agentId);
      if (!allowed.includes(key)) {
        return res.status(400).json({ error: 'key-not-allowed-for-agent' });
      }

      await deleteSecretForAgent({ key, agent: agentId });
      (logger.info ? logger.info.bind(logger) : console.log)(
        `[Settings] Secret deleted: ${key} (agent=${agentId}, by=${user.id})`,
      );

      // Restart bots that depended on the now-cleared key — they'll
      // refuse to start without a token, surfacing the missing-secret
      // state as an offline bot rather than as stale auth attempts.
      const procNames = pmProcessNamesForKey(policyMap, agentId, key);
      for (const procName of procNames) {
        await pm2RestartBestEffort(procName, REPO_ROOT, logger);
      }

      res.json({ ok: true });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)('[Settings] Secret delete error:', e.message);
      res.status(500).json({ error: e.message || 'Failed to delete secret' });
    }
  });

  (logger.info ? logger.info.bind(logger) : console.log)(
    `[${LOG_PREFIX}] portal-settings-router mounted 5 handlers`,
  );

  return router;
}

/**
 * Best-effort `pm2 delete && pm2 start --only <name>` for a known
 * process. Failure (process not found, PM2 absent in tests) is logged
 * and swallowed — the secret save / delete has already succeeded; the
 * operator can restart manually if PM2 isn't reachable from here.
 */
async function pm2RestartBestEffort(procName, repoRoot, logger) {
  try {
    const { execSync } = await import('child_process');
    const running = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8' });
    let procs;
    try { procs = JSON.parse(running); } catch { procs = []; }
    const exists = procs.find((p) => p.name === procName);

    if (!exists) {
      (logger.info ? logger.info.bind(logger) : console.log)(`[Settings] Starting ${procName}...`);
      execSync(`pm2 start ecosystem.config.cjs --only ${procName} 2>/dev/null`, { cwd: repoRoot });
    } else {
      (logger.info ? logger.info.bind(logger) : console.log)(`[Settings] Restarting ${procName}...`);
      execSync(
        `pm2 delete ${procName} 2>/dev/null; pm2 start ecosystem.config.cjs --only ${procName} 2>/dev/null`,
        { cwd: repoRoot },
      );
    }
  } catch (e) {
    (logger.warn ? logger.warn.bind(logger) : console.warn)(
      `[Settings] PM2 restart of ${procName} failed: ${e.message}`,
    );
  }
}

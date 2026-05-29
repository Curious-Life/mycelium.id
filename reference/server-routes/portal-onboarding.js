/**
 * Portal onboarding router (Phase 10 PR 7E, Wave 3.1).
 *
 * Drives the portal's "welcome / onboarding card" — a checklist surface
 * the UI polls to decide which steps are done. Four handlers plus the
 * 124-LOC readiness computation (computeOnboardingStatus) and a 5-second
 * per-user cache that keeps D1 load bounded under polling.
 *
 *   GET  /portal/onboarding/status        — computed readiness (cached 5s)
 *   POST /portal/onboarding/welcome-seen  — idempotent, marks welcome_shown_at
 *   POST /portal/onboarding/dismiss       — mark dismissed_at
 *   POST /portal/onboarding/reset         — undo dismiss (from Settings)
 *
 * Factory returns `{ router, invalidateCache }` rather than a bare router
 * because portal-uploads also needs to invalidate on message/document
 * ingestion. The cache lives inside this factory's closure (one Map per
 * test; no leakage between test files).
 *
 * computeOnboardingStatus has subtle fallbacks that matter:
 *   - AI connected: falls back to reading Claude OAuth creds file when
 *     no ai_providers row exists (direct Claude Code flow without DB row).
 *   - Messaging connected: falls back to process.env TELEGRAM_BOT_TOKEN /
 *     DISCORD_BOT_TOKEN when the secrets table is empty (self-hosted VPSes
 *     that keep tokens in .env rather than the centralized secrets store).
 */

import fs from 'fs';
import path from 'path';
import { Router } from 'express';

const ONBOARDING_STATUS_TTL_MS = 5_000;

/**
 * @typedef {object} CreatePortalOnboardingRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {object} config  — { LOG_PREFIX, aiReadyFlag (absolute path) }
 * @property {object} [log]
 */

export function createPortalOnboardingRouter(deps) {
  if (!deps) throw new TypeError('createPortalOnboardingRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalOnboardingRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalOnboardingRouter: tryGetDb required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalOnboardingRouter: config.LOG_PREFIX required');
  }
  if (!config?.aiReadyFlag) {
    throw new TypeError('createPortalOnboardingRouter: config.aiReadyFlag required');
  }

  const { LOG_PREFIX, aiReadyFlag } = config;
  const logger = log || console;
  const err = logger.error ? logger.error.bind(logger) : console.error;
  const info = logger.info ? logger.info.bind(logger) : console.log;

  // Per-factory cache — each router instance gets its own, so test runs
  // don't leak state across suites.
  const cache = new Map();

  function invalidateCache(userId) {
    cache.delete(userId);
  }

  // Validate a single claude config dir by reading its .credentials.json.
  // "Connected" means a refresh token is present (CLI can renew) OR the
  // access token is non-expired. Setup-token artifacts (no `user:inference`
  // scope) are treated as NOT connected — they can't power chat.
  async function readClaudeCredsHealth(credDir) {
    try {
      const raw = await fs.promises.readFile(path.join(credDir, '.credentials.json'), 'utf-8');
      const creds = JSON.parse(raw);
      const oauth = creds.claudeAiOauth || {};
      const scopes = Array.isArray(oauth.scopes) ? oauth.scopes : [];
      if (scopes.length && !scopes.includes('user:inference')) {
        return { ok: false, reason: 'quarantined' };
      }
      const hasRefresh = !!oauth.refreshToken;
      const hasValidAccess = oauth.accessToken && (!oauth.expiresAt || oauth.expiresAt > Date.now());
      if (!hasRefresh && !hasValidAccess) {
        return { ok: false, reason: 'expired' };
      }
      return {
        ok: true,
        email: oauth.email || null,
        subscriptionType: oauth.subscriptionType || null,
      };
    } catch {
      return { ok: false, reason: 'missing' };
    }
  }

  async function computeOnboardingStatus(db, userId) {
    const [aiRowsAll, msgRows, docRows, enrichedRows, msgSecrets, territoryRows, userRows] = await Promise.all([
      // Pull every claude row + every active openai/custom row. Don't trust
      // the cached `status` field for claude — the CLI refreshes tokens on
      // disk and can leave a stale 'active' marker after they fail; revalidate
      // by reading the filesystem below.
      db.rawQuery(
        "SELECT provider, label, config_dir, is_active, status FROM ai_providers WHERE user_id = ? ORDER BY is_active DESC, created_at DESC",
        [userId],
      ),
      db.rawQuery('SELECT COUNT(*) as c FROM messages WHERE user_id = ?', [userId]),
      db.rawQuery('SELECT COUNT(*) as c FROM documents WHERE user_id = ?', [userId]),
      db.rawQuery('SELECT COUNT(*) as c FROM messages WHERE user_id = ? AND nlp_processed = 1', [userId]),
      db.rawQuery(
        "SELECT key FROM secrets WHERE user_id = ? AND key IN ('TELEGRAM_BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'WHATSAPP_TOKEN')",
        [userId],
      ),
      db.rawQuery(
        'SELECT COUNT(*) as c FROM clustering_points WHERE user_id = ? AND territory_id IS NOT NULL',
        [userId],
      ),
      db.rawQuery(
        'SELECT welcome_shown_at, onboarding_dismissed_at FROM users WHERE id = ?',
        [userId],
      ),
    ]);

    let aiConnected = false;
    let aiProviderName = null;
    let aiLabelName = null;

    // Pass 1: Claude rows — validate each via filesystem. Active row first.
    for (const row of aiRowsAll.filter(r => r.provider === 'claude')) {
      const dir = row.config_dir || process.env.CLAUDE_CONFIG_DIR
        || path.join(process.env.HOME || '', '.claude');
      const health = await readClaudeCredsHealth(dir);
      if (health.ok) {
        aiConnected = true;
        aiProviderName = 'claude';
        aiLabelName = row.label || (health.subscriptionType
          ? `Claude ${health.subscriptionType}`
          : (health.email || 'Claude'));
        break;
      }
    }

    // Pass 2: non-claude rows — accept the cached status flag (we can't
    // cheaply revalidate without making real API calls).
    if (!aiConnected) {
      const activeNonClaude = aiRowsAll.find(
        r => r.provider !== 'claude' && r.is_active && r.status === 'active',
      );
      if (activeNonClaude) {
        aiConnected = true;
        aiProviderName = activeNonClaude.provider;
        aiLabelName = activeNonClaude.label || null;
      }
    }

    // Pass 3: filesystem fallback for the default CLAUDE_CONFIG_DIR — covers
    // the "user ran `claude auth login` outside the portal, no DB row" case.
    if (!aiConnected) {
      const defaultDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude');
      const health = await readClaudeCredsHealth(defaultDir);
      if (health.ok) {
        aiConnected = true;
        aiProviderName = 'claude';
        aiLabelName = health.subscriptionType ? `Claude ${health.subscriptionType}` : (health.email || 'Claude Code');
      }
    }

    let messagingChannels = msgSecrets.map((r) =>
      r.key.replace('_BOT_TOKEN', '').replace('_TOKEN', '').toLowerCase(),
    );
    if (messagingChannels.length === 0) {
      if (process.env.TELEGRAM_BOT_TOKEN) messagingChannels.push('telegram');
      if (process.env.DISCORD_BOT_TOKEN) messagingChannels.push('discord');
    }

    const messageCount = msgRows[0]?.c || 0;
    const documentCount = docRows[0]?.c || 0;
    const enrichedCount = enrichedRows[0]?.c || 0;
    const dataUploaded = messageCount >= 10 || documentCount >= 1;
    const messagingConnected = messagingChannels.length > 0;
    const territoryPointCount = territoryRows[0]?.c || 0;
    const myceliumGenerated = territoryPointCount > 0;
    const welcomeShownAt = userRows[0]?.welcome_shown_at || null;
    const dismissedAt = userRows[0]?.onboarding_dismissed_at || null;

    const allStepsDone = aiConnected && dataUploaded && messagingConnected;
    const showCard = !dismissedAt && !allStepsDone;
    const showWelcome = !welcomeShownAt;

    return {
      show: showCard,
      showWelcome,
      dismissed: !!dismissedAt,
      allStepsDone,
      steps: {
        ai: { done: aiConnected, provider: aiProviderName, label: aiLabelName },
        data: {
          done: dataUploaded,
          messageCount,
          documentCount,
          enrichedCount,
          enrichmentPending: Math.max(0, messageCount - enrichedCount),
        },
        messaging: { done: messagingConnected, channels: messagingChannels },
      },
      mycelium: { generated: myceliumGenerated, territoryPointCount },
      aiModelsReady: fs.existsSync(aiReadyFlag),
    };
  }

  const router = Router();

  router.get('/portal/onboarding/status', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const cached = cache.get(user.id);
      if (cached && cached.expiresAt > Date.now()) {
        return res.json(cached.data);
      }

      const data = await computeOnboardingStatus(db, user.id);
      cache.set(user.id, { data, expiresAt: Date.now() + ONBOARDING_STATUS_TTL_MS });

      if (cache.size > 1000) {
        const now = Date.now();
        for (const [k, v] of cache.entries()) {
          if (v.expiresAt < now) cache.delete(k);
        }
      }

      res.json(data);
    } catch (e) {
      err(`[${LOG_PREFIX}] [onboarding/status] ${e.message}`);
      res.status(500).json({ error: 'Failed to load onboarding status' });
    }
  });

  router.post('/portal/onboarding/welcome-seen', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      await db.rawQuery(
        "UPDATE users SET welcome_shown_at = datetime('now') WHERE id = ? AND welcome_shown_at IS NULL",
        [user.id],
      );
      invalidateCache(user.id);
      res.json({ ok: true });
    } catch (e) {
      err(`[${LOG_PREFIX}] [onboarding/welcome-seen] ${e.message}`);
      res.status(500).json({ error: 'Failed to mark welcome as seen' });
    }
  });

  router.post('/portal/onboarding/dismiss', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      await db.rawQuery(
        "UPDATE users SET onboarding_dismissed_at = datetime('now') WHERE id = ?",
        [user.id],
      );
      invalidateCache(user.id);
      res.json({ ok: true });
    } catch (e) {
      err(`[${LOG_PREFIX}] [onboarding/dismiss] ${e.message}`);
      res.status(500).json({ error: 'Failed to dismiss onboarding' });
    }
  });

  router.post('/portal/onboarding/reset', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      await db.rawQuery(
        'UPDATE users SET onboarding_dismissed_at = NULL WHERE id = ?',
        [user.id],
      );
      invalidateCache(user.id);
      res.json({ ok: true });
    } catch (e) {
      err(`[${LOG_PREFIX}] [onboarding/reset] ${e.message}`);
      res.status(500).json({ error: 'Failed to reset onboarding' });
    }
  });

  info(`[${LOG_PREFIX}] portal-onboarding-router mounted 4 handlers`);

  return { router, invalidateCache };
}

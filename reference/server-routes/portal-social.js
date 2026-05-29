/**
 * Portal social router (Phase 10 PR 7D, Wave 1.3).
 *
 * Thin surface for user-managed social integrations the portal exposes
 * today. Currently only Telegram group authorization:
 *
 *   GET    /portal/telegram/groups        — list authorized groups
 *   DELETE /portal/telegram/groups/:id    — revoke a group
 *
 * The underlying `db.telegramGroups` namespace is optional — a self-hosted
 * VPS without telegram tables should soft-fail (empty list / 503), not
 * crash the whole portal. The GET endpoint therefore returns an empty
 * list when the table is missing; DELETE is stricter (returns 503).
 */

import { Router } from 'express';

/**
 * @typedef {object} CreatePortalSocialRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {object} config  — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalSocialRouter(deps) {
  if (!deps) throw new TypeError('createPortalSocialRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalSocialRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalSocialRouter: tryGetDb required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalSocialRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const router = Router();

  router.get('/portal/telegram/groups', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.telegramGroups) return res.json({ groups: [] });
      const groups = await db.telegramGroups.list(user.id);
      res.json({ groups });
    } catch {
      res.status(500).json({ error: 'Failed to load groups' });
    }
  });

  router.delete('/portal/telegram/groups/:id', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.telegramGroups) return res.status(503).json({ error: 'Database not available' });
      await db.telegramGroups.revoke(req.params.id);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to revoke group' });
    }
  });

  (logger.info ? logger.info.bind(logger) : console.log)(
    `[${LOG_PREFIX}] portal-social-router mounted 2 handlers`
  );

  return router;
}

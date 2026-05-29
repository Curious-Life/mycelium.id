/**
 * Portal contexts router (Phase 10 PR 7E, Wave 1.2).
 *
 * Social-sharing Phase 3: multi-faceted identity. A "context" is a named
 * bundle of territories (mindscape regions) the user chooses to expose
 * to a subset of their connections. Nine CRUD handlers:
 *
 *   GET    /portal/contexts                                  — list
 *   POST   /portal/contexts                                  — create
 *   PUT    /portal/contexts/:id                              — rename
 *   DELETE /portal/contexts/:id                              — delete
 *   POST   /portal/contexts/:id/territories/:tid             — add territory
 *   DELETE /portal/contexts/:id/territories/:tid             — remove territory
 *   POST   /portal/contexts/:id/grant/:connId                — grant access
 *   DELETE /portal/contexts/:id/grant/:connId                — revoke access
 *   GET    /portal/contexts/:id/territories                  — list territories
 *   GET    /portal/contexts/:id/connections                  — list grants
 *
 * All handlers require a valid portal session. `db.contexts` is optional
 * (self-hosted DBs without the sharing schema) — GETs soft-fail to empty
 * lists; mutations return 503.
 */

import { Router } from 'express';

/**
 * @typedef {object} CreatePortalContextsRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {(err: Error, fallback?: string) => string} safeError
 * @property {object} config  — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalContextsRouter(deps) {
  if (!deps) throw new TypeError('createPortalContextsRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, safeError, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalContextsRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalContextsRouter: tryGetDb required');
  }
  if (typeof safeError !== 'function') {
    throw new TypeError('createPortalContextsRouter: safeError required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalContextsRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const info = logger.info ? logger.info.bind(logger) : console.log;

  const router = Router();

  router.get('/portal/contexts', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.contexts) return res.json({ contexts: [] });
      const contexts = await db.contexts.list(user.id);
      res.json({ contexts });
    } catch {
      res.status(500).json({ error: 'Failed to load contexts' });
    }
  });

  router.post('/portal/contexts', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.contexts) return res.status(503).json({ error: 'Database not available' });
      const { name, is_private } = req.body || {};
      const id = await db.contexts.create(user.id, { name, is_private });
      res.json({ id, ok: true });
    } catch (e) {
      res.status(400).json({ error: safeError(e, 'Failed to create context') });
    }
  });

  router.put('/portal/contexts/:id', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.contexts) return res.status(503).json({ error: 'Database not available' });
      await db.contexts.rename(user.id, req.params.id, req.body?.name);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: safeError(e, 'Failed to rename context') });
    }
  });

  router.delete('/portal/contexts/:id', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.contexts) return res.status(503).json({ error: 'Database not available' });
      await db.contexts.remove(user.id, req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: safeError(e, 'Failed to delete context') });
    }
  });

  router.post('/portal/contexts/:id/territories/:tid', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.contexts) return res.status(503).json({ error: 'Database not available' });
      await db.contexts.addTerritory(req.params.id, parseInt(req.params.tid, 10));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: safeError(e, 'Failed to add territory') });
    }
  });

  router.delete('/portal/contexts/:id/territories/:tid', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.contexts) return res.status(503).json({ error: 'Database not available' });
      await db.contexts.removeTerritory(req.params.id, parseInt(req.params.tid, 10));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: safeError(e, 'Failed to remove territory') });
    }
  });

  router.post('/portal/contexts/:id/grant/:connId', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.contexts) return res.status(503).json({ error: 'Database not available' });
      await db.contexts.grant(req.params.id, req.params.connId);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: safeError(e, 'Failed to grant access') });
    }
  });

  router.delete('/portal/contexts/:id/grant/:connId', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.contexts) return res.status(503).json({ error: 'Database not available' });
      await db.contexts.revoke(req.params.id, req.params.connId);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: safeError(e, 'Failed to revoke access') });
    }
  });

  router.get('/portal/contexts/:id/territories', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.contexts) return res.json({ territories: [] });
      const territories = await db.contexts.getTerritories(req.params.id);
      res.json({ territories });
    } catch {
      res.status(500).json({ error: 'Failed to load territories' });
    }
  });

  router.get('/portal/contexts/:id/connections', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.contexts) return res.json({ grants: [] });
      const grants = await db.contexts.getGrants(req.params.id);
      res.json({ grants });
    } catch {
      res.status(500).json({ error: 'Failed to load grants' });
    }
  });

  info(`[${LOG_PREFIX}] portal-contexts-router mounted 10 handlers`);

  return router;
}

/**
 * Portal connections router (Phase 10 PR 7E, Wave 1.1).
 *
 * Social-sharing Phase 2 surface: user-to-user connection requests
 * across the Mycelium fleet. Eleven handlers covering the full CRUD
 * of the `connections` graph:
 *
 *   POST   /portal/connections/request         — send a request to @handle
 *   GET    /portal/connections/count           — pending count (cheap)
 *   GET    /portal/connections/pending         — inbox of pending requests
 *   GET    /portal/connections/sent            — outbox of pending requests
 *   GET    /portal/connections                 — active connections
 *   POST   /portal/connections/:id/accept      — accept a pending request
 *   POST   /portal/connections/:id/reject      — reject a pending request
 *   POST   /portal/connections/:id/block       — block a connection
 *   DELETE /portal/connections/:id             — disconnect
 *   GET    /portal/connections/:id/overlap     — semantic overlap summary
 *
 * Notes on extraction (bugs folded in):
 *   - Pre-extraction, six handlers (count / accept / reject / block /
 *     disconnect / overlap) referenced a bare `db` identifier with no
 *     enclosing `const db = tryGetDb()`. There is no module-level
 *     `db` in agent-server.js, so every call threw a silent
 *     `ReferenceError` that the try/catch blocks swallowed as a generic
 *     400. In practice these endpoints had been returning "Failed to …"
 *     to the portal for an unknown period. Fixed here by calling
 *     tryGetDb() up front and returning 503 when absent.
 *   - `sendConnectionEmail` is optional — when the dep is absent (tests,
 *     self-hosted without outbound mail) the POST still succeeds.
 */

import { Router } from 'express';

/**
 * @typedef {object} CreatePortalConnectionsRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {(err: Error, fallback?: string) => string} safeError
 * @property {(toHandle: string, fromHandle: string, message?: string) => Promise<any>} [sendConnectionEmail]
 * @property {object} config  — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalConnectionsRouter(deps) {
  if (!deps) throw new TypeError('createPortalConnectionsRouter: deps required');
  const {
    authenticatePortalRequest,
    tryGetDb,
    safeError,
    sendConnectionEmail,
    config,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalConnectionsRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalConnectionsRouter: tryGetDb required');
  }
  if (typeof safeError !== 'function') {
    throw new TypeError('createPortalConnectionsRouter: safeError required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalConnectionsRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const warn = logger.warn ? logger.warn.bind(logger) : console.warn;
  const err = logger.error ? logger.error.bind(logger) : console.error;
  const info = logger.info ? logger.info.bind(logger) : console.log;

  const router = Router();

  router.post('/portal/connections/request', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const { toHandle, message } = req.body || {};
      if (!toHandle) return res.status(400).json({ error: 'toHandle required' });
      const cleanHandle = String(toHandle).replace(/^@/, '');
      const db = tryGetDb();
      if (!db?.connections) return res.status(503).json({ error: 'Database not available' });

      let id;
      try {
        id = await db.connections.request(user.id, cleanHandle);
      } catch (reqErr) {
        if (reqErr?.message === 'Request already pending') {
          info(`[${LOG_PREFIX}] [Connections] Already pending: ${cleanHandle}`);
          return res.json({ ok: true, status: 'already_pending' });
        }
        throw reqErr;
      }

      info(`[${LOG_PREFIX}] [Connections] Request created: ${cleanHandle} (${id})`);
      if (typeof sendConnectionEmail === 'function') {
        const fromProfile = await db.profiles?.get(user.id).catch(() => null);
        sendConnectionEmail(cleanHandle, fromProfile?.handle || 'someone', message).catch((e) => {
          warn(`[${LOG_PREFIX}] [Connections] Email send error: ${e.message}`);
        });
      }

      res.json({ id, ok: true });
    } catch (e) {
      err(`[${LOG_PREFIX}] [Connections] Request error: ${e.message}`);
      res.status(400).json({ error: safeError(e, 'Connection request failed') });
    }
  });

  router.get('/portal/connections/count', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.connections) return res.json({ pending: 0 });
      const pending = await db.connections.pending(user.id);
      res.json({ pending: pending.length });
    } catch {
      res.json({ pending: 0 });
    }
  });

  router.get('/portal/connections/pending', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.connections) return res.json({ requests: [] });
      const requests = await db.connections.pending(user.id);
      res.json({ requests });
    } catch (e) {
      err(`[${LOG_PREFIX}] [Connections] Pending error: ${e.message}`);
      res.status(500).json({ error: 'Failed to load requests' });
    }
  });

  router.get('/portal/connections/sent', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.connections) return res.json({ sent: [] });
      const sent = await db.connections.sent(user.id);
      res.json({ sent });
    } catch {
      res.status(500).json({ error: 'Failed to load sent requests' });
    }
  });

  router.get('/portal/connections', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.connections) return res.json({ connections: [] });
      const connections = await db.connections.list(user.id);
      res.json({ connections });
    } catch (e) {
      err(`[${LOG_PREFIX}] [Connections] List error: ${e.message}`);
      res.status(500).json({ error: 'Failed to load connections' });
    }
  });

  router.post('/portal/connections/:id/accept', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.connections) return res.status(503).json({ error: 'Database not available' });
      await db.connections.accept(user.id, req.params.id);
      res.json({ ok: true });
    } catch (e) {
      err(`[${LOG_PREFIX}] [Connections] Accept error: ${e.message}`);
      res.status(400).json({ error: safeError(e, 'Failed to accept connection') });
    }
  });

  router.post('/portal/connections/:id/reject', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.connections) return res.status(503).json({ error: 'Database not available' });
      await db.connections.reject(user.id, req.params.id);
      res.json({ ok: true });
    } catch (e) {
      err(`[${LOG_PREFIX}] [Connections] Reject error: ${e.message}`);
      res.status(400).json({ error: safeError(e, 'Failed to reject connection') });
    }
  });

  router.post('/portal/connections/:id/block', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.connections) return res.status(503).json({ error: 'Database not available' });
      await db.connections.block(user.id, req.params.id);
      res.json({ ok: true });
    } catch (e) {
      err(`[${LOG_PREFIX}] [Connections] Block error: ${e.message}`);
      res.status(400).json({ error: safeError(e, 'Failed to block connection') });
    }
  });

  router.delete('/portal/connections/:id', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.connections) return res.status(503).json({ error: 'Database not available' });
      await db.connections.disconnect(user.id, req.params.id);
      res.json({ ok: true });
    } catch (e) {
      err(`[${LOG_PREFIX}] [Connections] Disconnect error: ${e.message}`);
      res.status(400).json({ error: safeError(e, 'Failed to disconnect') });
    }
  });

  router.get('/portal/connections/:id/overlap', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.connections) return res.status(503).json({ error: 'Database not available' });
      const overlap = await db.connections.computeOverlap(user.id, req.params.id);
      res.json({ overlap });
    } catch (e) {
      err(`[${LOG_PREFIX}] [Connections] Overlap error: ${e.message}`);
      res.status(400).json({ error: safeError(e, 'Failed to compute overlap') });
    }
  });

  info(`[${LOG_PREFIX}] portal-connections-router mounted 10 handlers`);

  return router;
}

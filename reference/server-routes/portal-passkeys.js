/**
 * Portal passkey management router (Phase 10 PR 7A).
 *
 * WebAuthn credential lifecycle for authenticated portal users. All
 * endpoints require BOTH the worker secret (socket-level gate) AND a
 * valid portal session — passkey operations touch the root of the
 * auth system, so defense-in-depth matters.
 *
 *   GET    /portal/passkeys                       — list user credentials
 *   POST   /portal/passkeys/register/options      — issue registration challenge
 *   POST   /portal/passkeys/register/verify       — verify attestation + store
 *   POST   /portal/passkeys/rename                — relabel a passkey
 *   DELETE /portal/passkeys/:id                   — delete (blocked on last one)
 */

import { Router } from 'express';

/**
 * @typedef {object} CreatePortalPasskeysRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {(req: any, res: any) => boolean}    requireWorkerSecret
 * @property {() => object|null}                  tryGetDb
 * @property {() => Promise<object>}              getAuthModule
 * @property {object} [log]
 */

export function createPortalPasskeysRouter(deps) {
  if (!deps) throw new TypeError('createPortalPasskeysRouter: deps required');
  const {
    authenticatePortalRequest,
    requireWorkerSecret,
    tryGetDb,
    getAuthModule,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalPasskeysRouter: authenticatePortalRequest required');
  }
  if (typeof requireWorkerSecret !== 'function') {
    throw new TypeError('createPortalPasskeysRouter: requireWorkerSecret required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalPasskeysRouter: tryGetDb required');
  }
  if (typeof getAuthModule !== 'function') {
    throw new TypeError('createPortalPasskeysRouter: getAuthModule required');
  }

  const logger = log || console;
  const router = Router();

  // ── GET /portal/passkeys ────────────────────────────────────────────
  router.get('/portal/passkeys', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      const passkeys = await db.passkeys.listForManagement(user.id);
      res.json({ passkeys });
    } catch (e) {
      logger.error?.('[Passkeys] List failed:', e.message);
      res.status(500).json({ error: 'Failed to list passkeys' });
    }
  });

  // ── POST /portal/passkeys/register/options ──────────────────────────
  router.post('/portal/passkeys/register/options', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const auth = await getAuthModule();
      // Generate registration options for adding a new passkey to an existing
      // account. Pass null for registrationCode, userId as second param.
      const result = await auth.generateRegOptions(null, user.id);
      res.json({ options: result.options, challengeKey: result.challengeKey });
    } catch (e) {
      logger.error?.('[Passkeys] Register options failed:', e.message);
      res.status(500).json({ error: 'Failed to generate registration options' });
    }
  });

  // ── POST /portal/passkeys/register/verify ───────────────────────────
  router.post('/portal/passkeys/register/verify', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const { credential, name, challengeKey } = req.body;
      if (!credential || !challengeKey) {
        return res.status(400).json({ error: 'Missing credential or challengeKey' });
      }
      const auth = await getAuthModule();
      const result = await auth.verifyReg(null, credential, null, challengeKey);
      if (name && result.credentialId) {
        const db = tryGetDb();
        const stored = await db?.passkeys?.getByCredentialId(result.credentialId);
        if (stored) await db.passkeys.rename(stored.id, user.id, name.substring(0, 100));
      }
      tryGetDb()?.audit.log({
        action: 'passkey.register',
        userId: user.id,
        ip: req.ip,
        resourceType: 'passkey',
      }).catch(() => {});
      res.json({ ok: true });
    } catch (e) {
      logger.error?.('[Passkeys] Register verify failed:', e.message);
      res.status(400).json({ error: e.message || 'Registration failed' });
    }
  });

  // ── POST /portal/passkeys/rename ────────────────────────────────────
  router.post('/portal/passkeys/rename', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const { id, name } = req.body;
      if (!id || !name) return res.status(400).json({ error: 'id and name required' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      await db.passkeys.rename(id, user.id, name.substring(0, 100));
      res.json({ ok: true });
    } catch (e) {
      logger.error?.('[Passkeys] Rename failed:', e.message);
      res.status(500).json({ error: 'Failed to rename passkey' });
    }
  });

  // ── DELETE /portal/passkeys/:id ─────────────────────────────────────
  router.delete('/portal/passkeys/:id', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });
      // Never delete the last passkey — user would be locked out.
      const count = await db.passkeys.countByUser(user.id);
      if (count <= 1) return res.status(400).json({ error: 'Cannot delete your only passkey' });
      const deleted = await db.passkeys.delete(req.params.id, user.id);
      if (!deleted) return res.status(404).json({ error: 'Passkey not found' });
      tryGetDb()?.audit.log({
        action: 'passkey.delete',
        userId: user.id,
        ip: req.ip,
        resourceType: 'passkey',
        details: { passkeyId: req.params.id },
      }).catch(() => {});
      res.json({ ok: true });
    } catch (e) {
      logger.error?.('[Passkeys] Delete failed:', e.message);
      res.status(500).json({ error: 'Failed to delete passkey' });
    }
  });

  logger.info?.('[portal-passkeys-router] mounted 5 handlers');
  return router;
}

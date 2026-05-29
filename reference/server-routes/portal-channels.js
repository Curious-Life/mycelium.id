/**
 * Portal channel-authority router.
 *
 * Single owner of the Channel Authority Registry mutations. The registry
 * lives in agent-server's process memory (per-agent JSON file at
 * paths.memory.channels). This router exposes its mutations to:
 *   - the portal UI (settings page Channel Authority section), via portal
 *     session auth
 *   - the Telegram + Discord bots (loopback), via WORKER_SECRET
 *
 * Endpoints:
 *
 *   GET    /portal/channels                 — list channels + global state
 *   PATCH  /portal/channels/global          — { autonomousGlobalEnabled }
 *   POST   /portal/channels                 — { kind, id, label, allowAutonomous?, member? }
 *                                              upsert (records the channel; if
 *                                              telegram-group, also writes
 *                                              telegram_groups for legacy)
 *   PATCH  /portal/channels/:kind/:id       — { allowAutonomous?, label? }
 *   DELETE /portal/channels/:kind/:id       — soft-disable + (telegram-group)
 *                                              revoke in telegram_groups
 *
 * The bots' operator-command handlers (`/allow`, `/disallow`, `/channels`)
 * call into these endpoints via loopback. This keeps the registry's write
 * path single-owner — no two-process race on channels.json.
 */

import { Router } from 'express';

/**
 * @typedef {object} CreatePortalChannelsRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {(req: any, res: any) => boolean}    requireWorkerSecret
 * @property {() => object|null}                  tryGetDb
 * @property {() => object}                       getRegistry
 * @property {object} config                       — { LOG_PREFIX }
 * @property {(canonicalUserId: string) => Promise<string>} [getCanonicalUserId]
 *   Optional override for resolving authorized_by on /allow inserts; if
 *   omitted, the router does not write to telegram_groups (the bot's own
 *   command path handles that for backwards compat).
 * @property {object} [log]
 */

export function createPortalChannelsRouter(deps) {
  if (!deps) throw new TypeError('createPortalChannelsRouter: deps required');
  const {
    authenticatePortalRequest,
    requireWorkerSecret,
    tryGetDb,
    getRegistry,
    config,
    getCanonicalUserId,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalChannelsRouter: authenticatePortalRequest required');
  }
  if (typeof requireWorkerSecret !== 'function') {
    throw new TypeError('createPortalChannelsRouter: requireWorkerSecret required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalChannelsRouter: tryGetDb required');
  }
  if (typeof getRegistry !== 'function') {
    throw new TypeError('createPortalChannelsRouter: getRegistry required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalChannelsRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const router = Router();

  /**
   * Auth gate accepting either a portal session OR a same-host worker
   * secret. The portal UI uses the cookie; bots on loopback use the
   * Authorization: Bearer <WORKER_SECRET> header. Returns false (and
   * sends 401/403 itself) when neither is valid.
   */
  async function authOk(req, res) {
    // Worker secret first — fast path for bot loopback callers, no D1.
    if (requireWorkerSecret(req, res)) return true;
    // requireWorkerSecret may have written a 403; if not, try portal auth.
    if (res.headersSent) return false;
    const user = await authenticatePortalRequest(req);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
    return true;
  }

  // ── GET /portal/channels ──────────────────────────────────────────────

  router.get('/portal/channels', async (req, res) => {
    if (!(await authOk(req, res))) return;
    try {
      const reg = getRegistry();
      const state = reg.getState();
      res.json({
        agentId: state.agentId,
        autonomousGlobalEnabled: state.autonomousGlobalEnabled !== false,
        channels: state.channels.filter((c) => c.active !== false),
        updatedAt: state.updatedAt,
      });
    } catch (err) {
      logger.error?.(`[${LOG_PREFIX}] portal-channels GET failed: ${err.message}`);
      res.status(500).json({ error: 'Failed to load channels' });
    }
  });

  // ── PATCH /portal/channels/global ─────────────────────────────────────

  router.patch('/portal/channels/global', async (req, res) => {
    if (!(await authOk(req, res))) return;
    const { autonomousGlobalEnabled } = req.body || {};
    if (typeof autonomousGlobalEnabled !== 'boolean') {
      return res.status(400).json({ error: 'autonomousGlobalEnabled must be boolean' });
    }
    try {
      const reg = getRegistry();
      const result = reg.setGlobalAutonomous(autonomousGlobalEnabled);
      await reg.flushToDisk();
      res.json(result);
    } catch (err) {
      logger.error?.(`[${LOG_PREFIX}] portal-channels PATCH /global failed: ${err.message}`);
      res.status(500).json({ error: 'Failed to update global flag' });
    }
  });

  // ── POST /portal/channels ─────────────────────────────────────────────
  // Upsert. For telegram-group, also writes telegram_groups so legacy
  // /allow -in-group flow stays in sync with the registry.

  router.post('/portal/channels', async (req, res) => {
    if (!(await authOk(req, res))) return;
    const { kind, id, label, allowAutonomous, parentId, member, learnedFrom, spaceId } = req.body || {};
    if (!kind || id == null) {
      return res.status(400).json({ error: 'kind + id required' });
    }
    try {
      const reg = getRegistry();
      const rec = reg.record({
        kind,
        id: String(id),
        label,
        parentId,
        learnedFrom: learnedFrom || 'runtime',
        ...(allowAutonomous !== undefined ? { allowAutonomous } : {}),
        ...(member ? { member } : {}),
      });
      await reg.flushToDisk();

      // Legacy parity: a telegram-group written here should also land in
      // the telegram_groups D1 table so prior callsites that still query
      // it (and tooling) see consistent state.
      if (kind === 'telegram-group') {
        const db = tryGetDb();
        if (db?.telegramGroups?.authorize && getCanonicalUserId) {
          try {
            const userId = await getCanonicalUserId();
            await db.telegramGroups.authorize(
              String(id),
              label || null,
              spaceId || null,
              userId,
            );
          } catch (err) {
            logger.warn?.(
              `[${LOG_PREFIX}] portal-channels: telegram_groups.authorize failed (${err.message}); registry already updated`,
            );
          }
        }
      }

      res.json({ ok: true, channel: rec });
    } catch (err) {
      const status = err instanceof TypeError ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // ── PATCH /portal/channels/:kind/:id ──────────────────────────────────

  router.patch('/portal/channels/:kind/:id', async (req, res) => {
    if (!(await authOk(req, res))) return;
    const { kind, id } = req.params;
    const { allowAutonomous, label } = req.body || {};

    if (allowAutonomous === undefined && label === undefined) {
      return res.status(400).json({ error: 'allowAutonomous or label required' });
    }

    try {
      const reg = getRegistry();
      // Channel must exist before patch.
      const existing = reg.get({ kind, id });
      if (!existing) return res.status(404).json({ error: 'channel-not-found' });

      if (typeof allowAutonomous === 'boolean') {
        const r = reg.setAutonomous({ kind, id, allowAutonomous });
        if (!r.ok) {
          // cannot-disallow-operator-dm is the most common reason.
          return res.status(409).json({ error: r.reason });
        }
      }
      if (typeof label === 'string' && label.trim() !== '') {
        const r = reg.setLabel({ kind, id, label: label.trim() });
        if (!r.ok) return res.status(409).json({ error: r.reason });
      }

      await reg.flushToDisk();
      res.json({ ok: true, channel: reg.get({ kind, id }) });
    } catch (err) {
      logger.error?.(`[${LOG_PREFIX}] portal-channels PATCH ${kind}/${id} failed: ${err.message}`);
      res.status(500).json({ error: 'Failed to update channel' });
    }
  });

  // ── DELETE /portal/channels/:kind/:id ─────────────────────────────────

  router.delete('/portal/channels/:kind/:id', async (req, res) => {
    if (!(await authOk(req, res))) return;
    const { kind, id } = req.params;
    try {
      const reg = getRegistry();
      const result = reg.disable({ kind, id });
      await reg.flushToDisk();

      // Mirror in legacy table for telegram-group revocations so the
      // /allow flow's `db.telegramGroups.get()` gate stays consistent.
      if (kind === 'telegram-group') {
        const db = tryGetDb();
        if (db?.telegramGroups?.revoke) {
          await db.telegramGroups.revoke(String(id)).catch((err) => {
            logger.warn?.(
              `[${LOG_PREFIX}] portal-channels: telegram_groups.revoke failed (${err.message}); registry already disabled`,
            );
          });
        }
      }

      // disable returns { ok: false, reason: 'not-found' } when missing —
      // treat that as 404 for the API surface but keep the registry in a
      // consistent state regardless.
      if (!result.ok && result.reason === 'not-found') {
        return res.status(404).json({ error: 'not-found' });
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error?.(`[${LOG_PREFIX}] portal-channels DELETE ${kind}/${id} failed: ${err.message}`);
      res.status(500).json({ error: 'Failed to remove channel' });
    }
  });

  (logger.info ? logger.info.bind(logger) : console.log)(
    `[${LOG_PREFIX}] portal-channels-router mounted 5 handlers`,
  );

  return router;
}

/**
 * Portal fleet router — owner-only views into the multi-VPS fleet.
 *
 * Four endpoints, all locked down to the admin/operator VPS + the
 * configured owner account. No tenant VPS can ever see fleet data.
 *
 *   GET /portal/fleet/status                  — roll-up of all VPS states
 *   GET /portal/fleet/vps/:handle/history     — detailed check history
 *   GET /portal/fleet/guardians               — Worker-side guardian snapshot
 *                                               (metrics + scrubbed denies)
 *   GET /portal/fleet/gate                    — "can I see fleet data?"
 *                                               cheap probe the UI uses to
 *                                               decide whether to render
 *
 * Auth pipeline (fail-closed, checked in order):
 *   1. Portal session cookie → authenticatePortalRequest returns user
 *   2. OWNER_USER_ID env MUST be set (this is the operator distinguisher
 *      — tenant VPSes never have this configured)
 *   3. user.id MUST match OWNER_USER_ID (exact string equality)
 *
 * If OWNER_USER_ID is absent: tenant VPS or misconfigured operator —
 * either way, refuse. Fail-closed over trying to guess.
 *
 * ADMIN_SECRET never leaves the server — Worker-side Bearer header is
 * attached server-side, the client only sees a portal cookie.
 *
 * No fleet-report content (failure messages, metadata) is echoed back
 * with user-controlled strings, so no XSS surface beyond what the
 * Worker already vetted. `handle` is regex-validated before being
 * URL-encoded for the upstream call.
 */

import { Router } from 'express';
import { getWorkerUrl } from '@mycelium/core/env.js';

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * @typedef {object} CreatePortalFleetRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {(err: any, fallback?: string) => string} safeError
 * @property {object} [log]
 */

export function createPortalFleetRouter(deps) {
  if (!deps) throw new TypeError('createPortalFleetRouter: deps required');
  const { authenticatePortalRequest, safeError, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalFleetRouter: authenticatePortalRequest required');
  }
  if (typeof safeError !== 'function') {
    throw new TypeError('createPortalFleetRouter: safeError required');
  }

  const logger = log || console;
  const router = Router();

  /**
   * Fail-closed auth gate. Returns { ok: true, user } on success, or
   * { ok: false, status, body } on any failure. Callers send the
   * failure response directly; success grants full fleet access.
   */
  async function requireOwner(req) {
    const user = await authenticatePortalRequest(req);
    if (!user) return { ok: false, status: 401, body: { error: 'Unauthorized' } };

    // Tenant VPSes never have OWNER_USER_ID configured. Operator VPSes
    // do. Fail-closed when missing — covers both the tenant case and
    // the "operator misconfigured its .env" case with the same code.
    const ownerId = process.env.OWNER_USER_ID;
    if (!ownerId) {
      return { ok: false, status: 403, body: { error: 'Not available on this instance' } };
    }
    if (user.id !== ownerId) {
      return { ok: false, status: 403, body: { error: 'Forbidden' } };
    }

    return { ok: true, user };
  }

  /**
   * Proxy a GET to a Worker fleet endpoint with ADMIN_SECRET. Factored
   * out so all three data endpoints share the same error paths.
   */
  async function proxyWorkerGet(path, res) {
    const adminSecret = process.env.ADMIN_SECRET;
    const workerUrl = getWorkerUrl();
    if (!adminSecret || !workerUrl) {
      return res.status(503).json({ error: 'Fleet control plane not configured' });
    }
    const upstream = await fetch(`${workerUrl}${path}`, {
      headers: { Authorization: `Bearer ${adminSecret}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Worker returned ${upstream.status}` });
    }
    const data = await upstream.json();
    res.json(data);
  }

  // ── GET /portal/fleet/gate ─────────────────────────────────────────
  // Cheap probe endpoint: UI calls this first to decide if the /fleet
  // page should render at all. Returns 200 { ok: true } only for the
  // fully-authenticated owner; every other case echoes the gate's
  // rejection status.
  router.get('/portal/fleet/gate', async (req, res) => {
    const gate = await requireOwner(req);
    if (!gate.ok) return res.status(gate.status).json(gate.body);
    res.json({ ok: true });
  });

  // ── GET /portal/fleet/status ────────────────────────────────────────
  router.get('/portal/fleet/status', async (req, res) => {
    try {
      const gate = await requireOwner(req);
      if (!gate.ok) return res.status(gate.status).json(gate.body);
      await proxyWorkerGet('/api/fleet/status', res);
    } catch (e) {
      res.status(500).json({ error: safeError(e) });
    }
  });

  // ── GET /portal/fleet/vps/:handle/history ───────────────────────────
  router.get('/portal/fleet/vps/:handle/history', async (req, res) => {
    try {
      const gate = await requireOwner(req);
      if (!gate.ok) return res.status(gate.status).json(gate.body);

      const handle = String(req.params.handle || '');
      if (!HANDLE_PATTERN.test(handle)) {
        return res.status(400).json({ error: 'Invalid handle' });
      }
      await proxyWorkerGet(`/api/fleet/vps/${encodeURIComponent(handle)}/history`, res);
    } catch (e) {
      res.status(500).json({ error: safeError(e) });
    }
  });

  // ── GET /portal/fleet/guardians ─────────────────────────────────────
  // Worker-side guardian snapshot: counters + recent scrubbed deny
  // events. Scrubbing happens in the Worker — the shape emitted has
  // already had PII (tokens, user_ids, raw paths) redacted.
  router.get('/portal/fleet/guardians', async (req, res) => {
    try {
      const gate = await requireOwner(req);
      if (!gate.ok) return res.status(gate.status).json(gate.body);
      await proxyWorkerGet('/api/guardians', res);
    } catch (e) {
      res.status(500).json({ error: safeError(e) });
    }
  });

  logger.info?.('[portal-fleet-router] mounted 4 handlers (owner-gated)');
  return router;
}

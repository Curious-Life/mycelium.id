/**
 * Portal billing router (Phase 10 PR 7D, Wave 3.2).
 *
 * 3 handlers exposing the managed-hosting subscription surface:
 *
 *   GET  /portal/billing          — subscription row + crypto payment
 *                                    history (empty for self-hosted).
 *                                    Detects "managed" mode via
 *                                    MYA_USER_ID + MYA_WORKER_URL.
 *   POST /portal/billing/portal   — Stripe customer-portal session.
 *                                    Proxies to Worker /api/billing/portal
 *                                    using the agent token; Worker resolves
 *                                    the user_id from identity.user_id so
 *                                    tenants can't open portals for each
 *                                    other.
 *   POST /portal/billing/crypto   — CoinGate invoice creation (proxy to
 *                                    Worker /api/crypto/invoice).
 *
 * Self-hosted instances (no MYA_WORKER_URL / MYA_USER_ID) cleanly
 * short-circuit: GET returns `{ managed: false }`; POSTs return 400
 * with "Billing not available for self-hosted instances" /
 * "Not available".
 *
 * The `managed` flag is determined from env at handler time rather
 * than factory time so the toggle reflects current state (a customer
 * VPS can be switched from self-hosted to managed by setting envs +
 * restarting the agent; no router rebuild needed).
 */

import { Router } from 'express';
import { getWorkerUrl, getWorkerSecret, hasWorkerSecret } from '@mycelium/core/env.js';

const WORKER_BILLING_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} CreatePortalBillingRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {object} config  — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalBillingRouter(deps) {
  if (!deps) throw new TypeError('createPortalBillingRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalBillingRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalBillingRouter: tryGetDb required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalBillingRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const router = Router();

  router.get('/portal/billing', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      // Managed-mode detection: a customer VPS is "managed" if it has a tenant
      // identity (MYA_USER_ID) and can talk to the operator Worker. The
      // ADMIN_SECRET sentinel was removed as part of Option 3 — agents must not
      // hold operator credentials.
      if (!getWorkerUrl() || !process.env.MYA_USER_ID) {
        return res.json({ managed: false });
      }

      const rows = await db.rawQuery(
        `SELECT plan, type, status, current_period_end, cancel_at_period_end, created_at, payment_method, paid_through, crypto_coin
         FROM subscriptions WHERE user_id = ? LIMIT 1`,
        [user.id]
      );
      const sub = rows?.[0];

      if (!sub) {
        return res.json({ managed: true, subscription: null });
      }

      let cryptoPayments = [];
      if (sub.payment_method === 'crypto') {
        cryptoPayments = await db.rawQuery(
          `SELECT coingate_order_id, plan, amount_eur, crypto_amount, crypto_coin, credited_months, paid_at
           FROM crypto_payments WHERE user_id = ? AND status = 'paid' ORDER BY paid_at DESC LIMIT 20`,
          [user.id]
        );
      }

      res.json({
        managed: true,
        subscription: {
          plan: sub.plan,
          type: sub.type,
          status: sub.status,
          currentPeriodEnd: sub.current_period_end,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          createdAt: sub.created_at,
          paymentMethod: sub.payment_method || 'stripe',
          paidThrough: sub.paid_through,
          cryptoCoin: sub.crypto_coin,
        },
        cryptoPayments,
      });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        '[Portal] Billing fetch failed:', e?.message
      );
      res.status(500).json({ error: 'Failed to load billing info' });
    }
  });

  router.post('/portal/billing/portal', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const workerUrl = getWorkerUrl();
      const agentToken = process.env.AGENT_TOKEN;
      if (!workerUrl || !agentToken) {
        return res.status(400).json({ error: 'Billing not available for self-hosted instances' });
      }

      // Proxy to Worker billing portal endpoint with the agent token. The Worker
      // resolves the user_id from identity.user_id (the agent token's tenant)
      // — no need to pass it in the body. Agent tokens can only proxy billing
      // for their own tenant.
      const portalRes = await fetch(`${workerUrl}/api/billing/portal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
        body: JSON.stringify({
          returnUrl: req.body?.returnUrl || `https://${req.headers.host}/settings`,
        }),
        signal: AbortSignal.timeout(WORKER_BILLING_TIMEOUT_MS),
      });

      if (!portalRes.ok) {
        const err = await portalRes.json().catch(() => ({ error: 'Unknown error' }));
        return res.status(portalRes.status).json(err);
      }

      const data = await portalRes.json();
      res.json(data);
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        '[Portal] Billing portal failed:', e?.message
      );
      res.status(500).json({ error: 'Failed to create billing portal session' });
    }
  });

  router.post('/portal/billing/crypto', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const workerUrl = getWorkerUrl();
      if (!workerUrl) return res.status(400).json({ error: 'Not available' });

      const { plan } = req.body || {};
      const db = tryGetDb();
      // Email is preferred for the CoinGate invoice; fall back to the user's
      // display name if the provisioning row has no email on this VPS.
      let email = null;
      if (db) {
        try {
          const rows = await db.rawQuery(
            'SELECT email FROM provisioning_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
            [user.id]
          );
          email = rows?.[0]?.email;
        } catch { /* table absent on some self-hosted VPSes */ }
      }

      const headers = { 'Content-Type': 'application/json' };
      if (process.env.AGENT_TOKEN) headers['Authorization'] = `Bearer ${process.env.AGENT_TOKEN}`;

      const invoiceRes = await fetch(`${workerUrl}/api/crypto/invoice`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          plan,
          user_id: user.id,
          email: email || user.displayName,
          return_url: `https://${req.headers.host}`,
        }),
        signal: AbortSignal.timeout(WORKER_BILLING_TIMEOUT_MS),
      });

      if (!invoiceRes.ok) {
        const err = await invoiceRes.json().catch(() => ({ error: 'Unknown error' }));
        return res.status(invoiceRes.status).json(err);
      }

      const data = await invoiceRes.json();
      res.json(data);
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        '[Portal] Crypto top-up failed:', e?.message
      );
      res.status(500).json({ error: 'Failed to create crypto invoice' });
    }
  });

  (logger.info ? logger.info.bind(logger) : console.log)(
    `[${LOG_PREFIX}] portal-billing-router mounted 3 handlers`
  );

  return router;
}

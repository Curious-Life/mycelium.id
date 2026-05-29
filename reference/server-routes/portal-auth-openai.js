/**
 * Portal OpenAI-OAuth router (Phase 10 PR 7D, Wave 2.4).
 *
 * Four handlers for OpenAI's device-code flow (ChatGPT subscription auth,
 * used by the `streamOpenAICodex` inference path):
 *
 *   POST /portal/auth/openai                   — browser-initiated: take
 *                                                a device_code / user_code
 *                                                from the client, register
 *                                                a server-side polling
 *                                                session, return sessionId
 *   GET  /portal/auth/openai/poll/:sessionId   — server polls
 *                                                auth.openai.com/oauth/token
 *                                                with device_code grant;
 *                                                on success, create/activate
 *                                                provider record
 *   GET  /portal/auth/openai/status            — report current connection
 *                                                state; auto-refresh token
 *                                                when expiring within 5min
 *   POST /portal/auth/openai/disconnect        — remove all OpenAI providers
 *                                                for this user
 *
 * Why device-code flow instead of plain PKCE: Hetzner / Worker IPs hit
 * Cloudflare challenges at auth.openai.com; the customer's browser doesn't.
 * So the CLIENT fetches the device code and hands it back; the SERVER polls
 * for token completion on the customer's behalf.
 *
 * In-flight sessions live in the router factory's closure, keyed by a
 * random sessionId — unique per flow, auto-expire via setTimeout. The
 * Map is an acceptable memory-only store: if the agent restarts mid-flow,
 * the user retries the OAuth round-trip (~30s). No persisted state loss.
 *
 * `OPENAI_CODEX_OAUTH` constants and `refreshOpenAIToken` are injected
 * via deps rather than imported — agent-server.js keeps the canonical
 * copy because `streamOpenAICodex` (the inference streaming path) also
 * consumes them.
 *
 * IDOR: `/poll/:sessionId` asserts `session.userId === user.id` before
 * proceeding with the token exchange. The sessionId is random hex so
 * enumeration is not a meaningful threat either.
 */

import { Router } from 'express';
import crypto from 'crypto';

const EXPIRY_SWEEP_GRACE_MS = 5000;
const DEFAULT_DEVICE_CODE_TTL_S = 600;
const DEFAULT_POLL_INTERVAL_S = 5;
const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * @typedef {object} CreatePortalAuthOpenAIRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {(e: Error, fallback?: string) => string} safeError
 * @property {{ clientId: string, tokenUrl: string, codexResponsesUrl: string, audience?: string, deviceCodeUrl?: string }} openaiCodexOAuth
 * @property {(db:any, provider:any, userId:string, creds:any) => Promise<any>} refreshOpenAIToken
 * @property {object} config  — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalAuthOpenAIRouter(deps) {
  if (!deps) throw new TypeError('createPortalAuthOpenAIRouter: deps required');
  const {
    authenticatePortalRequest,
    tryGetDb,
    safeError,
    openaiCodexOAuth,
    refreshOpenAIToken,
    config,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalAuthOpenAIRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalAuthOpenAIRouter: tryGetDb required');
  }
  if (typeof safeError !== 'function') {
    throw new TypeError('createPortalAuthOpenAIRouter: safeError required');
  }
  if (!openaiCodexOAuth?.clientId || !openaiCodexOAuth?.tokenUrl || !openaiCodexOAuth?.codexResponsesUrl) {
    throw new TypeError('createPortalAuthOpenAIRouter: openaiCodexOAuth { clientId, tokenUrl, codexResponsesUrl } required');
  }
  if (typeof refreshOpenAIToken !== 'function') {
    throw new TypeError('createPortalAuthOpenAIRouter: refreshOpenAIToken required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalAuthOpenAIRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const router = Router();

  // Per-router in-memory session store. Each `createPortalAuthOpenAIRouter()`
  // call gets its own Map — tests can construct fresh routers without
  // sessions leaking across instances.
  const pendingOpenAIDeviceCodes = new Map();

  router.post('/portal/auth/openai', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      // Device code flow: browser fetches device_code + user_code directly
      // from auth.openai.com (Hetzner/Worker IPs get Cloudflare-challenged;
      // the customer's browser doesn't). The browser sends us the
      // device_code so the server can handle token polling.
      const body = req.body || {};
      if (!body.device_code || !body.user_code) {
        return res.status(400).json({ error: 'device_code and user_code required (browser-side OAuth)' });
      }

      const sessionId = crypto.randomBytes(16).toString('hex');
      const ttlSec = body.expires_in || DEFAULT_DEVICE_CODE_TTL_S;
      const intervalSec = body.interval || DEFAULT_POLL_INTERVAL_S;

      pendingOpenAIDeviceCodes.set(sessionId, {
        deviceCode: body.device_code,
        userId: user.id,
        createdAt: Date.now(),
        interval: intervalSec * 1000,
        expiresAt: Date.now() + ttlSec * 1000,
      });

      setTimeout(() => pendingOpenAIDeviceCodes.delete(sessionId), ttlSec * 1000 + EXPIRY_SWEEP_GRACE_MS);

      (logger.info ? logger.info.bind(logger) : console.log)(
        `[${LOG_PREFIX}] OpenAI device code flow started for user ${user.id} (browser-initiated)`
      );
      res.json({ sessionId });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] OpenAI auth initiate failed:`, e.message
      );
      res.status(500).json({ error: safeError(e, 'Failed to start OpenAI login') });
    }
  });

  router.get('/portal/auth/openai/poll/:sessionId', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const session = pendingOpenAIDeviceCodes.get(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'Session expired or not found' });
      if (session.userId !== user.id) return res.status(403).json({ error: 'Forbidden' });
      if (Date.now() > session.expiresAt) {
        pendingOpenAIDeviceCodes.delete(req.params.sessionId);
        return res.json({ status: 'expired' });
      }

      // Poll OpenAI's token endpoint with device_code grant.
      const tokenRes = await fetch(openaiCodexOAuth.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: openaiCodexOAuth.clientId,
          device_code: session.deviceCode,
        }),
      });

      if (!tokenRes.ok) {
        const errData = await tokenRes.json().catch(() => ({}));
        if (errData.error === 'authorization_pending') {
          return res.json({ status: 'pending' });
        }
        if (errData.error === 'slow_down') {
          return res.json({ status: 'pending', retryAfter: errData.interval || 10 });
        }
        if (errData.error === 'expired_token') {
          pendingOpenAIDeviceCodes.delete(req.params.sessionId);
          return res.json({ status: 'expired' });
        }
        (logger.error ? logger.error.bind(logger) : console.error)(
          `[${LOG_PREFIX}] OpenAI token exchange failed:`, errData
        );
        return res.json({ status: 'error', message: errData.error_description || 'Token exchange failed' });
      }

      const tokens = await tokenRes.json();
      pendingOpenAIDeviceCodes.delete(req.params.sessionId);

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const creds = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
        tokenType: tokens.token_type || 'Bearer',
      };

      let encryptedCreds;
      try {
        const { encrypt } = await import('@mycelium/core/crypto-local.js');
        encryptedCreds = await encrypt(JSON.stringify(creds), 'personal');
      } catch {
        encryptedCreds = JSON.stringify(creds);
      }

      // Deactivate any other OpenAI providers this user previously had.
      const existing = await db.providers.list(user.id);
      for (const p of existing.filter(p => p.provider === 'openai' && p.is_active)) {
        await db.providers.update(p.id, user.id, { status: 'replaced' });
      }

      const providerId = await db.providers.create(user.id, {
        provider: 'openai',
        label: 'ChatGPT subscription',
        authType: 'oauth',
        credentials: encryptedCreds,
        model: null,
        baseUrl: openaiCodexOAuth.codexResponsesUrl,
      });

      await db.providers.setActive(providerId, user.id);

      (logger.info ? logger.info.bind(logger) : console.log)(
        `[${LOG_PREFIX}] OpenAI Codex OAuth completed for user ${user.id}`
      );
      res.json({ status: 'done', providerId });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] OpenAI poll failed:`, e.message
      );
      res.status(500).json({ error: safeError(e, 'OpenAI authentication failed') });
    }
  });

  router.get('/portal/auth/openai/status', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.json({ authenticated: false });

      const provider = await db.providers.getActive(user.id, 'openai');
      if (!provider || !provider.credentials) {
        return res.json({ authenticated: false });
      }

      let creds;
      try {
        const { decrypt } = await import('@mycelium/core/crypto-local.js');
        creds = JSON.parse(await decrypt(provider.credentials));
      } catch {
        try { creds = JSON.parse(provider.credentials); } catch { return res.json({ authenticated: false, status: 'error' }); }
      }

      const expired = creds.expiresAt && creds.expiresAt < Date.now();
      const expiringSoon = creds.expiresAt && creds.expiresAt < Date.now() + TOKEN_REFRESH_WINDOW_MS;

      // Auto-refresh if expiring soon; a failed refresh falls through to
      // reporting the current (pre-refresh) status.
      if (expiringSoon && creds.refreshToken) {
        try {
          await refreshOpenAIToken(db, provider, user.id, creds);
          return res.json({
            authenticated: true,
            status: 'active',
            label: provider.label,
            model: provider.model_preference,
          });
        } catch (refreshErr) {
          (logger.error ? logger.error.bind(logger) : console.error)(
            `[${LOG_PREFIX}] OpenAI token refresh failed:`, refreshErr.message
          );
        }
      }

      res.json({
        authenticated: !expired,
        status: expired ? 'expired' : 'active',
        label: provider.label,
        model: provider.model_preference,
        hasRefreshToken: !!creds.refreshToken,
      });
    } catch (e) {
      res.status(500).json({ error: safeError(e, 'Failed to check OpenAI status') });
    }
  });

  router.post('/portal/auth/openai/disconnect', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const providers = await db.providers.list(user.id);
      for (const p of providers.filter(p => p.provider === 'openai')) {
        await db.providers.remove(p.id, user.id);
      }

      (logger.info ? logger.info.bind(logger) : console.log)(
        `[${LOG_PREFIX}] OpenAI disconnected by user ${user.id}`
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeError(e, 'Failed to disconnect OpenAI') });
    }
  });

  (logger.info ? logger.info.bind(logger) : console.log)(
    `[${LOG_PREFIX}] portal-auth-openai-router mounted 4 handlers`
  );

  return router;
}

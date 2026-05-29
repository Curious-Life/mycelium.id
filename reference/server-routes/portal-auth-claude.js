/**
 * Portal Claude-OAuth router (Phase 10 PR 7D, Wave 2.3).
 *
 * Four handlers for the direct PKCE flow against Anthropic's console
 * (no `claude` CLI spawn needed to INITIATE):
 *
 *   POST /portal/auth/claude              — build authorize URL, store flow
 *   POST /portal/auth/claude/code         — exchange code for tokens, write
 *                                            credentials file, create provider
 *   GET  /portal/auth/claude/status       — `claude auth status --json` with
 *                                            creds-file fallback
 *   POST /portal/auth/claude/disconnect   — `claude auth logout` with
 *                                            direct unlink fallback
 *
 * PKCE flows live in passkeyService.pkceStore, keyed by user.id — the
 * keying correctly isolates concurrent users (P1 fix from Phase 10
 * SUB-A). The single-slot-global version lost User A's verifier as
 * soon as User B clicked Connect.
 *
 * Filesystem side-effects (fs.mkdir, fs.writeFile, fs.unlink) and the
 * `claude` subprocess (execSync auth status / auth logout) are inline
 * — they don't have consumers outside this surface so there's no
 * extract-to-helper win.
 *
 * Welcome-greeting fire-and-forget runs ONLY on first-ever Claude
 * provider with zero prior messages. `enrichMessages` kicks off tagging
 * + embedding in the background.
 */

import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const CLAUDE_OAUTH = Object.freeze({
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scopes: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
});

/**
 * @typedef {object} CreatePortalAuthClaudeRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {object} passkeyService              — with createPkceFlow/getPkceFlow/clearPkceFlow
 * @property {(e: Error, fallback?: string) => string} safeError
 * @property {(inserted: any[], userId: string, agentId: string) => void} [enrichMessages]  — fire-and-forget
 * @property {object} config  — { LOG_PREFIX, AGENT_ID }
 * @property {object} [log]
 */

export function createPortalAuthClaudeRouter(deps) {
  if (!deps) throw new TypeError('createPortalAuthClaudeRouter: deps required');
  const {
    authenticatePortalRequest,
    tryGetDb,
    passkeyService,
    safeError,
    enrichMessages,
    storeSyntheticMessage,
    config,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalAuthClaudeRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalAuthClaudeRouter: tryGetDb required');
  }
  if (
    !passkeyService
    || typeof passkeyService.createPkceFlow !== 'function'
    || typeof passkeyService.getPkceFlow !== 'function'
    || typeof passkeyService.clearPkceFlow !== 'function'
  ) {
    throw new TypeError('createPortalAuthClaudeRouter: passkeyService (with createPkceFlow/getPkceFlow/clearPkceFlow) required');
  }
  if (typeof safeError !== 'function') {
    throw new TypeError('createPortalAuthClaudeRouter: safeError required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalAuthClaudeRouter: config.LOG_PREFIX required');
  }
  if (!config?.AGENT_ID) {
    throw new TypeError('createPortalAuthClaudeRouter: config.AGENT_ID required');
  }
  if (typeof storeSyntheticMessage !== 'function') {
    throw new TypeError('createPortalAuthClaudeRouter: storeSyntheticMessage required');
  }

  const { LOG_PREFIX, AGENT_ID } = config;
  const logger = log || console;
  const router = Router();

  router.post('/portal/auth/claude', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { label } = req.body || {};

      const defaultDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude');
      let configDir = defaultDir;

      // If user already has Claude providers, create a new numbered config dir.
      const db = tryGetDb();
      if (db?.providers) {
        const existing = await db.providers.list(user.id);
        const claudeCount = existing.filter(p => p.provider === 'claude').length;
        if (claudeCount > 0) {
          configDir = `${defaultDir}-${claudeCount + 1}`;
        }
      }

      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const state = crypto.randomBytes(24).toString('base64url');

      // Keyed by user.id — concurrent users keep their own verifiers.
      passkeyService.createPkceFlow(user.id, {
        verifier,
        state,
        configDir,
        label,
        userId: user.id,
      });

      const params = new URLSearchParams({
        code: 'true',
        client_id: CLAUDE_OAUTH.clientId,
        response_type: 'code',
        redirect_uri: CLAUDE_OAUTH.redirectUri,
        scope: CLAUDE_OAUTH.scopes,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      });

      const url = `${CLAUDE_OAUTH.authorizeUrl}?${params}`;
      (logger.info ? logger.info.bind(logger) : console.log)(
        `[${LOG_PREFIX}] Claude OAuth URL generated (PKCE direct)`
      );
      res.json({ url });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] Claude auth failed:`, e.message
      );
      res.status(500).json({ error: 'Auth flow failed' });
    }
  });

  router.post('/portal/auth/claude/code', async (req, res) => {
    // Hoisted so the catch block can clear this user's PKCE flow on failure.
    let user = null;
    try {
      user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { code } = req.body || {};
      if (!code) return res.status(400).json({ error: 'Code required' });

      // 10-minute TTL enforced inside getPkceFlow.
      const flow = passkeyService.getPkceFlow(user.id);
      if (!flow) {
        return res.status(400).json({ error: 'No pending auth session. Click "Connect with Claude" first.' });
      }
      const { verifier } = flow;

      // Clean code: user may have pasted the callback URL or a fragment.
      let cleanCode = code.trim();
      if (cleanCode.includes('code=')) {
        try {
          const u = new URL(cleanCode);
          cleanCode = u.searchParams.get('code') || cleanCode;
        } catch {
          const m = cleanCode.match(/[?&]code=([^&#]+)/);
          if (m) cleanCode = m[1];
        }
      }
      cleanCode = cleanCode.split('#')[0].trim();

      const tokenBody = {
        grant_type: 'authorization_code',
        code: cleanCode,
        redirect_uri: CLAUDE_OAUTH.redirectUri,
        client_id: CLAUDE_OAUTH.clientId,
        code_verifier: verifier,
        state: flow.state,
      };
      // Redacted log: never serialize `code` or `code_verifier` — both are
      // sensitive PKCE material. The redirect_uri / client_id / state are
      // not secrets but kept off the line for hygiene; code length and
      // verifier presence are enough for diagnostic purposes.
      (logger.info ? logger.info.bind(logger) : console.log)(
        `[${LOG_PREFIX}] Token exchange request: grant_type=authorization_code code_length=${cleanCode.length} verifier_present=true state_present=${!!flow.state}`
      );

      // Retry up to 3 times — Anthropic's token endpoint sometimes returns
      // transient 500s. Don't retry 4xx.
      let tokenRes = null;
      let lastErr = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        tokenRes = await fetch(CLAUDE_OAUTH.tokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'claude-code/1.0',
          },
          body: JSON.stringify(tokenBody),
        });
        if (tokenRes.ok) break;
        lastErr = await tokenRes.text();
        (logger.error ? logger.error.bind(logger) : console.error)(
          `[${LOG_PREFIX}] Token exchange attempt ${attempt}/3 failed (${tokenRes.status}): ${lastErr.substring(0, 150)}`
        );
        if (tokenRes.status < 500) break;
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
      }

      if (!tokenRes.ok) {
        (logger.error ? logger.error.bind(logger) : console.error)(
          `[${LOG_PREFIX}] Token exchange failed after retries`
        );
        passkeyService.clearPkceFlow(user.id);
        return res.status(400).json({ error: `Token exchange failed (${tokenRes.status}): ${lastErr.substring(0, 200)}` });
      }

      const tokens = await tokenRes.json();

      // Reject `claude setup-token`-shaped artifacts: tokens whose granted
      // scopes lack `user:inference` are billing/admin-only credentials
      // (e.g. `org:create_api_key` alone), not chat subscriptions. Pointing
      // an agent at one risks billing-relevant API key creation against
      // the org. Disk credentials file is NOT written; the dir is left
      // clean so the user can retry the OAuth flow.
      const grantedScopes = typeof tokens.scope === 'string'
        ? tokens.scope.split(/\s+/).filter(Boolean)
        : Array.isArray(tokens.scopes) ? tokens.scopes : [];
      if (!grantedScopes.includes('user:inference')) {
        passkeyService.clearPkceFlow(user.id);
        (logger.warn ? logger.warn.bind(logger) : console.warn)(
          `[${LOG_PREFIX}] Rejected token exchange: scopes lack user:inference (granted=${grantedScopes.join(',') || '<none>'})`
        );
        return res.status(400).json({
          error: 'setup_token_artifact_rejected',
          message: 'This token grants admin-only scopes (no user:inference). Use a Claude subscription account, not `claude setup-token`.',
        });
      }

      (logger.info ? logger.info.bind(logger) : console.log)(
        `[${LOG_PREFIX}] Token exchange successful, writing credentials`
      );

      // Claude Code CLI credentials file format. We persist the granted
      // scopes (from the token response), not the requested scopes, so the
      // disk record reflects what the IdP actually issued.
      const credentials = {
        claudeAiOauth: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
          scopes: grantedScopes,
        },
      };

      // Best-effort: fetch account details using the new access token.
      try {
        const accountRes = await fetch('https://api.claude.ai/api/auth/session', {
          headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'User-Agent': 'claude-code/1.0' },
        });
        if (accountRes.ok) {
          const account = await accountRes.json();
          if (account.email) credentials.claudeAiOauth.email = account.email;
          if (account.subscription_type || account.subscriptionType) {
            credentials.claudeAiOauth.subscriptionType = account.subscription_type || account.subscriptionType;
          }
          if (account.rate_limit_tier || account.rateLimitTier) {
            credentials.claudeAiOauth.rateLimitTier = account.rate_limit_tier || account.rateLimitTier;
          }
        }
      } catch (e) {
        (logger.warn ? logger.warn.bind(logger) : console.warn)(
          `[${LOG_PREFIX}] Could not fetch Claude account details:`, e.message
        );
      }

      const credDir = flow.configDir;
      const credLabel = flow.label;
      const authUserId = flow.userId;
      const credPath = path.join(credDir, '.credentials.json');

      await fs.mkdir(credDir, { recursive: true });
      await fs.writeFile(credPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });

      (logger.info ? logger.info.bind(logger) : console.log)(
        `[${LOG_PREFIX}] Claude Code credentials written to ${credPath}`
      );

      // Short delay so the CLI can recognize the new credentials, then
      // enrich from `claude auth status --json` (email / subscription tier).
      await new Promise(r => setTimeout(r, 2000));
      try {
        const { execSync } = await import('child_process');
        const claudeBin = process.env.CLAUDE_BIN || 'claude';
        const env = { ...process.env, CLAUDE_CONFIG_DIR: credDir };
        const statusOutput = execSync(`${claudeBin} auth status --json`, { encoding: 'utf-8', timeout: 10000, env }).trim();
        const cliStatus = JSON.parse(statusOutput);
        if (cliStatus.email) credentials.claudeAiOauth.email = cliStatus.email;
        if (cliStatus.subscriptionType) credentials.claudeAiOauth.subscriptionType = cliStatus.subscriptionType;
        if (cliStatus.rateLimitTier) credentials.claudeAiOauth.rateLimitTier = cliStatus.rateLimitTier;
        await fs.writeFile(credPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
        (logger.info ? logger.info.bind(logger) : console.log)(
          `[${LOG_PREFIX}] Enriched credentials with email: ${cliStatus.email}, sub: ${cliStatus.subscriptionType}`
        );
      } catch (e) {
        (logger.warn ? logger.warn.bind(logger) : console.warn)(
          `[${LOG_PREFIX}] Could not enrich credentials via CLI:`, e.message
        );
      }

      const db = tryGetDb();
      let isFirstEver = true;
      if (db?.providers) {
        try {
          // Don't store the OAuth credentials envelope in D1 for Claude. The
          // file at <credDir>/.credentials.json is canonical at runtime — the
          // CLI refreshes tokens there in place, so any DB snapshot would go
          // stale immediately and serve only as duplicated at-rest token
          // exposure. D1 keeps metadata only (label/email/subscriptionType
          // arrive via the connectivity test or onboarding probe).
          const existing = await db.providers.list(authUserId);
          const isFirstProvider = existing.filter(p => p.provider === 'claude').length === 0;

          // Any prior messages means this isn't a new user (don't send greeting).
          try {
            const msgCheck = await db.rawQuery(
              'SELECT COUNT(*) as c FROM messages WHERE user_id = ? LIMIT 1', [authUserId]
            );
            if (msgCheck?.[0]?.c > 0) isFirstEver = false;
          } catch {}
          if (!isFirstProvider) isFirstEver = false;

          const autoEmail = credentials.claudeAiOauth?.email;
          const autoSub = credentials.claudeAiOauth?.subscriptionType;
          const providerLabel = autoEmail
            ? (autoSub ? `${autoEmail} (${autoSub})` : autoEmail)
            : credLabel
              || (isFirstProvider ? 'Claude' : `Claude ${existing.filter(p => p.provider === 'claude').length + 1}`);

          const providerId = await db.providers.create(authUserId, {
            provider: 'claude', label: providerLabel,
            authType: 'oauth', credentials: null,
            configDir: credDir, model: null,
          });

          if (isFirstProvider && providerId) await db.providers.setActive(providerId, authUserId);

          (logger.info ? logger.info.bind(logger) : console.log)(
            `[${LOG_PREFIX}] Claude provider record created (id=${providerId}, dir=${credDir})`
          );
        } catch (err) {
          (logger.error ? logger.error.bind(logger) : console.error)(
            `[${LOG_PREFIX}] Provider record failed:`, err.message
          );
        }
      }

      passkeyService.clearPkceFlow(user.id);

      // Fire-and-forget: welcome greeting (only on first-ever Claude provider
      // with no prior messages).
      if (isFirstEver) {
        (async () => {
          try {
            if (!db) return;
            const agentId = AGENT_ID || 'personal-agent';
            const greeting = `Welcome to your Mycelium. I'm your personal agent — you can talk to me here, through Telegram, Discord, or any connected channel.\n\nYour AI inference is now connected. You can start a conversation, import your data, or just explore. Everything you share with me is encrypted end-to-end with your master key.\n\nWhat would you like to do first?`;
            await storeSyntheticMessage({
              userId: authUserId,
              role: 'assistant',
              source: 'portal_first_greeting',
              content: greeting,
              agentIdOverride: agentId,
              metadata: {
                origin: 'synthetic',
                channel: 'portal',
                extra: { trigger: 'first-ever-claude-provider' },
              },
            });
            (logger.info ? logger.info.bind(logger) : console.log)(
              `[${LOG_PREFIX}] Welcome greeting stored for user ${authUserId}`
            );
          } catch (err) {
            (logger.error ? logger.error.bind(logger) : console.error)(
              `[${LOG_PREFIX}] Welcome greeting failed:`, err.message
            );
          }
        })();
      }

      res.json({ ok: true, greeting: isFirstEver });
    } catch (e) {
      // Clear this user's flow so a retry starts fresh. If pre-auth failed,
      // the flow's 10-min TTL handles sweep.
      if (user?.id) passkeyService.clearPkceFlow(user.id);
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] Claude auth code failed:`, e.message
      );
      res.status(500).json({ error: safeError(e, 'Authentication failed') });
    }
  });

  router.get('/portal/auth/claude/status', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      // `claude auth status --json` gives rich info (email, subscription).
      try {
        const { execSync } = await import('child_process');
        const claudeBin = process.env.CLAUDE_BIN || 'claude';
        const configDir = process.env.CLAUDE_CONFIG_DIR;
        const env = configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : process.env;
        const output = execSync(`${claudeBin} auth status --json`, { encoding: 'utf-8', timeout: 5000, env }).trim();
        const status = JSON.parse(output);
        return res.json({
          authenticated: status.loggedIn || false,
          status: status.loggedIn ? 'Authenticated' : 'Not authenticated',
          email: status.email || null,
          subscriptionType: status.subscriptionType || null,
          orgName: status.orgName || null,
        });
      } catch (cliErr) {
        (logger.warn ? logger.warn.bind(logger) : console.warn)(
          `[${LOG_PREFIX}] claude auth status failed:`, cliErr?.message?.slice(0, 100)
        );
      }

      // Fallback: read credentials file directly.
      const credDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude');
      const credPath = path.join(credDir, '.credentials.json');

      const raw = await fs.readFile(credPath, 'utf-8').catch(() => null);
      if (!raw) return res.json({ authenticated: false, status: 'Not authenticated' });

      const creds = JSON.parse(raw);
      const oauth = creds.claudeAiOauth;
      if (!oauth?.accessToken) return res.json({ authenticated: false, status: 'No credentials' });

      const expired = oauth.expiresAt && oauth.expiresAt < Date.now();

      // If email is not in credentials, try ai_providers table.
      let email = oauth.email || null;
      let subscriptionType = oauth.subscriptionType || null;
      if (!email) {
        try {
          const db = tryGetDb();
          if (db?.providers) {
            const providers = await db.providers.list(process.env.MYA_USER_ID);
            const claudeProvider = providers.find(p => p.provider === 'claude' && p.is_active);
            if (claudeProvider?.label) email = claudeProvider.label;
          }
        } catch {}
      }

      res.json({
        authenticated: !expired,
        status: expired ? 'Token expired' : 'Authenticated',
        email,
        subscriptionType,
        hasRefreshToken: !!oauth.refreshToken,
      });
    } catch {
      res.json({ authenticated: false, status: 'Not authenticated' });
    }
  });

  router.post('/portal/auth/claude/disconnect', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { execSync } = await import('child_process');
      const claudeBin = process.env.CLAUDE_BIN || 'claude';
      const configDir = process.env.CLAUDE_CONFIG_DIR;
      const env = configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : process.env;
      execSync(`${claudeBin} auth logout`, { encoding: 'utf-8', timeout: 5000, env });

      (logger.info ? logger.info.bind(logger) : console.log)(
        `[${LOG_PREFIX}] Claude Code disconnected by user`
      );
      res.json({ ok: true });
    } catch {
      // Fallback: delete credentials file directly.
      try {
        const credDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude');
        const credPath = path.join(credDir, '.credentials.json');
        await fs.unlink(credPath);
        (logger.info ? logger.info.bind(logger) : console.log)(
          `[${LOG_PREFIX}] Claude credentials file removed`
        );
        res.json({ ok: true });
      } catch {
        res.status(500).json({ error: 'Failed to disconnect' });
      }
    }
  });

  (logger.info ? logger.info.bind(logger) : console.log)(
    `[${LOG_PREFIX}] portal-auth-claude-router mounted 4 handlers`
  );

  return router;
}

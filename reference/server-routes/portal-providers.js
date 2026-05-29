/**
 * Portal providers router (Phase 10 PR 7D, Wave 2.2).
 *
 * AI-provider CRUD + connectivity test. 5 handlers:
 *
 *   GET    /portal/providers               — list (stripped of credentials)
 *   POST   /portal/providers               — add an api-key provider
 *                                            (OpenAI or "custom"; Claude
 *                                            goes through the OAuth flow)
 *   PUT    /portal/providers/:id           — update label / model / active
 *   DELETE /portal/providers/:id           — remove provider
 *   POST   /portal/providers/:id/test      — connectivity check
 *                                            (Claude: creds file + expiry,
 *                                             OpenAI: /v1/models ping)
 *
 * The `.credentials.json` file lookup + decryption side-effects all
 * stay inside this router — no consumers outside. Crypto is dynamically
 * imported from `@mycelium/core/crypto-local.js` at handler time so the
 * router factory can be used in tests without a live master key.
 *
 * IDOR is enforced by every `db.providers.*` call taking `user.id` as
 * the second arg (or filtering the returned list by user.id); there is
 * no cross-user path anywhere.
 */

import { Router } from 'express';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { validateAgentIdKey } from '@mycelium/core/reconciler-core.js';

/**
 * @typedef {object} CreatePortalProvidersRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {object} config  — { LOG_PREFIX }
 * @property {Array<{slug:string, name:string, port:number}>} [knownAgents]
 *           Optional — fed by the orchestrator's KNOWN_AGENTS list. Used
 *           by /portal/providers/runtime-state to fan out to each agent's
 *           /health and report which CLAUDE_CONFIG_DIR it is currently
 *           using. Defaults to [] (endpoint returns an empty list).
 * @property {(url: string, init?: object) => Promise<Response>} [fetchFn]
 *           Optional fetch impl, injected for tests. Defaults to globalThis.fetch.
 * @property {() => boolean} [signalReconciler]
 *           Optional — invoked after a successful POST /assignments to
 *           tell the claude-reconciler daemon to reconcile immediately
 *           (vs. waiting for its next 30s poll). Default sends SIGUSR2 to
 *           the PID at /run/mycelium/claude-reconciler.pid; tests inject
 *           a stub. Returns true on success, false if the signal couldn't
 *           be sent (no PID file, dead process). Failure is non-fatal —
 *           the next poll cycle will pick up the change.
 * @property {string[]} [scopeAllowList]
 *           Allowed values for `scope:<x>` agent_id keys. Default
 *           ['personal','org','wealth','moms']. Validated on POST.
 * @property {object} [log]
 */

// Per-agent /health probe timeout. 1.5s was tight enough that an agent
// servicing a heavy chat or doing mind-search rehydrate could appear
// "unreachable" intermittently. 4s is comfortably above worst observed
// /health latency without making the portal grid load feel sluggish —
// probes run in parallel via Promise.all.
const RUNTIME_STATE_HEALTH_TIMEOUT_MS = 4000;
const DEFAULT_SCOPE_ALLOW_LIST = ['personal', 'org', 'wealth', 'moms'];
const RECONCILER_PID_PATH = '/run/mycelium/claude-reconciler.pid';

// Default reconciler-trigger: read the PID file and send SIGUSR2.
// Best-effort: any error → return false (caller logs at info, not error,
// because the next 30s poll will catch up regardless).
function defaultSignalReconciler() {
  try {
    const raw = readFileSync(RECONCILER_PID_PATH, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    process.kill(pid, 'SIGUSR2');
    return true;
  } catch {
    return false;
  }
}

export function createPortalProvidersRouter(deps) {
  if (!deps) throw new TypeError('createPortalProvidersRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, config, log } = deps;
  const knownAgents = Array.isArray(deps.knownAgents) ? deps.knownAgents : [];
  const fetchFn = deps.fetchFn || ((u, i) => fetch(u, i));
  const signalReconciler = typeof deps.signalReconciler === 'function'
    ? deps.signalReconciler
    : defaultSignalReconciler;
  const scopeAllowList = Array.isArray(deps.scopeAllowList) && deps.scopeAllowList.length
    ? deps.scopeAllowList
    : DEFAULT_SCOPE_ALLOW_LIST;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalProvidersRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalProvidersRouter: tryGetDb required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalProvidersRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const router = Router();

  router.get('/portal/providers', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.providers) return res.status(503).json({ error: 'Database not available' });

      const providers = await db.providers.list(user.id);
      // Strip credentials — only return metadata. config_dir is included so
      // the UI can correlate a row to a running agent's CLAUDE_CONFIG_DIR
      // for the "current vs preferred" badge.
      const safe = providers.map(p => ({
        id: p.id, provider: p.provider, label: p.label, auth_type: p.auth_type,
        model_preference: p.model_preference, base_url: p.base_url,
        config_dir: p.config_dir,
        is_active: p.is_active, status: p.status,
        last_used_at: p.last_used_at, created_at: p.created_at,
      }));
      res.json({ providers: safe });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] List providers error:`, e.message
      );
      res.status(500).json({ error: 'Failed to list providers' });
    }
  });

  router.post('/portal/providers', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.providers) return res.status(503).json({ error: 'Database not available' });

      const { provider, label, api_key, model_preference, base_url } = req.body || {};
      if (!provider || !api_key) return res.status(400).json({ error: 'provider and api_key required' });
      if (!['openai', 'custom'].includes(provider)) {
        return res.status(400).json({ error: 'Use Claude OAuth for Claude accounts' });
      }

      let encryptedCreds = null;
      try {
        const { encrypt } = await import('@mycelium/core/crypto-local.js');
        encryptedCreds = await encrypt(JSON.stringify({ api_key }));
      } catch {
        // No encryption available — store as-is (not ideal, but functional)
        encryptedCreds = JSON.stringify({ api_key });
      }

      const id = await db.providers.create(user.id, {
        provider, label, authType: 'api_key',
        credentials: encryptedCreds,
        model: model_preference, baseUrl: base_url,
      });

      // Set as active if first of this provider type for the user
      const existing = await db.providers.list(user.id);
      const sameType = existing.filter(p => p.provider === provider);
      if (sameType.length <= 1) await db.providers.setActive(id, user.id);

      (logger.info ? logger.info.bind(logger) : console.log)(
        `[${LOG_PREFIX}] Added ${provider} provider for user ${user.id}`
      );
      res.json({ ok: true, id });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] Add provider error:`, e.message
      );
      res.status(500).json({ error: 'Failed to add provider' });
    }
  });

  router.put('/portal/providers/:id', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.providers) return res.status(503).json({ error: 'Database not available' });

      const { label, model_preference, base_url, is_active } = req.body || {};
      const id = parseInt(req.params.id, 10);

      if (is_active) {
        // Refuse to mark a quarantined or setup-token row as active. Such
        // rows lack `user:inference` scope; pointing an agent at one risks
        // billing-relevant API key creation against the org. Detection
        // happens in /test (auth_type or status). Both signals are
        // accepted here so the rejection is robust to either being set.
        const all = await db.providers.list(user.id);
        const target = all.find(p => p.id === id);
        if (target && (target.status === 'quarantined' || target.auth_type === 'setup_token')) {
          (logger.warn ? logger.warn.bind(logger) : console.warn)(
            `[${LOG_PREFIX}] Refused to mark quarantined provider active: id=${id} status=${target.status} auth_type=${target.auth_type}`
          );
          return res.status(409).json({
            error: 'quarantined_provider',
            message: 'This provider is quarantined (no user:inference scope) and cannot be marked active.',
          });
        }
        await db.providers.setActive(id, user.id);

        // PR 2b shim: for Claude providers, ALSO create/update a wildcard
        // assignment ('*') so the legacy "Mark preferred" UI click actually
        // propagates (via the reconciler) instead of being a cosmetic flag.
        // OpenAI continues to use is_active alone — chat.js:1575 reads it
        // directly via db.providers.getActive('openai').
        if (target?.provider === 'claude' && db.assignments) {
          try {
            const existingAssignments = await db.assignments.list(user.id);
            const wildcard = existingAssignments.find(a => a.agent_id === '*');
            await db.assignments.upsertWithAudit({
              userId: user.id,
              agentId: '*',
              providerId: id,
              actorUserId: user.id,
              action: wildcard ? 'update' : 'create',
              fromProviderId: wildcard?.provider_id ?? null,
              reason: 'mark_preferred_shim',
            });
            const signaled = signalReconciler();
            (logger.info ? logger.info.bind(logger) : console.log)(
              `[${LOG_PREFIX}] Mark-preferred shim: wrote * assignment id=${id} signaled=${signaled}`
            );
          } catch (shimErr) {
            // Don't fail the request — the legacy flag was already set;
            // the shim is best-effort. Reconciler will pick up state on
            // its next 30s poll regardless of whether we signaled.
            (logger.warn ? logger.warn.bind(logger) : console.warn)(
              `[${LOG_PREFIX}] Mark-preferred shim failed (non-fatal):`, shimErr.message
            );
          }
        }
      }

      const updates = {};
      if (label !== undefined) updates.label = label;
      if (model_preference !== undefined) updates.model_preference = model_preference;
      if (base_url !== undefined) updates.base_url = base_url;
      if (Object.keys(updates).length) await db.providers.update(id, user.id, updates);

      res.json({ ok: true });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] Update provider error:`, e.message
      );
      res.status(500).json({ error: 'Failed to update provider' });
    }
  });

  router.delete('/portal/providers/:id', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.providers) return res.status(503).json({ error: 'Database not available' });

      await db.providers.remove(parseInt(req.params.id, 10), user.id);
      res.json({ ok: true });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] Delete provider error:`, e.message
      );
      res.status(500).json({ error: 'Failed to delete provider' });
    }
  });

  // Runtime-state read: which CLAUDE_CONFIG_DIR each known agent is
  // currently using, by fanning out to each agent's /health (port comes
  // from the orchestrator's KNOWN_AGENTS list, injected via deps).
  // Read-only; no DB writes. The portal settings page uses this to
  // render a "current vs preferred" badge per provider.
  //
  // Each agent entry returns:
  //   - configDir / configDirHash from /health, or null if unreachable
  //   - source: 'env' (today every running agent inherits process.env), or
  //             'helper' (PR 2: per-agent override from /run/mycelium cache)
  router.get('/portal/providers/runtime-state', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      if (knownAgents.length === 0) {
        return res.json({ agents: [], note: 'no_known_agents_configured' });
      }

      const probes = knownAgents.map(async (a) => {
        const base = { slug: a.slug, name: a.name, port: a.port };
        try {
          const r = await fetchFn(`http://localhost:${a.port}/health`, {
            signal: AbortSignal.timeout(RUNTIME_STATE_HEALTH_TIMEOUT_MS),
          });
          if (!r.ok) {
            return { ...base, ok: false, error: `HTTP ${r.status}` };
          }
          const data = await r.json();
          // /health is a thin shell; the configDir lives on the agent
          // sub-object (statusSummary) in some shapes, or top-level
          // (agentInfo). Tolerate both.
          const configDir = data.configDir
            || data.agent?.configDir
            || null;
          const configDirHash = data.configDirHash
            || data.agent?.configDirHash
            || null;
          return {
            ...base,
            ok: true,
            configDir,
            configDirHash,
            source: configDir ? 'env' : 'fallback',
          };
        } catch (e) {
          return {
            ...base,
            ok: false,
            error: e.name === 'TimeoutError' ? 'timeout' : (e.message || 'unreachable'),
          };
        }
      });

      const agents = await Promise.all(probes);
      res.json({ agents });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] Runtime-state error:`, e.message
      );
      res.status(500).json({ error: 'Failed to read runtime state' });
    }
  });

  // ── Assignments — desired-state per-agent CLAUDE_CONFIG_DIR ──────────────
  // Reconciler converges these into /run/mycelium/claude-config.json. The
  // helper at packages/core/claude-config.js reads that cache on every CLI
  // spawn. Together: portal click → DB row → reconciler signal → cache
  // write → next CLI spawn picks up the new dir. No PM2 restart required.

  router.get('/portal/providers/assignments', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.assignments) return res.status(503).json({ error: 'Database not available' });

      const assignments = await db.assignments.list(user.id);
      res.json({ assignments });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] List assignments error:`, e.message
      );
      res.status(500).json({ error: 'Failed to list assignments' });
    }
  });

  router.post('/portal/providers/assignments', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.assignments || !db?.providers) {
        return res.status(503).json({ error: 'Database not available' });
      }

      // Body shape:
      //   { assignments: [{ agentId: string, providerId: number|null }, ...],
      //     reason: string|null }
      // - providerId=null on a known agentId means "remove the assignment"
      //   (revert that agent to env fallback).
      // - reason is optional free-text logged in the audit row (operator
      //   can describe why they're changing assignments).
      const body = req.body || {};
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;
      const submitted = Array.isArray(body.assignments) ? body.assignments : null;
      if (!submitted) {
        return res.status(400).json({ error: 'assignments array required' });
      }

      // Build the literal allow-list from injected knownAgents (each agent's
      // slug is a valid agent_id). Plus '*'. scope:<x> validated against the
      // configured scopeAllowList.
      const literalAllowList = knownAgents.map(a => a.slug);

      // Pull existing rows once so we can validate provider ownership +
      // compute action ('create' vs 'update') for the audit log.
      const [existingProviders, existingAssignments] = await Promise.all([
        db.providers.list(user.id),
        db.assignments.list(user.id),
      ]);
      const providerById = new Map(existingProviders.map(p => [p.id, p]));
      const assignmentByAgent = new Map(existingAssignments.map(a => [a.agent_id, a]));

      // Validate every submitted entry first; reject the whole batch on any
      // failure so callers don't get partial-writes.
      for (const entry of submitted) {
        if (!entry || typeof entry !== 'object') {
          return res.status(400).json({ error: 'each assignment must be an object' });
        }
        const v = validateAgentIdKey(entry.agentId, { literalAllowList, scopeAllowList });
        if (!v.ok) {
          return res.status(400).json({ error: 'invalid_agent_id', detail: v.reason });
        }
        if (entry.providerId === null || entry.providerId === undefined) {
          continue;  // delete path — no provider to validate
        }
        const pid = parseInt(entry.providerId, 10);
        if (!Number.isFinite(pid)) {
          return res.status(400).json({ error: 'invalid_provider_id', detail: String(entry.providerId) });
        }
        const provider = providerById.get(pid);
        if (!provider) {
          return res.status(400).json({ error: 'provider_not_found', detail: pid });
        }
        // Reject quarantined / setup_token at the route too — defense in
        // depth (PR 1's PUT /portal/providers/:id is_active=true rejection
        // covered the legacy path; this is the new path).
        if (provider.status === 'quarantined' || provider.auth_type === 'setup_token') {
          return res.status(409).json({
            error: 'quarantined_provider',
            detail: `provider ${pid} cannot be assigned`,
          });
        }
      }

      // Apply each entry. We do them in a loop (one batch per change) rather
      // than one giant batch, because each assignment + audit pair must be
      // atomic with respect to itself, but cross-row atomicity isn't
      // required (the reconciler will see the new state on its next read).
      let writes = 0;
      for (const entry of submitted) {
        const agentId = entry.agentId;
        const wantProviderId = (entry.providerId === null || entry.providerId === undefined)
          ? null
          : parseInt(entry.providerId, 10);
        const existing = assignmentByAgent.get(agentId);

        if (wantProviderId === null) {
          if (existing) {
            await db.assignments.removeWithAudit({
              userId: user.id,
              agentId,
              actorUserId: user.id,
              fromProviderId: existing.provider_id,
              reason,
            });
            writes++;
          }
          continue;
        }

        // No-op if the row already maps to this provider.
        if (existing && existing.provider_id === wantProviderId) continue;

        await db.assignments.upsertWithAudit({
          userId: user.id,
          agentId,
          providerId: wantProviderId,
          actorUserId: user.id,
          action: existing ? 'update' : 'create',
          fromProviderId: existing?.provider_id ?? null,
          reason,
        });
        writes++;
      }

      // Best-effort: kick the reconciler so the cache file updates within
      // ~1s instead of waiting up to 30s for the next poll.
      const signaled = signalReconciler();
      (logger.info ? logger.info.bind(logger) : console.log)(
        `[${LOG_PREFIX}] Assignments updated: writes=${writes} signaled=${signaled}`
      );

      const updated = await db.assignments.list(user.id);
      res.json({ ok: true, writes, signaled, assignments: updated });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] Update assignments error:`, e.message
      );
      res.status(500).json({ error: 'Failed to update assignments' });
    }
  });

  router.post('/portal/providers/:id/test', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db?.providers) return res.status(503).json({ error: 'Database not available' });

      const providers = await db.providers.list(user.id);
      const provider = providers.find(p => p.id === parseInt(req.params.id, 10));
      if (!provider) return res.status(404).json({ error: 'Provider not found' });

      // Claude: check credentials file + expiry, and quarantine any
      // setup-token-shaped artifact we encounter.
      if (provider.provider === 'claude') {
        const credDir = provider.config_dir
          || process.env.CLAUDE_CONFIG_DIR
          || path.join(process.env.HOME || '', '.claude');
        const credPath = path.join(credDir, '.credentials.json');
        const raw = await fs.readFile(credPath, 'utf-8').catch(() => null);
        if (!raw) {
          await db.providers.update(provider.id, user.id, { status: 'error' });
          return res.json({ ok: false, status: 'error', message: 'No credentials file found' });
        }
        const creds = JSON.parse(raw);
        const oauth = creds.claudeAiOauth || {};

        // Quarantine: a `claude setup-token` artifact issues admin-only
        // scopes (e.g. `org:create_api_key` alone) with no `user:inference`,
        // and typically leaves `oauthAccount` empty. Such rows must never
        // be markable as active — pointing an agent at one risks creating
        // billing-relevant API keys against the org.
        const scopes = Array.isArray(oauth.scopes) ? oauth.scopes : [];
        const hasInference = scopes.includes('user:inference');
        const oauthAccount = oauth.oauthAccount || creds.oauthAccount;
        const accountEmpty = !oauthAccount || (typeof oauthAccount === 'object' && Object.keys(oauthAccount).length === 0);
        if (!hasInference && (accountEmpty || scopes.includes('org:create_api_key'))) {
          await db.providers.update(provider.id, user.id, {
            status: 'quarantined',
            auth_type: 'setup_token',
          });
          return res.json({
            ok: false,
            status: 'quarantined',
            message: 'Setup-token artifact (no user:inference scope) — cannot be used as a chat subscription.',
          });
        }

        const expired = oauth.expiresAt && oauth.expiresAt < Date.now();
        const status = expired ? 'expired' : 'active';
        await db.providers.update(provider.id, user.id, { status });
        return res.json({ ok: !expired, status, message: expired ? 'Token expired' : 'Connected' });
      }

      // OpenAI: try listing models
      if (provider.provider === 'openai') {
        let apiKey = null;
        try {
          const { decrypt } = await import('@mycelium/core/crypto-local.js');
          const decrypted = JSON.parse(await decrypt(provider.credentials));
          apiKey = decrypted.api_key;
        } catch {
          try { apiKey = JSON.parse(provider.credentials).api_key; } catch {}
        }
        if (!apiKey) {
          await db.providers.update(provider.id, user.id, { status: 'error' });
          return res.json({ ok: false, status: 'error', message: 'Could not decrypt credentials' });
        }

        const testRes = await fetch('https://api.openai.com/v1/models', {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        const status = testRes.ok ? 'active' : 'error';
        await db.providers.update(provider.id, user.id, { status });
        return res.json({
          ok: testRes.ok, status,
          message: testRes.ok ? 'Connected' : `API error (${testRes.status})`,
        });
      }

      res.json({ ok: true, status: 'active', message: 'No test available for this provider type' });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] Test provider error:`, e.message
      );
      res.status(500).json({ error: 'Test failed' });
    }
  });

  (logger.info ? logger.info.bind(logger) : console.log)(
    `[${LOG_PREFIX}] portal-providers-router mounted 5 handlers`
  );

  return router;
}

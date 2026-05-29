/**
 * Portal integrations router (Phase 10 PR 7D, Wave 2.1).
 *
 * Owns Linear credential management — connect, disconnect, status check.
 *
 *   GET    /portal/integrations/linear   — status (NEVER returns key material)
 *   POST   /portal/integrations/linear   — validate key with Linear, encrypt,
 *                                          store for both personal + company agents
 *   DELETE /portal/integrations/linear   — remove credentials for both agents,
 *                                          purge from this process's env
 *
 * Security posture (copied from the inline comments that originally
 * guarded this block):
 *   - The API key is verified against the Linear API before storage so
 *     we don't persist garbage.
 *   - Reads never return the stored value — only a connected/not-connected
 *     flag + public metadata (team name, viewer name).
 *   - Audit log captures the event but never the key material.
 *
 * Linear-specific helpers (`isLinearApiKey`, `isUuid`, `verifyLinearKey`)
 * and the scope/agent matrix (`LINEAR_SCOPED_AGENTS`) move with the
 * handlers — they have no consumers outside this surface.
 *
 * Cross-surface helpers kept in agent-server.js and injected as deps:
 *   - putEncryptedSecret, deleteSecretForAgent (also used by settings/secret)
 *   - refreshSecrets (dynamic import from @mycelium/core)
 */

import { Router } from 'express';

const LINEAR_SCOPED_AGENTS = Object.freeze([
  { agent: 'personal-agent', scope: 'personal' },
  { agent: 'company-agent', scope: 'org' },
]);

const LINEAR_API_KEY_RE = /^lin_api_[A-Za-z0-9_-]{20,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isLinearApiKey(v) { return typeof v === 'string' && LINEAR_API_KEY_RE.test(v); }
function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

// Verify a Linear API key by asking Linear for the viewer's teams.
// Returns { ok: true, teams, viewer } on success, { ok: false, error } otherwise.
// Teams list lets the UI confirm the teamId the user entered.
async function verifyLinearKey(apiKey) {
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
      body: JSON.stringify({ query: '{ viewer { id name } teams(first: 50) { nodes { id name key } } }' }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { ok: false, error: `Linear returned ${res.status}` };
    const body = await res.json();
    if (body.errors) return { ok: false, error: body.errors[0]?.message || 'GraphQL error' };
    return { ok: true, teams: body.data?.teams?.nodes || [], viewer: body.data?.viewer || null };
  } catch (err) {
    return { ok: false, error: err.message || 'Network error' };
  }
}

/**
 * @typedef {object} CreatePortalIntegrationsRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {(opts: {key:string,value:string,scope:string,agent:string,description?:string}) => Promise<void>} putEncryptedSecret
 * @property {(opts: {key:string,agent:string}) => Promise<void>}                                                deleteSecretForAgent
 * @property {object} config  — { LOG_PREFIX }
 * @property {object} [log]
 * @property {() => Promise<void>} [verifyKey]  — override for tests; defaults to live Linear GraphQL
 */

export function createPortalIntegrationsRouter(deps) {
  if (!deps) throw new TypeError('createPortalIntegrationsRouter: deps required');
  const {
    authenticatePortalRequest,
    tryGetDb,
    putEncryptedSecret,
    deleteSecretForAgent,
    config,
    log,
    verifyKey = verifyLinearKey,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalIntegrationsRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalIntegrationsRouter: tryGetDb required');
  }
  if (typeof putEncryptedSecret !== 'function') {
    throw new TypeError('createPortalIntegrationsRouter: putEncryptedSecret required');
  }
  if (typeof deleteSecretForAgent !== 'function') {
    throw new TypeError('createPortalIntegrationsRouter: deleteSecretForAgent required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalIntegrationsRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const router = Router();

  router.get('/portal/integrations/linear', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const apiKey = process.env.LINEAR_API_KEY;
      const teamId = process.env.LINEAR_TEAM_ID;
      if (!apiKey) return res.json({ connected: false });

      const check = await verifyKey(apiKey);
      if (!check.ok) return res.json({ connected: false, error: check.error });

      const team = teamId ? check.teams.find(t => t.id === teamId) : null;
      res.json({
        connected: true,
        teamId: teamId || null,
        teamName: team ? team.name : (teamId ? null : `All teams (${check.teams.length})`),
        teamKey: team ? team.key : null,
        viewerName: check.viewer?.name || null,
      });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] Linear status check failed:`, e.message
      );
      res.status(500).json({ error: 'Failed to check Linear status' });
    }
  });

  router.post('/portal/integrations/linear', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { apiKey, teamId } = req.body || {};
      if (!isLinearApiKey(apiKey)) return res.status(400).json({ error: 'Invalid Linear API key format' });
      const teamIdTrimmed = (teamId || '').trim();
      if (teamIdTrimmed && !isUuid(teamIdTrimmed)) {
        return res.status(400).json({ error: 'Invalid team ID format (expected UUID or blank)' });
      }

      const check = await verifyKey(apiKey);
      if (!check.ok) return res.status(400).json({ error: `Linear rejected the key: ${check.error}` });
      let team = null;
      if (teamIdTrimmed) {
        team = check.teams.find(t => t.id === teamIdTrimmed);
        if (!team) return res.status(400).json({ error: 'Team ID not visible to this API key' });
      }

      // Store for each (agent, scope) pair. Empty team ID = all teams visible to the key.
      for (const { agent, scope } of LINEAR_SCOPED_AGENTS) {
        await putEncryptedSecret({
          key: 'LINEAR_API_KEY', value: apiKey, scope, agent,
          description: 'Linear API key (user-provided)',
        });
        await putEncryptedSecret({
          key: 'LINEAR_TEAM_ID', value: teamIdTrimmed, scope, agent,
          description: 'Linear team ID (blank = all teams)',
        });
      }

      // Refresh this process's env so the change is visible immediately here.
      // force=true bypasses the 5-min rate limit (otherwise a save right after
      // the last cron refresh would be a no-op until the next cron tick).
      // The agent-server.js after-refresh hook regenerates .claude/settings.json
      // so MCP servers (linear-tools etc.) pick up the new key without an
      // agent restart. Other agent processes will pick it up via their own
      // bootstrap cycle (~5 min). Failure here is non-fatal — secret is persisted.
      try {
        const { refreshSecrets } = await import('@mycelium/core/bootstrap-secrets.js');
        if (typeof refreshSecrets === 'function') await refreshSecrets({ force: true });
      } catch (err) {
        (logger.warn ? logger.warn.bind(logger) : console.warn)(
          `[${LOG_PREFIX}] refreshSecrets failed (non-fatal): ${err.message}`
        );
      }

      tryGetDb()?.audit.log({
        action: 'integrations.linear.connected',
        userId: user.id,
        ip: req.ip,
        details: team
          ? { teamKey: team.key, teamName: team.name }
          : { allTeams: true, teamCount: check.teams.length },
      }).catch(() => {});

      res.json({
        ok: true,
        teamName: team?.name
          || (check.teams.length > 1 ? `All teams (${check.teams.length})` : check.teams[0]?.name || null),
        teamKey: team?.key || null,
        viewerName: check.viewer?.name || null,
      });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] Linear connect failed:`, e.message
      );
      res.status(500).json({ error: 'Failed to save Linear credentials' });
    }
  });

  router.delete('/portal/integrations/linear', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      for (const { agent } of LINEAR_SCOPED_AGENTS) {
        await deleteSecretForAgent({ key: 'LINEAR_API_KEY', agent });
        await deleteSecretForAgent({ key: 'LINEAR_TEAM_ID', agent });
      }

      // Clear in-memory for this process; note that agents must restart
      // to fully forget the value (deleting env vars doesn't stop MCP tools
      // that already loaded them in their own process).
      delete process.env.LINEAR_API_KEY;
      delete process.env.LINEAR_TEAM_ID;

      tryGetDb()?.audit.log({
        action: 'integrations.linear.disconnected',
        userId: user.id,
        ip: req.ip,
      }).catch(() => {});

      res.json({ ok: true });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        `[${LOG_PREFIX}] Linear disconnect failed:`, e.message
      );
      res.status(500).json({ error: 'Failed to disconnect Linear' });
    }
  });

  (logger.info ? logger.info.bind(logger) : console.log)(
    `[${LOG_PREFIX}] portal-integrations-router mounted 3 handlers`
  );

  return router;
}

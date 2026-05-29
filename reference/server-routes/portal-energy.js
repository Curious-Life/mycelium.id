/**
 * Portal energy router (Phase 10 PR 7E, Wave 3.2).
 *
 * Token-usage ledger surface. Three read-only endpoints, each requiring
 * a portal session. Opt-in via ENERGY_LEDGER_ENABLED=1 — otherwise the
 * ledger is empty and summaries return zeros.
 *
 *   GET /portal/energy          — raw records (filtered by agent/model/process/date)
 *   GET /portal/energy/summary  — aggregated totals
 *   GET /portal/energy/live     — today's totals + agent liveness + ledger state
 *
 * @mycelium/core/energy{,-state}.js are dynamically imported so agents
 * that don't enable the ledger never load the module. getAgentRegistry
 * is injected so tests can substitute a controlled fleet.
 */

import { Router } from 'express';

/**
 * @typedef {object} CreatePortalEnergyRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => Record<string, { name: string, role: string, color: string, port: number }>} getAgentRegistry
 * @property {object} config  — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalEnergyRouter(deps) {
  if (!deps) throw new TypeError('createPortalEnergyRouter: deps required');
  const { authenticatePortalRequest, getAgentRegistry, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalEnergyRouter: authenticatePortalRequest required');
  }
  if (typeof getAgentRegistry !== 'function') {
    throw new TypeError('createPortalEnergyRouter: getAgentRegistry required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalEnergyRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const info = logger.info ? logger.info.bind(logger) : console.log;

  const router = Router();

  router.get('/portal/energy', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const { queryEnergy } = await import('@mycelium/core/energy.js');
      const opts = {
        agent: req.query.agent || undefined,
        model: req.query.model || undefined,
        process: req.query.process || undefined,
        days: parseInt(req.query.days, 10) || 7,
        from: req.query.from || undefined,
        to: req.query.to || undefined,
      };
      const records = await queryEnergy(opts);
      res.json({ records, count: records.length });
    } catch {
      res.status(500).json({ error: 'Failed to query energy records' });
    }
  });

  router.get('/portal/energy/summary', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const { energySummary } = await import('@mycelium/core/energy.js');
      const opts = {
        agent: req.query.agent || undefined,
        model: req.query.model || undefined,
        days: parseInt(req.query.days, 10) || 7,
        from: req.query.from || undefined,
        to: req.query.to || undefined,
      };
      res.json(await energySummary(opts));
    } catch {
      res.status(500).json({ error: 'Failed to generate energy summary' });
    }
  });

  router.get('/portal/energy/live', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const { energySummary } = await import('@mycelium/core/energy.js');

      let energyState = null;
      try {
        const m = await import('@mycelium/core/energy-state.js');
        energyState = await m.getEnergyState();
      } catch { /* optional — ledger not enabled on this instance */ }

      const todaySummary = await energySummary({ days: 1 });
      const agentList = await Promise.all(
        Object.entries(getAgentRegistry()).map(async ([agentId, infoEntry]) => {
          try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 3000);
            const h = await (await fetch(`http://localhost:${infoEntry.port}/health`, { signal: controller.signal })).json();
            clearTimeout(t);
            return {
              id: agentId,
              name: infoEntry.name,
              role: infoEntry.role,
              color: infoEntry.color,
              status: 'online',
              model: h.lastModelUsed || h.model,
              messagesThisHour: h.state?.messagesThisHour || 0,
              messagesToday: h.state?.messagesToday || 0,
              activeTasks: h.state?.activeTasks || 0,
            };
          } catch {
            return { id: agentId, name: infoEntry.name, role: infoEntry.role, color: infoEntry.color, status: 'offline' };
          }
        }),
      );

      res.json({ timestamp: new Date().toISOString(), today: todaySummary, energyState, agents: agentList });
    } catch {
      res.status(500).json({ error: 'Failed to fetch live energy state' });
    }
  });

  info(`[${LOG_PREFIX}] portal-energy-router mounted 3 handlers`);

  return router;
}

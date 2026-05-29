/**
 * Portal intel router (Phase 10 PR 7F).
 *
 * Fourteen read-only proxies backing the portal Intel tab. Every handler
 * requires `authenticatePortalRequest` and hits an upstream service:
 *
 *   Polymarket Intelligence (6 handlers — `polymarketFetch` helper):
 *     GET /portal/intel/recommendations
 *     GET /portal/intel/signals
 *     GET /portal/intel/entities
 *     GET /portal/intel/insiders
 *     GET /portal/intel/markets/search
 *     GET /portal/intel/market/:conditionId
 *
 *   War Room report (1 handler — reads SITUATION_REPORT.md from disk,
 *                    stores new versions to D1 + enrichment pipeline):
 *     GET /portal/intel/report
 *
 *   War Room Dashboard (9 handlers — loopback proxy to FastAPI on
 *                       constants.warRoomPort, default 8050):
 *     GET /portal/intel/warroom-state
 *     GET /portal/intel/bases
 *     GET /portal/intel/infrastructure
 *     GET /portal/intel/cii
 *     GET /portal/intel/events-feed
 *     GET /portal/intel/convergence
 *     GET /portal/intel/trending         (short proxy)
 *     GET /portal/intel/oref             (short proxy)
 *     GET /portal/intel/ais              (short proxy)
 *     GET /portal/intel/gpsjam           (short proxy)
 *     GET /portal/intel/finnhub          (short proxy)
 *     GET /portal/intel/markets-geo      (short proxy)
 *
 *   OpenSky Network (1 handler — public free API; filters to military
 *                    callsigns + conflict-zone ISR at >10km altitude):
 *     GET /portal/intel/opensky
 *
 * The report handler's dedupe cache (`lastReportHash`) is kept in factory
 * closure so each createApp() instance owns its own — tests don't leak.
 *
 * NOTE: `pushIntelSnapshot` (the 15-min cron that pushes aggregated state
 * to Worker KV for the public intel page) stays in agent-server.js because
 * it runs at process scope via setTimeout/setInterval, not as a route.
 */

import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { execSync } from 'child_process';

/**
 * @typedef {object} CreatePortalIntelRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {(rows: any[], userId: string, agentId: string) => any} [enrichMessages]
 * @property {object} config  — { LOG_PREFIX }
 * @property {object} [log]
 * @property {object} [constants]  — optional env overrides; falls back to process.env
 */

export function createPortalIntelRouter(deps) {
  if (!deps) throw new TypeError('createPortalIntelRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, enrichMessages, storeSyntheticMessage, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalIntelRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalIntelRouter: tryGetDb required');
  }
  if (typeof storeSyntheticMessage !== 'function') {
    throw new TypeError('createPortalIntelRouter: storeSyntheticMessage required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalIntelRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const err = logger.error ? logger.error.bind(logger) : console.error;
  const info = logger.info ? logger.info.bind(logger) : console.log;

  // Read env at request time, not construction time — makes the router
  // hot-reload-safe if the operator rotates credentials via Worker secrets.
  function polymarketHeaders() {
    const user = process.env.POLYMARKET_API_USER;
    const pass = process.env.POLYMARKET_API_PASSWORD;
    if (!user || !pass) return null;
    return {
      Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
      Accept: 'application/json',
    };
  }

  async function polymarketFetch(endpoint, params = {}) {
    const baseUrl = process.env.POLYMARKET_API_URL;
    if (!baseUrl) throw new Error('POLYMARKET_API_URL not configured');
    const headers = polymarketHeaders();
    if (!headers) throw new Error('Polymarket credentials not configured');

    const url = new URL(endpoint, baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    const resp = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`Polymarket API ${resp.status}`);
    return resp.json();
  }

  function warRoomPort() {
    return process.env.WARROOM_DASHBOARD_PORT || '8050';
  }

  // Generic war-room dashboard proxy. Used for the six short endpoints
  // (trending / oref / ais / gpsjam / finnhub / markets-geo) and again
  // inline where a handler needs to compose query params.
  const wrProxy = (upstreamPath) => async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const port = warRoomPort();
      const resp = await fetch(`http://127.0.0.1:${port}${upstreamPath}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) throw new Error(`War room ${upstreamPath} returned ${resp.status}`);
      res.json(await resp.json());
    } catch (e) {
      err(`[${LOG_PREFIX}] [intel] ${upstreamPath} failed: ${e.message}`);
      res.status(500).json({ error: `${upstreamPath} unavailable` });
    }
  };

  // Dedup cache for situation-report ingestion. Scoped to this router
  // instance so tests stay isolated.
  let lastReportHash = '';

  const router = Router();

  // ── Polymarket Intelligence proxies ────────────────────────────────

  router.get('/portal/intel/recommendations', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const { hours, min_conf, limit } = req.query;
      const data = await polymarketFetch('/api/recommendations', { hours, min_conf, limit });
      res.json({ recommendations: data });
    } catch (e) {
      err(`[${LOG_PREFIX}] [intel] recommendations failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to fetch recommendations' });
    }
  });

  router.get('/portal/intel/signals', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const { hours, signal_type, limit } = req.query;
      const data = await polymarketFetch('/api/signals', { hours, signal_type, limit });
      res.json({ signals: data });
    } catch (e) {
      err(`[${LOG_PREFIX}] [intel] signals failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to fetch signals' });
    }
  });

  router.get('/portal/intel/entities', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const { limit } = req.query;
      const data = await polymarketFetch('/api/entities', { limit });
      res.json({ entities: data });
    } catch (e) {
      err(`[${LOG_PREFIX}] [intel] entities failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to fetch entities' });
    }
  });

  router.get('/portal/intel/insiders', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const { tier, limit } = req.query;
      const data = await polymarketFetch('/api/insiders', { tier, limit });
      res.json({ insiders: data });
    } catch (e) {
      err(`[${LOG_PREFIX}] [intel] insiders failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to fetch insiders' });
    }
  });

  router.get('/portal/intel/markets/search', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const { q, active_only, limit } = req.query;
      if (!q) return res.json({ markets: [] });
      const data = await polymarketFetch('/api/search', { q, active_only, limit });
      res.json({ markets: data });
    } catch (e) {
      err(`[${LOG_PREFIX}] [intel] search failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to search markets' });
    }
  });

  router.get('/portal/intel/market/:conditionId', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const data = await polymarketFetch(`/api/market/${req.params.conditionId}`);
      res.json({ market: data });
    } catch (e) {
      err(`[${LOG_PREFIX}] [intel] market detail failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to fetch market detail' });
    }
  });

  // ── War Room situation report ──────────────────────────────────────

  router.get('/portal/intel/report', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const warRoomPath = process.env.WARROOM_PATH;
      if (!warRoomPath) return res.json({ report: null, message: 'War room not configured' });

      const reportPath = path.join(warRoomPath, 'SITUATION_REPORT.md');
      try {
        const content = await fs.readFile(reportPath, 'utf8');
        let lastUpdated = null;
        try {
          lastUpdated = execSync(`git log -1 --format='%aI' -- SITUATION_REPORT.md`, {
            encoding: 'utf8',
            cwd: warRoomPath,
          }).trim();
        } catch { /* git not available or no commits */ }

        // Ingest new versions into D1 for enrichment + semantic search.
        const contentHash = Buffer.from(content).toString('base64').slice(0, 32);
        if (contentHash !== lastReportHash) {
          lastReportHash = contentHash;
          try {
            const userId = user.userId || process.env.USER_ID;
            await storeSyntheticMessage({
              userId,
              role: 'assistant',
              source: 'intel_report',
              content: `# Situation Report\n\n${content}`,
              agentIdOverride: 'intel-agent',
              createdAt: lastUpdated ? new Date(lastUpdated) : new Date(),
              metadata: {
                origin: 'synthetic',
                channel: 'intel',
                extra: {
                  reportContentLength: content.length,
                  contentHash: contentHash.slice(0, 16),
                },
              },
            });
            info(`[${LOG_PREFIX}] [intel] Stored situation report in D1 (${content.length} chars)`);
          } catch (dbErr) {
            err(`[${LOG_PREFIX}] [intel] Failed to store report in D1: ${dbErr.message}`);
          }
        }

        res.json({ report: content, lastUpdated });
      } catch (e) {
        if (e.code === 'ENOENT') {
          return res.json({
            report: null,
            message: 'No situation report yet — Apollo will create one on the next cycle',
          });
        }
        throw e;
      }
    } catch (e) {
      err(`[${LOG_PREFIX}] [intel] report failed: ${e.message}`);
      res.status(500).json({ error: 'Failed to load situation report' });
    }
  });

  // ── War Room dashboard proxies (parametrised) ──────────────────────

  router.get('/portal/intel/warroom-state', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const resp = await fetch(`http://127.0.0.1:${warRoomPort()}/api/state`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) throw new Error(`War room API ${resp.status}`);
      res.json(await resp.json());
    } catch (e) {
      err(`[${LOG_PREFIX}] [intel] warroom-state failed: ${e.message}`);
      res.status(500).json({ error: 'War room state unavailable' });
    }
  });

  router.get('/portal/intel/bases', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const resp = await fetch(`http://127.0.0.1:${warRoomPort()}/api/bases`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) throw new Error(`War room bases API ${resp.status}`);
      res.json(await resp.json());
    } catch (e) {
      err(`[${LOG_PREFIX}] [intel] bases failed: ${e.message}`);
      res.status(500).json({ error: 'Bases data unavailable' });
    }
  });

  router.get('/portal/intel/infrastructure', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const url = new URL(`http://127.0.0.1:${warRoomPort()}/api/infrastructure`);
      if (req.query.infra_type) url.searchParams.set('infra_type', req.query.infra_type);
      const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) throw new Error(`War room infrastructure API ${resp.status}`);
      res.json(await resp.json());
    } catch (e) {
      err(`[${LOG_PREFIX}] [intel] infrastructure failed: ${e.message}`);
      res.status(500).json({ error: 'Infrastructure data unavailable' });
    }
  });

  router.get('/portal/intel/cii', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const resp = await fetch(`http://127.0.0.1:${warRoomPort()}/api/cii`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) throw new Error(`CII API ${resp.status}`);
      res.json(await resp.json());
    } catch (e) {
      err(`[${LOG_PREFIX}] [intel] cii failed: ${e.message}`);
      res.status(500).json({ error: 'CII data unavailable' });
    }
  });

  router.get('/portal/intel/events-feed', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const hours = req.query.hours || '24';
      const limit = req.query.limit || '100';
      const source = req.query.source || '';
      const url = new URL(`http://127.0.0.1:${warRoomPort()}/api/events`);
      url.searchParams.set('hours', hours);
      url.searchParams.set('limit', limit);
      if (source) url.searchParams.set('source', source);
      const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) throw new Error(`Events API ${resp.status}`);
      res.json(await resp.json());
    } catch (e) {
      err(`[${LOG_PREFIX}] [intel] events-feed failed: ${e.message}`);
      res.status(500).json({ error: 'Events feed unavailable' });
    }
  });

  router.get('/portal/intel/convergence', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const resp = await fetch(`http://127.0.0.1:${warRoomPort()}/api/convergence`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) throw new Error(`Convergence API ${resp.status}`);
      res.json(await resp.json());
    } catch (e) {
      err(`[${LOG_PREFIX}] [intel] convergence failed: ${e.message}`);
      res.status(500).json({ error: 'Convergence data unavailable' });
    }
  });

  // ── Short war-room dashboard proxies ───────────────────────────────

  router.get('/portal/intel/trending',    wrProxy('/api/trending'));
  router.get('/portal/intel/oref',        wrProxy('/api/oref'));
  router.get('/portal/intel/ais',         wrProxy('/api/ais'));
  router.get('/portal/intel/gpsjam',      wrProxy('/api/gpsjam'));
  router.get('/portal/intel/finnhub',     wrProxy('/api/finnhub'));
  router.get('/portal/intel/markets-geo', wrProxy('/api/markets/geo'));

  // ── OpenSky live aircraft ──────────────────────────────────────────

  router.get('/portal/intel/opensky', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const resp = await fetch('https://opensky-network.org/api/states/all', {
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) throw new Error(`OpenSky API ${resp.status}`);
      const data = await resp.json();

      // OpenSky row layout:
      //   [icao24, callsign, origin_country, time_position, last_contact,
      //    longitude, latitude, baro_altitude, on_ground, velocity,
      //    true_track, vertical_rate, sensors, geo_altitude, squawk, spi,
      //    position_source]
      const militaryPrefixes = ['RCH', 'FORTE', 'HOMER', 'JAKE', 'DUKE', 'IRON', 'NCHO',
        'LAGR', 'VIPER', 'HAWK', 'REAP', 'EVIL', 'TOPG', 'VADER', 'BANZAI', 'HAVOC', 'KNIFE'];
      const interestRegions = [
        { name: 'Middle East',       minLat: 12, maxLat: 42, minLng:  25, maxLng: 65 },
        { name: 'Ukraine',           minLat: 44, maxLat: 53, minLng:  22, maxLng: 42 },
        { name: 'Taiwan Strait',     minLat: 20, maxLat: 28, minLng: 115, maxLng: 125 },
        { name: 'South China Sea',   minLat:  5, maxLat: 22, minLng: 105, maxLng: 122 },
        { name: 'Baltic',            minLat: 53, maxLat: 60, minLng:  14, maxLng: 30 },
        { name: 'Korean Peninsula',  minLat: 33, maxLat: 43, minLng: 124, maxLng: 132 },
      ];

      const filtered = (data.states || []).filter((s) => {
        if (!s[6] || !s[5]) return false;
        if (s[8]) return false;  // on ground
        const callsign = (s[1] || '').trim().toUpperCase();
        const lat = s[6], lng = s[5];
        if (militaryPrefixes.some((p) => callsign.startsWith(p))) return true;
        const alt = s[7] || 0;
        if (alt > 10000) {
          for (const r of interestRegions) {
            if (lat >= r.minLat && lat <= r.maxLat && lng >= r.minLng && lng <= r.maxLng) return true;
          }
        }
        return false;
      }).map((s) => ({
        icao24: s[0],
        callsign: (s[1] || '').trim(),
        origin: s[2],
        lat: s[6],
        lng: s[5],
        altitude: s[7],
        velocity: s[9],
        heading: s[10],
        on_ground: s[8],
      }));

      res.json({ aircraft: filtered, time: data.time });
    } catch (e) {
      err(`[${LOG_PREFIX}] [intel] opensky failed: ${e.message}`);
      res.json({ aircraft: [], time: null, error: 'Aircraft data unavailable' });
    }
  });

  info(`[${LOG_PREFIX}] portal-intel-router mounted 14 handlers`);

  return router;
}

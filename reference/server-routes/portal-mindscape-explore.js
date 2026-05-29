/**
 * Portal mindscape explore router (Phase 10 PR 7C-c, explore slice).
 *
 * Owns the exploration workflow that runs `describe-chronicles.js` and
 * streams per-territory progress via Server-Sent Events. 5 handlers:
 *
 *   GET  /portal/mindscape/exploration-status           — overall progress
 *   POST /portal/mindscape/explore                      — spawn + register SSE
 *   GET  /portal/mindscape/explore/status/:jobId        — poll / abandon check
 *   GET  /portal/mindscape/explore/stream/:jobId        — SSE channel (live + replay)
 *   GET  /portal/mindscape/explore/report/:jobId        — pass-notes summary
 *
 * Robustness contract:
 *   - Job state persists to D1 `background_jobs`.
 *   - `exploreRunning` Map tracks child, timers, event buffer, and live SSE
 *     listeners per job id.
 *   - Startup IIFE marks pre-restart 'running' jobs as 'abandoned'.
 *   - Heartbeat 10 s; stale > 25 s AND absent from map → status 'abandoned'.
 *   - Hard timeout 30 min (SIGTERM → SIGKILL 5 s later).
 *   - Per-user concurrency guard + 10-min cooldown.
 *   - Replay buffer capped at 200 events (FIFO) so late SSE joiners still
 *     see the trailing story without unbounded memory growth.
 *   - SSE listener registry cleans up on `req.close`; `child.on('exit')`
 *     end()s all listeners + clears the set (no orphan responses).
 *
 * Security contract:
 *   - Request fields (limit, period, realm, territory) are clamped /
 *     regex-scrubbed before being passed as spawn args.
 *   - Env allowlist: PATH/HOME/USER/NODE_ENV/LANG only.
 *   - Regex-validate jobId before any DB touch.
 *   - IDOR guard on status + report (user.id must match job.user_id).
 *   - CSRF enforced globally.
 *
 * Ownership note on SSE stream:
 *   Stream lookup is keyed on `exploreRunning.get(jobId)`, which only
 *   holds jobs spawned in THIS process. Because jobIds are
 *   `exp_<timestamp>_<randomBytes(4)>`, they're unguessable. An explicit
 *   DB-backed user-id check before registering as listener adds a belt to
 *   the suspenders without an extra round-trip on hot path.
 */

import crypto from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import { Router } from 'express';

const EXPLORE_COOLDOWN_MS = 10 * 60 * 1000;       // 10 min
const EXPLORE_MAX_DURATION_MS = 30 * 60 * 1000;   // 30 min
const EXPLORE_HEARTBEAT_MS = 10_000;              // 10 s
const EXPLORE_MAX_LIMIT = 100;
const EXPLORE_EVENT_BUFFER_CAP = 200;
const JOB_ID_RE = /^exp_[a-z0-9_]{1,48}$/;

/**
 * @typedef {object} CreatePortalMindscapeExploreRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {object} config                       — { LOG_PREFIX, REPO_ROOT }
 * @property {object} [log]
 */

export function createPortalMindscapeExploreRouter(deps) {
  if (!deps) throw new TypeError('createPortalMindscapeExploreRouter: deps required');
  const {
    authenticatePortalRequest,
    tryGetDb,
    config,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalMindscapeExploreRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalMindscapeExploreRouter: tryGetDb required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalMindscapeExploreRouter: config.LOG_PREFIX required');
  }
  if (!config?.REPO_ROOT) {
    throw new TypeError('createPortalMindscapeExploreRouter: config.REPO_ROOT required');
  }

  const { LOG_PREFIX, REPO_ROOT } = config;
  const logger = log || console;
  const router = Router();

  // jobId -> { child, heartbeatTimer, timeoutTimer, events: Array, listeners: Set<res> }
  const exploreRunning = new Map();

  const dbUpdateJob = async (db, jobId, fields) => {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => fields[k]);
    values.push(jobId);
    await db.rawQuery(`UPDATE background_jobs SET ${sets} WHERE id = ?`, values);
  };

  // Clean up ghost 'running' rows left over from a prior crash. Fire-and-forget.
  (async () => {
    try {
      const db = tryGetDb();
      if (!db) return;
      await db.rawQuery(
        "UPDATE background_jobs SET status = 'abandoned', error = 'agent-server restarted', finished_at = datetime('now') WHERE kind = 'explore_chronicles' AND status = 'running'",
        [],
      );
    } catch (err) {
      logger.error?.(`[${LOG_PREFIX}] explore startup cleanup failed:`, err.message);
    }
  })();

  // ── GET /portal/mindscape/exploration-status ─────────────────────────
  router.get('/portal/mindscape/exploration-status', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      // clustering_points is the source of truth for total count
      // (territory_profiles.message_count drifts over time).
      const [stats] = await db.rawQuery(
        `SELECT
          COUNT(*) as total_territories,
          COUNT(chronicle) as with_chronicles,
          COALESCE(SUM(explored_count), 0) as messages_analyzed,
          MAX(last_described_at) as last_run_at,
          ROUND(COALESCE(SUM(explored_percent * message_count), 0) * 1.0 / NULLIF(SUM(message_count), 0), 1) as global_explored_percent
        FROM territory_profiles WHERE user_id = ?`,
        [user.id],
      );
      const [cpStats] = await db.rawQuery(
        `SELECT COUNT(*) as total_points FROM clustering_points WHERE user_id = ?`,
        [user.id],
      );

      const runningJobs = await db.rawQuery(
        "SELECT id FROM background_jobs WHERE user_id = ? AND kind = 'explore_chronicles' AND status = 'running' LIMIT 1",
        [user.id],
      );

      const totalPoints = cpStats?.total_points || 0;
      const analyzed = stats?.messages_analyzed || 0;
      const globalPct = totalPoints > 0 ? Math.round((analyzed / totalPoints) * 1000) / 10 : 0;

      res.json({
        globalExploredPercent: globalPct,
        territoriesWithChronicles: stats?.with_chronicles || 0,
        totalTerritories: stats?.total_territories || 0,
        totalMessages: totalPoints,
        messagesAnalyzed: analyzed,
        lastRunAt: stats?.last_run_at || null,
        explorationRunning: runningJobs.length > 0,
        explorationJobId: runningJobs[0]?.id || null,
      });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] exploration-status failed:`, e.message);
      res.status(500).json({ error: 'Failed to get exploration status' });
    }
  });

  // ── POST /portal/mindscape/explore ───────────────────────────────────
  router.post('/portal/mindscape/explore', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const limit = Math.min(Math.max(parseInt(req.body?.limit, 10) || 10, 1), EXPLORE_MAX_LIMIT);
      const period = req.body?.period ? String(req.body.period).replace(/[^0-9-]/g, '').slice(0, 10) : null;
      const realm = req.body?.realm != null ? parseInt(req.body.realm, 10) : null;
      const territory = req.body?.territory != null ? parseInt(req.body.territory, 10) : null;

      const running = await db.rawQuery(
        "SELECT id FROM background_jobs WHERE user_id = ? AND kind = 'explore_chronicles' AND status = 'running' LIMIT 1",
        [user.id],
      );
      if (running.length > 0) {
        return res.json({ jobId: running[0].id, status: 'already_running' });
      }

      const recent = await db.rawQuery(
        "SELECT finished_at FROM background_jobs WHERE user_id = ? AND kind = 'explore_chronicles' AND status IN ('done', 'error') ORDER BY finished_at DESC LIMIT 1",
        [user.id],
      );
      if (recent.length > 0 && recent[0].finished_at) {
        const elapsed = Date.now() - new Date(recent[0].finished_at).getTime();
        if (elapsed < EXPLORE_COOLDOWN_MS) {
          const retryAfterSec = Math.ceil((EXPLORE_COOLDOWN_MS - elapsed) / 1000);
          return res.status(429).json({ error: 'Cooldown active', retryAfter: retryAfterSec });
        }
      }

      const scriptPath = path.join(REPO_ROOT, 'scripts', 'describe-chronicles.js');
      const jobId = `exp_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
      const startedAt = new Date().toISOString();

      await db.rawQuery(
        `INSERT INTO background_jobs (id, user_id, kind, status, step, total_steps, stage_label, started_at, last_heartbeat)
         VALUES (?, ?, 'explore_chronicles', 'running', 0, ?, 'Starting exploration…', ?, ?)`,
        [jobId, user.id, limit, startedAt, startedAt],
      );

      const childEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USER: process.env.USER,
        NODE_ENV: process.env.NODE_ENV || 'production',
        LANG: process.env.LANG || 'en_US.UTF-8',
        // AGENT_ID drives scope inference inside @mycelium/core/db-d1.js d1Query.
        // Without it, inferScope() defaults to 'org' and writes to realms /
        // semantic_themes / territory_profiles encrypt under the wrong scope.
        // AGENT_SCOPES must match personal-agent's full scope set so reads
        // of historical scope='personal' rows don't silently
        // ScopeViolationError post-migration.
        AGENT_ID: 'personal-agent',
        AGENT_SCOPES: '["personal","org","wealth","moms"]',
      };

      const scriptArgs = ['--limit', String(limit)];
      if (period) scriptArgs.push('--period', period);
      if (realm != null && !isNaN(realm)) scriptArgs.push('--realm', String(realm));
      if (territory != null && !isNaN(territory)) scriptArgs.push('--territory', String(territory));

      const child = spawn('node', [scriptPath, ...scriptArgs], {
        cwd: REPO_ROOT,
        env: childEnv,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const jobState = { step: 0, totalSteps: limit, stageLabel: 'Starting exploration…', currentTerritory: '' };
      const eventBuffer = [];          // replay buffer for late joiners
      const sseListeners = new Set();  // active res objects

      const emitSSE = (event) => {
        eventBuffer.push(event);
        if (eventBuffer.length > EXPLORE_EVENT_BUFFER_CAP) eventBuffer.shift();
        for (const r of sseListeners) {
          try { r.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
        }
      };

      const persistProgress = async () => {
        try {
          await dbUpdateJob(db, jobId, {
            step: jobState.step,
            total_steps: jobState.totalSteps,
            stage_label: jobState.stageLabel,
            last_heartbeat: new Date().toISOString(),
          });
        } catch {}
      };

      const parseLine = (line) => {
        // Structured events from describe-chronicles.js: `@@EVENT:<type>:<json>`
        const eventMatch = line.match(/^@@EVENT:(\w+):(.+)$/);
        if (eventMatch) {
          try {
            const event = { type: eventMatch[1], ...JSON.parse(eventMatch[2]) };
            emitSSE(event);
            if (event.type === 'territory_done' || event.type === 'territory_skip' || event.type === 'territory_error') {
              jobState.step++;
              jobState.stageLabel = event.name ? `${event.name}` : `T${event.id}`;
              persistProgress().catch(() => {});
            }
          } catch {}
          return;
        }
        // Plaintext fallbacks for any line that doesn't match the structured format.
        const terrMatch = line.match(/T(\d+)\s.*\.\.\.\s*(.*)/);
        if (terrMatch) {
          jobState.currentTerritory = `T${terrMatch[1]}`;
          jobState.stageLabel = `${jobState.currentTerritory}: ${terrMatch[2].trim()}`;
        }
        const phaseMatch = line.match(/Phase (\d).*?:\s*(.*)/);
        if (phaseMatch) {
          jobState.stageLabel = phaseMatch[2].trim();
        }
      };

      let stdoutBuffer = '';
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        let idx;
        while ((idx = stdoutBuffer.indexOf('\n')) !== -1) {
          parseLine(stdoutBuffer.slice(0, idx));
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
        }
      });
      child.stderr.on('data', () => {}); // stderr is noise for explore; drop it

      const heartbeatTimer = setInterval(() => persistProgress().catch(() => {}), EXPLORE_HEARTBEAT_MS);
      const timeoutTimer = setTimeout(() => {
        if (!child.killed) {
          try { child.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
        }
      }, EXPLORE_MAX_DURATION_MS);

      exploreRunning.set(jobId, { child, heartbeatTimer, timeoutTimer, events: eventBuffer, listeners: sseListeners, userId: user.id });

      const finalize = async (status, error) => {
        clearInterval(heartbeatTimer);
        clearTimeout(timeoutTimer);
        exploreRunning.delete(jobId);
        try {
          await dbUpdateJob(db, jobId, {
            status,
            step: status === 'done' ? jobState.totalSteps : jobState.step,
            stage_label: status === 'done' ? 'Exploration complete' : jobState.stageLabel,
            finished_at: new Date().toISOString(),
            error: error || null,
          });
        } catch {}
      };

      child.on('exit', (code) => {
        emitSSE({ type: 'job_done', status: code === 0 ? 'done' : 'error' });
        for (const r of sseListeners) { try { r.end(); } catch {} }
        sseListeners.clear();
        finalize(code === 0 ? 'done' : 'error', code !== 0 ? `Exited with code ${code}` : null);
      });
      child.on('error', (err) => {
        emitSSE({ type: 'job_done', status: 'error', error: err.message });
        for (const r of sseListeners) { try { r.end(); } catch {} }
        sseListeners.clear();
        finalize('error', err.message);
      });

      try {
        await db.rawQuery('UPDATE background_jobs SET pid = ? WHERE id = ?', [child.pid || null, jobId]);
      } catch {}

      res.json({ jobId, status: 'running' });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] explore failed:`, e.message);
      res.status(500).json({ error: 'Failed to start exploration' });
    }
  });

  // ── GET /portal/mindscape/explore/status/:jobId ──────────────────────
  router.get('/portal/mindscape/explore/status/:jobId', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      if (!JOB_ID_RE.test(req.params.jobId)) {
        return res.status(400).json({ error: 'Invalid job id' });
      }

      const rows = await db.rawQuery(
        "SELECT id, user_id, status, step, total_steps, stage_label, started_at, finished_at, error, last_heartbeat FROM background_jobs WHERE id = ? AND kind = 'explore_chronicles'",
        [req.params.jobId],
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Job not found' });
      const job = rows[0];
      if (job.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

      let status = job.status;
      if (status === 'running' && job.last_heartbeat) {
        const heartbeatAge = Date.now() - new Date(job.last_heartbeat).getTime();
        if (heartbeatAge > 2 * EXPLORE_HEARTBEAT_MS + 5000 && !exploreRunning.has(job.id)) {
          status = 'abandoned';
          await dbUpdateJob(db, job.id, {
            status: 'abandoned',
            error: 'Heartbeat stalled',
            finished_at: new Date().toISOString(),
          }).catch(() => {});
        }
      }

      res.json({
        id: job.id, status,
        step: job.step, totalSteps: job.total_steps,
        stageLabel: job.stage_label,
        startedAt: job.started_at, finishedAt: job.finished_at,
        error: job.error,
      });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] explore/status failed:`, e.message);
      res.status(500).json({ error: 'Failed to get job status' });
    }
  });

  // ── GET /portal/mindscape/explore/stream/:jobId ──────────────────────
  router.get('/portal/mindscape/explore/stream/:jobId', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      if (!JOB_ID_RE.test(req.params.jobId)) {
        return res.status(400).json({ error: 'Invalid job id' });
      }

      const running = exploreRunning.get(req.params.jobId);
      if (!running) {
        return res.status(404).json({ error: 'Job not found or already completed' });
      }
      // Belt + suspenders: the map-key check already requires the job to
      // be alive in this process, but reject cross-user attempts anyway.
      if (running.userId && running.userId !== user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // Replay buffered events so late joiners still see the opening act.
      for (const event of running.events) {
        try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
      }

      running.listeners.add(res);
      req.on('close', () => { running.listeners.delete(res); });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] explore/stream failed:`, e.message);
      if (!res.headersSent) res.status(500).json({ error: 'Streaming failed' });
    }
  });

  // ── GET /portal/mindscape/explore/report/:jobId ──────────────────────
  router.get('/portal/mindscape/explore/report/:jobId', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      if (!JOB_ID_RE.test(req.params.jobId)) {
        return res.status(400).json({ error: 'Invalid job id' });
      }

      const jobs = await db.rawQuery(
        "SELECT started_at, finished_at, step, total_steps FROM background_jobs WHERE id = ? AND user_id = ? AND kind = 'explore_chronicles'",
        [req.params.jobId, user.id],
      );
      if (!jobs.length) return res.status(404).json({ error: 'Job not found' });
      const job = jobs[0];

      const notes = await db.rawQuery(
        `SELECT tpn.territory_id, tpn.pass_number, tpn.points_seen, tpn.cumulative_percent,
                tpn.notes, tpn.key_entities, tpn.new_patterns, tpn.time_range, tpn.created_at,
                tp.name as territory_name, tp.explored_percent
         FROM territory_pass_notes tpn
         LEFT JOIN territory_profiles tp ON tp.territory_id = tpn.territory_id AND tp.user_id = tpn.user_id
         WHERE tpn.user_id = ? AND tpn.created_at >= ? AND tpn.created_at <= ?
         ORDER BY tpn.created_at`,
        [user.id, job.started_at, job.finished_at || new Date().toISOString()],
      );

      const territories = notes.map((n) => ({
        territoryId: n.territory_id,
        name: n.territory_name || `Territory ${n.territory_id}`,
        passNumber: n.pass_number,
        coverage: n.cumulative_percent,
        currentCoverage: n.explored_percent,
        notes: n.notes,
        keyEntities: (() => { try { return JSON.parse(n.key_entities); } catch { return []; } })(),
        newPatterns: (() => { try { return JSON.parse(n.new_patterns); } catch { return []; } })(),
        timeRange: n.time_range,
      }));

      res.json({
        jobId: req.params.jobId,
        startedAt: job.started_at,
        finishedAt: job.finished_at,
        territoriesProcessed: job.step,
        totalTarget: job.total_steps,
        territories,
      });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] explore/report failed:`, e.message);
      res.status(500).json({ error: 'Failed to get report' });
    }
  });

  logger.info?.('[portal-mindscape-explore-router] mounted 5 handlers');
  return router;
}

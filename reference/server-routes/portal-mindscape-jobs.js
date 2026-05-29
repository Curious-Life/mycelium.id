/**
 * Portal mindscape jobs router (Phase 10 PR 7C-c, jobs slice).
 *
 * Owns the "generate my mindscape" background job — the manual trigger
 * users can tap when they don't want to wait for the 2 AM clustering cron.
 * 2 handlers:
 *
 *   POST /portal/mycelium/generate                  — spawn run-clustering.sh
 *   GET  /portal/mycelium/generate/status/:jobId    — poll status / detect abandon
 *
 * Robustness contract (matches the pre-extraction agent-server behavior):
 *   - Job state persists to D1 `background_jobs` so it survives restarts.
 *   - In-memory `myceliumGenRunning` Map tracks child + timers per job so
 *     we can reliably detect abandoned jobs vs. jobs still running.
 *   - A startup IIFE marks any 'running' jobs as 'abandoned' on construction
 *     (restarts invalidate in-memory state — D1 would otherwise lie forever).
 *   - Heartbeat (10 s) keeps `last_heartbeat` fresh; 25 s stale + absent
 *     from `myceliumGenRunning` → status endpoint marks job 'abandoned'.
 *   - Hard timeout (45 min) SIGTERMs then SIGKILLs.
 *   - Per-user single-job concurrency via DB check.
 *   - 10-minute cooldown after completion (429 + Retry-After header).
 *
 * Security contract:
 *   - Hardcoded script path (no user input in `spawn` args).
 *   - Explicit env allowlist — no ambient secrets leak to child.
 *   - IDOR guard on status (user must own the job).
 *   - Job id regex-validated before any DB touch.
 *   - CSRF still enforced by the global middleware in app.js.
 */

import crypto from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import { existsSync } from 'fs';
import { Router } from 'express';

const MYCELIUM_GEN_COOLDOWN_MS = 10 * 60 * 1000;      // 10 min
const MYCELIUM_GEN_MAX_DURATION_MS = 45 * 60 * 1000;  // 45 min
const MYCELIUM_GEN_HEARTBEAT_MS = 10_000;             // 10 s
const MYCELIUM_STAGE_LABELS = {
  1: 'Syncing your content',
  2: 'Embedding and clustering',
  3: 'Writing territory chronicles',
  4: 'Naming realms and territories',
  5: 'Indexing for search',
  6: 'Computing connections',
  7: 'Measuring cognitive fingerprint',
  8: 'Computing vitality metrics',
};
const JOB_ID_RE = /^myc_[a-z0-9_]{1,48}$/;

/**
 * @typedef {object} CreatePortalMindscapeJobsRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {object} config                       — { LOG_PREFIX, REPO_ROOT }
 * @property {object} [log]
 */

export function createPortalMindscapeJobsRouter(deps) {
  if (!deps) throw new TypeError('createPortalMindscapeJobsRouter: deps required');
  const {
    authenticatePortalRequest,
    tryGetDb,
    config,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalMindscapeJobsRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalMindscapeJobsRouter: tryGetDb required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalMindscapeJobsRouter: config.LOG_PREFIX required');
  }
  if (!config?.REPO_ROOT) {
    throw new TypeError('createPortalMindscapeJobsRouter: config.REPO_ROOT required');
  }

  const { LOG_PREFIX, REPO_ROOT } = config;
  const logger = log || console;
  const router = Router();

  const AI_READY_FLAG = path.join(REPO_ROOT, '.ai-ready');

  // Per-router state: in-memory child + timer refs.
  const myceliumGenRunning = new Map();

  const dbUpdateJob = async (db, jobId, fields) => {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => fields[k]);
    values.push(jobId);
    await db.rawQuery(`UPDATE background_jobs SET ${sets} WHERE id = ?`, values);
  };

  // Startup: a previous agent-server crash could have left 'running' rows
  // in D1 with no process behind them. Mark them abandoned once, here, so
  // the next status poll doesn't report a ghost job. Fire-and-forget; an
  // inaccessible DB at boot just means we retry on the next restart.
  (async () => {
    try {
      const db = tryGetDb();
      if (!db) return;
      await db.rawQuery(
        "UPDATE background_jobs SET status = 'abandoned', error = 'agent-server restarted', finished_at = datetime('now') WHERE kind = 'mycelium_generate' AND status = 'running'",
        [],
      );
    } catch (err) {
      logger.error?.(`[${LOG_PREFIX}] mycelium startup cleanup failed:`, err.message);
    }
  })();

  // ── POST /portal/mycelium/generate ───────────────────────────────────
  router.post('/portal/mycelium/generate', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      if (!existsSync(AI_READY_FLAG)) {
        return res.status(503).json({
          error: 'ai_not_ready',
          message: 'AI models are still being set up. This usually takes 10-15 minutes after your vault was created.',
        });
      }

      // Per-user concurrency: at most one running job at a time.
      const running = await db.rawQuery(
        "SELECT id, started_at FROM background_jobs WHERE user_id = ? AND kind = 'mycelium_generate' AND status = 'running' LIMIT 1",
        [user.id],
      );
      if (running.length > 0) {
        return res.json({ jobId: running[0].id, status: 'already_running' });
      }

      // Cooldown window — 10 min from last finished job.
      const recent = await db.rawQuery(
        "SELECT finished_at FROM background_jobs WHERE user_id = ? AND kind = 'mycelium_generate' AND status IN ('done', 'error') ORDER BY finished_at DESC LIMIT 1",
        [user.id],
      );
      if (recent.length > 0 && recent[0].finished_at) {
        const elapsed = Date.now() - new Date(recent[0].finished_at).getTime();
        if (elapsed < MYCELIUM_GEN_COOLDOWN_MS) {
          const retryAfterSec = Math.ceil((MYCELIUM_GEN_COOLDOWN_MS - elapsed) / 1000);
          res.setHeader('Retry-After', String(retryAfterSec));
          return res.status(429).json({ error: 'Cooldown active', retryAfter: retryAfterSec });
        }
      }

      const scriptPath = path.join(REPO_ROOT, 'scripts', 'run-clustering.sh');

      const jobId = `myc_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
      const startedAt = new Date().toISOString();

      await db.rawQuery(
        `INSERT INTO background_jobs (id, user_id, kind, status, step, total_steps, stage_label, started_at, last_heartbeat)
         VALUES (?, ?, 'mycelium_generate', 'running', 0, 8, 'Starting…', ?, ?)`,
        [jobId, user.id, startedAt, startedAt],
      );

      // Env allowlist: run-clustering.sh sources its own .env; we pass only
      // the Node/locale vars the shell itself needs.
      const childEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USER: process.env.USER,
        NODE_ENV: process.env.NODE_ENV || 'production',
        LANG: process.env.LANG || 'en_US.UTF-8',
        LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
      };

      const child = spawn('bash', [scriptPath], {
        cwd: REPO_ROOT,
        env: childEnv,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const jobState = {
        step: 0,
        totalSteps: 8,
        stageLabel: 'Starting…',
        logTail: [],
      };

      const persistProgress = async () => {
        try {
          await dbUpdateJob(db, jobId, {
            step: jobState.step,
            total_steps: jobState.totalSteps,
            stage_label: jobState.stageLabel,
            last_heartbeat: new Date().toISOString(),
          });
        } catch (err) {
          logger.error?.(`[${LOG_PREFIX}] mycelium heartbeat failed:`, err.message);
        }
      };

      const parseStep = (line) => {
        const m = line.match(/Step\s+(\d+)\/(\d+):\s*(.*)/);
        if (m) {
          jobState.step = parseInt(m[1], 10);
          jobState.totalSteps = parseInt(m[2], 10);
          jobState.stageLabel = MYCELIUM_STAGE_LABELS[jobState.step] || m[3].trim();
          // Flush stage transitions immediately (don't wait for next heartbeat).
          persistProgress().catch(() => {});
        }
      };

      const handleLine = (line, isErr) => {
        if (!line.trim()) return;
        jobState.logTail.push(isErr ? `[err] ${line}` : line);
        if (jobState.logTail.length > 50) jobState.logTail.shift();
        if (!isErr) parseStep(line);
      };

      let stdoutBuffer = '';
      let stderrBuffer = '';
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        let idx;
        while ((idx = stdoutBuffer.indexOf('\n')) !== -1) {
          handleLine(stdoutBuffer.slice(0, idx), false);
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
        }
      });
      child.stderr.on('data', (chunk) => {
        stderrBuffer += chunk.toString();
        let idx;
        while ((idx = stderrBuffer.indexOf('\n')) !== -1) {
          handleLine(stderrBuffer.slice(0, idx), true);
          stderrBuffer = stderrBuffer.slice(idx + 1);
        }
      });

      const heartbeatTimer = setInterval(() => {
        persistProgress().catch(() => {});
      }, MYCELIUM_GEN_HEARTBEAT_MS);

      const timeoutTimer = setTimeout(() => {
        if (!child.killed) {
          logger.warn?.(`[${LOG_PREFIX}] mycelium job ${jobId} exceeded max duration, killing`);
          try { child.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
        }
      }, MYCELIUM_GEN_MAX_DURATION_MS);

      myceliumGenRunning.set(jobId, { child, heartbeatTimer, timeoutTimer });

      const finalize = async (status, error) => {
        clearInterval(heartbeatTimer);
        clearTimeout(timeoutTimer);
        myceliumGenRunning.delete(jobId);
        try {
          await dbUpdateJob(db, jobId, {
            status,
            step: status === 'done' ? jobState.totalSteps : jobState.step,
            stage_label: status === 'done' ? 'Complete' : jobState.stageLabel,
            finished_at: new Date().toISOString(),
            error: error || null,
          });
        } catch (err) {
          logger.error?.(`[${LOG_PREFIX}] mycelium finalize failed:`, err.message);
        }
      };

      child.on('exit', (code) => {
        if (code === 0) {
          finalize('done', null);
        } else {
          // Surface the actual failure reason so users see the root cause
          // instead of a bare exit code.
          const errLines = jobState.logTail.filter((l) => l.startsWith('[err] ')).map((l) => l.slice(6).trim()).filter(Boolean);
          const lastStderr = errLines.length ? errLines.slice(-3).join(' | ') : '';
          const detail = lastStderr ? ` — ${lastStderr.slice(0, 500)}` : '';
          finalize('error', `Clustering exited with code ${code}${detail}`);
        }
      });
      child.on('error', (err) => { finalize('error', err.message); });

      try {
        await db.rawQuery('UPDATE background_jobs SET pid = ? WHERE id = ?', [child.pid || null, jobId]);
      } catch {}

      res.json({ jobId, status: 'running' });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] mycelium/generate failed:`, e.message);
      res.status(500).json({ error: 'Failed to start generation' });
    }
  });

  // ── GET /portal/mycelium/generate/status/:jobId ──────────────────────
  router.get('/portal/mycelium/generate/status/:jobId', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      if (!JOB_ID_RE.test(req.params.jobId)) {
        return res.status(400).json({ error: 'Invalid job id' });
      }

      const rows = await db.rawQuery(
        "SELECT id, user_id, status, step, total_steps, stage_label, started_at, finished_at, error, last_heartbeat FROM background_jobs WHERE id = ? AND kind = 'mycelium_generate'",
        [req.params.jobId],
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Job not found' });
      const job = rows[0];

      if (job.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' });

      // Detect abandoned jobs: status=running but heartbeat is stale AND
      // the in-memory tracker doesn't know about it (would mean the process
      // crashed while the job was running).
      let status = job.status;
      if (status === 'running' && job.last_heartbeat) {
        const heartbeatAge = Date.now() - new Date(job.last_heartbeat).getTime();
        if (heartbeatAge > 2 * MYCELIUM_GEN_HEARTBEAT_MS + 5000 && !myceliumGenRunning.has(job.id)) {
          status = 'abandoned';
          await dbUpdateJob(db, job.id, {
            status: 'abandoned',
            error: 'Job heartbeat stalled — agent-server may have restarted',
            finished_at: new Date().toISOString(),
          }).catch(() => {});
        }
      }

      res.json({
        id: job.id,
        status,
        step: job.step,
        totalSteps: job.total_steps,
        stageLabel: job.stage_label,
        startedAt: job.started_at,
        finishedAt: job.finished_at,
        error: job.error,
      });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] mycelium/generate/status failed:`, e.message);
      res.status(500).json({ error: 'Failed to get job status' });
    }
  });

  logger.info?.('[portal-mindscape-jobs-router] mounted 2 handlers');
  return router;
}

/**
 * Portal pipeline router — user-facing read-only summary of the
 * data-pipeline state for the authenticated user's VPS.
 *
 * Wave P4 of docs/PIPELINE-COORDINATOR-PLAN.md. Complement to the
 * operator's /admin/pipeline/health — this endpoint is friendlier
 * (single state summary + a human label) and available to anyone
 * with a valid portal session, so a customer can see "processing
 * your data" rather than staring at a blank mindscape while the
 * coordinator fills territories / chronicles / vitality.
 *
 *   GET /portal/pipeline/status
 *
 * Response:
 *   {
 *     state: 'healthy' | 'processing' | 'waiting-for-data' | 'error',
 *     summary: string (human-readable one-liner),
 *     currentStage: string | null (stage that most recently fired),
 *     lastActivity: ISO timestamp | null,
 *     progress: { completed: number, total: number },
 *     quarantined: Array<{ stage, reason, since }>,
 *   }
 */

import { Router } from 'express';

const STAGE_LABELS = {
  'enrichment-liveness':      'Live enrichment daemon',
  'sync-clustering-points':   'Syncing new messages',
  'cluster':                  'Re-clustering territories',
  'describe-clusters':        'Naming territories',
  'compute-cofire':           'Mapping connections between territories',
  'compute-vitality':         'Computing territory vitality scores',
  'backfill-vitality':        'Projecting history backwards',
  'describe-chronicles':      'Writing territory chronicles',
  'time-chronicles-daily':    'Composing daily chronicles',
  'time-chronicles-weekly':   'Composing weekly chronicles',
  'time-chronicles-monthly':  'Composing monthly chronicles',
};

// Total stages the coordinator knows about (kept in sync with
// scripts/pipeline-health.js registry — if that grows, update here).
const TOTAL_STAGES = Object.keys(STAGE_LABELS).length;

export function createPortalPipelineRouter(deps) {
  if (!deps) throw new TypeError('createPortalPipelineRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalPipelineRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalPipelineRouter: tryGetDb required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalPipelineRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const router = Router();

  router.get('/portal/pipeline/status', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'DB unavailable' });

      // Resolve user_id exactly as the coordinator does.
      const userId =
        process.env.MINDSCAPE_OWNER_ID ||
        process.env.MYA_USER_ID ||
        user.id;

      const rows = await db.rawQuery(
        `SELECT stage_name, last_success_at, last_failure_at, last_failure_reason,
                consecutive_failures, quarantined, one_shot_complete_at,
                last_duration_ms, updated_at
         FROM pipeline_state
         WHERE user_id = ?
         ORDER BY stage_name`,
        [userId],
      );
      const stages = Array.isArray(rows) ? rows : (rows?.results || []);

      // Early exit: no pipeline_state rows yet → fresh install.
      if (stages.length === 0) {
        return res.json({
          state: 'waiting-for-data',
          summary: 'Waiting for the coordinator to start processing your data.',
          currentStage: null,
          lastActivity: null,
          progress: { completed: 0, total: TOTAL_STAGES },
          quarantined: [],
        });
      }

      // Derive state + summary.
      const quarantined = stages
        .filter((s) => s.quarantined)
        .map((s) => ({
          stage: s.stage_name,
          reason: (s.last_failure_reason || 'unknown').slice(0, 180),
          since: s.last_failure_at,
        }));

      const completed = stages.filter((s) => s.last_success_at || s.one_shot_complete_at).length;
      const lastActivityRow = stages.reduce((latest, s) => {
        const ts = s.updated_at;
        if (!ts) return latest;
        if (!latest?.updated_at) return s;
        return Date.parse(ts) > Date.parse(latest.updated_at) ? s : latest;
      }, null);
      const lastActivity = lastActivityRow?.updated_at || null;

      // Classify current state. Priority: error > processing > healthy > waiting.
      let state = 'healthy';
      let summary = 'Your mindscape is up to date.';
      let currentStage = null;

      if (quarantined.length > 0) {
        state = 'error';
        summary = quarantined.length === 1
          ? `Pipeline stage stuck: ${STAGE_LABELS[quarantined[0].stage] || quarantined[0].stage}`
          : `${quarantined.length} pipeline stages stuck — see details.`;
      } else {
        // "processing" if any stage ran in the last hour.
        const recentMs = Date.now() - (60 * 60 * 1000);
        const recent = stages
          .filter((s) => s.last_success_at && Date.parse(s.last_success_at) > recentMs)
          .sort((a, b) => Date.parse(b.last_success_at) - Date.parse(a.last_success_at));
        if (recent.length > 0) {
          state = 'processing';
          currentStage = recent[0].stage_name;
          const label = STAGE_LABELS[currentStage] || currentStage;
          summary = `${label} — ${completed} of ${TOTAL_STAGES} stages complete.`;
        } else {
          state = 'healthy';
          summary = `All ${completed} active stages healthy.`;
        }
      }

      res.json({
        state,
        summary,
        currentStage,
        lastActivity,
        progress: { completed, total: TOTAL_STAGES },
        quarantined,
      });
    } catch (e) {
      logger.error?.(`[${LOG_PREFIX}] Portal pipeline status failed:`, e.message);
      res.status(500).json({ error: 'Failed to read pipeline state' });
    }
  });

  logger.info?.(`[${LOG_PREFIX}] portal-pipeline-router mounted 1 handler`);
  return router;
}

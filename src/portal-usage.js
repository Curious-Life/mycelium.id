// src/portal-usage.js — the token-usage transparency surface. One endpoint that
// aggregates llm_usage into input/output totals categorized by area/source/
// provider/model/day, plus a recent-events table. Backs the Settings → Usage pane.
// @see src/db/llm-usage.js, docs/TEXT-GENERATION-ABSTRACTION-DESIGN-2026-06-15.md §12.
//
// SECURITY: loopback/authed like the rest of /portal. The data is counts +
// dimensions ONLY — llm_usage never stores any prompt/completion text (§1).

import express from 'express';

const clampDays = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(Math.floor(n), 365);
};

export function portalUsageRouter({ db, userId, authenticatePortalRequest }) {
  if (!db) throw new Error('portalUsageRouter: db required');
  if (typeof authenticatePortalRequest !== 'function') throw new Error('portalUsageRouter: authenticatePortalRequest required');
  const router = express.Router();
  const auth = (req, res) => { const u = authenticatePortalRequest(req); if (!u) { res.status(401).json({ error: 'Unauthorized' }); return null; } return u; };

  // GET /usage?days=N — aggregated token consumption + recent events.
  router.get('/usage', async (req, res) => {
    if (!auth(req, res)) return;
    const days = clampDays(req.query.days);
    try {
      const [summary, recent] = await Promise.all([
        db.usage.summary(userId, { sinceDays: days }),
        db.usage.recent(userId, 50),
      ]);
      res.json({ days, ...summary, recent });
    } catch {
      // fail-soft: an empty but well-shaped payload (the UI renders "no usage yet")
      res.json({ days, totals: { inputTokens: 0, outputTokens: 0, events: 0 }, byArea: [], bySource: [], byProvider: [], byModel: [], byDay: [], recent: [] });
    }
  });

  return router;
}

export default portalUsageRouter;

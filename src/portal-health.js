// src/portal-health.js — Apple Health daily summaries (write + read).
//
// The native app pushes structured daily metrics here (POST /health/sync), which
// land in the `health_daily` table (21 encrypted columns, scope='personal') via
// db.health.syncDays. The Body dashboard (portal Streams 'body' facet) and the
// iOS Health screen read them back through /health/today|range|summary.
//
// This is the STRUCTURED companion to the stream ingest (src/portal-ingest.js):
// charts/trends need typed rows, not free-text events. Owner-gated (loopback OR
// the owner's static Bearer) — it reads/writes vault plaintext.
import express from 'express';

const MAX_SYNC_DAYS = 60;

function todayStr() { return new Date().toISOString().split('T')[0]; }
function daysAgoStr(n) { return new Date(Date.now() - n * 86400000).toISOString().split('T')[0]; }

export function portalHealthRouter({ db, userId = 'local-user', authenticatePortalRequest }) {
  if (typeof authenticatePortalRequest !== 'function') throw new Error('portalHealthRouter: authenticatePortalRequest required');
  const router = express.Router();
  const auth = (req, res) => {
    const u = authenticatePortalRequest(req);
    if (!u) { res.status(401).json({ ok: false, error: 'Unauthorized' }); return null; }
    return u;
  };
  const ready = (res) => {
    if (!db?.health) { res.status(503).json({ ok: false, error: 'health unavailable' }); return false; }
    return true;
  };

  // POST /health/sync — body { days: [{ date, sleep_duration_min, hrv_avg, steps, … }] }
  router.post('/health/sync', async (req, res) => {
    if (!auth(req, res)) return;
    if (!ready(res)) return;
    const days = Array.isArray(req.body?.days) ? req.body.days : null;
    if (!days || days.length === 0) return res.status(400).json({ ok: false, error: 'days[] required' });
    if (days.length > MAX_SYNC_DAYS) return res.status(400).json({ ok: false, error: `max ${MAX_SYNC_DAYS} days per sync` });
    try {
      const synced = await db.health.syncDays(userId, days.filter((d) => d && d.date));
      res.json({ ok: true, synced });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'sync failed' });
    }
  });

  // GET /health/today
  router.get('/health/today', async (req, res) => {
    if (!auth(req, res)) return;
    if (!ready(res)) return;
    try {
      const date = todayStr();
      res.json({ date, metrics: await db.health.getDay(userId, date) });
    } catch { res.status(500).json({ error: 'today failed' }); }
  });

  // GET /health/range?from=YYYY-MM-DD&to=YYYY-MM-DD
  router.get('/health/range', async (req, res) => {
    if (!auth(req, res)) return;
    if (!ready(res)) return;
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from & to required' });
    try { res.json({ days: await db.health.getRange(userId, String(from), String(to)) }); }
    catch { res.status(500).json({ error: 'range failed' }); }
  });

  // GET /health/summary?days=7 — shaped { today, days, averages, trends, anomalies }
  // (BodyView + the iOS HealthSummaryResponse both expect today + days alongside
  // the computed averages/trends/anomalies).
  router.get('/health/summary', async (req, res) => {
    if (!auth(req, res)) return;
    if (!ready(res)) return;
    const n = Math.min(parseInt(req.query.days, 10) || 7, 90);
    const to = todayStr();
    try {
      const rows = await db.health.getRange(userId, daysAgoStr(n), to);
      const summary = await db.health.getSummary(userId, n);
      const today = rows.find((r) => r.date === to) ?? null;
      res.json({
        today,
        days: rows,
        averages: summary.averages || {},
        trends: summary.trends || {},
        anomalies: summary.anomalies || [],
      });
    } catch { res.status(500).json({ error: 'summary failed' }); }
  });

  return router;
}

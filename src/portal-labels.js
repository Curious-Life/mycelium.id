/**
 * Portal CVP-labels router — the data plane for inner-state axis validation.
 *
 *   GET  /labels/status        per-axis CVP progress (status + label count) so the UI
 *                              can show "tone: 14/20 labels, pending".
 *   POST /labels               save (upsert) one operator label for a window.
 *   POST /labels/run-cvp       run CVP for an axis from its stored labels → verdict.
 *
 * Auth: every handler is guarded by authenticatePortalRequest (loopback OR bearer, via
 * makePortalOwnerGate). Mounted under /api/v1/portal on the REST server (:8787).
 *
 * The content-sampling endpoint (windows + message text to rate) is intentionally NOT
 * here — it is tightly coupled to the labeling UI and ships with it (P3d). These three
 * endpoints are the headless-verifiable data plane.
 */
import express from 'express';
import { runAxisCvpFromLabels } from './metrics/axis-cvp.js';

const AXES = Object.freeze([
  'tone', 'charge', 'warmth', 'gatheredness', 'holding', 'noticing', 'edges', 'kusala',
]);
// Window durations (window_end is the exclusive upper bound; start = end − duration).
// Matches compute_information_harmonics.windows_for: alpha daily, theta weekly, delta 30d.
const GRAN_MS = Object.freeze({ alpha: 86400000, theta: 7 * 86400000, delta: 30 * 86400000 });
const rows = (r) => (Array.isArray(r) ? r : (r?.results ?? r?.rows ?? []));

export function portalLabelsRouter({ db, userId = 'local-user', authenticatePortalRequest }) {
  if (typeof authenticatePortalRequest !== 'function') {
    throw new Error('portalLabelsRouter: authenticatePortalRequest required');
  }
  const router = express.Router();
  const auth = (req, res) => {
    const u = authenticatePortalRequest(req);
    if (!u) { res.status(401).json({ ok: false, error: 'Unauthorized' }); return null; }
    return u;
  };

  // Resolve the current anchor_version (the latest one the pipeline computed). A label
  // is scoped to the version it was rated under, so the UI works against this version.
  const currentVersion = async () => {
    // Fail-soft: if the separability table is absent or unreadable — axes not computed
    // yet, or a partial/again-pending migration — treat it as "no version" so the
    // surfaces return a graceful empty (not-computed) state instead of a hard 500. The
    // real error is logged so a genuine fault is still diagnosable.
    try {
      const r = await db.d1Query(
        'SELECT anchor_version FROM cognitive_axis_separability ORDER BY computed_at DESC LIMIT 1', [],
      );
      return rows(r)[0]?.anchor_version || null;
    } catch (e) {
      console.error('[labels] cognitive_axis_separability not readable (axes not computed yet?):', e?.message || e);
      return null;
    }
  };

  // GET /labels/status?anchorVersion=… → { anchorVersion, axes: [{axis,cvp_status,measurable,labels}] }
  router.get('/labels/status', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const version = req.query.anchorVersion || await currentVersion();
      if (!version) return res.json({ ok: true, anchorVersion: null, axes: [] });
      const sep = rows(await db.d1Query(
        'SELECT axis, cvp_status, measurable, loo_auc FROM cognitive_axis_separability WHERE anchor_version = ?',
        [version],
      ));
      const byAxis = new Map(sep.map((s) => [s.axis, s]));
      const axes = [];
      for (const axis of AXES) {
        const s = byAxis.get(axis);
        const labels = await db.labels.countLabels(userId, { axis, anchorVersion: version });
        axes.push({
          axis,
          cvp_status: s?.cvp_status || 'pending',
          measurable: !!(s && s.measurable),
          loo_auc: s?.loo_auc ?? null,
          labels,
        });
      }
      res.json({ ok: true, anchorVersion: version, axes });
    } catch (e) {
      console.error('[labels] status failed:', e?.message || e);
      res.status(500).json({ ok: false, error: 'status failed' });
    }
  });

  // GET /labels/sample?axis=&granularity=&anchorVersion=&n= → UNLABELED windows + their
  // message content for the user to rate. Returns content (the user reading their own
  // words over loopback) but DELIBERATELY NOT the computed lean — a rater must not see
  // the model's guess (anchoring bias would invalidate the label).
  router.get('/labels/sample', async (req, res) => {
    if (!auth(req, res)) return;
    const axis = req.query.axis;
    if (!AXES.includes(axis)) return res.status(400).json({ ok: false, error: 'unknown axis' });
    const granularity = req.query.granularity || 'alpha';
    if (!GRAN_MS[granularity]) return res.status(400).json({ ok: false, error: 'unknown granularity' });
    const n = Math.min(Math.max(parseInt(req.query.n, 10) || 5, 1), 20);
    try {
      const version = req.query.anchorVersion || await currentVersion();
      if (!version) return res.json({ ok: true, anchorVersion: null, axis, granularity, windows: [] });
      const windows = await db.anchor.listWindows(userId, { granularity, anchorVersion: version });
      const labeled = new Set(rows(await db.labels.listLabels(userId, { axis, anchorVersion: version })).map((l) => l.window_end));
      // Unlabeled, non-empty windows; richest first (more to read = a better rating).
      const candidates = windows
        .filter((w) => !labeled.has(w.window_end) && w.message_count > 0)
        .sort((a, b) => b.message_count - a.message_count)
        .slice(0, n);
      const out = [];
      for (const w of candidates) {
        const start = new Date(new Date(w.window_end).getTime() - GRAN_MS[granularity]).toISOString();
        let messages = [];
        try {
          const r = await db.messages.selectPaginated(userId, { since: start, until: w.window_end, limit: 40 });
          messages = (r?.messages || r?.results || []).map((m) => ({ role: m.role, created_at: m.created_at, content: m.content }));
        } catch { /* content is best-effort; still offer the window */ }
        out.push({ window_end: w.window_end, era_id: w.era_id, granularity, window_start: start, message_count: w.message_count, messages });
      }
      res.json({ ok: true, anchorVersion: version, axis, granularity, windows: out });
    } catch (e) {
      console.error('[labels] sample failed:', e?.message || e);
      res.status(500).json({ ok: false, error: 'sample failed' });
    }
  });

  // POST /labels  body { axis, anchorVersion, windowEnd, granularity, eraId, target }
  router.post('/labels', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    if (!AXES.includes(b.axis)) return res.status(400).json({ ok: false, error: 'unknown axis' });
    try {
      await db.labels.saveLabel(userId, {
        axis: b.axis, anchorVersion: b.anchorVersion, windowEnd: b.windowEnd,
        granularity: b.granularity, eraId: b.eraId, target: b.target,
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || 'invalid label') });
    }
  });

  // POST /labels/run-cvp  body { axis, anchorVersion, granularity? } → the CVP verdict
  router.post('/labels/run-cvp', async (req, res) => {
    if (!auth(req, res)) return;
    const b = req.body || {};
    if (!AXES.includes(b.axis)) return res.status(400).json({ ok: false, error: 'unknown axis' });
    if (!b.anchorVersion) return res.status(400).json({ ok: false, error: 'anchorVersion required' });
    try {
      const report = await runAxisCvpFromLabels(db, {
        userId, axis: b.axis, anchorVersion: b.anchorVersion,
        granularity: b.granularity || 'alpha',
      });
      // Surface only the verdict + evidence summary — never raw leans/labels.
      res.json({
        ok: true, axis: b.axis, status: report.status, n: report.n,
        reason: report.reason, criteria: report.criteria,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(e?.message || 'run-cvp failed') });
    }
  });

  // GET /labels/leans?granularity= → the CVP-PASSED inner-state leans for display. Goes
  // through the gated reader, so pending/abstained axes are simply ABSENT (fail-closed) —
  // the portal-facing counterpart of the getContext surfacing. Never exposes a raw
  // pending number (the gate already dropped it).
  router.get('/labels/leans', async (req, res) => {
    if (!auth(req, res)) return;
    const granularity = req.query.granularity || 'alpha';
    if (!GRAN_MS[granularity]) return res.status(400).json({ ok: false, error: 'unknown granularity' });
    try {
      const w = await db.anchor.getCurrentWindow(userId, { granularity });
      const leans = Object.entries(w?.values ?? {})
        .filter(([c, v]) => c.endsWith('_lean') && v != null)
        .map(([c, v]) => ({ axis: c.replace(/_lean$/, ''), value: Number(v) }));
      res.json({ ok: true, window_end: w?.window_end ?? null, granularity, leans });
    } catch (e) {
      console.error('[labels] leans failed:', e?.message || e);
      res.status(500).json({ ok: false, error: 'leans failed' });
    }
  });

  return router;
}

export default portalLabelsRouter;

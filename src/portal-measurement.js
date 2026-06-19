import express from 'express';
import { CONTRACTS } from './metrics/contracts.js';
import { METRIC_COLUMNS, _internal as metricsInternal } from './db/metrics.js';

// Lempel-Ziv (1976) complexity of a symbol sequence (Kaspar-Schuster). Used for
// the territory-river "path novelty" overlay — how varied vs repetitive the route
// through topics is. Returns the production count c (≥1); the caller normalizes.
function lz76Count(seq) {
  const n = seq.length;
  if (n === 0) return 0;
  let i = 0, k = 1, l = 1, c = 1, kmax = 1;
  while (true) {
    if (seq[i + k - 1] === seq[l + k - 1]) {
      k++;
      if (l + k - 1 >= n) { c++; break; }
    } else {
      if (k > kmax) kmax = k;
      i++;
      if (i === l) {
        c++;
        l += kmax;
        if (l >= n) break;
        i = 0; k = 1; kmax = 1;
      } else {
        k = 1;
      }
    }
  }
  return c;
}

/**
 * portalMeasurementRouter — S1 measurement REST bridge.
 *
 * Surfaces the now-populated measurement plane (cognitive harmonics, vitality,
 * Fisher trajectory + phase + milestones, metric freshness) to the HUMAN over
 * HTTP so the shipped portal pages render real numbers instead of
 * "Era unavailable". Ported from reference/server-routes/{portal-metrics,
 * portal-vitality,portal-trajectory,portal-metric-freshness,internal-metrics}.js
 * and adapted to V1: single-user, in-process, local SQLite — every
 * Cloudflare-Worker / multi-tenant / remote-fetch hop stripped.
 *
 * Mounted under `/api/v1/portal` (alongside portalMindscapeRouter), so route
 * strings here are RELATIVE (e.g. `/metrics/window`, NOT `/portal/metrics/...`).
 *
 * AUTH (fail-closed): every handler calls `authenticatePortalRequest(req)`. It
 * returns the single vault owner only for a genuine local request and `null`
 * otherwise → 401. There is no decryption for a rejected request. The reads go
 * through the auto-decrypting db namespaces (db.metrics / db.fisher /
 * db.topology) + db.rawQuery, so ciphertext never reaches a response.
 *
 * @param {object} deps
 * @param {object} deps.db        wired db (metrics, fisher, topology, rawQuery)
 * @param {string} deps.userId    the single V1 owner
 * @param {(req: import('express').Request) => ({id:string}|null)} deps.authenticatePortalRequest
 * @returns {import('express').Router}
 */
export function portalMeasurementRouter({ db, userId, authenticatePortalRequest }) {
  if (!db) throw new Error('portalMeasurementRouter: db required');
  if (!userId) throw new Error('portalMeasurementRouter: userId required');
  if (typeof authenticatePortalRequest !== 'function') {
    throw new Error('portalMeasurementRouter: authenticatePortalRequest required');
  }

  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  const fail = (res, code = 500, error = 'request failed') => res.status(code).json({ error });
  // Resolve the authenticated owner or 401. Single helper so every route is
  // gated identically and a missing owner is always fail-closed.
  const owner = (req, res) => {
    const u = authenticatePortalRequest(req);
    if (!u || !u.id) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    return u;
  };

  const VALID_GRANULARITIES = new Set(['alpha', 'theta', 'delta']);
  const VALID_LEVELS = new Set(['realm', 'theme', 'territory']);
  const PERIOD_DAYS = { week: 7, month: 30, quarter: 90 };

  // ── Fisher geodesic on the categorical simplex (period-level displacement).
  // d(p,q) = 2·arccos(Σ √(p_i·q_i)). Ported verbatim from portal-trajectory.js.
  const fisherDistance = (p, q) => {
    let bhatt = 0;
    const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
    for (const k of keys) bhatt += Math.sqrt((p[k] ?? 0) * (q[k] ?? 0));
    bhatt = Math.max(-1, Math.min(1, bhatt));
    return 2 * Math.acos(bhatt);
  };
  const parseVec = (v) => {
    if (!v) return {};
    if (typeof v === 'object' && !Array.isArray(v)) return v;
    try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; }
    catch { return {}; }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // COGNITIVE METRICS (harmonics) — db.metrics auto-decrypts the 41 columns.
  // ──────────────────────────────────────────────────────────────────────────

  // GET /metrics/window — latest window for (user, granularity), all/subset metrics.
  router.get('/metrics/window', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const granularity = String(req.query.granularity || 'alpha');
      if (!VALID_GRANULARITIES.has(granularity)) {
        return res.status(400).json({ error: `granularity must be one of: ${[...VALID_GRANULARITIES].join(', ')}` });
      }
      const metricsParam = req.query.metrics;
      const requestedMetrics = typeof metricsParam === 'string' && metricsParam.trim()
        ? metricsParam.split(',').map((s) => s.trim()).filter(Boolean)
        : null;
      const result = await db.metrics.getCurrentWindow(u.id, { granularity, requestedMetrics });
      res.set('Cache-Control', 'no-store');
      res.json(result);
    } catch (e) {
      if (e instanceof TypeError) return res.status(400).json({ error: e.message });
      fail(res, 500, 'Failed to load window');
    }
  });

  // GET /metrics/series — time-series of one metric across windows.
  router.get('/metrics/series', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const granularity = String(req.query.granularity || 'alpha');
      const metric = String(req.query.metric || '');
      const series = await db.metrics.getSeries(u.id, {
        metric, granularity,
        from: req.query.from, to: req.query.to, limit: req.query.limit,
      });
      const era_id = await db.metrics.getCurrentEra(u.id);
      res.set('Cache-Control', 'no-store');
      res.json({ metric, granularity, era_id, series });
    } catch (e) {
      if (e instanceof TypeError) return res.status(400).json({ error: e.message });
      fail(res, 500, 'Failed to load series');
    }
  });

  // GET /metrics/contracts/:family — frozen presentation contract for a family.
  // Pure copy (no user data), but still owner-gated for surface consistency.
  router.get('/metrics/contracts/:family', (req, res) => {
    const u = owner(req, res); if (!u) return;
    const contract = CONTRACTS[req.params.family];
    if (!contract) return res.status(404).json({ error: `Unknown family: ${req.params.family}` });
    res.set('Cache-Control', 'private, max-age=86400');
    res.json({ family: req.params.family, contract });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // VITALITY — per-territory vitality + the headline harmonics window.
  // territory_vitality scalars are encrypted; db.rawQuery auto-decrypts → coerce.
  // ──────────────────────────────────────────────────────────────────────────

  const VITALITY_NUMERIC = [
    'entropy_diversification', 'connection_growth_rate', 'reach',
    'cofire_partner_diversity', 'engagement_depth_normalized', 'vitality',
  ];
  const num = (v) => { if (v == null) return null; const n = Number(v); return Number.isNaN(n) ? null : n; };

  // GET /vitality/snapshot — latest per-territory vitality rows (real numbers).
  router.get('/vitality/snapshot', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      // Latest run by RECENCY (computed_at) — NOT lexicographic MAX(clustering_run_id).
      // String max picked a stale 'backfill-v1' over 'era-2026-…' (b>e) and ignored
      // NULL-tagged rows entirely. `clustering_run_id IS ?` matches a NULL run id too.
      const latest = ((await db.rawQuery(
        `SELECT clustering_run_id FROM territory_vitality WHERE user_id = ? ORDER BY computed_at DESC LIMIT 1`,
        [u.id])).results || [])[0];
      const runId = latest ? (latest.clustering_run_id ?? null) : null;

      const cols = `territory_id, phase, computed_at, clustering_run_id,
                  entropy_diversification, connection_growth_rate, reach,
                  cofire_partner_diversity, engagement_depth_normalized, vitality`;
      const sql = latest
        ? `SELECT ${cols} FROM territory_vitality WHERE user_id = ? AND clustering_run_id IS ? ORDER BY territory_id`
        : `SELECT ${cols} FROM territory_vitality WHERE user_id = ? ORDER BY territory_id`;
      const params = latest ? [u.id, runId] : [u.id];
      const rows = (await db.rawQuery(sql, params)).results || [];
      const territories = rows.map((r) => {
        const out = { territory_id: r.territory_id, phase: r.phase, computed_at: r.computed_at, clustering_run_id: r.clustering_run_id };
        for (const f of VITALITY_NUMERIC) out[f] = num(r[f]);
        return out;
      });
      // Phase distribution + a vitality summary for the page headline.
      const phases = {};
      let vSum = 0, vN = 0;
      for (const t of territories) {
        phases[t.phase] = (phases[t.phase] || 0) + 1;
        if (t.vitality != null) { vSum += t.vitality; vN += 1; }
      }
      res.set('Cache-Control', 'no-store');
      res.json({
        run_id: runId,
        territories,
        summary: {
          territory_count: territories.length,
          phases,
          avg_vitality: vN ? vSum / vN : null,
        },
      });
    } catch { fail(res, 500, 'Failed to load vitality'); }
  });

  // GET /vitality/audit — latest topology-health snapshot (M2 entropy, gini…).
  // Encrypted metric columns auto-decrypt + coerce via db.topology.getLatestAudit.
  router.get('/vitality/audit', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const audit = await db.topology.getLatestAudit({ p_user_id: u.id });
      res.set('Cache-Control', 'no-store');
      res.json({ audit: audit || null });
    } catch { fail(res, 500, 'Failed to load topology audit'); }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // FISHER TRAJECTORY — db.fisher auto-decrypts + coerces the metric columns.
  // ──────────────────────────────────────────────────────────────────────────

  // GET /trajectory — paged trajectory rows for level × window_type.
  router.get('/trajectory', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const level = String(req.query.level || 'realm');
      if (!VALID_LEVELS.has(level)) {
        return res.status(400).json({ error: `level must be one of: ${[...VALID_LEVELS].join(', ')}` });
      }
      const windowType = String(req.query.window_type || 'weekly_step');
      const rows = await db.fisher.getTrajectory(u.id, {
        level, windowType,
        from: req.query.from, to: req.query.to,
        runId: req.query.run_id, limit: req.query.limit,
      });
      res.set('Cache-Control', 'no-store');
      res.json({ trajectory: rows, level, window_type: windowType });
    } catch (e) {
      if (e instanceof TypeError) return res.status(400).json({ error: e.message });
      fail(res, 500, 'Failed to load trajectory');
    }
  });

  // GET /trajectory/current — latest weekly_step phase row(s). level=all → 3 levels.
  router.get('/trajectory/current', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const level = String(req.query.level || 'realm');
      if (level !== 'all' && !VALID_LEVELS.has(level)) {
        return res.status(400).json({ error: `level must be 'all' or one of: ${[...VALID_LEVELS].join(', ')}` });
      }
      const phase = await db.fisher.getCurrentPhase(u.id, { level });
      res.set('Cache-Control', 'no-store');
      res.json({ current: phase || null });
    } catch (e) {
      if (e instanceof TypeError) return res.status(400).json({ error: e.message });
      fail(res, 500, 'Failed to load current phase');
    }
  });

  // GET /trajectory/summary — headline numbers for a period (week|month|quarter).
  router.get('/trajectory/summary', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const period = String(req.query.period || 'month');
      const level = String(req.query.level || 'realm');
      if (!(period in PERIOD_DAYS)) {
        return res.status(400).json({ error: `period must be one of: ${Object.keys(PERIOD_DAYS).join(', ')}` });
      }
      if (!VALID_LEVELS.has(level)) {
        return res.status(400).json({ error: `level must be one of: ${[...VALID_LEVELS].join(', ')}` });
      }

      // weekly_step is the canonical statistical series; fetch the whole run and
      // slice the period window in JS (window_start/end are plaintext, but the
      // metric columns are encrypted so we read through db.fisher which decrypts).
      const all = await db.fisher.getTrajectory(u.id, { level, windowType: 'weekly_step', limit: 1000 });
      if (!all.length) return res.json({ summary: null });
      const cutoff = Date.now() - PERIOD_DAYS[period] * 86400000;
      const rows = all.filter((r) => {
        const end = Date.parse(r.window_end || '');
        return Number.isFinite(end) ? end >= cutoff : true;
      });
      if (!rows.length) return res.json({ summary: null });

      const first = rows[0], last = rows[rows.length - 1];
      const total_distance = (last.fisher_trajectory_length || 0) - (first.fisher_trajectory_length || 0);
      const displacement = fisherDistance(parseVec(first.activation_vector), parseVec(last.activation_vector));
      const ratio = total_distance > 0.001 ? displacement / total_distance : null;

      const velocities = rows.map((r) => r.fisher_velocity).filter((v) => v != null);
      const velocityZs = rows.map((r) => r.fisher_velocity_z).filter((z) => z != null);
      const avg_velocity = velocities.length ? velocities.reduce((a, b) => a + b, 0) / velocities.length : null;
      const avg_velocity_z = velocityZs.length ? velocityZs.reduce((a, b) => a + b, 0) / velocityZs.length : null;

      let peak = null;
      for (const r of rows) {
        if (r.fisher_velocity != null && (!peak || r.fisher_velocity > peak.fisher_velocity)) peak = r;
      }
      const peak_velocity = peak ? {
        date: (peak.window_end || '').slice(0, 10),
        value: peak.fisher_velocity, z: peak.fisher_velocity_z ?? null,
      } : null;

      const lastDisp = last.fisher_displacement != null ? Number(last.fisher_displacement) / Math.PI : null;
      res.set('Cache-Control', 'no-store');
      res.json({
        summary: {
          period, level,
          run_id: last.clustering_run_id || null,
          phase: last.phase || 'stable',
          phase_recent: last.phase_recent || last.phase || 'stable',
          total_distance, displacement,
          displacement_normalized: lastDisp,
          exploration_ratio: ratio,
          R_recent: last.R_recent != null ? last.R_recent : null,
          avg_velocity, avg_velocity_z, peak_velocity,
          top_movers: Array.isArray(last.top_contributors) ? last.top_contributors : [],
          window_count: rows.length,
        },
      });
    } catch (e) {
      if (e instanceof TypeError) return res.status(400).json({ error: e.message });
      fail(res, 500, 'Failed to load summary');
    }
  });

  // GET /trajectory/milestones — active (undismissed) milestones; ?include_dismissed=1.
  router.get('/trajectory/milestones', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const milestones = await db.fisher.getActiveMilestones(u.id, {
        includeDismissed: req.query.include_dismissed === '1',
        limit: req.query.limit,
      });
      res.set('Cache-Control', 'no-store');
      res.json({ milestones });
    } catch { fail(res, 500, 'Failed to load milestones'); }
  });

  // POST /trajectory/milestones/:id/dismiss — idempotent dismissal.
  router.post('/trajectory/milestones/:id/dismiss', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const id = String(req.params.id || '');
      if (!id) return res.status(400).json({ error: 'milestone id required' });
      const r = await db.fisher.dismissMilestone(u.id, id);
      if (!r.exists) return res.status(404).json({ error: 'milestone not found' });
      res.json({ dismissed: r.dismissed, already_dismissed: r.already_dismissed });
    } catch { fail(res, 500, 'Failed to dismiss milestone'); }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // COMPLEXITY (LZ76) — complexity_snapshots. Numeric cols are encrypted, so
  // db.rawQuery auto-decrypts → coerce; "latest per (level, level_id)" in JS.
  // ──────────────────────────────────────────────────────────────────────────
  router.get('/complexity', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const rows = (await db.rawQuery(
        `SELECT level, level_id, level_name, lz_complexity, raw_complexity, sequence_length,
                alphabet_size, point_count, low_confidence, embedding_novelty,
                embedding_novelty_low_conf, window_start, window_end, computed_at
           FROM complexity_snapshots WHERE user_id = ?
           ORDER BY computed_at DESC LIMIT 400`, [u.id])).results || [];
      const seen = new Set(); const latest = [];
      for (const r of rows) {
        const k = `${r.level}:${r.level_id ?? ''}`;
        if (seen.has(k)) continue; seen.add(k);
        latest.push({
          level: r.level, level_id: r.level_id, level_name: r.level_name,
          lz_complexity: num(r.lz_complexity), raw_complexity: num(r.raw_complexity),
          sequence_length: num(r.sequence_length), alphabet_size: num(r.alphabet_size),
          point_count: num(r.point_count),
          // LZ honesty + the Tier-1 embedding-novelty primary (§4.19).
          low_confidence: Number(r.low_confidence) ? 1 : 0,
          embedding_novelty: r.embedding_novelty != null ? num(r.embedding_novelty) : null,
          embedding_novelty_low_conf: Number(r.embedding_novelty_low_conf) ? 1 : 0,
          window_start: r.window_start, window_end: r.window_end, computed_at: r.computed_at,
        });
      }
      const global = latest.find((r) => r.level === 'global') || null;
      const territories = latest.filter((r) => r.level === 'territory');
      let avg = null;
      const tv = territories.map((t) => t.lz_complexity).filter((v) => v != null);
      if (tv.length) avg = tv.reduce((a, b) => a + b, 0) / tv.length;
      res.set('Cache-Control', 'no-store');
      res.json({ global, territories, realms: latest.filter((r) => r.level === 'realm'), avg_territory_lz: avg });
    } catch { fail(res, 500, 'Failed to load complexity'); }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // CO-FIRING graph — territory_cofire. cofire_* strengths are encrypted, so we
  // load (decrypt-on-read), then filter/sort by strength in JS (not SQL).
  // ──────────────────────────────────────────────────────────────────────────
  router.get('/cofire', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const limit = Math.min(Number(req.query.limit) || 24, 200);
      const rows = (await db.rawQuery(
        `SELECT territory_a, territory_b, cofire_immediate, cofire_session,
                cofire_daily, cofire_weekly, last_cofire_at, last_computed
           FROM territory_cofire WHERE user_id = ?`, [u.id])).results || [];
      const edges = rows.map((r) => ({
        a: r.territory_a, b: r.territory_b,
        immediate: num(r.cofire_immediate), session: num(r.cofire_session),
        daily: num(r.cofire_daily), weekly: num(r.cofire_weekly),
        last_cofire_at: r.last_cofire_at,
      })).filter((e) => ['immediate', 'session', 'daily', 'weekly'].some((s) => (e[s] ?? 0) > 0));
      edges.sort((x, y) => (y.weekly ?? 0) - (x.weekly ?? 0) || (y.daily ?? 0) - (x.daily ?? 0));
      res.set('Cache-Control', 'no-store');
      res.json({ edges: edges.slice(0, limit), total_edges: edges.length, scales: ['immediate', 'session', 'daily', 'weekly'] });
    } catch { fail(res, 500, 'Failed to load co-firing'); }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // FREQUENCY — frequency_snapshots (latest window). Numeric cols encrypted →
  // coerce. coherence · entropy · compression · learning_rate · gradient_signal.
  // ──────────────────────────────────────────────────────────────────────────
  router.get('/frequency', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const rows = (await db.rawQuery(
        `SELECT window_start, window_end, granularity, coherence, entropy, compression,
                learning_rate, gradient_signal, point_count, territory_count, message_count, computed_at
           FROM frequency_snapshots WHERE user_id = ?
           ORDER BY computed_at DESC LIMIT 1`, [u.id])).results || [];
      const r = rows[0];
      if (!r) return res.json({ snapshot: null });
      res.set('Cache-Control', 'no-store');
      res.json({ snapshot: {
        window_start: r.window_start, window_end: r.window_end, granularity: r.granularity,
        coherence: num(r.coherence), entropy: num(r.entropy), compression: num(r.compression),
        learning_rate: num(r.learning_rate), gradient_signal: num(r.gradient_signal),
        point_count: num(r.point_count), territory_count: num(r.territory_count),
        message_count: num(r.message_count), computed_at: r.computed_at,
      } });
    } catch { fail(res, 500, 'Failed to load frequency'); }
  });

  // GET /frequency/series — frequency_snapshots over time for one granularity,
  // so the page can chart coherence/entropy/learning-rate/drift across windows.
  router.get('/frequency/series', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const granularity = String(req.query.granularity || 'day');
      const limit = Math.min(Number(req.query.limit) || 180, 400);
      const rows = (await db.rawQuery(
        `SELECT window_start, window_end, granularity, coherence, entropy, compression,
                learning_rate, gradient_signal, point_count, territory_count, message_count, computed_at
           FROM frequency_snapshots WHERE user_id = ? AND granularity = ?
           ORDER BY window_end ASC LIMIT ?`, [u.id, granularity, limit])).results || [];
      const series = rows.map((r) => ({
        window_end: r.window_end, window_start: r.window_start,
        coherence: num(r.coherence), entropy: num(r.entropy), compression: num(r.compression),
        learning_rate: num(r.learning_rate), gradient_signal: num(r.gradient_signal),
        message_count: num(r.message_count), territory_count: num(r.territory_count),
      }));
      res.set('Cache-Control', 'no-store');
      res.json({ granularity, series });
    } catch { fail(res, 500, 'Failed to load frequency series'); }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // METRIC FRESHNESS — per-table staleness map (no decrypted values, just
  // MAX(timestamp) / pipeline_state probes). All timestamp/state columns are
  // plaintext, so nothing here can leak ciphertext.
  // ──────────────────────────────────────────────────────────────────────────

  const HOUR = 3600000, DAY = 24 * HOUR;
  // V1 freshness budgets — the subset of reference/core/metric-budgets.js whose
  // tables exist in the V1 schema. Era-anchored tables (cognitive_metrics_harmonic)
  // use a pipeline_state probe; the rest use MAX(timestamp_column).
  const METRIC_BUDGETS = [
    { table: 'fisher_trajectory', timestamp_column: 'computed_at', budget_ms: 26 * HOUR, cadence: '24h', description: 'Cognitive trajectory (Fisher information geometry per window).' },
    { table: 'fisher_milestones', timestamp_column: 'detected_at', budget_ms: 26 * HOUR, cadence: '24h', description: 'Milestone events (phase shifts, velocity outliers).' },
    { table: 'territory_vitality', timestamp_column: 'computed_at', budget_ms: 26 * HOUR, cadence: '24h', description: 'Per-territory vitality scores (sparse/active/anchor phase).' },
    { table: 'territory_cofire', timestamp_column: 'last_computed', budget_ms: 26 * HOUR, cadence: '24h', description: 'Territory co-firing graph (4 temporal scales).' },
    { table: 'complexity_snapshots', timestamp_column: 'computed_at', budget_ms: 30 * HOUR, cadence: '24h', description: 'LZ76 complexity (territory-id sequence novelty).' },
    { table: 'topology_audit_snapshots', timestamp_column: 'run_at', budget_ms: 30 * HOUR, cadence: '24h', description: 'Topology health (M2 entropy, degree Gini, orphans).' },
    { table: 'frequency_snapshots', timestamp_column: 'computed_at', budget_ms: 30 * HOUR, cadence: '24h', description: 'Windowed cognitive frequency metrics.' },
    { table: 'cognitive_metrics_harmonic', probe: { kind: 'pipeline_state', stage_name: 'cognitive-harmonics' }, budget_ms: 26 * HOUR, cadence: '24h (era-anchored)', description: 'Cognitive harmonics (information-harmonics + bigram flow + topology H0 entropy).' },
  ];

  // Which pipeline_state stage writes each metric family — so /measurement-health
  // can say "stale BECAUSE the stage failed" (not just "stale"). These match the
  // CANONICAL stage_names the stages record (script-basename, e.g. 'compute-cofire';
  // specials: 'fisher-trajectory', 'cognitive-harmonics', 'cluster') so the surface
  // joins to the live pipeline_state rows instead of orphan short-name entries.
  const FAMILY_STAGE = {
    fisher_trajectory: 'fisher-trajectory', fisher_milestones: 'fisher-trajectory', territory_vitality: 'compute-vitality',
    territory_cofire: 'compute-cofire', complexity_snapshots: 'compute-complexity', topology_audit_snapshots: 'topology-audit',
    frequency_snapshots: 'compute-frequency', cognitive_metrics_harmonic: 'cognitive-harmonics',
  };

  // Shared freshness probe (MAX(timestamp) / pipeline_state) → per-family verdict map.
  // No decrypted values, just plaintext timestamps — nothing here can leak ciphertext.
  async function computeFreshness(uid) {
    const nowMs = Date.now();
    const rows = await Promise.all(METRIC_BUDGETS.map(async (b) => {
        let lastWrite = null, present = true;
        try {
          if (b.probe?.kind === 'pipeline_state') {
            const r = await db.rawQuery(
              `SELECT last_success_at AS last_write FROM pipeline_state WHERE user_id = ? AND stage_name = ?`,
              [uid, b.probe.stage_name]);
            lastWrite = (r.results || [])[0]?.last_write ?? null;
          } else {
            // timestamp columns are PLAINTEXT — MAX() is valid in SQL.
            const r = await db.rawQuery(
              `SELECT MAX(${b.timestamp_column}) AS last_write FROM ${b.table} WHERE user_id = ?`,
              [uid]);
            lastWrite = (r.results || [])[0]?.last_write ?? null;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('no such table')) {
            return { table: b.table, present: false, last_write: null, age_ms: null, budget_ms: b.budget_ms, cadence: b.cadence, description: b.description, verdict: 'missing' };
          }
          throw err;
        }
        if (!lastWrite) {
          return { table: b.table, present, last_write: null, age_ms: null, budget_ms: b.budget_ms, cadence: b.cadence, description: b.description, verdict: 'empty' };
        }
        const writeMs = Date.parse(lastWrite);
        const ageMs = Number.isFinite(writeMs) ? nowMs - writeMs : null;
        const verdict = ageMs === null ? 'empty' : ageMs <= b.budget_ms ? 'fresh' : 'stale';
        return { table: b.table, present, last_write: lastWrite, age_ms: ageMs, budget_ms: b.budget_ms, cadence: b.cadence, description: b.description, verdict };
    }));
    const summary = rows.reduce((acc, r) => {
      acc.total += 1; acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc;
    }, { total: 0, fresh: 0, stale: 0, missing: 0, empty: 0 });
    return { nowMs, rows, summary };
  }

  router.get('/metric-freshness', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const { nowMs, rows, summary } = await computeFreshness(u.id);
      res.set('Cache-Control', 'no-store');
      res.json({ user_id: u.id, now: new Date(nowMs).toISOString(), metrics: rows, summary });
    } catch { fail(res, 500, 'Failed to fetch metric freshness'); }
  });

  // Measurement health: per-stage trackability. Joins the freshness verdict with the
  // pipeline_state ledger (last success/failure, streak, quarantine) so a stale family
  // is DIAGNOSABLE — failed vs never-ran — and chronically-broken stages are badged.
  // Content-free (counts/timestamps/short reason). @see src/db/pipeline-state.js.
  router.get('/measurement-health', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const [{ nowMs, rows: freshRows }, health] = await Promise.all([
        computeFreshness(u.id),
        db.pipelineState.all(u.id),
      ]);
      const byStage = new Map(health.map((h) => [h.stage_name, h]));
      const used = new Set();
      const shape = (h, base = {}) => {
        if (h) used.add(h.stage_name);
        return {
          ...base,
          stage: h?.stage_name ?? base.stage ?? null,
          last_success_at: h?.last_success_at ?? null,
          last_failure_at: h?.last_failure_at ?? null,
          last_failure_reason: h?.last_failure_reason ?? null,
          consecutive_failures: Number(h?.consecutive_failures ?? 0),
          quarantined: !!Number(h?.quarantined ?? 0),
          last_duration_ms: h?.last_duration_ms ?? null,
        };
      };
      // Freshness families, each joined to the health of the stage that writes it.
      const families = freshRows.map((r) => {
        const stage = FAMILY_STAGE[r.table] ?? null;
        return shape(stage ? byStage.get(stage) : null, {
          table: r.table, stage, verdict: r.verdict, last_write: r.last_write,
          age_ms: r.age_ms, budget_ms: r.budget_ms, cadence: r.cadence, description: r.description,
        });
      });
      // Stages with health but no freshness-mapped table (cluster, describe,
      // territory-neighbors, coupling, criticality, coherence, behavioral, anchors)
      // — surfaced health-only so a quarantined stage is never hidden.
      const others = health.filter((h) => !used.has(h.stage_name))
        .map((h) => shape(h, { table: null, verdict: null, last_write: null, age_ms: null, budget_ms: null, cadence: null, description: null }));
      const all = [...families, ...others];
      const summary = all.reduce((acc, r) => {
        acc.total += 1;
        if (r.verdict) acc[r.verdict] = (acc[r.verdict] || 0) + 1;
        if (r.consecutive_failures > 0) acc.failing += 1;
        if (r.quarantined) acc.quarantined += 1;
        return acc;
      }, { total: 0, fresh: 0, stale: 0, missing: 0, empty: 0, failing: 0, quarantined: 0 });
      res.set('Cache-Control', 'no-store');
      res.json({ user_id: u.id, now: new Date(nowMs).toISOString(), families: all, summary });
    } catch { fail(res, 500, 'Failed to fetch measurement health'); }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // BEHAVIORAL — diurnal rhythm + session cadence (Tier-0, timestamps only).
  // cognitive_metrics_behavioral is written by pipeline/compute-behavioral.py with
  // caller-side envelope encryption; db.rawQuery's read path sniffs + auto-decrypts
  // the envelopes per-column (crypto-local.js autoDecryptResults) → coerce to number.
  // ──────────────────────────────────────────────────────────────────────────
  router.get('/behavioral', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const rows = (await db.rawQuery(
        `SELECT window_end, era_id, language,
                diurnal_entropy, diurnal_peak_hour, diurnal_concentration, diurnal_hist,
                session_count, intersession_entropy, intersession_cv,
                message_count, low_confidence, notes, computed_at
           FROM cognitive_metrics_behavioral WHERE user_id = ?
           ORDER BY computed_at DESC LIMIT 1`, [u.id])).results || [];
      const r = rows[0];
      if (!r) { res.set('Cache-Control', 'no-store'); return res.json({ behavioral: null }); }
      let hist = null;
      try { hist = r.diurnal_hist ? JSON.parse(r.diurnal_hist) : null; } catch { hist = null; }
      res.set('Cache-Control', 'no-store');
      res.json({ behavioral: {
        window_end: r.window_end, era_id: r.era_id,
        diurnal_entropy: num(r.diurnal_entropy),
        diurnal_peak_hour: num(r.diurnal_peak_hour),
        diurnal_concentration: num(r.diurnal_concentration),
        diurnal_hist: Array.isArray(hist) ? hist.map((v) => num(v)) : null,
        session_count: num(r.session_count),
        intersession_entropy: num(r.intersession_entropy),
        intersession_cv: num(r.intersession_cv),
        message_count: num(r.message_count),
        low_confidence: !!Number(r.low_confidence),
        computed_at: r.computed_at,
      } });
    } catch { fail(res, 500, 'Failed to load behavioral'); }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // CRITICALITY — early-warning signals (critical slowing) per level, latest window.
  // Honest by construction: every row carries low_confidence=1 + a sensitivity caveat
  // (EWS sensitivity is LOW in the literature). cognitive_metrics_criticality is
  // envelope-encrypted by compute-criticality.py; read path auto-decrypts.
  // ──────────────────────────────────────────────────────────────────────────
  router.get('/criticality', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const windowType = String(req.query.window_type || 'weekly_step');
      const rows = (await db.rawQuery(
        `SELECT level, window_type, window_start, window_end,
                ar1_autocorrelation, rolling_variance, early_warning_joint,
                flickering_score, window_count, low_confidence, computed_at
           FROM cognitive_metrics_criticality WHERE user_id = ? AND window_type = ?
           ORDER BY window_end DESC`, [u.id, windowType])).results || [];
      // Latest row per level (realm/theme/territory).
      const seen = new Set(); const levels = [];
      for (const r of rows) {
        if (seen.has(r.level)) continue; seen.add(r.level);
        levels.push({
          level: r.level, window_start: r.window_start, window_end: r.window_end,
          ar1_autocorrelation: num(r.ar1_autocorrelation),
          rolling_variance: num(r.rolling_variance),
          early_warning_joint: num(r.early_warning_joint),
          flickering_score: num(r.flickering_score),
          window_count: num(r.window_count),
          low_confidence: !!Number(r.low_confidence),
          computed_at: r.computed_at,
        });
      }
      res.set('Cache-Control', 'no-store');
      res.json({ window_type: windowType, levels });
    } catch { fail(res, 500, 'Failed to load criticality'); }
  });

  // GET /events — discrete cognitive events (phase-lock, flickering). Undismissed by
  // default; magnitude/detail/headline are encrypted and auto-decrypt on read.
  router.get('/events', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const includeDismissed = req.query.include_dismissed === '1';
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const sql = `SELECT id, event_type, level, window_start, window_end,
                          magnitude, severity, detail, headline, detected_at, dismissed_at
                     FROM cognitive_events WHERE user_id = ?
                     ${includeDismissed ? '' : 'AND dismissed_at IS NULL'}
                     ORDER BY detected_at DESC LIMIT ?`;
      const rows = (await db.rawQuery(sql, [u.id, limit])).results || [];
      const events = rows.map((r) => {
        let detail = null;
        try { detail = r.detail ? JSON.parse(r.detail) : null; } catch { detail = null; }
        return {
          id: r.id, event_type: r.event_type, level: r.level,
          window_start: r.window_start, window_end: r.window_end,
          magnitude: num(r.magnitude), severity: r.severity, detail,
          headline: r.headline, detected_at: r.detected_at, dismissed_at: r.dismissed_at,
        };
      });
      res.set('Cache-Control', 'no-store');
      res.json({ events });
    } catch { fail(res, 500, 'Failed to load events'); }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TERRITORY RIVER — how your topics change over time. The reliable spine:
  // anchor (persistent) territories as named bands + the count of active
  // territories per week. Built ONLY from robust counts/shares of the activation
  // trajectory (a single clustering run) — it does NOT lean on Fisher velocity
  // (temporal-amnesia risk). Realm-level naming is currently inconsistent (see
  // docs/FINDING-clustering-run-inconsistency-...md) so this rides the TERRITORY
  // altitude, which reconciles (311/372 ids name-resolvable). Two novelty
  // overlays: text (gzip compression) + path (rolling LZ76 of the topic route).
  // ──────────────────────────────────────────────────────────────────────────
  router.get('/territory-river', async (req, res) => {
    const u = owner(req, res); if (!u) return;
    try {
      const FLOOR = 0.01;      // a territory counts as "active" in a week above this share
      const TOP_ANCHORS = 7;   // named bands to show
      const LZ_WINDOW = 26;    // rolling window (weeks) for path-novelty LZ76

      // 1) Weekly territory-activation trajectory, scoped to one clustering run.
      const runRow = (await db.rawQuery(
        `SELECT MAX(clustering_run_id) AS run FROM fisher_trajectory
           WHERE user_id = ? AND level = 'territory' AND window_type = 'weekly_step'`, [u.id])).results || [];
      const runId = runRow[0]?.run || null;
      const trajRows = (await db.rawQuery(
        `SELECT window_end, activation_vector, active_territory_count, message_count, low_confidence
           FROM fisher_trajectory
           WHERE user_id = ? AND level = 'territory' AND window_type = 'weekly_step'
             ${runId ? 'AND clustering_run_id = ?' : ''}
           ORDER BY window_end ASC`, runId ? [u.id, runId] : [u.id])).results || [];

      const weeks = []; const vectors = [];
      for (const r of trajRows) {
        let v = {};
        try { v = typeof r.activation_vector === 'string' ? JSON.parse(r.activation_vector) : (r.activation_vector || {}); } catch { v = {}; }
        if (!v || typeof v !== 'object' || Array.isArray(v)) v = {};
        vectors.push(v);
        weeks.push({
          end: (r.window_end || '').slice(0, 10),
          active_count: num(r.active_territory_count),
          message_count: num(r.message_count),
          low_confidence: !!Number(r.low_confidence),
        });
      }

      // 2) Territory profiles → name + current standing (anchor / active / dormant).
      const profRows = (await db.rawQuery(
        `SELECT territory_id, name, current_phase, is_anchored, last_active
           FROM territory_profiles WHERE user_id = ?`, [u.id])).results || [];
      const profById = {};
      for (const r of profRows) if (r.territory_id != null) profById[String(r.territory_id)] = r;
      const nameById = {};
      for (const id in profById) nameById[id] = profById[id].name || null;
      // Status is data-relative: "recent" is measured against the latest window.
      const refMs = weeks.length ? Date.parse(weeks[weeks.length - 1].end) : Date.now();
      const DORMANT_DAYS = 60;
      const statusOf = (p) => {
        if (!p) return 'unknown';
        if (Number(p.is_anchored) || p.current_phase === 'anchor') return 'anchor';
        const la = p.last_active ? Date.parse(p.last_active) : NaN;
        const ageDays = Number.isNaN(la) ? Infinity : (refMs - la) / 86400000;
        if (ageDays > DORMANT_DAYS) return 'dormant';
        return 'active';
      };

      // 3) Anchors = territories active above FLOOR in the most weeks (persistent core).
      const weeksActive = {}; const totalShare = {};
      vectors.forEach((v) => {
        for (const k in v) {
          const s = Number(v[k]) || 0;
          if (s > FLOOR) { weeksActive[k] = (weeksActive[k] || 0) + 1; totalShare[k] = (totalShare[k] || 0) + s; }
        }
      });
      const anchorIds = Object.keys(weeksActive)
        .sort((a, b) => (weeksActive[b] - weeksActive[a]) || (totalShare[b] - totalShare[a]))
        .slice(0, TOP_ANCHORS);
      const anchors = anchorIds.map((id) => ({
        territory_id: Number(id),
        name: nameById[id] || `Territory ${id}`,
        named: nameById[id] != null,
        status: statusOf(profById[id]),                 // anchor | active | dormant | unknown
        last_active: profById[id]?.last_active ?? null,
        weeks_active: weeksActive[id],
        series: vectors.map((v) => Number(v[id]) || 0),
      }));

      // 4) Path novelty — rolling LZ76 over the dominant-territory-per-week sequence.
      const dominant = vectors.map((v) => {
        let best = null, bs = -1;
        for (const k in v) { const s = Number(v[k]) || 0; if (s > bs) { bs = s; best = k; } }
        return best;
      });
      const pathNovelty = weeks.map((w, i) => {
        if (i + 1 < LZ_WINDOW) return { end: w.end, value: null };
        const win = dominant.slice(i + 1 - LZ_WINDOW, i + 1).filter((x) => x != null);
        if (win.length < LZ_WINDOW * 0.6) return { end: w.end, value: null };
        const c = lz76Count(win);
        const norm = (c * Math.log2(win.length)) / win.length;
        return { end: w.end, value: Math.max(0, Math.min(1, norm)) };
      });

      // 5) Text novelty — weekly gzip compression (higher = less compressible = more novel).
      const freqRows = (await db.rawQuery(
        `SELECT window_end, compression FROM frequency_snapshots
           WHERE user_id = ? AND granularity = 'week'
           ORDER BY window_end ASC`, [u.id])).results || [];
      const textNovelty = freqRows.map((r) => ({ end: (r.window_end || '').slice(0, 10), value: num(r.compression) }));

      res.set('Cache-Control', 'no-store');
      res.json({
        run_id: runId,
        level: 'territory',
        span: weeks.length ? { start: weeks[0].end, end: weeks[weeks.length - 1].end } : null,
        weeks,
        anchors,
        novelty: { text: textNovelty, path: pathNovelty },
      });
    } catch { fail(res, 500, 'Failed to load territory river'); }
  });

  return router;
}

// Exposed for tests / introspection.
export const _internal = { METRIC_COLUMNS, validGranularities: [...metricsInternal.VALID_GRANULARITIES] };

export default portalMeasurementRouter;

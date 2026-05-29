# PR1.5 B3 — Portal Metrics Endpoints (Design v2)

**Date:** 2026-05-08
**Companions:** [docs/COGNITIVE-METRICS-SPEC-HANDOFF-2026-05-07.md](./COGNITIVE-METRICS-SPEC-HANDOFF-2026-05-07.md), [docs/architecture/COGNITIVE-METRICS-SPEC.md](./architecture/COGNITIVE-METRICS-SPEC.md), [docs/MEASUREMENT-PLANE-PR1-DESIGN-2026-05-07.md](./MEASUREMENT-PLANE-PR1-DESIGN-2026-05-07.md)
**Audience:** the next Claude Code instance + operator review before implementation.
**Sweep cycles:** 4 parallel Explore agents (routing/auth, D1 query/tenant, caching/contracts/metric-count, test patterns) + cited-code verification.

---

## TL;DR

Add `createPortalMetricsRouter` (new file `packages/server/routes/portal-metrics.js`) with three GET handlers serving the cognitive metrics surface to portal browser AND agent loopback callers.

| Endpoint | Purpose | Cache |
|---|---|---|
| `GET /portal/metrics/window` | One window of all (or filtered) metrics for `(user, granularity, era)` | `no-store` |
| `GET /portal/metrics/series` | Time-series of one metric across N windows | `no-store` |
| `GET /portal/metrics/contracts/:family` | Frozen presentation contract (negative constraints + delivery guidance + voice register) | `private, max-age=86400` |

Mount in `packages/server/app.js` at line ~984 between `createPortalTrajectoryRouter` (line 976) and `createPortalActivityRouter` (line 987). Estimated: ~520 LOC across 5 files (4 new + 1 modified). Smaller than v1 estimate (655 LOC) because path-versioning was dropped.

---

## Revision history

### v1 (locked at end of 2026-05-07 session)
- Path: `/portal/metrics/...` ✅ (kept)
- Auth: dual-auth — worker-secret loopback + portal-session
- Cache: 1-year cache for contracts
- Versioning: `/contracts/:family/:version` in path
- Mount: `app.use('/portal/metrics', router)` (prefix-mounted)
- Estimated 655 LOC across 6 files

### v3 (FINAL — post-Mya-audit + 7-sweep refinement)

After 3 sweep rounds (4+3+5 = 12 Explore agents) + cited-code verification + Mya's consumer audit, the architecture pivots to **D-3 (split routers + shared handlers + Pattern B internal gate)**. v2 was structurally OK but didn't match codebase precedent — v3 mirrors `/internal/audit/egress` exactly.

**Architecture v3:** 6 files, ~560 LOC. Three layers:

| Layer | File | Auth | LOC |
|---|---|---|---|
| Pure handlers | `packages/server/lib/metrics-handlers.js` | none — `(deps, params)` → object | ~120 |
| Portal router | `packages/server/routes/portal-metrics.js` | `authenticatePortalRequest` (session) | ~110 |
| Internal router | `packages/server/routes/internal-metrics.js` | Pattern B socket-loopback + `MYA_USER_ID` env | ~100 |
| Tests | 3 files (handlers, portal, internal) | mocks per layer | ~230 |

**v2 → v3 pivots (in addition to v1→v2):**

| # | Pivot | Why |
|---|---|---|
| 6 | Split portal/internal routers (NOT single dual-mode endpoint) | Sweep 7 — agents call `/internal/*` exclusively today. Zero precedent for `/portal/*` agent callers. v2 single-endpoint would've been first-of-kind; v3 mirrors all 11 existing agent tools. |
| 7 | Use Pattern B (handler-level socket-loopback check), NOT `INTERNAL_ENDPOINTS` gate | Sweep 6 — `/internal/audit/egress`, `/internal/inbound-context/current`, `/internal/guardians/metrics` all use the handler-level socket check (`req.socket.remoteAddress` + reject `X-Forwarded-For`), NOT the gate. Cleaner: no INTERNAL_ENDPOINTS list change, sidesteps `trust proxy: 'loopback'` concern, returns 404 (non-discoverable) not 403. |
| 8 | Fix `pipeline_state.stage_name` (NOT `stage`) in era helper | Direct verification of D1 schema. v2 had `WHERE stage = ?` — would've silently returned empty. |
| 9 | Drop `_baseline_90d` from window response (FOR NOW) | Sweep 8 — `compute_information_harmonics.py` doesn't yet populate baseline columns. All NULL in production. Honest absence vs NULL noise. Add baselines to response when compute script fills them (separate follow-up PR with robust median+MAD baseline). |
| 10 | Add `notes` field to response | Migration 156 schema has it. Field 7 spec uses it for "non-English language; awaiting validation"-style honesty. Cheap to surface. |
| 11 | Workstream-D scope: 4 narrow tools, NOT 1 mega-tool | Sweep 12 — Mya's existing pattern is 11 narrow tools, all markdown out, named (not IDs), limit-capped. Mirror exactly. |

---

## Mya audit — honesty mapping (post-sweep)

Mya's 2026-05-08 consumer audit raised 5 concerns about the EXISTING metrics surface (fisher_trajectory + co-firing + vitality, NOT the new harmonic family she can't yet reach). Sweeps 8-12 verified each:

| Mya's concern | Sweep verdict | B3 impact |
|---|---|---|
| Velocity z-scores 43-62σ "physically impossible" | ✅ Confirmed structural bug. Mechanism: null-model resampling at sample-size-dependent variance ([fisher.py:194-234](../scripts/fisher.py#L194-L234)). Not "early baseline + regime change" — it's `σ ∝ 1/sqrt(message_count)`. | B3 ships NO z-score column; serves raw `value` + (eventually) `baseline_90d`. Structurally avoids the failure mode. |
| 52 orphans incl. 4-6K message "core work" territories | ✅ Algorithm honest. Mono-topic deep-focus sessions never co-occur with other territories within 7-day windows, so cofire = 0. ([compute-cofire.js:59-191](../scripts/compute-cofire.js#L59-L191)) | OUT OF SCOPE for B3. Future PR: reclassify "orphan" → "Monotopic Anchor" (~50 LOC). |
| No within-session activation order | ⚠️ PARTIALLY ALREADY SOLVED. `autocorrelation_lag1_gamma` measures message-to-message continuity; `slope_sign_change_rate_gamma` measures trajectory reversals. Both persisted in `cognitive_metrics_harmonic` per migration 156. Just not surfaced or named clearly. | B3 surfaces these via `/window` and `/series`. Workstream D MCP tool's `delivery_guidance` translates technical names → Mya's voice ("threading vs flipping"). |
| Co-firing is binary | ⚠️ HALF-TRUE. Per-scale weights are graded continuous (decay-weighted) but BINARIZED at graph level (≥0.05 threshold for inclusion). | OUT OF SCOPE for B3. Cofire is its own pipeline. |
| Vitality saturation indistinguishable from genuine integration | ✅ Real. `engagementDepth = clamp(msg_count/p90Messages × coherence, 0, 1)` saturates above 90th percentile. Top territories plateau at vitality~0.50 (slight refute of "0.7-0.8"). Harmonic family's `total_spectral_energy_*` + `variance_*` per band ARE the missing gradient. | B3 surfaces them. Workstream D MCP tool helps Mya read them as gradient. |

**Truly missing** (out of scope for B3, future PRs): pairwise transition counts `(territory_A, territory_B, count)` where B follows A within N messages; conditional probabilities `P(B | A first)`; self-loop rate `P(A | A)`. ~200-400 LOC + 1 migration.

---

## v2 (superseded — kept for revision-history honesty)

| # | Pivot | Why |
|---|---|---|
| 1 | Auth: dual-mode (portal-session OR loopback-IP+MYA_USER_ID), NOT internal-secret | Sweep 1 surfaced: `x-internal-secret` gate at app.js:329-337 covers ONLY `/delegation-callback`, `/spawn-task-async`, `/think`, `/delegate`, `/internal/v1/search/*` — **does NOT cover `/portal/*`**. Codebase precedent for loopback-only access on portal routes is the IP-allowlist pattern at portal-enrichment.js:244-250 (`LOOPBACK_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1']`). User identity for loopback callers comes from `process.env.MYA_USER_ID` (precedent at app.js:497 — `getOwnerUserId: () => process.env.MYA_USER_ID || null`). |
| 2 | Cache: `private, max-age=86400` for contracts, NOT 1-year `immutable` | Sweep 3 surfaced: codebase has zero `immutable`-cache precedent on auth-gated routes. Closest is `private, max-age=3600` (portal-library.js:1130 for R2 file fetch). 1-day cache balances "contracts rarely change mid-day" against "we WANT browser-side updates within ~24h after a spec edit + redeploy." |
| 3 | Versioning: response-embedded `contract_version`, drop `:version` from path | Sweep 3 surfaced: codebase has zero path-versioning precedent. `ContractEndpointResponseSchema` already includes `contract_version: z.string().min(1)` (metric-tool-response.js:140-145) — the field exists, no need to duplicate it in the path. |
| 4 | Mount: `app.use('/', router)` with full paths inside, NOT prefix-mounted | Sweep 1 surfaced: all 4 sibling portal routers (vitality, metric-freshness, trajectory, activity) follow this pattern. Routes like `router.get('/portal/metrics/window', ...)` keep the full path co-located with the handler, easier to grep. |
| 5 | Granularity enum: alpha/theta/delta only (NOT 5 bands) | Sweep 2 + 3 surfaced: `gamma` and `beta` are intermediate signal-band aggregations within each window, NOT separate storage granularities. Schema CHECK constraint at migration 156 limits stored rows to alpha/theta/delta. `GranularityEnum` in metric-tool-response.js already enforces this. |

---

## Sweep findings (consolidated)

**1. Existing portal-router pattern (Sweep 1).** Factory shape across 4 siblings is uniform:
```js
export function createPortalXyzRouter(deps) {
  if (!deps) throw new TypeError(...);
  const { authenticatePortalRequest, tryGetDb, safeError, config, log } = deps;
  // validate each (TypeError on missing) — see portal-trajectory.js:83-97
  const router = Router();
  router.get('/portal/xyz/...', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      // ... handler logic, query, respond
      res.json({ ... });
    } catch (e) {
      err(`[${LOG_PREFIX}] ...`);
      res.status(500).json({ error: safeError(e, '...') });
    }
  });
  return router;
}
```
Mount in app.js at line 984 (between trajectory:976-983 and activity:987-992). Import line near app.js:87.

**2. cognitive_metrics_harmonic shape (Sweep 2 + verification probe).**
- Schema: 91 columns total (5 grain PK + 41 metric values + 41 baselines + 3 honesty + 1 bookkeeping). Migration 156 line 56-133.
- Granularities: CHECK constraint allows `alpha | theta | delta` only.
- Production state (1448 rows / 1 era):
  - 250/1448 (17.3%) have populated `harmonic_amplitude_alpha_k1` — most windows lack enough message-rate to compute K=1 alpha.
  - 1290/1448 (89.1%) have `message_count > 0` — 158 windows are seeded-but-empty.
  - **0/1448 have `low_confidence = 0`** — all flagged low until 90d baselines exist (by design).
- Distribution: 1 era × (1129 alpha + 161 theta + 158 delta) = 1448.

**3. Era anchoring (Sweep 2 + cited-code read).** `deriveFisherEraId` at packages/metrics/era.js:52-70 is the canonical anchor:
1. `pipeline_state.cluster.last_success_at` (canonical)
2. `MAX(territory_profiles.updated_at WHERE dissolved_at IS NULL)` (legacy fallback)
3. `era-bootstrap-YYYYMMDD` (cold-start)

**Use this for B3 reads** rather than `MAX(clustering_run_id)` from the table, because MAX in mixed-format eras (era-X vs fisher-X) hits the known follow-up #1 lex-ordering bug. The cognitive_metrics_harmonic table only has the new `era-...` format, but defensive use of the canonical anchor avoids future drift.

**4. Frozen contract registry (Sweep 3 + cited-code read).** `packages/metrics/contracts/index.js:32-36`:
```js
export const CONTRACTS = Object.freeze({
  information_harmonic_amplitude,
  bigram_flow_features,
  topology_persistence_entropy,
});
```
- `getContract(family)` → frozen object or throws `UnknownMetricFamilyError`.
- `validateContract(family, schema)` → `{ valid, issues }` (Zod injection avoids server↔metrics dep cycle).

**5. Auth precedents.**
- Portal-session: `await authenticatePortalRequest(req)` returns `{ id: userId }` or null. Definition lives at agent-server.js level (injected into createApp).
- Loopback-IP allowlist (portal-enrichment.js:34, 244-250):
  ```js
  const LOOPBACK_IPS = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  const remoteIp = req.ip || req.connection?.remoteAddress || '';
  if (!LOOPBACK_IPS.some(ip => remoteIp.includes(ip))) {
    return res.status(403).json({ error: 'Internal only' });
  }
  ```
- Operator user from env: `process.env.MYA_USER_ID` (precedent at app.js:497).

**6. Caching precedents (Sweep 3).**
- `private, max-age=3600` exists in portal-library.js:1130 (R2 file-fetch).
- `maxAge: '1y', immutable: true` exists in agent-server.js:1335-1338 (SvelteKit hashed assets) — NOT auth-gated.
- Default for HTML: `no-store, no-cache, must-revalidate, max-age=0` (response.js:24).

**7. Test patterns (Sweep 4).** Mirror portal-trajectory.test.js / portal-vitality.test.js: supertest, mocked deps via `buildDeps()`, mocked `rawQuery` returning fixtures. 18 pre-existing failing tests in app.test.js / chat.test.js / portal-runtime.test.js / telegram tests — independent of portal-router work.

---

## Module shape

### File 1 (new): `packages/server/routes/portal-metrics.js`

~280 LOC. Mirrors portal-trajectory.js structure precisely.

```js
/**
 * Portal Metrics Router (PR1.5 B3) — three GET handlers serving the
 * cognitive metrics surface (PR1 v3 §4.23/§4.33/§4.34) to portal browser
 * AND agent loopback callers.
 *
 * @spec-ref docs/architecture/COGNITIVE-METRICS-SPEC.md §4.23/§4.33/§4.34
 * @design-ref docs/MEASUREMENT-PLANE-PR1.5-B3-DESIGN-2026-05-08.md
 */

import { Router } from 'express';
import { CONTRACTS, getContract, UnknownMetricFamilyError }
  from '@mycelium/metrics/contracts/index.js';
import { deriveFisherEraId } from '@mycelium/metrics/era.js';

const LOOPBACK_IPS = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const VALID_GRANULARITIES = new Set(['alpha', 'theta', 'delta']);
const VALID_FAMILIES = new Set(Object.keys(CONTRACTS));
const SERIES_DEFAULT_LIMIT = 100;
const SERIES_MAX_LIMIT = 1000;
const CONTRACTS_VERSION = 'v1.3.3'; // matches spec revision history; bump on spec change

// All 41 metric column names, harvested from migration 156 + index.js fixtures.
// Source of truth: this list is the wire-format public surface.
const METRIC_COLUMNS = Object.freeze([
  // §4.23 information_harmonic_amplitude — 5 bands × K=3 = 15
  'harmonic_amplitude_gamma_k1', 'harmonic_amplitude_gamma_k2', 'harmonic_amplitude_gamma_k3',
  'harmonic_amplitude_beta_k1',  'harmonic_amplitude_beta_k2',  'harmonic_amplitude_beta_k3',
  'harmonic_amplitude_alpha_k1', 'harmonic_amplitude_alpha_k2', 'harmonic_amplitude_alpha_k3',
  'harmonic_amplitude_theta_k1', 'harmonic_amplitude_theta_k2', 'harmonic_amplitude_theta_k3',
  'harmonic_amplitude_delta_k1', 'harmonic_amplitude_delta_k2', 'harmonic_amplitude_delta_k3',
  // §4.33 bigram_flow_features — 5 features × 5 bands = 25
  'mean_crossing_rate_gamma', 'mean_crossing_rate_beta', 'mean_crossing_rate_alpha',
  'mean_crossing_rate_theta', 'mean_crossing_rate_delta',
  'slope_sign_change_rate_gamma', 'slope_sign_change_rate_beta', 'slope_sign_change_rate_alpha',
  'slope_sign_change_rate_theta', 'slope_sign_change_rate_delta',
  'autocorrelation_lag1_gamma', 'autocorrelation_lag1_beta', 'autocorrelation_lag1_alpha',
  'autocorrelation_lag1_theta', 'autocorrelation_lag1_delta',
  'variance_gamma', 'variance_beta', 'variance_alpha', 'variance_theta', 'variance_delta',
  'total_spectral_energy_gamma', 'total_spectral_energy_beta', 'total_spectral_energy_alpha',
  'total_spectral_energy_theta', 'total_spectral_energy_delta',
  // §4.34 topology — 1 (column renamed to `topology_h0_persistence_entropy` in mig 157)
  'topology_h0_persistence_entropy',
]);

// Map metric_id → contract family (for response shape).
// Note: column renamed to topology_h0_persistence_entropy (mig 157) but
// the FAMILY ID stays `topology_persistence_entropy` for URL stability.
const METRIC_FAMILY = Object.freeze({
  // ... 15 harmonic_amplitude_* → 'information_harmonic_amplitude'
  // ... 25 flow features → 'bigram_flow_features'
  // ... topology_h0_persistence_entropy → 'topology_persistence_entropy'
});

/**
 * Resolve user from either portal session OR loopback IP + MYA_USER_ID.
 * Returns { id } on success, null on auth fail.
 */
async function resolveUser(req, authenticatePortalRequest) {
  // Try portal session first (browser path).
  const sessionUser = await authenticatePortalRequest(req);
  if (sessionUser?.id) return sessionUser;

  // Fall back to loopback (agent path).
  const remoteIp = req.ip || req.connection?.remoteAddress || '';
  if (LOOPBACK_IPS.some(ip => remoteIp.includes(ip))) {
    const operatorUserId = process.env.MYA_USER_ID;
    if (operatorUserId) return { id: operatorUserId };
  }

  return null;
}

export function createPortalMetricsRouter(deps) {
  if (!deps) throw new TypeError('createPortalMetricsRouter: deps required');
  const { authenticatePortalRequest, tryGetDb, safeError, config, log } = deps;

  if (typeof authenticatePortalRequest !== 'function') throw new TypeError('...');
  if (typeof tryGetDb !== 'function') throw new TypeError('...');
  if (typeof safeError !== 'function') throw new TypeError('...');
  if (!config?.LOG_PREFIX) throw new TypeError('...');

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const err = logger.error ? logger.error.bind(logger) : console.error;

  const router = Router();

  // ── Helper: get current era for the user ───────────────────────────
  async function getCurrentEra(db, userId) {
    return deriveFisherEraId({
      getPipelineState: async (name) => {
        const rows = await db.rawQuery(
          `SELECT last_success_at FROM pipeline_state WHERE user_id = ? AND stage = ?`,
          [userId, name],
        );
        return rows?.[0] || null;
      },
      query: (sql, params) => db.rawQuery(sql, params),
      userId,
    });
  }

  // ── GET /portal/metrics/window ─────────────────────────────────────
  // One window of all (or filtered) metrics for (user, granularity, era).
  router.get('/portal/metrics/window', async (req, res) => {
    try {
      const user = await resolveUser(req, authenticatePortalRequest);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const granularity = String(req.query.granularity || 'alpha');
      if (!VALID_GRANULARITIES.has(granularity)) {
        return res.status(400).json({
          error: `granularity must be one of: ${[...VALID_GRANULARITIES].join(', ')}`,
        });
      }

      // Optional ?metrics= filter (CSV); default = all 41.
      const metricsParam = req.query.metrics;
      let requestedMetrics = METRIC_COLUMNS;
      if (typeof metricsParam === 'string' && metricsParam.trim()) {
        const requested = metricsParam.split(',').map(s => s.trim()).filter(Boolean);
        const invalid = requested.filter(m => !METRIC_COLUMNS.includes(m));
        if (invalid.length) {
          return res.status(400).json({ error: `Unknown metrics: ${invalid.join(', ')}` });
        }
        requestedMetrics = requested;
      }

      const eraId = await getCurrentEra(db, user.id);

      // Query the most-recent window for (user, granularity, era).
      const cols = ['window_end', 'message_count', 'low_confidence',
                    ...requestedMetrics,
                    ...requestedMetrics.map(m => `${m}_baseline_90d`)];
      const sql = `SELECT ${cols.join(', ')} FROM cognitive_metrics_harmonic
                   WHERE user_id = ? AND granularity = ? AND clustering_run_id = ?
                   ORDER BY window_end DESC LIMIT 1`;
      const rows = await db.rawQuery(sql, [user.id, granularity, eraId]);

      if (!rows?.length) {
        return res.json({
          window: { granularity, window_end: null, era_id: eraId, message_count: 0 },
          metrics: [],
        });
      }

      const row = rows[0];
      const metrics = requestedMetrics.map(m => ({
        metric_id: m,
        value: row[m],
        baseline_90d: row[`${m}_baseline_90d`],
        low_confidence: !!row.low_confidence,
      }));

      res.set('Cache-Control', 'no-store');
      res.json({
        window: {
          granularity,
          window_end: row.window_end,
          era_id: eraId,
          message_count: row.message_count,
        },
        metrics,
      });
    } catch (e) {
      err(`[${LOG_PREFIX}] /portal/metrics/window error: ${e.message}`);
      res.status(500).json({ error: safeError(e, 'Failed to load window') });
    }
  });

  // ── GET /portal/metrics/series ─────────────────────────────────────
  // Time-series of one metric across N windows.
  router.get('/portal/metrics/series', async (req, res) => {
    try {
      const user = await resolveUser(req, authenticatePortalRequest);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const granularity = String(req.query.granularity || 'alpha');
      const metric = String(req.query.metric || '');
      if (!VALID_GRANULARITIES.has(granularity)) {
        return res.status(400).json({ error: `granularity must be one of: ...` });
      }
      if (!METRIC_COLUMNS.includes(metric)) {
        return res.status(400).json({ error: `Unknown metric: ${metric}` });
      }

      const rawLim = parseInt(req.query.limit, 10);
      const limit = !Number.isFinite(rawLim) || rawLim <= 0
        ? SERIES_DEFAULT_LIMIT
        : Math.min(rawLim, SERIES_MAX_LIMIT);

      const eraId = await getCurrentEra(db, user.id);

      const params = [user.id, granularity, eraId];
      let sql = `SELECT window_end, ${metric} AS value, ${metric}_baseline_90d AS baseline_90d,
                        message_count, low_confidence
                 FROM cognitive_metrics_harmonic
                 WHERE user_id = ? AND granularity = ? AND clustering_run_id = ?`;
      if (req.query.from) { sql += ` AND window_end >= ?`; params.push(req.query.from); }
      if (req.query.to)   { sql += ` AND window_end <= ?`; params.push(req.query.to); }
      sql += ` ORDER BY window_end LIMIT ?`;
      params.push(limit);

      const rows = await db.rawQuery(sql, params);

      res.set('Cache-Control', 'no-store');
      res.json({
        metric,
        granularity,
        era_id: eraId,
        series: (rows || []).map(r => ({
          window_end: r.window_end,
          value: r.value,
          baseline_90d: r.baseline_90d,
          message_count: r.message_count,
          low_confidence: !!r.low_confidence,
        })),
      });
    } catch (e) {
      err(`[${LOG_PREFIX}] /portal/metrics/series error: ${e.message}`);
      res.status(500).json({ error: safeError(e, 'Failed to load series') });
    }
  });

  // ── GET /portal/metrics/contracts/:family ──────────────────────────
  // Frozen presentation contract for a metric family.
  router.get('/portal/metrics/contracts/:family', async (req, res) => {
    try {
      const user = await resolveUser(req, authenticatePortalRequest);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { family } = req.params;
      if (!VALID_FAMILIES.has(family)) {
        return res.status(404).json({ error: `Unknown family: ${family}` });
      }

      const contract = getContract(family);

      res.set('Cache-Control', 'private, max-age=86400');
      res.json({
        family,
        contract,
        spec_ref: `COGNITIVE-METRICS-SPEC.md ${specSectionFor(family)}`,
        contract_version: CONTRACTS_VERSION,
      });
    } catch (e) {
      err(`[${LOG_PREFIX}] /portal/metrics/contracts error: ${e.message}`);
      res.status(500).json({ error: safeError(e, 'Failed to load contract') });
    }
  });

  return router;
}

function specSectionFor(family) {
  return {
    information_harmonic_amplitude: '§4.23',
    bigram_flow_features: '§4.33',
    topology_persistence_entropy: '§4.34',
  }[family] || '';
}
```

### File 2 (modified): `packages/server/app.js`

Two edits:
1. Import line near existing portal-router imports (~line 87):
   ```js
   import { createPortalMetricsRouter } from './routes/portal-metrics.js';
   ```
2. Mount block at line 984 (between trajectory and activity):
   ```js
   if (typeof safeError === 'function') {
     app.use('/', createPortalMetricsRouter({
       authenticatePortalRequest,
       tryGetDb,
       safeError,
       config: constants,
       log: logger?.child ? logger.child({ component: 'portal-metrics-router' }) : logger,
     }));
   }
   ```

### File 3 (new): `packages/server/test/routes/portal-metrics.test.js`

~200 LOC. Mirror portal-trajectory.test.js. Test cases:
- 401 when neither session nor loopback (rejects `203.0.113.5` IP)
- 401 when session-only path returns null
- 200 when session returns user
- 200 when loopback IP + MYA_USER_ID env set
- 401 when loopback IP but MYA_USER_ID env unset
- 503 when tryGetDb returns null
- 400 on invalid granularity
- 400 on invalid metric_id (series endpoint)
- 400 on invalid metric in `?metrics=` (window endpoint)
- 404 on unknown family (contracts endpoint)
- All-41-metrics window response has correct shape (matches MetricToolResponseSchema)
- Series response has correct shape
- Contracts response has correct shape (matches ContractEndpointResponseSchema)
- Cache-Control header set correctly per endpoint
- low_confidence boolean conversion (D1 returns 0/1 int)

### File 4 (new): `packages/server/lib/auth-loopback.js` (~30 LOC)

Extract `LOOPBACK_IPS` + `resolveUser` helper for re-use. **OR collapse into the route file** if no other caller (currently no other caller — keep collapsed for minimal-surface principle).

**Decision: collapse into portal-metrics.js for now.** Move out only if a second caller appears.

### File 5 (modified): `packages/server/test/integration/app.test.js` (optional)

Add a single line to the "extracted routers mounted" test that lists portal-metrics-router. **Defer until after primary work — these tests have pre-existing failures (Sweep 4)**.

---

## Threat model

| Threat | Mitigation |
|---|---|
| Cross-tenant read via forged user_id | Auth resolves `user.id` from session OR `MYA_USER_ID` env — never from request input. SQL params always use `user.id`. |
| Loopback bypass abused from non-VPS IP | `LOOPBACK_IPS` allowlist (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) — exact match via `.includes()` on resolved `req.ip`. Express trust-proxy off (default), so `req.ip` is socket-level not header-level. |
| Cache poisoning of contracts endpoint | `Cache-Control: private` prevents shared-cache leaks. `max-age=86400` is per-user-per-browser. |
| Encrypted PII leakage in response | All response columns are aggregate metrics (numeric). `cognitive_metrics_harmonic` table contains zero plaintext content (per migration 156 design). Per-user grain enforced by user_id in WHERE. |
| Timing-attack on contract endpoint | Frozen-fixture lookup is constant-time (object key access on small map). No timing side-channel. |
| DOS via large `?limit=` on series | Capped at SERIES_MAX_LIMIT=1000 (mirrors fisher.js precedent). |

---

## Edge cases — explicit decisions

| Edge case | Decision |
|---|---|
| User has zero rows for the requested era | `/window`: return `{ window: {...,window_end:null,message_count:0}, metrics: [] }`. `/series`: return `{ series: [] }`. NOT 404 — empty is a valid state for new users. |
| User has NULL `pipeline_state.cluster.last_success_at` | `deriveFisherEraId` falls back to `MAX(territory_profiles.updated_at)` per era.js:60-67. If still null, `era-bootstrap-YYYYMMDD`. Empty result is honest. |
| Metric value is NULL (e.g., topology where N<20) | Pass through as `value: null`. Schema allows null. Caller (agent / portal) sees `low_confidence: true` and renders accordingly. |
| Baseline 90d is NULL (always today, since no 90d history yet) | Pass through as `baseline_90d: null`. Expected for ~90 days post-PR1. |
| `?metrics=` lists 0 metrics (empty after filter) | 400 — caller intent ambiguous. Or accept and return `{ metrics: [] }`? **Decision: 400** to make caller bug visible. |
| Family in URL is a valid string but unknown | 404 (`getContract` throws `UnknownMetricFamilyError` — catch and convert). |
| Concurrent request during compute-information-harmonics rewrite | Reads are non-blocking (D1 is MVCC-ish per Cloudflare's model). Returning a partial-era is acceptable; `low_confidence: true` already flags. |
| Caller passes `granularity=monthly` (legacy spelling) | 400 — strict enum. Portal should send `delta` (canonical). |
| User has 5+ eras of data | Read uses CURRENT era only (no historical-era query). Future PR can add `?era_id=` filter. |

---

## Test strategy

| File | Tests | What's asserted |
|---|---|---|
| portal-metrics.test.js | ~25 cases | Auth (session, loopback, neither, env-missing); validation (granularity, metric_id, family); shape (window-all-41, window-filtered, series, contracts); cache headers; D1 unavailability; honesty fields (low_confidence boolean). |
| metric-tool-response.test.js (existing) | already covers schemas | No new tests needed. The route uses the same Zod schemas. |
| spec-alignment.test.js (existing) | already covers fixture↔spec drift | No new tests needed. |

Total new tests: ~25. Run via `cd packages/server && node --test 'test/**/*.test.js'`. Expect 25 new pass / 0 new fail; pre-existing 18 failures untouched.

---

## Implementation order

1. **Step 1 — Create `packages/server/routes/portal-metrics.js`** (~280 LOC). Smoke-test by starting agent-server locally + curling `/portal/metrics/contracts/information_harmonic_amplitude` from loopback (expect 200 + JSON). Stop here if anything wrong before proceeding.

2. **Step 2 — Wire mount in `packages/server/app.js`** (2-line change). Smoke-test: restart, hit each of 3 endpoints from loopback, verify response shape.

3. **Step 3 — Write tests** (~200 LOC). Run `cd packages/server && node --test 'test/routes/portal-metrics.test.js'` → expect all pass.

4. **Step 4 — Run full server suite** to confirm zero regressions: `cd packages/server && node --test 'test/**/*.test.js' 2>&1 | tail -20`. Expect: existing 18 failures unchanged, 25 new pass.

5. **Step 5 — `/deploy-and-verify` admin-only.** ssh operator-host + helper pull + pm2 restart personal-agent + smoke each of 3 endpoints via loopback curl on the VPS:
   ```bash
   ssh operator-host 'curl -s http://127.0.0.1:3004/portal/metrics/contracts/information_harmonic_amplitude | head -c 500'
   ssh operator-host 'curl -s "http://127.0.0.1:3004/portal/metrics/window?granularity=alpha" | head -c 500'
   ssh operator-host 'curl -s "http://127.0.0.1:3004/portal/metrics/series?granularity=alpha&metric=harmonic_amplitude_alpha_k1&limit=5" | head -c 500'
   ```
   Each must return 200 with JSON matching the Zod schema. If 401, MYA_USER_ID is missing or loopback gate is broken.

6. **Step 6 — Customer fleet HOLD.** Bundle with C (portal page rewrite) + D (agent MCPs) per D17 in handoff. PyWavelets pre-install in update-customers.sh is a separate prerequisite.

---

## Decision criteria for proceeding to next phase (γ)

After admin lands:
- All 3 endpoints return 200 from loopback.
- Window response includes 41 metric values (most NULL is OK, 250/1448 populated).
- Series endpoint returns ≥250 alpha rows for `harmonic_amplitude_alpha_k1`.
- Contracts endpoint returns frozen object matching ContractEndpointResponseSchema.
- No regressions in pre-existing test suite (still 18 failures, identical names).
- Cache-Control header present on contracts endpoint; absent (no-store) on window/series.

When all 6 hold, γ-phase begins (workstream C portal page + workstream D agent MCPs in parallel; both consume B3).

---

## Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `req.ip` is wrong because Express trust-proxy is on | Low | High (forged loopback) | Default trust-proxy is OFF in createApp (verify). Add unit test covering `203.0.113.5` rejection (already in plan). |
| MYA_USER_ID env-missing on customer hosts | Medium | Medium (loopback returns 401) | Provisioner sets MYA_USER_ID per host; verified in handoff. Add explicit log when loopback reaches gate but MYA_USER_ID unset. |
| 41-column SELECT exceeds D1 query size limits | Low | Medium | D1 limit is 1MB; 41 cols × 1448 rows × ~50 bytes ≈ 3MB max but our query is LIMIT 1 (window) or LIMIT ≤1000 (series). Series with all 41 metrics × 1000 rows would be ~2MB but series only fetches ONE metric — well within limits. |
| Frozen fixture mutation between import + serialization | Low | Low | Fixtures are deeply Object.freeze'd at module load; verified by registry tests. JSON.stringify ignores non-enumerable so no impact. |
| Era derivation slow on first call (each request hits D1 twice) | Medium | Low | Could cache eraId per (user,window) for ~5 min but premature optimization. Measure first; add cache only if slow. |

---

## Open questions resolved during sweep

1. **"Path-prefix `/portal/metrics/...` correct?"** → Yes; confirmed via Sweep 1 (`/api/*` is Worker-only, all server portal routes use `/portal/*`).
2. **"Internal-secret bypass for agents?"** → No; codebase uses loopback-IP allowlist + MYA_USER_ID env, NOT internal-secret, for portal routes. Pivot v1→v2.
3. **"Path-version slug?"** → No; codebase has no path-versioning precedent. Use response field. Pivot v1→v2.
4. **"1-year cache for contracts?"** → No; max precedent is `private, max-age=3600`. Use `private, max-age=86400`. Pivot v1→v2.
5. **"All 41 metrics in `/window`?"** → Yes; with optional `?metrics=` filter for narrower agent calls.
6. **"Should series endpoint be in B3?"** → Yes; portal page (workstream C) needs sparklines.
7. **"Mount as prefix or full-path?"** → Full-path inside router; mirrors all 4 sibling portal routers. Pivot v1→v2.

---

## Open questions deferred

1. **Versioning the contract URL slug.** When the spec rev bumps to v2.0 with structurally different fields, do we add `/portal/metrics/contracts/v2/:family`? **Defer:** decide when v2.0 is on the table. For now, response embeds `contract_version`.
2. **Multi-era queries.** Today reads are CURRENT era only. A trajectory-style "show me how harmonic_amplitude_alpha_k1 evolved across 3 cluster runs" needs `?era_id=` and re-tests era-mode skip semantics. **Defer to PR2 or later.**
3. **Caching the `/portal/metrics/window` response.** Currently `no-store`. Could add ETag based on `(user_id, era_id, window_end)`. **Defer:** measure 24h of admin traffic first.
4. **An `/internal/metrics/...` family.** If agents proliferate and loopback-IP gate proves insufficient, add separate `/internal/*` routes guarded by AGENT_INTERNAL_SECRET. **Defer:** loopback-IP is sufficient today.

---

## Verification table — every load-bearing assumption

| # | Assumption | Verified at |
|---|---|---|
| 1 | `createPortalTrajectoryRouter` is the canonical pattern to mirror | packages/server/routes/portal-trajectory.js:82-161 (read end-to-end) |
| 2 | Mount at line 984 between trajectory:976 and activity:987 | packages/server/app.js:976-992 (read) |
| 3 | Auth = `await authenticatePortalRequest(req)` returns `{id}` or null | packages/server/routes/portal-trajectory.js:121 |
| 4 | `x-internal-secret` does NOT cover `/portal/*` | packages/server/app.js:325-338 (INTERNAL_ENDPOINTS list — `/portal/*` not in it) |
| 5 | Loopback-IP gate pattern exists with LOOPBACK_IPS allowlist | packages/server/routes/portal-enrichment.js:34, 244-250 |
| 6 | Operator user from `process.env.MYA_USER_ID` | packages/server/app.js:497 (`getOwnerUserId: () => process.env.MYA_USER_ID || null`) |
| 7 | `deriveFisherEraId` is the canonical era anchor with documented fallback chain | packages/metrics/era.js:52-70 (read) |
| 8 | `pipeline_state` table has `(user_id, stage, last_success_at)` shape | known from prior session — verify by `PRAGMA table_info(pipeline_state)` before impl |
| 9 | `CONTRACTS` is frozen with 3 keys; `getContract` throws `UnknownMetricFamilyError` | packages/metrics/contracts/index.js:32-77 |
| 10 | `cognitive_metrics_harmonic` schema has 41 metric cols + 41 baseline + 5 grain + 3 honesty + 1 bookkeeping = 91 | migrations/156_cognitive_metrics_harmonic.sql:29-34 (comment), 56-133 |
| 11 | granularity CHECK constraint = alpha/theta/delta only | migration 156 (verify exact lines pre-impl) |
| 12 | 1448 rows in production; 250 alpha-k1 populated; 0 with low_confidence=0 | wrangler probe 2026-05-08 (this design) |
| 13 | Existing portal-trajectory test pattern uses supertest + `buildDeps()` mocks | packages/server/test/routes/portal-trajectory.test.js (per Sweep 4) |
| 14 | Pre-existing 18 server-test failures live in app.test.js / chat.test.js / portal-runtime.test.js / telegram tests | Sweep 4 ran `node --test test/` and confirmed |
| 15 | `MetricToolResponseSchema` + `ContractEndpointResponseSchema` exist | packages/server/schemas/metric-tool-response.js:140-145 (per Sweep 3) |
| 16 | Closest auth-gated cache precedent is `private, max-age=3600` | packages/server/routes/portal-library.js:1130 (per Sweep 3) |
| 17 | `Object.freeze` on contracts is deep (registry test asserts) | packages/metrics/test/contracts/registry.test.js:122-132 |
| 18 | Express trust-proxy is OFF by default — `req.ip` is socket-level | Express docs + verify in createApp before impl |

Rows 8, 11, 18 marked "verify pre-impl" — small enough to confirm in Step 1 of implementation rather than another sweep.

---

## Pickup protocol

1. Read this design top-down.
2. Operator review: confirm/redirect each of the 5 v1→v2 pivots (auth, cache, versioning, mount, granularity).
3. On approval: run TodoWrite for Step 1-5 of impl; start Step 1.
4. Verify rows 8/11/18 of verification table during Step 1 (pre-impl).
5. Ship admin via deploy-and-verify; gate γ on the 6 decision criteria.
6. Update handoff doc + MEMORY.md with B3 admin-shipped marker after Step 5 lands.

---

## Glossary (B3-specific)

- **Era / clustering_run_id**: a `era-${ISO8601}` string tagging all derived-metric rows produced from one cluster.py run. The canonical anchor lives in `pipeline_state.cluster.last_success_at`.
- **Granularity**: one of alpha (daily), theta (weekly), delta (monthly). Distinct from "bands" (gamma/beta/alpha/theta/delta intermediate signal aggregations *within* a window).
- **Family**: the contract-level grouping of related metric columns. PR1 v3 ships 3 families: information_harmonic_amplitude (15 cols), bigram_flow_features (25 cols), topology_persistence_entropy (1 col).
- **Loopback gate**: 403 for any request whose `req.ip` doesn't match `127.0.0.1` / `::1` / `::ffff:127.0.0.1`. Allows agent tool use from same VPS without portal session.
- **Low-confidence**: `low_confidence = true` ALL the time during the first 90 days of metrics, by design. Only flips to false after 90d baselines are backfilled (post-PR1.5).

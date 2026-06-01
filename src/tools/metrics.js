/**
 * Cognitive metrics MCP tools — surfaces the information-harmonics family
 * (PR1 v3 §4.23 + §4.33 + §4.34) to agents.
 *
 *   getHarmonicState   — "What's my cognitive rhythm right now?" (orientation
 *                        across all 41 metrics for one granularity). The
 *                        `detail` param narrows it:
 *                          detail:'flow'  — §4.33 within-window continuity +
 *                                           reversal rate ("threading vs flipping")
 *                          detail:'shape' — §4.34 topology persistence entropy
 *                                           ("how spread-out is the activity")
 *                        (these were the former getFlowFeatures / getShape tools,
 *                        folded in 2026-05-31 to cut surface decision-cost.)
 *   getMetricSeries    — "How has THIS metric moved over time?" (time-series
 *                        of one named metric)
 *
 * The handlers query through `db.metrics.*` (see packages/core/db-d1/metrics.js)
 * — never inline rawQuery. Same canonical layer as fisher-tools.js. Importantly,
 * the agent does NOT go through HTTP /internal/metrics/* (that's for cross-
 * process consumers); same-process MCP child reads D1 directly via the db
 * client injected from agent-tools.js.
 *
 * Voice/honesty: per the per-family Field 7 contracts (see
 * packages/metrics/contracts/), output uses preferred vocab (rhythm/pattern/
 * movement for §4.23; flow/thread/movement for §4.33; shape/spread/ground for
 * §4.34) and surfaces low_confidence + the science_honesty_footnote inline so
 * the agent has the constraint at tool-call time.
 *
 * Design: docs/MEASUREMENT-PLANE-PR1.5-B3-DESIGN-2026-05-08.md (B3 designed
 * the data layer; D shipped the agent surface that consumes it).
 *
 * @typedef {object} MetricsDomainDeps
 * @property {object} db       — needs db.metrics.*
 * @property {string} userId
 */

import { CONTRACTS } from '../metrics/contracts.js';

const VALID_GRANULARITIES = new Set(['alpha', 'theta', 'delta']);
const BANDS = ['gamma', 'beta', 'alpha', 'theta', 'delta'];
const FLOW_FEATURES = [
  'mean_crossing_rate',
  'slope_sign_change_rate',
  'autocorrelation_lag1',
  'variance',
  'total_spectral_energy',
];

const HARMONIC_AMPLITUDE_COLS = [];
for (const k of [1, 2, 3]) for (const b of BANDS) HARMONIC_AMPLITUDE_COLS.push(`harmonic_amplitude_${b}_k${k}`);
const BIGRAM_FLOW_COLS = [];
for (const f of FLOW_FEATURES) for (const b of BANDS) BIGRAM_FLOW_COLS.push(`${f}_${b}`);
const ALL_METRIC_COLS = [...HARMONIC_AMPLITUDE_COLS, ...BIGRAM_FLOW_COLS, 'topology_h0_persistence_entropy'];

const GRAIN_NAME = { alpha: 'daily', theta: 'weekly', delta: 'monthly' };


export function createMetricsDomain(deps) {
  if (!deps) throw new TypeError('createMetricsDomain: deps required');
  const { db, userId } = deps;
  if (!db?.metrics) throw new TypeError('createMetricsDomain: db.metrics required');
  if (typeof userId !== 'string') throw new TypeError('createMetricsDomain: userId required');

  const tools = [
    {
      name: 'getHarmonicState',
      description:
        'Your cognitive RHYTHM right now (vs getCurrentPhase, which is cognitive MOVEMENT). The latest window\'s bundle: activity energy at each timescale (raw / 10-msg / daily / weekly / monthly), how the thinking is flowing (continuity = how much consecutive messages stay on theme; reversals = how often direction flips), and how spread-out it is (high = scattered across topics; low = concentrated).\n\nUse detail to narrow: omit for the full bundle, "flow" for just the flow shape, "shape" for just the spread. Granularity = window grain (alpha=daily / theta=weekly / delta=monthly), default alpha.\n\nThese are RELATIVE within-user values — the bands are aggregation timescales, not EEG frequencies; do not compare across users.',
      inputSchema: {
        type: 'object',
        properties: {
          granularity: {
            type: 'string',
            enum: ['alpha', 'theta', 'delta'],
            description: 'Window grain. alpha=daily (most reactive), theta=weekly (default for "how was this week"), delta=monthly (slow drift). Default: alpha.',
          },
          detail: {
            type: 'string',
            enum: ['full', 'flow', 'shape'],
            description: 'What to return: "full" (default — energy + flow + shape), "flow" (continuity/reversals only), or "shape" (spread-out-ness only).',
          },
        },
      },
    },
    {
      name: 'getMetricSeries',
      description:
        'Time-series of one named metric across windows in the current era. Returns up to `limit` rows ordered chronologically (oldest first). Use when investigating a specific metric over time, not orienting across all 41.\n\nMetric names match column names in cognitive_metrics_harmonic — e.g., harmonic_amplitude_alpha_k1, autocorrelation_lag1_gamma, topology_h0_persistence_entropy.',
      inputSchema: {
        type: 'object',
        properties: {
          metric: { type: 'string', description: 'Column name (one of the 41 metrics). Required.' },
          granularity: {
            type: 'string',
            enum: ['alpha', 'theta', 'delta'],
            description: 'Window grain (default alpha)',
          },
          from: { type: 'string', description: 'ISO 8601 lower bound (inclusive)' },
          to:   { type: 'string', description: 'ISO 8601 upper bound (inclusive)' },
          limit: { type: 'number', description: 'Max rows (default 100, max 1000)' },
        },
        required: ['metric'],
      },
    },
  ];

  // ── Formatters (markdown) ────────────────────────────────────────────────

  function fmtNum(v, digits = 3) {
    if (v == null) return '—';
    return Number(v).toFixed(digits);
  }

  function lowConfFlag(low) {
    return low ? '_low_confidence: 90d baselines not yet established; raw values only_' : '';
  }

  function emptyWindow(title, granularity, eraId, msg) {
    return [
      `# ${title} — ${granularity} (${GRAIN_NAME[granularity]})`,
      '',
      msg,
      '',
      `era: ${eraId}`,
    ].join('\n');
  }

  function formatHarmonicState(window) {
    const lines = [`# Cognitive rhythm — ${window.granularity} (${GRAIN_NAME[window.granularity]})`, ''];
    lines.push(`Window end: ${(window.window_end || '').slice(0, 10) || '—'}`);
    lines.push(`Messages in window: ${window.message_count}`);
    lines.push(`Era: ${window.era_id}`);
    lines.push('');

    // §4.23 — K=1 amplitudes per band (the headline harmonic strength)
    lines.push('## Rhythm strength (§4.23 harmonic_amplitude, K=1)');
    lines.push('Bands are temporal aggregation scales, NOT EEG Hz.');
    lines.push('');
    for (const b of BANDS) {
      const v = window.values[`harmonic_amplitude_${b}_k1`];
      lines.push(`- **${b}** (${b === 'gamma' ? 'per-message' : b === 'beta' ? '10-msg' : GRAIN_NAME[b] || b}): ${fmtNum(v, 4)}`);
    }
    lines.push('');

    // §4.33 — flow shape (autocorr + reversal rate per band)
    lines.push('## Flow shape (§4.33 within-window features)');
    lines.push('Threading (autocorrelation_lag1) vs flipping (slope_sign_change_rate).');
    lines.push('');
    lines.push('```');
    lines.push('band     autocorr_lag1   slope_flip_rate   variance');
    for (const b of BANDS) {
      const ac = fmtNum(window.values[`autocorrelation_lag1_${b}`], 3).padStart(13);
      const sf = fmtNum(window.values[`slope_sign_change_rate_${b}`], 3).padStart(15);
      const v  = fmtNum(window.values[`variance_${b}`], 3).padStart(8);
      lines.push(`${b.padEnd(8)} ${ac}  ${sf}  ${v}`);
    }
    lines.push('```');
    lines.push('');

    // §4.34 — topology shape
    lines.push('## Activity shape (§4.34 topology_h0_persistence_entropy)');
    const tpe = window.values['topology_h0_persistence_entropy'];
    if (tpe == null) {
      lines.push('Not enough messages here to read the shape (N<20 threshold).');
    } else {
      lines.push(`H0 entropy on 256D matryoshka projection: ${fmtNum(tpe, 3)}`);
    }
    lines.push('');

    if (window.notes) lines.push(`_note: ${window.notes}_`);
    const flag = lowConfFlag(window.low_confidence);
    if (flag) lines.push(flag);
    return lines.join('\n').trimEnd();
  }

  function formatFlowFeatures(window) {
    const lines = [`# Flow shape — ${window.granularity} (${GRAIN_NAME[window.granularity]})`, ''];
    lines.push(`Window end: ${(window.window_end || '').slice(0, 10) || '—'}`);
    lines.push(`Messages in window: ${window.message_count}`);
    lines.push(`Era: ${window.era_id}`);
    lines.push('');
    lines.push('§4.33 bigram_flow_features — within-window temporal structure across 5 bands.');
    lines.push('Validated clinically (Palominos 2024 schizophrenia); Mycelium use is methodological extrapolation.');
    lines.push('');

    lines.push('```');
    lines.push('feature                  gamma     beta      alpha     theta     delta');
    for (const f of FLOW_FEATURES) {
      const cells = BANDS.map((b) => fmtNum(window.values[`${f}_${b}`], 3).padStart(8));
      lines.push(`${f.padEnd(24)} ${cells.join('  ')}`);
    }
    lines.push('```');
    lines.push('');

    if (window.notes) lines.push(`_note: ${window.notes}_`);
    const flag = lowConfFlag(window.low_confidence);
    if (flag) lines.push(flag);
    return lines.join('\n').trimEnd();
  }

  function formatShape(window) {
    const lines = [`# Activity shape — ${window.granularity} (${GRAIN_NAME[window.granularity]})`, ''];
    lines.push(`Window end: ${(window.window_end || '').slice(0, 10) || '—'}`);
    lines.push(`Messages in window: ${window.message_count}`);
    lines.push(`Era: ${window.era_id}`);
    lines.push('');

    const tpe = window.values['topology_h0_persistence_entropy'];
    if (tpe == null) {
      lines.push('Not enough messages here to read the shape (N<20 — Vietoris-Rips H0 unstable below threshold).');
    } else {
      lines.push(`H0 persistence entropy: **${fmtNum(tpe, 3)}**`);
      lines.push('');
      lines.push('Computed on a 256D matryoshka projection of the window\'s message embeddings.');
      lines.push('Higher = activity spread across more semantic regions; lower = concentrated.');
    }
    lines.push('');

    if (window.notes) lines.push(`_note: ${window.notes}_`);
    const flag = lowConfFlag(window.low_confidence);
    if (flag) lines.push(flag);
    return lines.join('\n').trimEnd();
  }

  function formatMetricSeries(metric, granularity, eraId, rows) {
    const lines = [`# ${metric} — ${granularity} (${GRAIN_NAME[granularity]})`, ''];
    lines.push(`Era: ${eraId}`);
    if (rows.length === 0) {
      lines.push('');
      lines.push('No data in the requested range.');
      return lines.join('\n');
    }
    lines.push(`Windows: ${rows.length}`);
    lines.push('');
    lines.push('```');
    lines.push('window_end   value      msgs   conf');
    for (const r of rows) {
      const date = (r.window_end || '').slice(0, 10);
      const value = fmtNum(r.value, 4).padStart(8);
      const msgs = String(r.message_count).padStart(4);
      const conf = r.low_confidence ? 'low' : 'ok ';
      lines.push(`${date}   ${value}   ${msgs}   ${conf}`);
    }
    lines.push('```');
    return lines.join('\n');
  }

  // ── Handlers ────────────────────────────────────────────────────────────

  const handlers = {
    // getHarmonicState absorbs the former getFlowFeatures / getShape tools via
    // the `detail` param — same fetch + formatter logic, one discoverable tool.
    getHarmonicState: async (args = {}) => {
      const granularity = args.granularity || 'alpha';
      if (!VALID_GRANULARITIES.has(granularity)) {
        return `# Error\n\nInvalid granularity "${granularity}". Use one of: alpha, theta, delta.`;
      }
      const detail = args.detail || 'full';

      if (detail === 'flow') {
        const window = await db.metrics.getCurrentWindow(userId, { granularity, requestedMetrics: BIGRAM_FLOW_COLS });
        if (!window.window_end) {
          return emptyWindow('Flow shape', granularity, window.era_id, CONTRACTS.bigram_flow_features.refusal_mode);
        }
        return formatFlowFeatures(window);
      }
      if (detail === 'shape') {
        const window = await db.metrics.getCurrentWindow(userId, { granularity, requestedMetrics: ['topology_h0_persistence_entropy'] });
        if (!window.window_end) {
          return emptyWindow('Activity shape', granularity, window.era_id, CONTRACTS.topology_persistence_entropy.refusal_mode);
        }
        return formatShape(window);
      }

      const window = await db.metrics.getCurrentWindow(userId, { granularity });
      if (!window.window_end) {
        return emptyWindow('Cognitive rhythm', granularity, window.era_id, CONTRACTS.information_harmonic_amplitude.refusal_mode);
      }
      return formatHarmonicState(window);
    },

    getMetricSeries: async (args = {}) => {
      const metric = args.metric;
      if (!metric) return '# Error\n\nMetric required. See cognitive_metrics_harmonic columns.';
      if (!ALL_METRIC_COLS.includes(metric)) {
        return `# Error\n\nUnknown metric "${metric}". Must be a column name from cognitive_metrics_harmonic (e.g., harmonic_amplitude_alpha_k1, autocorrelation_lag1_gamma, topology_h0_persistence_entropy).`;
      }
      const granularity = args.granularity || 'alpha';
      if (!VALID_GRANULARITIES.has(granularity)) {
        return `# Error\n\nInvalid granularity "${granularity}". Use one of: alpha, theta, delta.`;
      }
      const eraId = await db.metrics.getCurrentEra(userId);
      const rows = await db.metrics.getSeries(userId, {
        metric,
        granularity,
        from: args.from,
        to: args.to,
        limit: args.limit,
      });
      return formatMetricSeries(metric, granularity, eraId, rows);
    },
  };

  return { tools, handlers };
}

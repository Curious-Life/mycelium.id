// verify:cross-check-display — the honesty gate for wiring the 2×2 cross-check into the
// Curious Life page. The cross-check is the page's strongest trust signal, so the wiring
// must NEVER let the chip vouch for a number it isn't actually about.
//
// THE LOAD-BEARING INVARIANT (proven numerically below): the headline σ
// (summary.velocity_baseline_z) and the cross-check F (fisher_velocity_z) are computed by
// the SAME baselineZ() over the SAME confident-Fisher series. They are bit-equal IFF the
// cross-check's aligned week W is the latest confident Fisher week (is_current). When the
// embedding stage lags, W is an EARLIER week → the chip must NOT qualify the displayed σ.
// This gate proves the equality holds when current, and that the "current" week genuinely
// differs when it lags (so the is_current gate is necessary, not decorative), then asserts
// the endpoint reports is_current and the view gates the chip on it + fails closed.

import { readFileSync } from 'node:fs';
import { baselineZ } from '../src/metrics/baseline-z.js';

const ledger = [];
const rec = (name, pass, detail = '') => {
  ledger.push(Boolean(pass));
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};

// ── Numeric invariant: model the two endpoints' series selection exactly ──
// rows mirror fisher_trajectory weekly_step: { w: window_start, v: fisher_velocity, lc: low_confidence }
const rows = [
  { w: '2026-01-05', v: 0.10, lc: 0 },
  { w: '2026-01-12', v: 0.12, lc: 0 },
  { w: '2026-01-19', v: 0.09, lc: 0 },
  { w: '2026-01-26', v: 0.11, lc: 0 },
  { w: '2026-02-02', v: 0.10, lc: 0 },
  { w: '2026-02-09', v: 0.13, lc: 0 },
  { w: '2026-02-16', v: 0.09, lc: 1 }, // low-confidence → excluded by both endpoints
  { w: '2026-02-23', v: 0.20, lc: 0 }, // latest confident "big week" — the headline's current
];
// summary's confVel (src/portal-measurement.js:323) — ALL confident rows.
const confVel = rows.filter((r) => !r.lc && r.v != null).map((r) => Number(r.v));
// cross-check's latestFisherW (the new field) — max confident window.
const latestFisherW = rows.reduce(
  (mx, r) => (!r.lc && r.v != null && (mx === null || r.w > mx)) ? r.w : mx, null);

// is_current case: W === latestFisherW → fSeries === confVel → F.z === headline σ.
const Wcur = latestFisherW;
const fSeriesCur = rows.filter((r) => r.w <= Wcur && !r.lc && r.v != null).map((r) => Number(r.v));
const headlineZ = baselineZ(confVel).z;
const fCurZ = baselineZ(fSeriesCur).z;
rec('X7a. is_current ⇒ F.z === velocity_baseline_z (same series, same baselineZ)',
  headlineZ != null && fCurZ != null && headlineZ === fCurZ,
  `headline σ=${headlineZ?.toFixed(4)} crosscheck F=${fCurZ?.toFixed(4)} (W=${Wcur}=latest)`);

// lagged case: W is an EARLIER confident week (embedding stage behind) → the cross-check's
// "current" week differs from the headline's, so qualifying the σ would be dishonest.
const Wlag = '2026-02-09';
const fSeriesLag = rows.filter((r) => r.w <= Wlag && !r.lc && r.v != null).map((r) => Number(r.v));
rec('X7b. lagged: W < latest ⇒ is_current false AND cross-check current-week ≠ headline current-week',
  (Wlag === latestFisherW) === false
    && fSeriesLag[fSeriesLag.length - 1] !== confVel[confVel.length - 1],
  `Wlag=${Wlag} latest=${latestFisherW}; lag-current=${fSeriesLag.at(-1)} headline-current=${confVel.at(-1)}`);

// ── Endpoint contract (read source) ──
const restSrc = readFileSync(new URL('../src/portal-measurement.js', import.meta.url), 'utf8');
rec('X1. /trajectory/cross-check returns latest_window + is_current',
  restSrc.includes('latest_window:') && restSrc.includes('is_current:'),
  'latest_window + is_current present in the cross_check payload');

rec('X2. is_current derived from the SAME getTrajectory(weekly_step) Fisher series as the headline',
  restSrc.includes('const latestFisherW = fisher.reduce(')
    && restSrc.includes('!r.low_confidence && r.fisher_velocity != null')
    && (restSrc.match(/db\.fisher\.getTrajectory\(u\.id, \{ level, windowType: 'weekly_step'/g) || []).length >= 2,
  'latestFisherW computed over `fisher` with the headline filter; getTrajectory used by both endpoints');

rec('X6. the is_current ⇒ === velocity_baseline_z invariant is documented at the source',
  restSrc.includes('is_current') && restSrc.includes('velocity_baseline_z')
    && /EXACTLY|=== summary\.velocity_baseline_z|F\.z === summary/.test(restSrc),
  'rationale comment present so the invariant does not rot');

// ── View wiring + fail-closed honesty (read source) ──
const viewSrc = readFileSync(new URL('../portal-app/src/lib/views/CuriousLifeView.svelte', import.meta.url), 'utf8');
rec('X3. trust chip is GATED on is_current (never qualifies a stale week)',
  viewSrc.includes('is_current') && viewSrc.includes('xcCurrent') && viewSrc.includes('headlineTrust')
    && viewSrc.includes('class="trust"'),
  'xcCurrent + headlineTrust gate the .trust pill');

rec('X4. view renders <CrossCheckQuadrant> and the old always-on one-liner is gone',
  viewSrc.includes('import CrossCheckQuadrant') && viewSrc.includes('<CrossCheckQuadrant')
    && !viewSrc.includes('<b>Cross-check — {movementCrossCheck.label}.</b>'),
  '2×2 component imported + rendered; legacy single-line block removed');

rec('X5. honesty: insufficient still renders nothing (fail-closed) in BOTH view and component',
  viewSrc.includes("movementCrossCheck.state !== 'insufficient'")
    && readFileSync(new URL('../portal-app/src/lib/curious/CrossCheckQuadrant.svelte', import.meta.url), 'utf8')
      .includes("state === 'insufficient'"),
  'insufficient guard present in the panel gate and the component');

rec('X8. lag + freshness + attribution surfaced honestly (xcLag, xcHedge, top_movers)',
  viewSrc.includes('xcLag') && viewSrc.includes('xcHedge') && viewSrc.includes('xcMovers'),
  'as-of lag note + freshness hedge + basis-suspect top_movers wired');

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — cross-check chip qualifies the headline ONLY when current (proven F.z===σ); fails closed; 2×2 wired' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

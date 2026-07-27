// verify:pipeline-poll — the built-map LIVE FEED (PIPELINE-TRANSPARENCY-DESIGN-2026-07-19, Unit 5;
// the built-map-live-feed MED deferred from Unit 3).
//
// MindscapeView's readiness timer is the SOLE feeder of the canonical `pipeline` store. It used to
// CLEAR itself the moment `mindGenerated === true` (the map is built) — so after the map existed, a
// re-import or a model-approval that re-opened embed/categorize left the built-map pipeline overview
// FROZEN on stale stages (held, never blank — §3.2a — but not live). Unit 5 keeps the SAME timer
// armed past a built map and switches its tick to the cheap pipeline-only refresh, so the overview
// stays live WITHOUT a new interval or a new scan.
//
// The decision is extracted as a pure function (src/lib/pipeline-poll.ts) so this gate DRIVES it
// rather than grepping the THREE.js-heavy MindscapeView ([[render-must-be-mounted-not-grepped]] /
// the "run the module, don't grep it" discipline the generate-store + probe-cap gates use).
//
//   L1  ⭐ a BUILT map keeps the pipeline slice LIVE ('pipeline'), and the timer OUTLIVES it (armed).
//       Mutate pollAction to return 'stop' on a built map (the OLD behaviour) → this reds.
//   L2  a not-yet-known map runs the full convergence poll ('converge') — invite-vs-map still resolving.
//   L3  the probe cap OUTRANKS a built map: it STOPS the timer (retry state owns it) — no infinite poll.
//
// Reach: gates the DECISION, not MindscapeView's $effect wiring of it (see drive-pipeline-poll.mjs's
// honest-reach note). The decision is the falsifiable half.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const t = (n, fn) => { try { fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } };

let d;
try {
  const line = execFileSync('node', ['test/drive-pipeline-poll.mjs'],
    { cwd: 'portal-app', encoding: 'utf8', timeout: 120000, env: { ...process.env } })
    .trim().split('\n').pop();
  d = JSON.parse(line);
} catch (e) {
  console.log(`FAIL  L0. the driver runs — ${String(e?.message || e).slice(0, 400)}`);
  console.log('\nVERDICT: NO-GO — the pipeline-poll driver did not run  EXIT=1');
  process.exit(1);
}
if (!d.ok) {
  console.log(`FAIL  L0. the driver built + imported pipeline-poll.ts — ${String(d.error).slice(0, 400)}`);
  console.log('\nVERDICT: NO-GO  EXIT=1');
  process.exit(1);
}
rec('L0. pipeline-poll.ts builds, imports, and the decision runs', true);

t('L1. ⭐ a BUILT map keeps the pipeline slice LIVE, and the timer OUTLIVES it (the Unit-5 fix)', () => {
  assert.equal(d.builtMapTick, 'pipeline',
    `mindGenerated===true (map built) must keep the pipeline slice LIVE ('pipeline'), got '${d.builtMapTick}'. `
    + "Returning 'stop' here is the OLD behaviour that froze the built-map overview on a re-import.");
  assert.equal(d.builtMapArmed, true,
    'the timer must stay ARMED past a built map — it is the sole feeder of the pipeline store; '
    + 'clearing it on known-true is exactly the frozen-overview bug Unit 5 fixes');
});

t('L2. a not-yet-known map runs the full convergence poll (invite-vs-map still resolving)', () => {
  assert.equal(d.unknownTick, 'converge', `mindGenerated===null must run the convergence poll, got '${d.unknownTick}'`);
  assert.equal(d.falseTick, 'converge', `mindGenerated===false (still resolving) must converge, got '${d.falseTick}'`);
});

t('L3. the probe cap OUTRANKS a built map — it STOPS the timer (no infinite poll)', () => {
  assert.equal(d.cappedTick, 'stop', `the exhausted probe cap must stop the tick, got '${d.cappedTick}'`);
  assert.equal(d.cappedArmed, false, 'and disarm the timer so the "couldn\'t read your map" retry state owns it');
});

const allPass = ledger.every(Boolean);
console.log(`\n${ledger.filter(Boolean).length}/${ledger.length} checks passed`);
console.log(`VERDICT: ${allPass ? 'GO — the built-map pipeline overview stays LIVE (the timer outlives a built map; the tick switches to the cheap pipeline-only refresh), and the probe cap still stops it' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);

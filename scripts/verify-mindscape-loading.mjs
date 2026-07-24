// verify:mindscape-loading — D-028 part 2: the post-generate loading screen must NOT jitter.
//
// THE DEFECT (operator, reported THREE times): after landing on the Mycelium screen "that reload
// screen is buggy — it laggs and restarts reload multiple times, eventually loads but the jittery
// restarting loading icon is buggy and looks very broken."
//
// This gate does NOT grep for an animation tweak — the operator's explicit call was to root-cause
// it, not paper over it. It MOUNTS the real MindscapeView (real Svelte compiler + jsdom + the real
// mindscape/generate/pipeline stores) via test/mount-mindscape-loading.mjs, drives the real
// post-generate sequence, and asserts on MEASURED behaviour:
//
//   L1  BOUNDED RELOADS. The `$generate.phase === 'done'` $effect must run its body once per
//       completion, not re-enter itself. Pre-fix it re-entered ~18,000×/s because it called
//       loadTerritories(), whose `if (territoriesLoaded) return` guard made the effect take a
//       reactive dependency on a signal the effect itself writes — an infinite reload loop, each
//       iteration tearing down and rebuilding the spinner. Measured: 20,001 load() calls in 1.1s.
//       L1 fails if the harness reports `runaway`, or if load() is called more than L1_MAX times.
//
//   L2  ONE STABLE LOADING NODE. The waiting states used to be five separate `<div class=loading-3d>`
//       across an {#if}/{:else if} chain. Each arm is a different DOM element, so a transition
//       DESTROYS one and CREATES another — restarting the spinner's CSS keyframe from t=0 on every
//       hop (the "restarting loading icon"). The fix renders ONE element whose copy varies. L2 fails
//       if the single post-generate map-landing creates more than one `.loading-3d` element.
//
//   L3  THE SURFACE IS NOT MUTED. Collapsing five nodes into one must NOT collapse the five
//       messages — §3.2a: a waiting state that stops saying which state it is has regressed into
//       silence. L3 fails if the honest "map built — finishing loading it…" copy never reaches the
//       stable node (proof the copy still changes even though the element does not).
//
// MUTATION-TESTED: reverted the done-effect to its un-untracked/un-latched form (mindscapeState.load
//   + loadTerritories with no untrack, no doneHandled) → harness reports runaway:true → L1 REDs.
// MUTATION-TESTED: restored the five separate `<div class="loading-3d">` arms (one per {:else if})
//   in place of the single `{#if loadArm}` node → perStep.onGenerateDone creations = 3 (>1) → L2 REDs.
// MUTATION-TESTED: deleted the "finishing loading it…" copy from the built-not-loaded arm →
//   distinctCopy no longer contains it → L3 REDs.
import { execFileSync } from 'node:child_process';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// A cap comfortably above the healthy count (2) but low enough that a runaway terminates the
// harness in well under a second instead of spinning to the gate's timeout. On the fixed tree the
// harness never approaches it and reports the full summary; on a regression it reports `runaway`.
const L1_MAX = 8;

let r;
try {
  const out = execFileSync('node', ['--conditions', 'browser', 'test/mount-mindscape-loading.mjs'], {
    cwd: 'portal-app', encoding: 'utf8', timeout: 120000,
    env: { ...process.env, LOAD_CAP: String(L1_MAX), TRACE: '' },
  }).trim().split('\n').filter(Boolean).pop();
  r = JSON.parse(out);
} catch (e) {
  console.log(`FAIL  harness — did not run cleanly: ${e?.message || e}`);
  console.log('VERDICT: NO-GO — the measurement harness itself failed  EXIT=1');
  process.exit(1);
}

if (r.fatal) {
  console.log(`FAIL  harness — ${r.fatal.split('\n')[0]}`);
  console.log('VERDICT: NO-GO — see FAIL rows  EXIT=1');
  process.exit(1);
}

// L1 — bounded reloads
rec('L1 done-effect does not re-enter (no reload runaway)',
  !r.runaway && r.calls?.load <= L1_MAX,
  r.runaway ? `runaway: ${r.calls?.load}+ load() calls in ${r.msSinceFirstLoad}ms`
            : `load() called ${r.calls?.load}× (≤ ${L1_MAX})`);

// L2 — one stable loading node across the post-generate map-landing
rec('L2 one stable loading node (spinner not recreated per state)',
  !r.runaway && r.perStep?.onGenerateDone <= 1,
  r.runaway ? 'runaway — node count unmeasurable' : `${r.perStep?.onGenerateDone} .loading-3d node(s) created when the map landed`);

// L3 — the collapsed node still carries the distinct waiting messages
const BUILT_COPY = 'finishing loading it';
rec('L3 waiting surface not muted (copy still changes on the stable node)',
  Array.isArray(r.distinctCopy) && r.distinctCopy.some((c) => c.includes(BUILT_COPY)),
  `distinctCopy = ${JSON.stringify(r.distinctCopy)}`);

const allPass = ledger.every(Boolean);
console.log(`VERDICT: ${allPass ? 'GO — the post-generate loading screen is one stable node, reloaded once' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);

// verify:swipe-back — the app-level VIEW-HISTORY back navigation (QA R4-SWIPEBACK)
//                      + the unified back that walks the mindscape drill-down first (D-035).
//
// The workspace authors its own URL with replaceState, so in-app view switches leave NO browser
// history entry — the OS/WebKit Back gesture has nothing to return to. R4 adds an app-level back-stack
// (workspace.back()/canGoBack) and binds a two-finger horizontal swipe to it (Header.svelte), guarded
// so it never hijacks a legitimate in-view horizontal scroll.
//
//   B-behaviour  DRIVES the real store: a view sequence records history, back() replays it in reverse,
//                a self-nav does not grow the stack, and canGoBack tracks depth (test/drive-workspace-back.mjs).
//   B-gesture    Header.svelte binds a WINDOW wheel listener that calls the unified back (goBackIntent),
//                is horizontal-dominant only, and GUARDS against hijacking an in-view horizontal scroller.
//   B-store      the store exposes back() + canGoBack and records history in openInActiveTab.
//
// D-035: the mindscape keeps its OWN drill-down history (realms → themes → territories → detail) in a
// SEPARATE store, invisible to the workspace view-history stack. A swipe used to pop the whole mindscape
// VIEW instead of stepping up the drill-down. The fix routes the gesture through a coordinator
// (lib/nav/back-intent.ts goBackIntent) that walks the mindscape drill-down FIRST and only pops the
// workspace VIEW once the mindscape is at its top level (or is not the focused view).
//
//   D-behaviour  DRIVES the real coordinator over the real workspace + mindscape + navigation stores:
//                (a) drilling in then a back walks the drill-down and does NOT leave the view;
//                (b) at the top, a back finally pops the workspace view;
//                (c) when the mindscape is not focused, a back goes straight to the view-history back
//                (no hijack)  (test/drive-mindscape-back.mjs).
//   D-wire       Header routes the gesture through goBackIntent, and the coordinator considers the
//                mindscape drill-down (mindscapeState.goBack) BEFORE the workspace view back.
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.
//
// MUTATION-TESTED: coordinator reverted to the D-035 bug (never walk the mindscape: `false && …`) →
//   D1 REDs (a back while drilled-in pops the workspace VIEW instead of stepping up the drill-down).
// MUTATION-TESTED: coordinator never falls through at the top (`if (focused) { goBack(); return 'mindscape' }`)
//   → D2 REDs (at the top level the back no longer leaves the mindscape view).
// MUTATION-TESTED: focus guard removed (walk the mindscape even when it is NOT the focused view)
//   → D3 REDs (an unfocused mindscape's drill-down gets consumed / the view back is hijacked).
// MUTATION-TESTED: Header reverted to call workspace.back() directly instead of goBackIntent()
//   → B-gesture + D-wire RED (the gesture no longer routes through the unified back).
// All restored afterwards; the suite returns GREEN on the restored tree.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const P = (...p) => path.join(HERE, '..', 'portal-app', ...p);
const read = (f) => readFileSync(f, 'utf8');
const ledger = [];
const rec = (n, pass, d = '') => { ledger.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// ── Drive the real store ─────────────────────────────────────────────────────
let d;
try {
  const line = execFileSync('node', ['test/drive-workspace-back.mjs'], { cwd: P(), encoding: 'utf8', timeout: 120000 }).trim().split('\n').pop();
  d = JSON.parse(line);
} catch (e) {
  console.log(`FAIL  B0. the back-history harness runs — ${String(e?.message || e).slice(0, 400)}`);
  console.log('\nVERDICT: NO-GO — the harness failed to run  EXIT=1');
  process.exit(1);
}
rec('B0. the workspace back-history harness runs', d.ok, d.error);

rec('B1. a view sequence records history; back() replays it in REVERSE (areas → mindscape)',
  d.startView === 'mindscape' && d.afterAreas === 'areas' && d.afterTimeline === 'timeline'
    && d.back1 === true && d.viewBack1 === 'areas'
    && d.back2 === true && d.viewBack2 === 'mindscape',
  `start=${d.startView} areas=${d.afterAreas} timeline=${d.afterTimeline} back1=${d.back1}/${d.viewBack1} back2=${d.back2}/${d.viewBack2}`);

rec('B2. back() at the BOTTOM of the stack is a no-op (returns false, stays put) — never leaves the app',
  d.back3 === false && d.viewBack3 === 'mindscape',
  `back3=${d.back3} view=${d.viewBack3}`);

rec('B3. a SELF-navigation does not grow the stack (no dupe back entry)',
  // after mindscape→areas→timeline→timeline(self), two backs reach mindscape and a third is a no-op.
  d.afterSelfNav === 'timeline' && d.canBackAtBottom === false,
  `afterSelfNav=${d.afterSelfNav} canBackAtBottom=${d.canBackAtBottom}`);

rec('B4. canGoBack tracks depth: false at start, true after a nav, false when exhausted, true again after a new nav',
  d.canBackAtStart === false && d.canBackAfterOne === true && d.canBackAtBottom === false
    && d.canBackAfterLibrary === true && d.back4 === true && d.viewBack4 === 'mindscape',
  `start=${d.canBackAtStart} afterOne=${d.canBackAfterOne} bottom=${d.canBackAtBottom} afterLib=${d.canBackAfterLibrary} back4=${d.back4}/${d.viewBack4}`);

// ── Static: the store surface + the Header gesture binding ────────────────────
const store = read(P('src', 'lib', 'workspace', 'store.ts'));
rec('B-store. the store exposes back() + canGoBack and records history in openInActiveTab',
  /\bback\(\)\s*:\s*boolean/.test(store) && /canGoBack\s*:/.test(store) && /recordNav\(/.test(store),
  'store must define back(), canGoBack, and call recordNav in openInActiveTab');

const header = read(P('src', 'lib', 'components', 'shell', 'Header.svelte'));
const bindsWheel = /addEventListener\(\s*['"]wheel['"]/.test(header);
const callsBack = /goBackIntent\(\)/.test(header);   // D-035: the gesture routes through the unified back
const horizontalOnly = /deltaX[\s\S]{0,60}deltaY/.test(header);   // horizontal-dominant guard
const scrollerGuard = /overflowX|scrollWidth|ownedByScroller/.test(header);
rec('B-gesture. Header binds a window wheel swipe → goBackIntent(), horizontal-dominant, guarding an in-view scroller',
  bindsWheel && callsBack && horizontalOnly && scrollerGuard,
  `wheel=${bindsWheel} back=${callsBack} horizontalOnly=${horizontalOnly} scrollerGuard=${scrollerGuard}`);

// ── D-035: the unified back walks the mindscape drill-down before leaving the view ────────────
// Drive the REAL coordinator (lib/nav/back-intent.ts) over the REAL workspace + mindscape +
// navigation stores. This is the state-machine proof; the D-wire static check below only guards
// the wiring the harness assumes.
let m;
try {
  const line = execFileSync('node', ['test/drive-mindscape-back.mjs'], { cwd: P(), encoding: 'utf8', timeout: 120000 }).trim().split('\n').pop();
  m = JSON.parse(line);
} catch (e) {
  m = { ok: false, error: String(e?.message || e).slice(0, 400) };
}
rec('D0. the unified-back harness runs', m.ok, m.error);

rec('D1. drilled INTO the mindscape, a back walks the drill-down (detail → territory → realm) and NEVER leaves the view',
  m.step1 === 'mindscape' && m.afterStep1Territory === null
    && m.step2 === 'mindscape' && m.afterStep2Theme === null
    && m.step3 === 'mindscape' && m.afterStep3Realm === null
    && m.viewAfterDrillWalk === 'mindscape' && m.viewHistoryIntactAfterWalk === true
    && m.atTopAfterWalk === true,
  `step1=${m.step1}/${m.afterStep1Territory} step2=${m.step2}/${m.afterStep2Theme} step3=${m.step3}/${m.afterStep3Realm} `
    + `view=${m.viewAfterDrillWalk} histIntact=${m.viewHistoryIntactAfterWalk} atTop=${m.atTopAfterWalk}`);

rec('D2. only ONCE the mindscape is at its top level does a back pop the workspace VIEW (leaves to the previous screen)',
  m.step4 === 'workspace' && m.viewAfterTopBack === 'areas',
  `step4=${m.step4} viewAfterTopBack=${m.viewAfterTopBack}`);

rec('D3. when the mindscape is NOT the focused view, a back goes STRAIGHT to the view-history back (no hijack of the drill-down)',
  m.unfocusedConsumer === 'workspace' && m.unfocusedViewAfter === 'mindscape' && m.unfocusedMindscapeUntouched === true,
  `consumer=${m.unfocusedConsumer} view=${m.unfocusedViewAfter} drillUntouched=${m.unfocusedMindscapeUntouched}`);

// D-wire (static): the gesture routes through goBackIntent, and the coordinator considers the
// mindscape drill-down BEFORE the workspace view back.
const backIntentRaw = read(P('src', 'lib', 'nav', 'back-intent.ts'));
// Strip comments so a prose mention of `workspace.back()` in the doc block can't be
// mistaken for the CODE order we're asserting.
const backIntent = backIntentRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const idxMind = backIntent.indexOf('mindscapeState.goBack()');
const idxWs = backIntent.indexOf('workspace.back()');
const mindBeforeWs = idxMind !== -1 && idxWs !== -1 && idxMind < idxWs;
const guardsFocus = /primaryView[\s\S]{0,40}mindscape/.test(backIntent);
rec('D-wire. goBackIntent considers the mindscape drill-down (guarded by focus) BEFORE the workspace view back',
  callsBack && mindBeforeWs && guardsFocus,
  `headerRoutes=${callsBack} mindBeforeWs=${mindBeforeWs} guardsFocus=${guardsFocus}`);

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — app-level view-history back (recorded, replayed in reverse, depth-tracked, bound to a guarded two-finger swipe) AND the unified back walks the mindscape drill-down first, leaving the view only at its top level (D-035)' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

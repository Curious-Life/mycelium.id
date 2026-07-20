// verify:swipe-back — the app-level VIEW-HISTORY back navigation (QA R4-SWIPEBACK).
//
// The workspace authors its own URL with replaceState, so in-app view switches leave NO browser
// history entry — the OS/WebKit Back gesture has nothing to return to. R4 adds an app-level back-stack
// (workspace.back()/canGoBack) and binds a two-finger horizontal swipe to it (Header.svelte), guarded
// so it never hijacks a legitimate in-view horizontal scroll.
//
//   B-behaviour  DRIVES the real store: a view sequence records history, back() replays it in reverse,
//                a self-nav does not grow the stack, and canGoBack tracks depth (test/drive-workspace-back.mjs).
//   B-gesture    Header.svelte binds a WINDOW wheel listener that calls workspace.back(), is horizontal-
//                dominant only, and GUARDS against hijacking an in-view horizontal scroller.
//   B-store      the store exposes back() + canGoBack and records history in openInActiveTab.
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.
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
const callsBack = /workspace\.back\(\)/.test(header);
const horizontalOnly = /deltaX[\s\S]{0,60}deltaY/.test(header);   // horizontal-dominant guard
const scrollerGuard = /overflowX|scrollWidth|ownedByScroller/.test(header);
rec('B-gesture. Header binds a window wheel swipe → workspace.back(), horizontal-dominant, guarding an in-view scroller',
  bindsWheel && callsBack && horizontalOnly && scrollerGuard,
  `wheel=${bindsWheel} back=${callsBack} horizontalOnly=${horizontalOnly} scrollerGuard=${scrollerGuard}`);

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — app-level view-history back: recorded, replayed in reverse, depth-tracked, and bound to a guarded two-finger swipe' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

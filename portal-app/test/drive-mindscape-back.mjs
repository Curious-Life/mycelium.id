// Drives the REAL lib/nav/back-intent.ts coordinator (D-035) against the REAL
// workspace store, mindscape store, and navigation store — only the app specifiers
// ($app/environment browser:false so no DOM/localStorage, $app/navigation, $lib/api)
// and the view registry are stubbed. So goBackIntent()'s real branching runs over
// the real drill-down + view-history state machines. This EXERCISES the unified
// back semantics; a source grep is only a projection.
//
// The scenario proves the three things the fix must guarantee:
//   (a) while the mindscape is FOCUSED and drilled in, a back walks its internal
//       drill-down (detail → territory → realm) and does NOT pop the workspace VIEW;
//   (b) once the mindscape is at its TOP level, a back finally pops the workspace VIEW;
//   (c) when the mindscape is NOT the focused view, a back goes straight to the
//       view-history back even if the mindscape is mid-drill (no hijack).
//
// One esbuild bundle re-exports the coordinator AND the three stores together, so the
// coordinator and the harness observe ONE shared store instance.
import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-mindscape-back';
rmSync(GEN, { recursive: true, force: true });
mkdirSync(GEN, { recursive: true });

// Minimal registry: every view exists; a tab key is viewId+params so distinct screens are distinct.
writeFileSync(`${GEN}/registry-stub.js`, `
export const viewExists = () => true;
export const getView = (id) => ({ title: id, icon: '', load: async () => ({ default: {} }) });
export const tabKey = (viewId, params) => viewId + ':' + JSON.stringify(params || {});
`);
writeFileSync(`${GEN}/env-stub.js`, `export const browser = false;\n`);
writeFileSync(`${GEN}/nav-stub.js`, `export const replaceState = () => {};\nexport const goto = async () => {};\n`);
// $lib/api is only touched by the mindscape store's async network methods (load/refresh/social),
// none of which the back path calls — a throwing stub proves the back path never reaches the network.
writeFileSync(`${GEN}/api-stub.js`, `export const api = () => { throw new Error('api() must not be called on the back path'); };\n`);

writeFileSync(`${GEN}/probe.ts`, `
export { goBackIntent } from '../src/lib/nav/back-intent';
export { workspace } from '../src/lib/workspace/store';
export { mindscapeState } from '../src/lib/stores/mindscape';
export { navigationState } from '../src/lib/stores/navigation';
`);

await build({
  entryPoints: [`${GEN}/probe.ts`],
  outfile: `${GEN}/probe.js`,
  bundle: true, format: 'esm', platform: 'neutral',
  external: ['svelte/store'],
  plugins: [{ name: 'stubs', setup(b) {
    b.onResolve({ filter: /\/registry$/ }, () => ({ path: resolve(GEN, 'registry-stub.js') }));
    b.onResolve({ filter: /^\$app\/environment$/ }, () => ({ path: resolve(GEN, 'env-stub.js') }));
    b.onResolve({ filter: /^\$app\/navigation$/ }, () => ({ path: resolve(GEN, 'nav-stub.js') }));
    b.onResolve({ filter: /^\$lib\/api$/ }, () => ({ path: resolve(GEN, 'api-stub.js') }));
    // Resolve the SvelteKit `$lib/*` alias to the real source (after the specific
    // stubs above, so $lib/api still hits its stub) — this pulls in the REAL stores.
    b.onResolve({ filter: /^\$lib\// }, (args) => ({ path: resolve('src/lib', args.path.slice('$lib/'.length) + '.ts') }));
  } }],
  logLevel: 'silent',
});

const P = await import(pathToFileURL(resolve(GEN, 'probe.js')).href);
const { get } = await import('svelte/store');

const activeView = () => {
  const s = get(P.workspace);
  const root = s.root;
  const tab = root.tabs?.find((t) => t.id === root.activeTabId);
  return tab?.viewId ?? null;
};
const viewHasHistory = () => get(P.workspace.canGoBack);   // true iff the view-history stack has entries
const ms = () => get(P.mindscapeState);
const setFocus = (v) => P.navigationState.setPrimaryView(v);
const atTop = () => ms().selectedRealmId === null && ms().selectedSemanticThemeId === null && ms().selectedTerritoryId === null;

const out = { ok: true };
try {
  if (typeof P.goBackIntent !== 'function') throw new Error('goBackIntent not exported');

  // ── Build a workspace view-history so a view-pop is observable, ending on mindscape. ──
  P.workspace.reset();
  P.workspace.openInActiveTab('areas');       // navBack: [mindscape]
  P.workspace.openInActiveTab('mindscape');   // navBack: [mindscape, areas]; active view = mindscape
  out.startView = activeView();               // 'mindscape'
  out.startCanGoBack = viewHasHistory();      // true — there IS view history to leave to

  // ── Drill DEEP into the mindscape while it is the focused view. ──
  setFocus('mindscape');
  P.mindscapeState.drillIntoRealm(1);
  P.mindscapeState.drillIntoTheme(1, 2);
  P.mindscapeState.selectTerritory(5);
  out.deepLevel = ms().currentLevel;              // 'territories'
  out.deepTerritory = ms().selectedTerritoryId;   // 5

  // (a) three backs must walk the drill-down and NEVER pop the workspace VIEW.
  out.step1 = P.goBackIntent();  out.afterStep1Territory = ms().selectedTerritoryId;  // detail → territories (territory cleared)
  out.step2 = P.goBackIntent();  out.afterStep2Theme = ms().selectedSemanticThemeId;  // territories → themes (theme cleared)
  out.step3 = P.goBackIntent();  out.afterStep3Realm = ms().selectedRealmId;          // themes → realms (realm cleared)
  out.viewAfterDrillWalk = activeView();          // STILL 'mindscape' — never left the view
  out.viewHistoryIntactAfterWalk = viewHasHistory();  // STILL true — the view-history stack was untouched
  out.atTopAfterWalk = atTop();

  // (b) NOW at the top: the next back finally pops the workspace VIEW.
  out.step4 = P.goBackIntent();                   // 'workspace' — leaves the mindscape
  out.viewAfterTopBack = activeView();            // 'areas' — the previously-viewed screen
  out.viewHistoryAfterTopBack = viewHasHistory(); // false — the view-history stack was consumed

  // (c) NOT focused → straight to view-history back even mid-drill (no hijack).
  P.workspace.reset();
  P.workspace.openInActiveTab('timeline');        // navBack: [mindscape]; active view = timeline
  P.mindscapeState.drillIntoRealm(3);             // mindscape mid-drill…
  P.mindscapeState.selectTerritory(9);            // …deep
  setFocus('timeline');                           // …but the mindscape is NOT the focused view
  out.unfocusedConsumer = P.goBackIntent();       // 'workspace' — must NOT touch the mindscape drill state
  out.unfocusedViewAfter = activeView();          // 'mindscape' (popped the view)
  out.unfocusedMindscapeUntouched = ms().selectedTerritoryId === 9 && ms().selectedRealmId === 3;
} catch (e) {
  out.ok = false; out.error = String(e?.stack || e);
} finally {
  rmSync(GEN, { recursive: true, force: true });
}
console.log(JSON.stringify(out));
process.exit(0);

// Drives the REAL lib/workspace/store.ts back-history (QA R4-SWIPEBACK) against lightweight stubs
// for the app specifiers ($app/environment browser:false so no DOM/localStorage is touched,
// $app/navigation, $lib/stores/navigation) and a minimal registry — the store's own openInActiveTab /
// back() logic is what runs. This EXERCISES the state machine; a source grep is a projection.
import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-workspace-back';
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
writeFileSync(`${GEN}/navstore-stub.js`, `export const navigationState = { setPrimaryView() {} };\n`);

await build({
  entryPoints: ['src/lib/workspace/store.ts'],
  outfile: `${GEN}/store.js`,
  bundle: true, format: 'esm', platform: 'neutral',
  external: ['svelte/store'],
  plugins: [{ name: 'stubs', setup(b) {
    b.onResolve({ filter: /\.\/registry$/ }, () => ({ path: resolve(GEN, 'registry-stub.js') }));
    b.onResolve({ filter: /^\$app\/environment$/ }, () => ({ path: resolve(GEN, 'env-stub.js') }));
    b.onResolve({ filter: /^\$app\/navigation$/ }, () => ({ path: resolve(GEN, 'nav-stub.js') }));
    b.onResolve({ filter: /^\$lib\/stores\/navigation$/ }, () => ({ path: resolve(GEN, 'navstore-stub.js') }));
  } }],
  logLevel: 'silent',
});

const { workspace } = await import(pathToFileURL(resolve(GEN, 'store.js')).href);
const { get } = await import('svelte/store');

// Read the active view from the (never-split, in this test) leaf root.
const activeView = () => {
  const s = get(workspace);
  const root = s.root;
  const tab = root.tabs?.find((t) => t.id === root.activeTabId);
  return tab?.viewId ?? null;
};
const canGoBack = () => get(workspace.canGoBack);

const out = { ok: true };
try {
  workspace.reset();
  out.startView = activeView();                 // default: 'mindscape'
  out.canBackAtStart = canGoBack();             // false — nothing to return to

  workspace.openInActiveTab('areas');
  out.afterAreas = activeView();
  out.canBackAfterOne = canGoBack();            // true

  workspace.openInActiveTab('timeline');
  out.afterTimeline = activeView();

  // A self-navigation must NOT grow the stack (no dupe entry).
  workspace.openInActiveTab('timeline');
  out.afterSelfNav = activeView();

  out.back1 = workspace.back();  out.viewBack1 = activeView();   // → areas
  out.back2 = workspace.back();  out.viewBack2 = activeView();   // → mindscape
  out.canBackAtBottom = canGoBack();                             // false
  out.back3 = workspace.back();  out.viewBack3 = activeView();   // false, stays mindscape

  // After returning to the bottom, a NEW forward navigation records history again.
  workspace.openInActiveTab('library');
  out.afterLibrary = activeView();
  out.canBackAfterLibrary = canGoBack();                         // true
  out.back4 = workspace.back();  out.viewBack4 = activeView();   // → mindscape
} catch (e) {
  out.ok = false; out.error = String(e?.stack || e);
} finally {
  rmSync(GEN, { recursive: true, force: true });
}
console.log(JSON.stringify(out));
process.exit(0);

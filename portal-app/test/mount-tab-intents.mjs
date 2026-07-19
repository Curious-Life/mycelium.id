// Drives the REAL workspace store (src/lib/workspace/store.ts, bundled with the
// REAL registry.ts) through the tab-open intents and prints ONE JSON line for
// scripts/verify-tab-intents.mjs to assert on.
//
// Run: node portal-app/test/mount-tab-intents.mjs   (cwd = portal-app)
//
// ⚠️ WHY A BUNDLE AND NOT A REGEX. The property under test is BEHAVIOR — "a route
// intent mutates the current tab in place; only an explicit gesture appends" —
// and a source regex is satisfied by a delegation that was never changed (or one
// wrapped in dead code). Only executing the compiled store against the compiled
// registry observes which path openFromRoute actually takes. The registry is the
// REAL module (bundled via its relative import from store.ts) — singleton flags
// and key() functions are the shipped ones, never a hand-rolled fixture (a
// hand-rolled registry models shapes the app cannot exhibit; see the
// gates-fail-on-fixtures method note).
//
// $app/environment is stubbed with browser:false — the store's persistence, URL
// sync, and navigationState mirroring are all browser-gated, so the state
// machine runs pure. $lib/views/* stay EXTERNAL dynamic imports: the scenarios
// never call load(), so they never resolve.
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-mount-tab-intents';
mkdirSync(GEN, { recursive: true });

writeFileSync(`${GEN}/env-stub.mjs`, `export const browser = false;\n`);
writeFileSync(`${GEN}/nav-stub.mjs`, `export const replaceState = () => {};\nexport const goto = async () => {};\n`);
writeFileSync(`${GEN}/navstate-stub.mjs`, `export const navigationState = { setPrimaryView: () => {} };\n`);

const emit = (o) => console.log(JSON.stringify(o));

try {
  const stubs = {
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /^\$app\/environment$/ }, () => ({ path: resolve(GEN, 'env-stub.mjs') }));
      b.onResolve({ filter: /^\$app\/navigation$/ }, () => ({ path: resolve(GEN, 'nav-stub.mjs') }));
      b.onResolve({ filter: /^\$lib\/stores\/navigation$/ }, () => ({ path: resolve(GEN, 'navstate-stub.mjs') }));
      // View components are lazily imported by the registry's load() thunks,
      // which these scenarios never invoke — leave them unresolved externals.
      b.onResolve({ filter: /^\$lib\/views\// }, (args) => ({ path: args.path, external: true }));
    },
  };
  await build({
    entryPoints: ['src/lib/workspace/store.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: `${GEN}/store.bundle.mjs`,
    plugins: [stubs],
    logLevel: 'silent',
  });

  const { workspace } = await import(pathToFileURL(resolve(GEN, 'store.bundle.mjs')).href);

  // The scenarios stay single-pane, so the root is always ONE leaf — a split
  // showing up would itself be a defect, and snap() surfaces it.
  const snap = () => {
    const st = workspace.getState();
    if (st.root.kind !== 'leaf') return { split: true, tabs: [], active: null };
    return {
      tabs: st.root.tabs.map((t) => ({ id: t.id, viewId: t.viewId, params: t.params })),
      active: st.root.activeTabId,
    };
  };

  const out = { ok: true };

  // S1 — ROUTE INTENT NAVIGATES IN PLACE: two successive route opens mutate the
  // ONE existing tab (same id, same slot), never append.
  workspace.reset();
  const s1 = [snap()];
  workspace.openFromRoute('connections');
  s1.push(snap());
  workspace.openFromRoute('agents', {});
  s1.push(snap());
  out.s1 = s1;

  // S2 — EXPLICIT INTENT APPENDS: openOrFocus (the ⌘/middle-click · context-menu
  // · drag gesture path) adds a second tab and focuses it; the first survives.
  workspace.reset();
  const s2 = [snap()];
  workspace.openOrFocus('agents');
  s2.push(snap());
  out.s2 = s2;

  // S3 — SINGLETON RE-OPEN FOCUSES, NEVER DUPLICATES: from S2's two tabs,
  // explicitly re-opening each view flips focus without growing the set.
  workspace.openOrFocus('mindscape');
  const s3 = [snap()];
  workspace.openOrFocus('agents');
  s3.push(snap());
  out.s3 = s3;

  // S4 — ROUTE INTENT DEDUPES TO AN EXISTING TAB: with agents open in a second
  // tab and mindscape focused, a route open of agents focuses the EXISTING tab —
  // it must NOT replace the focused mindscape tab's content.
  workspace.reset();
  workspace.openOrFocus('agents');
  const preS4 = snap();
  workspace.focusTab(preS4.tabs[0].id); // back to the mindscape tab
  workspace.openFromRoute('agents', {});
  out.s4 = { before: preS4, after: snap() };

  // S5 — PER-KEY VIEWS (space): route-open replaces in place; an explicit open
  // of a DIFFERENT key appends; a route re-open of the first key focuses it.
  workspace.reset();
  const s5 = [];
  workspace.openFromRoute('space', { id: 's1' });
  s5.push(snap());
  workspace.openOrFocus('space', { id: 's2' });
  s5.push(snap());
  workspace.openFromRoute('space', { id: 's1' });
  s5.push(snap());
  out.s5 = s5;

  // S6 — CONTROL: an unregistered viewId is a no-op on every path (and proves
  // the harness can see NON-mutation, so the in-place assertions aren't vacuous).
  workspace.reset();
  const preS6 = snap();
  workspace.openFromRoute('no-such-view');
  workspace.openOrFocus('no-such-view');
  out.s6 = { before: preS6, after: snap() };

  // S7 — MULTI-PANE: the route intent must act on the FOCUSED pane, never
  // blindly on the first leaf. (A reviewer mutation replacing the focused-pane
  // lookup with firstLeaf(s.root) stayed green against S1–S6 — every scenario
  // was single-pane, where first == focused. This scenario is the discriminator.)
  const paneSnap = () => {
    const st = workspace.getState();
    if (st.root.kind !== 'split') return { split: false };
    return {
      split: true,
      focused: st.focusedPaneId,
      panes: st.root.children.map((l) => ({
        id: l.id,
        tabs: (l.tabs ?? []).map((t) => ({ id: t.id, viewId: t.viewId })),
        active: l.activeTabId,
      })),
    };
  };
  workspace.reset();
  workspace.splitPane(workspace.getState().root.id, 'h'); // → [mindscape pane, fresh EMPTY pane]; focus = the fresh pane
  const s7 = [paneSnap()];
  workspace.openFromRoute('agents', {});      // route intent into the focused EMPTY pane → creates there
  s7.push(paneSnap());
  workspace.openFromRoute('connections', {}); // route intent again → mutates THAT pane's tab in place
  s7.push(paneSnap());
  out.s7 = s7;

  emit(out);
} catch (e) {
  emit({ ok: false, error: String(e?.stack || e) });
} finally {
  rmSync(GEN, { recursive: true, force: true });
}
process.exit(0);

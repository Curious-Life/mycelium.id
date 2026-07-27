// verify:tab-intents — sections NAVIGATE the current tab in place; a NEW tab is
// only ever an EXPLICIT gesture (⌘/ctrl·middle-click, right-click → "Open in new
// tab", drag onto the tab strip — all of which call openOrFocus/openInPane).
//
// It executes the REAL workspace store + REAL registry (bundled by
// portal-app/test/mount-tab-intents.mjs) and asserts on the state machine's
// actual transitions. Nothing here reads the source — a source regex is blind to
// a delegation that still points at the append path (the exact bug this fixes:
// openFromRoute delegated to openOrFocus, so every sidebar click stacked a tab).
//
// The properties:
//   G1  route intent (openFromRoute) mutates the ONE current tab IN PLACE —
//       same tab id, same slot, tab count pinned at 1 across two navigations.
//   G2  explicit intent (openOrFocus) APPENDS a second tab, focuses it, and the
//       first tab survives untouched.
//   G3  singleton re-open focuses the existing tab — never duplicates.
//   G4  route intent DEDUPES: a route open of a view already open elsewhere
//       focuses that tab and must NOT replace the focused tab's content.
//   G5  per-key views (space): route-open replaces in place, a different key
//       appends explicitly, and a route re-open of the first key focuses it.
//   G6  CONTROL — an unregistered viewId mutates nothing on either path (the
//       harness can see non-mutation, so G1's "unchanged" clauses are earned).
//   G7  MULTI-PANE — the route intent acts on the FOCUSED pane, never blindly
//       on the first leaf; the unfocused pane's tab is untouched throughout.
//       (Discriminator for the firstLeaf-instead-of-focused mutation, which
//       stayed green against the single-pane scenarios where first == focused.)
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const t = (n, fn) => { try { fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } };

let o;
try {
  const line = execFileSync('node', ['test/mount-tab-intents.mjs'],
    { cwd: 'portal-app', encoding: 'utf8', timeout: 120000 })
    .trim().split('\n').pop();
  o = JSON.parse(line);
  if (!o.ok) throw new Error(String(o.error).slice(0, 400));
} catch (e) {
  console.log(`FAIL  M0. the workspace store bundles and every scenario runs — ${String(e?.message || e).slice(0, 400)}`);
  console.log('\nVERDICT: NO-GO — the harness failed to run  EXIT=1');
  process.exit(1);
}
rec('M0. the REAL store + REAL registry bundle, and all seven scenarios ran', true);

const ids = (s) => s.tabs.map((x) => x.id);
const views = (s) => s.tabs.map((x) => x.viewId);

t('G1. ⭐ route intent navigates the CURRENT tab in place — one tab, same id, across two navigations', () => {
  const [a, b, c] = o.s1;
  assert.deepEqual(views(a), ['mindscape'], `fresh state must be one mindscape tab. Got ${JSON.stringify(views(a))}`);
  assert.equal(b.tabs.length, 1, `after openFromRoute('connections') there must still be ONE tab (in-place), got ${b.tabs.length}`);
  assert.equal(c.tabs.length, 1, `after openFromRoute('agents') there must still be ONE tab (in-place), got ${c.tabs.length}`);
  assert.deepEqual(views(b), ['connections'], 'the tab CONTENT must have navigated to connections');
  assert.deepEqual(views(c), ['agents'], 'and then to agents');
  assert.equal(b.tabs[0].id, a.tabs[0].id, 'the tab IDENTITY must be preserved (same tab, same slot — a new id means close+open, not navigate)');
  assert.equal(c.tabs[0].id, a.tabs[0].id, 'still the same tab after the second navigation');
});

t('G2. ⭐ explicit intent (openOrFocus — the ⌘·middle-click / context-menu / drag path) APPENDS a tab', () => {
  const [a, b] = o.s2;
  assert.equal(b.tabs.length, 2, `openOrFocus over one tab must yield TWO tabs, got ${b.tabs.length}`);
  assert.deepEqual(views(b), ['mindscape', 'agents'], `the original tab survives in slot 0 and the new view lands after it. Got ${JSON.stringify(views(b))}`);
  assert.equal(b.tabs[0].id, a.tabs[0].id, 'the pre-existing tab must be untouched (same id)');
  assert.notEqual(b.tabs[1].id, a.tabs[0].id, 'the appended tab is a NEW tab');
  assert.equal(b.active, b.tabs[1].id, 'and the new tab takes focus');
});

t('G3. singleton re-open FOCUSES the existing tab — never duplicates (the accepted no-relax design)', () => {
  const [a, b] = o.s3;
  assert.equal(a.tabs.length, 2, `re-opening mindscape must not grow the set. Got ${a.tabs.length}`);
  assert.equal(a.active, a.tabs.find((x) => x.viewId === 'mindscape').id, 'focus flips to the existing mindscape tab');
  assert.equal(b.tabs.length, 2, `re-opening agents must not grow the set. Got ${b.tabs.length}`);
  assert.equal(b.active, b.tabs.find((x) => x.viewId === 'agents').id, 'focus flips back to the existing agents tab');
});

t('G4. route intent DEDUPES to an already-open tab instead of replacing the focused one', () => {
  const { before, after } = o.s4;
  assert.equal(after.tabs.length, 2, `no tab may be created or destroyed. Got ${after.tabs.length}`);
  assert.equal(after.tabs[0].viewId, 'mindscape', 'the focused mindscape tab must NOT have been replaced by the route open');
  assert.equal(after.tabs[0].id, before.tabs[0].id, 'and it keeps its identity');
  assert.equal(after.active, after.tabs.find((x) => x.viewId === 'agents').id, 'focus lands on the EXISTING agents tab');
});

t('G5. per-key views: route-open replaces in place · a different key appends explicitly · a route re-open focuses', () => {
  const [a, b, c] = o.s5;
  assert.deepEqual(views(a), ['space'], `openFromRoute('space',{id:s1}) replaces the default tab in place. Got ${JSON.stringify(views(a))}`);
  assert.equal(a.tabs[0].params.id, 's1');
  assert.equal(b.tabs.length, 2, `an explicit open of a DIFFERENT space appends. Got ${b.tabs.length}`);
  assert.deepEqual(b.tabs.map((x) => x.params.id), ['s1', 's2'], 'both spaces are open, keyed apart');
  assert.notEqual(b.tabs[0].id, b.tabs[1].id, 'two distinct tabs');
  assert.equal(c.tabs.length, 2, `a route re-open of s1 must FOCUS, not replace or append. Got ${c.tabs.length}`);
  assert.equal(c.active, c.tabs.find((x) => x.params.id === 's1').id, 'focus is on the existing s1 tab');
});

t('G6. CONTROL — an unregistered viewId is a no-op on BOTH paths (non-mutation is observable)', () => {
  const { before, after } = o.s6;
  assert.deepEqual(after, before,
    `neither openFromRoute nor openOrFocus of an unknown view may mutate anything. before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
});

t('G7. ⭐ MULTI-PANE — route intent acts on the FOCUSED pane, never blindly on the first leaf', () => {
  const [a, b, c] = o.s7;
  // Setup: a split whose SECOND (fresh, empty) pane is focused; mindscape lives in the first.
  assert.ok(a.split && b.split && c.split, 'the workspace must be a two-pane split throughout');
  assert.equal(a.focused, a.panes[1].id, 'precondition: the fresh (second) pane holds focus after splitPane');
  assert.deepEqual(a.panes[0].tabs.map((x) => x.viewId), ['mindscape'], 'precondition: pane 1 holds the mindscape tab');
  assert.equal(a.panes[1].tabs.length, 0, 'precondition: pane 2 is empty');
  const mindscapeId = a.panes[0].tabs[0].id;
  // Route open #1 → creates in the FOCUSED (empty) pane 2; pane 1 untouched.
  assert.deepEqual(b.panes[1].tabs.map((x) => x.viewId), ['agents'],
    `openFromRoute must land in the FOCUSED pane (pane 2). pane2=${JSON.stringify(b.panes[1].tabs)} pane1=${JSON.stringify(b.panes[0].tabs)}`);
  assert.deepEqual(b.panes[0].tabs, a.panes[0].tabs,
    `the unfocused pane 1 must be UNTOUCHED — a firstLeaf lookup mutates it instead. Got ${JSON.stringify(b.panes[0].tabs)}`);
  // Route open #2 → mutates pane 2's tab IN PLACE (same id); pane 1 still untouched.
  assert.deepEqual(c.panes[1].tabs.map((x) => x.viewId), ['connections'], 'the focused pane navigates in place');
  assert.equal(c.panes[1].tabs[0].id, b.panes[1].tabs[0].id, 'same tab identity in the focused pane (in-place, not close+open)');
  assert.equal(c.panes[1].tabs.length, 1, `still one tab in the focused pane. Got ${c.panes[1].tabs.length}`);
  assert.deepEqual(c.panes[0].tabs, a.panes[0].tabs,
    `pane 1 keeps its mindscape tab (id ${mindscapeId}) through BOTH navigations. Got ${JSON.stringify(c.panes[0].tabs)}`);
});

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — route intents navigate the current tab in place; only explicit gestures append; singletons and keyed views focus, never duplicate' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

// Mounts the REAL PipelineStatus.svelte — real Svelte compiler → real jsdom → the REAL
// src/lib/pipeline.ts store fed the REAL wire shape readiness.js's `pipeline` slice emits — and
// prints one JSON line per PROBE for scripts/verify-pipeline-status-render.mjs to assert on.
//
// WHY A MOUNT, NOT A REGEX (the lesson this whole test-suite is built on): the design's motivating
// bug is a RENDER bug — "$generate.error is rendered in ZERO places app-wide, so a state the store
// holds the user never sees" (generate.ts:29-37). A source regex over PipelineStatus.svelte passes
// with the render dead-coded (`{#if false && …}` keeps every asserted string), the component never
// mounted, or the store never subscribed. Only MOUNTING the real component, driving the real store
// with the real slice shape, and reading host.textContent proves a user can SEE each stage state.
// [[render-must-be-mounted-not-grepped]].
//
// Run: node --conditions browser portal-app/test/mount-pipeline-status.mjs   (cwd = portal-app)
// `--conditions browser` is REQUIRED — without it Node resolves svelte's SERVER exports map and
// mount() throws lifecycle_function_unavailable (learned across mount-generate-render / -invite-data).
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROBE = process.env.PROBE || 'midflight';
const GEN = '.gen-mount-pipeline';
const COMPONENT = 'src/lib/components/mindscape/PipelineStatus.svelte';

// ── DOM globals before svelte/internal/client is imported ────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (k in globalThis) continue;
  try { globalThis[k] = dom.window[k]; } catch { /* getter-only global — jsdom's is fine */ }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// ── The wire shapes readiness.js's pipeline() ACTUALLY emits (Unit 2). Byte-for-byte the stage
// machine — not a hand-invented shape — so a server change to the enum would surface here too.
// Each PROBE sets a scenario; the store is driven through ingest()/ingestReadiness(), the same
// entry the hosts call from their existing readiness reads. ─────────────────────────────────────
const A_APPROVE = { label: 'Approve a labeling model', target: 'intelligence' };
const A_GENERATE = { label: 'Generate', target: 'generate' };
const A_RESUME = { label: 'Resume', target: 'resume' };
const A_CHECK_EMB = { label: 'Check the embedder', target: 'intelligence' };

const SLICES = {
  // A live embed, categorize blocked on no model (the biggest silent stall) — every state present.
  midflight: {
    stages: [
      { key: 'import', state: 'done', count: { done: 76000 } },
      { key: 'embed', state: 'running', count: { done: 3200, total: 76000 }, etaSeconds: 90, paused: false },
      { key: 'categorize', state: 'blocked', reason: 'no_model', action: A_APPROVE, paused: false },
      { key: 'cluster', state: 'pending', reason: 'waiting_embed' },
      { key: 'describe', state: 'pending' },
      { key: 'measure', state: 'pending' },
    ],
    overall: 'blocked', blockedOn: 'no_model',
  },
  // A caught-up vault: EVERY stage done, no spinner, no "checking" (the models-slice / restart trap).
  caughtup: {
    stages: [
      { key: 'import', state: 'done', count: { done: 76000 } },
      { key: 'embed', state: 'done', count: { done: 76000, total: 76000 } },
      { key: 'categorize', state: 'done', count: { done: 76000, total: 76000 } },
      { key: 'cluster', state: 'done', count: { done: 5000 } },
      { key: 'describe', state: 'done' },
      { key: 'measure', state: 'done' },
    ],
    overall: 'done', blockedOn: null,
  },
  // Sub-floor: cluster blocked, too_few_embedded, with a Generate action (never stranded).
  toofew: {
    stages: [
      { key: 'import', state: 'done', count: { done: 4 } },
      { key: 'embed', state: 'done', count: { done: 3, total: 4 } },
      { key: 'categorize', state: 'done', count: { done: 4, total: 4 } },
      { key: 'cluster', state: 'blocked', reason: 'too_few_embedded', action: A_GENERATE },
      { key: 'describe', state: 'pending' },
      { key: 'measure', state: 'pending' },
    ],
    overall: 'blocked', blockedOn: 'too_few_embedded',
  },
  // Paused: embed + categorize blocked-by-choice, each carrying `paused:true` so the co-located
  // Stop/Resume control renders Resume. The slice still emits the A_RESUME action (PS5), but the
  // component renders the per-stage Resume CONTROL for a paused stage, not the generic action button.
  paused: {
    stages: [
      { key: 'import', state: 'done', count: { done: 100 } },
      { key: 'embed', state: 'blocked', count: { done: 50, total: 100 }, reason: 'paused', action: A_RESUME, paused: true },
      { key: 'categorize', state: 'blocked', reason: 'paused', action: A_RESUME, paused: true },
      { key: 'cluster', state: 'pending', reason: 'waiting_embed' },
      { key: 'describe', state: 'pending' },
      { key: 'measure', state: 'pending' },
    ],
    overall: 'blocked', blockedOn: 'paused',
  },
  // A down embedder blocks embed with its reason + remedy.
  embedderdown: {
    stages: [
      { key: 'import', state: 'done', count: { done: 100 } },
      { key: 'embed', state: 'blocked', count: { done: 10, total: 100 }, reason: 'embedder_down', action: A_CHECK_EMB },
      { key: 'categorize', state: 'pending' },
      { key: 'cluster', state: 'pending', reason: 'waiting_embed' },
      { key: 'describe', state: 'pending' },
      { key: 'measure', state: 'pending' },
    ],
    overall: 'blocked', blockedOn: 'embedder_down',
  },
  // An empty vault: idle, import pending — no spinner, no fabricated running/done.
  idle: {
    stages: [
      { key: 'import', state: 'pending' },
      { key: 'embed', state: 'pending' },
      { key: 'categorize', state: 'pending' },
      { key: 'cluster', state: 'pending' },
      { key: 'describe', state: 'pending' },
      { key: 'measure', state: 'pending' },
    ],
    overall: 'idle', blockedOn: null,
  },
};

// PROBE=error / uptodate exercise the overall arms the SLICE does not emit today but the component
// must render (the "$generate.error in ZERO places" fix + Unit 5's projection). Modelled as a
// caught-up stage list carrying an overall the generate store will fold in.
const OVERRIDE_OVERALL = { error: 'error', uptodate: 'up-to-date' };

const dom_host = () => dom.window.document.getElementById('host');

// ── One api stub (pipeline.ts imports `./api`); we drive the store directly, so it is inert here. ─
mkdirSync(GEN, { recursive: true });
writeFileSync(`${GEN}/api-stub.js`, `export const api = async () => ({ ok: true, json: async () => ({}) });\nexport default { api };\n`);

// ── The REAL pipeline store (esbuild strips TS; only `./api` is redirected) ───────────────────
await build({
  entryPoints: ['src/lib/pipeline.ts'],
  outfile: `${GEN}/pipeline.js`,
  bundle: true, format: 'esm', platform: 'neutral',
  external: ['svelte/store'],
  plugins: [{ name: 'stub-api', setup(b) { b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: resolve(GEN, 'api-stub.js') })); } }],
  logLevel: 'silent',
});

// ── The REAL generate store, for the REAL fmtSeconds the component renders the ETA with ───────
// Not a stub: a stubbed fmtSeconds would let the ETA formatting (`90` → "1m 30s") drift out from
// under the gate, and the gate asserts the FORMATTED string. Only `./api` is redirected.
await build({
  entryPoints: ['src/lib/generate.ts'],
  outfile: `${GEN}/generate.js`,
  bundle: true, format: 'esm', platform: 'neutral',
  external: ['svelte/store'],
  plugins: [{ name: 'stub-api', setup(b) { b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: resolve(GEN, 'api-stub.js') })); } }],
  logLevel: 'silent',
});

// ── SPIES for the Unit-4 wiring (goto / apiPost / start). We drive the REAL component's onclick and
// record which remedy fired per target — a source regex can't prove `start()` was CALLED, only that
// the string is present ([[render-must-be-mounted-not-grepped]]). fmtSeconds stays REAL (re-exported
// from the real generate.js) so the ETA-format assertion still bites. All three spies push into ONE
// shared `calls` array (Node caches ./spies.js by URL, so the component's modules and this test see
// the SAME instance). The spies return resolved promises with no side effects, so a click is inert
// apart from the record — no real POST, no timer, no navigation. ─────────────────────────────────
writeFileSync(`${GEN}/spies.js`, `export const calls = [];\n`);
writeFileSync(`${GEN}/nav-spy.js`, `import { calls } from './spies.js';\nexport async function goto(url) { calls.push('goto:' + url); }\n`);
writeFileSync(`${GEN}/api-spy.js`, `import { calls } from './spies.js';\nexport const api = async () => ({ ok: true, json: async () => ({}) });\nexport async function apiPost(path) { calls.push('apiPost:' + path); return {}; }\nexport default { api };\n`);
writeFileSync(`${GEN}/generate-spy.js`, `import { calls } from './spies.js';\nexport { fmtSeconds } from './generate.js';\nexport async function start() { calls.push('start'); }\n`);

// ── The component under test: REAL source, only its four lib/app specifiers rewired ───────────
// pipeline + fmtSeconds are the REAL modules; goto/apiPost/start are the spies above so a click's
// effect is observable. If the component ever imports a NEW $lib/$app specifier we don't rewire,
// the unresolved-specifier guard below throws rather than silently importing an app path in jsdom.
const rewired = compile(readFileSync(COMPONENT, 'utf8'), { generate: 'client', name: 'PipelineStatus', css: 'injected' }).js.code
  .replace(/from\s+['"]\$lib\/pipeline['"]/g, `from './pipeline.js'`)
  .replace(/from\s+['"]\$lib\/generate['"]/g, `from './generate-spy.js'`)
  .replace(/from\s+['"]\$lib\/api['"]/g, `from './api-spy.js'`)
  .replace(/from\s+['"]\$app\/navigation['"]/g, `from './nav-spy.js'`);
const unresolved = [...rewired.matchAll(/from\s+['"](\$(?:lib|app)\/[^'"]+)['"]/g)].map((m) => m[1]);
if (unresolved.length) throw new Error(`unrewired specifiers in ${COMPONENT}: ${[...new Set(unresolved)].join(', ')}`);
writeFileSync(`${GEN}/Subject.gen.js`, rewired);

const emit = (o) => console.log(JSON.stringify(o));
try {
  const store = await import(pathToFileURL(resolve(GEN, 'pipeline.js')).href);
  const { default: Subject } = await import(pathToFileURL(resolve(GEN, 'Subject.gen.js')).href);
  const { mount, flushSync } = await import('svelte');

  // Build the slice for this probe (the override probes reuse the caught-up stage list + a folded
  // overall the component must still render).
  let slice;
  if (PROBE in OVERRIDE_OVERALL) slice = { ...SLICES.caughtup, overall: OVERRIDE_OVERALL[PROBE] };
  else slice = SLICES[PROBE] || SLICES.midflight;

  // Drive the REAL store through the REAL entry the hosts use — ingestReadiness({pipeline}) — NOT a
  // hand-set writable. If the store ever stops being the singleton the component subscribes to, or
  // ingest's fold changes shape, this notices.
  store.ingestReadiness({ pipeline: slice });

  const spies = await import(pathToFileURL(resolve(GEN, 'spies.js')).href);

  mount(Subject, { target: dom_host() });
  flushSync();

  const D = dom.window.document;

  // ── Unit-4 wiring drive: click a specific stage's action button and record which remedy fired.
  // CLICK=<stageKey> clicks once; DOUBLE=1 clicks TWICE synchronously (no microtask yield between)
  // so the SECOND click exercises the busy-guard — a live button must record its remedy exactly
  // ONCE despite two clicks. The spies record synchronously (goto/start/apiPost are invoked before
  // onAction's first await), so `calls` is complete by the time we emit. `clickedDisabledAfter` is
  // the button's disabled state after the click+flush — busy (in-flight) so it reads true. ───────
  // CTRL=<pause|resume|restart> clicks the co-located per-stage CONTROL (R2/R3) within the CLICK
  // stage instead of the generic `.pipe-action` remedy; absent, the generic action is clicked.
  let clickedDisabledAfter = null;
  const clickKey = process.env.CLICK;
  const clickCtrl = process.env.CTRL;
  if (clickKey) {
    const li = D.querySelector(`.pipe-stage[data-key="${clickKey}"]`);
    const btn = clickCtrl
      ? li?.querySelector(`button.pipe-ctrl[data-ctrl="${clickCtrl}"]`)
      : li?.querySelector('button.pipe-action');
    if (btn) {
      btn.click();
      if (process.env.DOUBLE === '1') btn.click(); // must be dropped by the busy-guard
      flushSync();
      clickedDisabledAfter = !!btn.disabled;
    }
  }
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // visible() — the SAME open-set hiding-mechanism check the generate-render harness documents:
  // jsdom does no layout, so this proves "none of these mechanisms hides it", NOT human-visibility.
  // Every entry is a real one-line regression it catches; the value is defence in depth.
  const visible = (el) => {
    if (!el) return false;
    for (let n = el; n && n !== D.body.parentElement; n = n.parentElement) {
      const cs = dom.window.getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true') return false;
      if (parseFloat(cs.opacity || '1') === 0) return false;
      if (cs.fontSize && parseFloat(cs.fontSize) === 0) return false;
    }
    return true;
  };

  // Per-stage report, keyed by the data-key the component stamps — so the gate asserts on the
  // SPECIFIC stage's rendered element, never "some text somewhere in the body".
  const stages = [...D.querySelectorAll('.pipe-stage')].map((li) => {
    const key = li.getAttribute('data-key');
    const iconEl = li.querySelector('.pipe-stage-icon');
    const btn = li.querySelector('button.pipe-action');
    // The co-located per-stage controls (R2/R3/N9): the ONE two-state icon toggle (⏸/▶) + Restart (↻).
    // Reported so the render gate can assert the toggle, its accessible name (the ACTION a click
    // performs), its rendered icon, and its enabled/visible state per stage. `label` is the ACCESSIBLE
    // NAME (aria-label) — the buttons are icon-only, so textContent is empty; the accessible name is
    // what a screen-reader user hears and the gate asserts on.
    const controls = [...li.querySelectorAll('button.pipe-ctrl')].map((b) => ({
      kind: b.getAttribute('data-ctrl'),
      label: norm(b.getAttribute('aria-label') || b.textContent),
      hasIcon: !!b.querySelector('svg'),
      visible: visible(b),
      disabled: !!b.disabled,
    }));
    return {
      key,
      state: li.getAttribute('data-state'),
      text: norm(li.textContent),
      icon: norm(iconEl?.textContent),
      hasSpinner: !!li.querySelector('.pipe-spin'),
      actionLabel: btn ? norm(btn.textContent) : null,
      actionVisible: btn ? visible(btn) : false,
      // Unit 3 renders the remedy NOT-YET-LIVE: the button is present + labelled but disabled
      // (Unit 4 removes this). `disabled` reflects the DOM property jsdom sets from the attribute.
      actionDisabled: btn ? !!btn.disabled : false,
      controls,
      visible: visible(li),
    };
  });

  const overallEl = D.querySelector('.pipe-overall');
  emit({
    ok: true,
    probe: PROBE,
    // The rendered order of stage keys — the component must not re-sort the server array.
    order: stages.map((s) => s.key),
    stages,
    overallText: norm(overallEl?.textContent),
    overallVisible: visible(overallEl),
    // ⭐ THE PROOF: the whole surface's text a user reads, and whether the root mounted at all.
    text: norm(D.body.textContent),
    rootCount: D.querySelectorAll('.pipe').length,
    actionCount: D.querySelectorAll('button.pipe-action').length,
    ctrlCount: D.querySelectorAll('button.pipe-ctrl').length,
    spinnerCount: D.querySelectorAll('.pipe-spin').length,
    // ⭐ Unit-4 wiring proof: which remedy(ies) the click fired, and the in-flight disabled state.
    calls: [...spies.calls],
    clickedDisabledAfter,
  });
} catch (e) {
  emit({ ok: false, probe: PROBE, error: String(e?.stack || e) });
}

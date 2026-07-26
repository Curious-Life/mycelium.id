// D-034 ↻1 — build a REAL-BROWSER harness for the mindscape LEFT RAIL.
//
// Why a browser and not jsdom: this defect is *layout*. jsdom has no layout engine — every
// element reports scrollHeight === clientHeight === 0 — so a jsdom mount can assert that a CSS
// rule EXISTS but can never observe that a box actually overflows and actually scrolls. #350
// fixed `.nav-content`'s `min-height:0` and shipped with exactly that blind spot; the operator
// then reported the rail was still "only partially scrollable". A measurement in a real engine
// is the thing that was missing.
//
// This script bundles the REAL MindscapeView with the REAL rail children (PipelineStatus,
// MindscapeDetail + MapFreshness, MeasureControl, MeasurementHealthSection, NarrateControl)
// against a fixture-backed api stub, and emits a static page into
// portal-app/.gen-browser-rail/. Serve that directory over http and drive it:
//
//   node portal-app/test/browser-mindscape-rail.mjs          # (cwd = portal-app/..)
//   python3 -m http.server 8099 -d portal-app/.gen-browser-rail
//
// The page exposes window.__probe() → per-container scroll geometry, so "does it scroll, and
// does it reach the bottom of its padding" is a NUMBER, not an impression.
//
// Only Mindscape3D / MindscapeBackground / MindscapeInvite are stubbed — they drag in THREE.js
// and none of them is part of the rail under test.
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname); // portal-app/
const GEN = resolve(ROOT, '.gen-browser-rail');
rmSync(GEN, { recursive: true, force: true });
mkdirSync(GEN, { recursive: true });

// ── The fixture ────────────────────────────────────────────────────────────────────────────
// Deliberately TALL: 14 realms with long essences, 9 themes, 12 territories, and a territory
// profile with a long chronicle. The rail must overflow at EVERY drill level, otherwise the
// harness would pass on a rail that simply had nothing to scroll.
const LOREM =
  'A long-running thread of thought that keeps returning under different names, folding new ' +
  'material into an older shape until the shape itself is what you notice rather than any one ' +
  'entry in it. It shows up in build logs, in half-finished notes, and in the questions asked twice.';

const REALMS = {};
for (let i = 1; i <= 14; i++) {
  REALMS[i] = {
    id: i,
    name: `Realm ${i} — ${['Curious Life build', 'Family', 'Money', 'Health', 'Reading'][i % 5]}`,
    essence: LOREM,
    pointCount: 1200 + i * 37,
    territoryCount: 3 + (i % 5),
    chapter: 'Current chapter: consolidating.',
  };
}
const SEMANTIC_THEMES = {};
for (let r = 1; r <= 14; r++) {
  SEMANTIC_THEMES[`${r}-${r}`] = { id: r, realmId: r, name: `Theme ${r}`, essence: LOREM, messageCount: 900, territoryCount: 4 };
}
const TERRITORIES = {};
for (let t = 1; t <= 40; t++) {
  TERRITORIES[t] = {
    id: t,
    name: t === 1 ? 'Curious Life build' : `Territory ${t}`,
    essence: LOREM,
    archetypeType: 'builder',
    archetypeCharacter: LOREM,
    realmId: (t % 14) + 1,
    semanticThemeId: (t % 14) + 1,
    count: 120 + t,
    exploredCount: 40,
    exploredPercent: 33,
    gravityShare: 0.08,
    currentPhase: 'active',
    currentVitality: 0.62,
    isAnchored: false,
    evolvedFromCount: 0,
    daysActive: 210,
    firstActive: '2024-02-01',
    visibility: 'private',
    topEntities: Array.from({ length: 12 }, (_, i) => ({ name: `Entity ${i}`, type: 'concept', count: 9 - (i % 9) })),
    storyBirth: LOREM,
    storyArc: LOREM,
    storyPeakMoments: [LOREM, LOREM, LOREM],
    storyCurrentChapter: LOREM,
    uncertaintyOpenQuestions: [LOREM, LOREM],
    uncertaintyEdges: LOREM,
    activity: Array.from({ length: 24 }, (_, i) => ({ month: `2024-${String((i % 12) + 1).padStart(2, '0')}`, count: i * 3 })),
  };
}
const NODES = Array.from({ length: 400 }, (_, i) => ({
  id: `m${i}`,
  type: 'message',
  data: { type: 'message', clusterId: (i % 40) + 1, cluster3d: (i % 14) + 1, themeId: (i % 14) + 1, position3d: { x: i % 10, y: (i * 7) % 10, z: (i * 3) % 10 } },
}));

const FIXTURE = {
  '/portal/mindscape': { nodes: NODES, themes: {}, territories: TERRITORIES, realms: REALMS, semanticThemes: SEMANTIC_THEMES, meta: { total: NODES.length } },
  '/portal/mindscape/points': { nodes: NODES, meta: { total: NODES.length } },
  '/portal/mindscape/social': { contacts: [] },
  // Pipeline SETTLED → the D-067 collapse toggle is rendered (it only exists when settled).
  '/portal/readiness': {
    mindscape: { generated: true, pointCount: NODES.length },
    pipeline: {
      overall: 'done',
      stages: [
        { key: 'import', state: 'done', count: { done: 1500, total: 1500 } },
        { key: 'embed', state: 'done', count: { done: 1500, total: 1500 } },
        { key: 'categorize', state: 'done', count: { done: 1500, total: 1500 } },
        { key: 'cluster', state: 'done' },
        { key: 'describe', state: 'done' },
        { key: 'measure', state: 'done' },
      ],
    },
  },
  '/portal/measurement-health': {
    families: Array.from({ length: 10 }, (_, i) => ({
      table: `t${i}`, stage: `stage ${i}`, verdict: 'fresh', last_write: '2026-07-20T10:00:00Z',
      age_ms: 1000, cadence: 'daily', description: 'x', last_success_at: '2026-07-20T10:00:00Z',
      last_failure_at: null, last_failure_reason: null, consecutive_failures: 0, quarantined: false, last_duration_ms: 10,
    })),
    summary: { total: 10, fresh: 10, stale: 0, missing: 0, empty: 0, failing: 0, quarantined: 0 },
  },
  '/portal/mycelium/processing-status': { embedded: 1500, total: 1500, pending: 0 },
  '/portal/mycelium/map-status': { embedded: 1500, mapped: 1131, drift: 369, driftPct: 24.6 },
  '/portal/onboarding/status': { aiModelsReady: true, steps: { data: { messageCount: 1500, enrichedCount: 1500, enrichmentPending: 0 } } },
  '/portal/mycelium/naming-status': { areas: { total: 14, unnamed: 3, named: 11 } },
  '/portal/narrate/coverage': { territories: 40, described: 12, percent: 30 },
  '/portal/activity': { items: [] },
};

writeFileSync(
  resolve(GEN, 'fixture.js'),
  `export const FIXTURE = ${JSON.stringify(FIXTURE)};\n`,
);

writeFileSync(
  resolve(GEN, 'api-stub.js'),
  `import { FIXTURE } from './fixture.js';
const match = (p) => {
  const clean = String(p).split('?')[0];
  if (FIXTURE[clean]) return FIXTURE[clean];
  const k = Object.keys(FIXTURE).find((key) => clean.startsWith(key));
  return k ? FIXTURE[k] : {};
};
export const api = async (p) => ({ ok: true, status: 200, json: async () => match(p) });
export const apiGet = async (p) => match(p);
export const apiPost = async (p) => match(p);
export const apiDelete = async (p) => match(p);
export default { api, apiGet, apiPost, apiDelete };
`,
);
writeFileSync(resolve(GEN, 'env-stub.js'), 'export const browser = true;\nexport const dev = true;\nexport const building = false;\n');
writeFileSync(resolve(GEN, 'nav-stub.js'), 'export const goto = async () => {};\nexport const beforeNavigate = () => {};\nexport const afterNavigate = () => {};\nexport const invalidateAll = async () => {};\nexport const pushState = () => {};\n');
writeFileSync(resolve(GEN, 'stores-stub.js'), "import { readable } from 'svelte/store';\nexport const page = readable({ url: new URL('http://localhost/mindscape'), params: {}, route: { id: '/mindscape' } });\nexport const navigating = readable(null);\n");
// The three heavy children that are NOT the rail (THREE.js scene, animated background, invite).
writeFileSync(resolve(GEN, 'HeavyStub.svelte'), '<div class="heavy-stub" style="width:100%;height:100%"></div>\n');

// ── esbuild: compile the real .svelte tree ─────────────────────────────────────────────────
const HEAVY = /(Mindscape3D|MindscapeBackground|MindscapeInvite)\.svelte$/;
const sveltePlugin = {
  name: 'svelte',
  setup(b) {
    b.onResolve({ filter: /^\$lib\/api$|^\.\.?\/api$/ }, () => ({ path: resolve(GEN, 'api-stub.js') }));
    b.onResolve({ filter: /^\$app\/environment$/ }, () => ({ path: resolve(GEN, 'env-stub.js') }));
    b.onResolve({ filter: /^\$app\/navigation$/ }, () => ({ path: resolve(GEN, 'nav-stub.js') }));
    b.onResolve({ filter: /^\$app\/stores$/ }, () => ({ path: resolve(GEN, 'stores-stub.js') }));
    b.onResolve({ filter: HEAVY }, () => ({ path: resolve(GEN, 'HeavyStub.svelte') }));
    b.onLoad({ filter: /\.svelte$/ }, (a) => {
      const src = readFileSync(a.path, 'utf8');
      const { js } = compile(src, { filename: a.path, generate: 'client', css: 'injected', runes: undefined });
      return { contents: js.code, loader: 'js', resolveDir: dirname(a.path) };
    });
  },
};

writeFileSync(
  resolve(GEN, 'entry.js'),
  `import { mount } from 'svelte';
import MindscapeView from '${resolve(ROOT, 'src/lib/views/MindscapeView.svelte')}';
import { mindscapeState } from '${resolve(ROOT, 'src/lib/stores/mindscape.ts')}';
mount(MindscapeView, { target: document.getElementById('host'), props: { active: true } });

// The REAL store, exposed so a probe can navigate the way the 3D CANVAS does — from outside the
// rail, without clicking a rail item. That distinction is the whole point of the QA9 M-3 check:
// a section collapsed by the user must re-open when the user selects something elsewhere.
window.__mindscapeState = mindscapeState;

// ── The probe: real layout numbers, not impressions ────────────────────────────────────────
// For every candidate container in the rail, report whether it is a scroll port, whether it
// overflows, and how far the LAST child sits below the visible bottom when scrolled to the end
// (bottomGap < 0 ⇒ content is cut off / unreachable).
window.__probe = () => {
  const rail = document.querySelector('.nav-panel');
  if (!rail) return { error: 'no .nav-panel — the rail did not render' };
  const boxes = [rail, ...rail.querySelectorAll('*')].filter((el) => {
    const cs = getComputedStyle(el);
    return cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'hidden';
  });
  const railRect = rail.getBoundingClientRect();
  // The deepest element actually painted in the rail, and whether it is reachable.
  const all = [...rail.querySelectorAll('*')];
  const lowest = all.reduce((acc, el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > (acc?.rect.bottom ?? -Infinity) && r.height > 0 ? { el, rect: r } : acc;
  }, null);
  return {
    railHeight: rail.clientHeight,
    scrollers: boxes.map((el) => ({
      sel: el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName,
      overflowY: getComputedStyle(el).overflowY,
      minHeight: getComputedStyle(el).minHeight,
      paddingBottom: getComputedStyle(el).paddingBottom,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      overflows: el.scrollHeight > el.clientHeight + 1,
    })),
    lowestPaintedBottom: lowest ? Math.round(lowest.rect.bottom) : null,
    railBottom: Math.round(railRect.bottom),
    // > 0 means content is painted BELOW the rail's own box ⇒ clipped and unreachable.
    overhangPx: lowest ? Math.round(lowest.rect.bottom - railRect.bottom) : null,
  };
};

// Scroll the rail's outermost scroll port to the very bottom and re-measure.
window.__scrollToBottom = () => {
  const rail = document.querySelector('.nav-panel');
  const port = [rail, ...rail.querySelectorAll('*')].find((el) => {
    const cs = getComputedStyle(el);
    return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
  });
  if (!port) return { error: 'no scroll port that overflows' };
  port.scrollTop = port.scrollHeight;
  return { scrolledTo: port.scrollTop, max: port.scrollHeight - port.clientHeight, atBottom: Math.abs(port.scrollTop - (port.scrollHeight - port.clientHeight)) < 2 };
};
window.__ready = true;
`,
);

await build({
  entryPoints: [resolve(GEN, 'entry.js')],
  outfile: resolve(GEN, 'app.js'),
  bundle: true,
  // IIFE, not ESM: the page is opened over file:// (no dev server, no port bound — CLAUDE.md
  // §13), and a browser refuses `<script type="module">` from file:// on CORS grounds.
  format: 'iife',
  platform: 'browser',
  conditions: ['browser'],
  alias: { $lib: resolve(ROOT, 'src/lib') },
  resolveExtensions: ['.ts', '.js', '.svelte', '.mjs', '.json'],
  plugins: [sveltePlugin],
  loader: { '.svg': 'text' },
  logLevel: 'info',
});

const bundled = readFileSync(resolve(GEN, 'app.js'), 'utf8');
writeFileSync(
  resolve(GEN, 'index.html'),
  `<!doctype html>
<html><head><meta charset="utf-8"><title>mindscape rail harness</title>
<style>
  /* Only the app-shell tokens the rail reads. The harness must not restyle the rail itself. */
  :root {
    --color-bg:#0A0A0C; --color-surface:#141418; --color-elevated:#1A1A20; --color-border:#2A2A32;
    --color-text-primary:#EDEDF0; --color-text-secondary:#A8A8B4; --color-text-tertiary:#75757F;
    --color-accent:#5B9FE8; --color-accent-aurum:#E5B84C; --color-accent-jade:#4ADE80;
    --glass-border:rgba(255,255,255,0.1); --glass-card-bg:rgba(255,255,255,0.04);
    --glass-panel-bg:rgba(20,20,24,0.7); --shadow-lg:0 10px 40px rgba(0,0,0,.5);
    --radius-md:10px; --radius-full:999px; --font-mono:ui-monospace,monospace;
  }
  html,body { margin:0; height:100%; background:var(--color-bg); color:var(--color-text-primary);
    font-family: system-ui, sans-serif; }
  /* The real app mounts the view inside a fixed-height pane (Pane.svelte / the workspace grid).
     Reproduce ONLY that contract: a definite-height box. */
  #host { height:100vh; overflow:hidden; }
  .card { border:1px solid var(--color-border); border-radius:10px; }
</style></head>
<body><div id="host"></div><script>${bundled}</script></body></html>
`,
);

console.log(`[browser-mindscape-rail] built → ${GEN}/index.html`);
console.log(`[browser-mindscape-rail] open: file://${GEN}/index.html`);

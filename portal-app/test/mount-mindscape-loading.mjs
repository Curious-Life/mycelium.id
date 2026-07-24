// D-028 part 2 — MEASURE the "jittery, restarting loading icon" instead of theorising about it.
//
// THE REPORT (operator, third appearance): "that reload screen is buggy — it laggs and restarts
// reload multiple times, eventually loads but the jittery restarting loading icon is buggy and
// looks very broken."
//
// TWO HYPOTHESES WERE ON THE TABLE, and a hypothesis is not evidence:
//   H1 — MindscapeView's `$generate.phase === 'done'` $effect re-runs and calls
//        mindscapeState.load() repeatedly, each call flipping the store's `loading` true→false,
//        so the spinner restarts once per reload.
//   H2 — the loading states live in FIVE SEPARATE `.loading-3d` elements across one
//        {#if}/{:else if} chain. Each arm is a DIFFERENT DOM node, so every transition between
//        arms DESTROYS one element and CREATES another — and a CSS keyframe animation on a
//        freshly-created element starts at t=0. The user sees the spinner snap back to its
//        start angle on every state transition: "restarts reload multiple times".
//
// This harness mounts the REAL MindscapeView (real Svelte compiler, real jsdom, the REAL
// mindscape + generate + pipeline stores) and drives the REAL post-generate sequence off REAL
// route-shaped responses. It then COUNTS, via a MutationObserver on the live DOM:
//   • how many times mindscapeState.load() is called            → H1's evidence
//   • how many distinct `.loading-3d` ELEMENTS are created/destroyed → H2's evidence
//   • which arm was showing at each step (arms are disambiguated by their copy, and the two
//     bare-spinner arms by the store state at the moment of creation)
//
// The COUNT is the finding. A spinner that is one stable node across the whole sequence
// animates continuously; N nodes means N restarts, and that is a number, not an opinion.
//
// Run with: node --conditions browser portal-app/test/mount-mindscape-loading.mjs (cwd=portal-app)
// The `browser` condition is REQUIRED — without it Node resolves svelte's SERVER build via the
// exports map and mount() throws lifecycle_function_unavailable. (Learned in mount-onbox-select.)
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-mount-mindscape-loading';
rmSync(GEN, { recursive: true, force: true });
mkdirSync(GEN, { recursive: true });

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
  url: 'http://localhost/mindscape',
  pretendToBeVisual: true,
});
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (k in globalThis) continue;
  try { globalThis[k] = dom.window[k]; } catch { /* getter-only global — jsdom's is fine */ }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// ── The server, as a small state machine ─────────────────────────────────────────────────────
// This is the post-generate reality, not a convenience: the map is generated, and the POINTS
// GEOMETRY LANDS LATER than the readiness flag (clustering writes points after the job row flips
// — the very race MindscapeView's "Your map is built — finishing loading it…" arm exists for).
const server = {
  generated: false,      // readiness.mindscape.generated
  pointCount: 0,         // readiness.mindscape.pointCount (the cheap COUNT)
  pointsReady: false,    // has /portal/mindscape/points started returning geometry?
  messageCount: 0,       // /portal/onboarding/status — drives the auto-generate effect
  jobStatus: 'running',  // the generate job
};
const NODES = Array.from({ length: 8 }, (_, i) => ({ id: i, x: i, y: i, z: i, cluster3d: 0 }));

const calls = { load: 0, refreshPoints: 0, points: 0, readiness: 0 };

// ⚠️ LATENCY IS NOT DECORATION. With instantly-resolving stubs a runaway reactive loop starves
// the microtask queue and NO timer ever fires — the probe would hang and report an unbounded loop
// that a real browser bounds. A few ms per request is what makes the measurement faithful: the
// loop then runs at the speed the network allows, and the 4s resetGen timer can actually land.
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 4);
const wire = () => new Promise((r) => setTimeout(r, LATENCY_MS));

globalThis.__apiStub = async (path, init = {}) => {
  const method = init?.method || 'GET';
  await wire();
  if (path.startsWith('/portal/mycelium/generate/status/')) {
    return { ok: true, status: 200, json: async () => ({
      id: 'job-1', status: server.jobStatus, step: server.jobStatus === 'done' ? 5 : 3, totalSteps: 5,
      stageLabel: 'Clustering your conversations…', startedAt: Date.now() - 5_000,
      ...(server.jobStatus === 'done' ? { finishedAt: Date.now() } : {}),
    }) };
  }
  if (path.startsWith('/portal/mycelium/generate') && method === 'POST') {
    return { ok: true, status: 200, json: async () => ({ jobId: 'job-1', status: 'running' }) };
  }
  if (path.startsWith('/portal/mycelium/processing-status')) {
    return { ok: true, status: 200, json: async () => ({ embedded: 200, total: 200, pending: 0 }) };
  }
  if (path.startsWith('/portal/mycelium/map-status')) {
    return { ok: true, status: 200, json: async () => ({ embedded: 200, mapped: 200, drift: 0, driftPct: 0 }) };
  }
  if (path.startsWith('/portal/readiness')) {
    calls.readiness++;
    return { ok: true, status: 200, json: async () => ({
      mindscape: { generated: server.generated, pointCount: server.pointCount },
      pipeline: { stages: [] },
    }) };
  }
  if (path.startsWith('/portal/mindscape/points')) {
    calls.points++;
    return { ok: true, status: 200, json: async () => ({ nodes: server.pointsReady ? NODES : [], meta: {} }) };
  }
  if (path.startsWith('/portal/mindscape/social')) {
    return { ok: true, status: 200, json: async () => ({ contacts: [] }) };
  }
  if (path === '/portal/mindscape') {
    return { ok: true, status: 200, json: async () => ({
      nodes: server.pointsReady ? NODES : [], themes: {}, territories: {}, realms: {},
      semanticThemes: {}, meta: {},
    }) };
  }
  if (path.startsWith('/portal/onboarding/status')) {
    return { ok: true, status: 200, json: async () => ({
      aiModelsReady: true,
      steps: { data: { messageCount: server.messageCount, enrichedCount: server.messageCount, enrichmentPending: 0 } },
    }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
writeFileSync(`${GEN}/api-stub.js`, `
export const api = (...a) => globalThis.__apiStub(...a);
export const apiGet = async (p) => (await globalThis.__apiStub(p)).json();
export const apiPost = (p, b) => globalThis.__apiStub(p, { method: 'POST', body: JSON.stringify(b) });
export default { api, apiGet, apiPost };
`);
writeFileSync(`${GEN}/env-stub.js`, 'export const browser = true;\n');
writeFileSync(`${GEN}/navigation-stub.js`, 'export const goto = () => {};\nexport const beforeNavigate = () => {};\nexport const afterNavigate = () => {};\n');

// The REAL modules MindscapeView's loading logic reads. Bundled, not faked — a hand-written
// mirror of `load()` would let the store's own loading semantics drift out from under the gate.
const REAL = {
  'stores/mindscape': 'src/lib/stores/mindscape.ts',
  'stores/navigation': 'src/lib/stores/navigation.ts',
  'stores/auth': 'src/lib/stores/auth.ts',
  generate: 'src/lib/generate.ts',
  pipeline: 'src/lib/pipeline.ts',
  'pipeline-poll': 'src/lib/pipeline-poll.ts',
  'mind-probe-cap': 'src/lib/mind-probe-cap.ts',
};
for (const [name, entry] of Object.entries(REAL)) {
  await build({
    entryPoints: [entry],
    outfile: `${GEN}/${name.replace('/', '_')}.js`,
    bundle: true, format: 'esm', platform: 'neutral',
    external: ['svelte/store', 'svelte'],
    plugins: [{
      name: 'stub-deps',
      setup(b) {
        b.onResolve({ filter: /^(\$lib\/api|\.\/api)$/ }, () => ({ path: resolve(GEN, 'api-stub.js') }));
        b.onResolve({ filter: /^\$app\/environment$/ }, () => ({ path: resolve(GEN, 'env-stub.js') }));
      },
    }],
    logLevel: 'silent',
  });
}

// ── Stub the heavy CHILDREN, never the component under test ──────────────────────────────────
// The subject is MindscapeView's OWN loading chain. Its children (the 3D scene, the rail panels,
// the invite) render their own facts and none of them owns a `.loading-3d` node, so inert stubs
// are faithful. Mindscape3D in particular would drag in THREE.js.
const STUB = '<script>let { ...rest } = $props();</script><div class="stub-child"></div>';
const CHILDREN = ['MindscapeDetail', 'NarrateControl', 'MeasureControl', 'MeasurementHealthSection',
  'MindscapeBackground', 'MindscapeInvite', 'PipelineStatus', 'Mindscape3D'];
for (const name of CHILDREN) {
  const out = compile(STUB, { generate: 'client', name, css: 'injected' });
  writeFileSync(`${GEN}/${name}.gen.js`, out.js.code);
}

const SRC = 'src/lib/views/MindscapeView.svelte';
const out = compile(readFileSync(SRC, 'utf8'), { generate: 'client', name: 'MindscapeView', css: 'injected' });
let rewired = out.js.code
  .replace(/from\s+['"]\$lib\/stores\/mindscape['"]/g, `from './stores_mindscape.js'`)
  .replace(/from\s+['"]\$lib\/stores\/navigation['"]/g, `from './stores_navigation.js'`)
  .replace(/from\s+['"]\$lib\/stores\/auth['"]/g, `from './stores_auth.js'`)
  .replace(/from\s+['"]\$lib\/generate['"]/g, `from './generate.js'`)
  .replace(/from\s+['"]\$lib\/pipeline['"]/g, `from './pipeline.js'`)
  .replace(/from\s+['"]\$lib\/pipeline-poll['"]/g, `from './pipeline-poll.js'`)
  .replace(/from\s+['"]\$lib\/mind-probe-cap['"]/g, `from './mind-probe-cap.js'`)
  .replace(/from\s+['"]\$lib\/api['"]/g, `from './api-stub.js'`)
  .replace(/from\s+['"]\$app\/environment['"]/g, `from './env-stub.js'`)
  .replace(/from\s+['"]\$app\/navigation['"]/g, `from './navigation-stub.js'`);
for (const name of CHILDREN) {
  rewired = rewired
    .replace(new RegExp(`from\\s+['"]\\$lib/components/mindscape/${name}\\.svelte['"]`, 'g'), `from './${name}.gen.js'`)
    // the LAZY 3D load is a dynamic import, not a static one — the static-only regex above
    // leaves it untouched and it throws at runtime, which would silently remove the
    // Mindscape3D-null arm from the measurement.
    .replace(new RegExp(`import\\(['"]\\$lib/components/mindscape/${name}\\.svelte['"]\\)`, 'g'), `import('./${name}.gen.js')`);
}
writeFileSync(`${GEN}/Subject.gen.js`, rewired);
const unresolved = [...rewired.matchAll(/['"](\$(?:lib|app)\/[^'"]+)['"]/g)].map((m) => m[1]);
if (unresolved.length) throw new Error(`unrewired specifiers in ${SRC}: ${[...new Set(unresolved)].join(', ')}`);

const emit = (o) => console.log(JSON.stringify(o));
const trace = (m) => { if (process.env.TRACE) console.error(`[trace] ${m}`); };
if (process.env.TRACE) {
  // A heartbeat on the event loop. If it stops ticking while the probe is "waiting", the block is
  // SYNCHRONOUS (a spin), not a slow await — the two look identical from outside.
  let beat = 0;
  setInterval(() => console.error(`[beat] ${++beat} calls=${JSON.stringify(calls)}`), 500);
}

try {
  trace('bundles built');
  const { mindscapeState } = await import(pathToFileURL(resolve(GEN, 'stores_mindscape.js')).href);
  const { generate } = await import(pathToFileURL(resolve(GEN, 'generate.js')).href);
  const { default: Subject } = await import(pathToFileURL(resolve(GEN, 'Subject.gen.js')).href);
  const { mount, flushSync } = await import('svelte');
  trace('modules imported');
  const { get } = await import('svelte/store');

  // Count the store calls WITHOUT changing their behaviour — the real implementations still run.
  // A RUNAWAY GUARD, not a convenience. `load()` is called from inside the `phase === 'done'`
  // $effect; if that effect re-enters, this is where it shows up — and an unbounded reactive loop
  // starves the event loop, so the probe would hang rather than report. Bounded, it REPORTS.
  const LOAD_CAP = Number(process.env.LOAD_CAP || 40);
  let firstLoadAt = 0;
  const realLoad = mindscapeState.load.bind(mindscapeState);
  mindscapeState.load = (...a) => {
    calls.load++;
    if (calls.load === 2) firstLoadAt = Date.now();   // #1 is onMount's; the loop starts after
    trace(`load #${calls.load}`);
    if (calls.load > LOAD_CAP) {
      emit({ probe: 'mindscape-loading', runaway: true, msSinceFirstLoad: Date.now() - firstLoadAt,
        calls, nodes: { created, destroyed },
        armSequence: timeline.filter((e) => e.ev === 'created').map((e) => e.arm), timeline });
      process.exit(0);
    }
    return realLoad(...a);
  };
  const realRefresh = mindscapeState.refreshPoints.bind(mindscapeState);
  mindscapeState.refreshPoints = (...a) => { calls.refreshPoints++; return realRefresh(...a); };

  // ── The instrument ───────────────────────────────────────────────────────────────────────
  // Every `.loading-3d` ELEMENT that is created or destroyed, in order, with the store state at
  // that instant. Element IDENTITY is the point: a spinner that survives as one node animates
  // continuously; a new node restarts the CSS keyframe at t=0.
  const timeline = [];
  let created = 0, destroyed = 0, seq = 0;
  const seen = new WeakMap();
  const ARM = (el) => {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.includes('Couldn')) return 'capped-retry';
    if (t.includes('Checking your mind')) return 'checking';
    if (t.includes('finishing loading')) return 'built-not-loaded';
    // The two BARE-SPINNER arms are textually identical; the store disambiguates them.
    const st = get(mindscapeState);
    return st.loading ? 'store-loading' : 'awaiting-3d-module';
  };
  const scan = (nodes, kind) => {
    for (const n of nodes) {
      if (n.nodeType !== 1) continue;
      const hits = n.classList?.contains('loading-3d') ? [n] : [...(n.querySelectorAll?.('.loading-3d') || [])];
      for (const el of hits) {
        if (kind === 'created') {
          created++;
          seen.set(el, ++seq);
          timeline.push({ ev: 'created', node: seq, arm: ARM(el) });
        } else {
          destroyed++;
          timeline.push({ ev: 'destroyed', node: seen.get(el) ?? null });
        }
      }
    }
  };
  // ⚠️ COLLAPSING THE FIVE ARMS INTO ONE NODE MUST NOT COLLAPSE THE FIVE MESSAGES. If the copy
  // stopped changing, node churn would read as "fixed" while the surface had gone mute — the
  // §3.2a failure this codebase keeps re-learning. So the probe also records every DISTINCT copy
  // the stable node carries, and the gate asserts the honest ones are still reachable.
  const copySeen = new Set();
  const sampleCopy = () => {
    for (const el of dom.window.document.querySelectorAll('.loading-3d')) {
      copySeen.add((el.textContent || '').replace(/\s+/g, ' ').trim());
    }
  };
  new dom.window.MutationObserver((recs) => {
    for (const r of recs) { scan(r.addedNodes, 'created'); scan(r.removedNodes, 'destroyed'); }
    sampleCopy();
  }).observe(dom.window.document.body, { childList: true, subtree: true, characterData: true });

  const settle = async (ms = 60) => {
    flushSync();
    await new Promise((r) => setTimeout(r, ms));
    flushSync();
    sampleCopy();
  };

  // ── STEP 0 — land on the mindscape screen with data imported and no map yet ───────────────
  // This is the operator's exact entry: they finished the wizard (data + intelligence connected)
  // and landed on the Mycelium screen. The map does not exist yet, so generate auto-starts.
  server.messageCount = 200;
  mount(Subject, { target: dom.window.document.getElementById('host'), props: { active: true } });
  trace('mounted');
  await settle(120);
  trace('settled mount');
  const t0 = timeline.length;

  // ── STEP 1 — the generate job completes ──────────────────────────────────────────────────
  // Driven through the REAL store: the job row flips to done, the store's own poll observes it
  // and moves phase → 'done'. Nothing is force-set.
  server.jobStatus = 'done';
  server.generated = true;
  server.pointCount = NODES.length;   // the server COUNTS points…
  server.pointsReady = false;         // …but the geometry read still races clustering (P1-A)
  // Long enough to cover generate.ts's 1500ms status poll AND the 4000ms resetGen the done-effect
  // arms — the window in which the user is staring at the reload screen.
  await settle(7000);
  trace('settled done');
  const t1 = timeline.length;

  // ── STEP 2 — the geometry finally lands ──────────────────────────────────────────────────
  server.pointsReady = true;
  await settle(1500);
  trace('settled geometry');
  const t2 = timeline.length;

  const armsCreated = timeline.filter((e) => e.ev === 'created').map((e) => e.arm);
  emit({
    probe: 'mindscape-loading',
    phase: get(generate).phase,
    calls,
    nodes: { created, destroyed },
    distinctArms: [...new Set(armsCreated)],
    armSequence: armsCreated,
    perStep: { mount: t0, onGenerateDone: t1 - t0, onGeometryLanded: t2 - t1 },
    // Distinct COPY carried by the (now stable) loading node — proves the message still changes
    // even though the element does not. Empty string is the transient no-loading-node state.
    distinctCopy: [...copySeen].filter(Boolean),
    timeline,
    finalPoints: get(mindscapeState).points.length,
  });
  process.exit(0);
} catch (e) {
  emit({ probe: 'mindscape-loading', fatal: String(e?.stack || e) });
  process.exit(1);
}

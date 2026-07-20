// Mounts MindscapeDetail's NAMING RUN SURFACE (INTELLIGENCE-SCREEN-REDESIGN Part II) — for
// REAL: real Svelte compiler, real jsdom, the REAL $lib/stores/activity store (compiled, shared
// instance — the DURING view's owner, so IL4's identity assert watches the actual chain) — and
// prints one JSON line per PROBE scenario for scripts/verify-illuminate-surface.mjs.
//
// WHY MOUNTED, NOT GREPPED: `{#if false && …}` keeps every asserted string in the file and a
// regex says GO (the mount-generate-render lesson, #194 M4). Only rendering proves rendering.
//
// Run with: node --conditions browser portal-app/test/mount-illuminate-card.mjs  (cwd=portal-app)
// The `browser` condition is REQUIRED (svelte's exports map — learned in mount-onbox-select).
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-mount-illuminate';
rmSync(GEN, { recursive: true, force: true });
mkdirSync(GEN, { recursive: true });

const SCENARIO = process.env.PROBE || 'before';

// A name that must NEVER appear inside the card (IL8) — it may appear ONLY in the area list
// (the rendered vault). Seeded into the mindscape store below.
const SECRET_NAME = 'ZZSECRET Client Work';

// ── Fixtures the api stub serves (mutated per scenario mid-run) ─────────────────────────────
const STATUS_BEFORE = {
  areas: { total: 40, named: 28, unnamed: 12 },
  forecast: { perUnitTokenBound: 4300, expectedTokensBound: 51_600 },
  narrator: { ready: true, label: 'Local Ollama', model: 'qwen3.5:4b', local: true, jurisdiction: 'local' },
};
globalThis.__namingFixture = STATUS_BEFORE;
globalThis.__activityFixture = { active: [], recent: [] };
globalThis.__postResponse = { status: 'running', pid: 123 };
globalThis.__postCalls = 0;
// What the store's reload serves — the mount fixture until a scenario swaps it (AFTER: the
// renamed vault, so the list re-render + wash are observed, not assumed).
const REALMS_AT_MOUNT = {
  0: { name: 'Realm 0', essence: '', pointCount: 40 },
  1: { name: SECRET_NAME, essence: 'a described area', pointCount: 12 },
  7: { name: 'Realm 7', essence: '', pointCount: 5 },
};
globalThis.__mindscapeFixture = REALMS_AT_MOUNT;

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (k in globalThis) continue;
  try { globalThis[k] = dom.window[k]; } catch { /* getter-only global — jsdom's is fine */ }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// ── ONE api stub for the whole graph (path-dispatching, like mount-generate-render) ─────────
globalThis.__apiStub = async (path, init = {}) => {
  const method = init?.method || 'GET';
  if (path.startsWith('/portal/mycelium/name-clusters') && method === 'POST') {
    globalThis.__postCalls += 1;
    return { ok: true, status: 200, json: async () => globalThis.__postResponse };
  }
  if (path.startsWith('/portal/mycelium/naming-status')) {
    const f = globalThis.__namingFixture;
    if (!f) return { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) };
    return { ok: true, status: 200, json: async () => f };
  }
  if (path.startsWith('/portal/activity')) return { ok: true, json: async () => globalThis.__activityFixture };
  if (path.startsWith('/portal/providers')) return { ok: true, json: async () => ({ providers: [{ id: 1, label: 'Local Ollama', is_active: 1 }] }) };
  if (path.startsWith('/portal/mycelium/generate')) return { ok: true, status: 200, json: async () => ({ jobId: null, status: 'skipped', reason: 'topology_exists' }) };
  // The store's completion reload (points BEFORE the aggregate — the startsWith trap).
  if (path.startsWith('/portal/mindscape/points')) return { ok: true, json: async () => ({ nodes: [], meta: { total: 57 } }) };
  if (path.startsWith('/portal/mindscape')) {
    return { ok: true, json: async () => ({ nodes: [], themes: {}, territories: {}, semanticThemes: {}, meta: { total: 57 }, realms: globalThis.__mindscapeFixture }) };
  }
  return { ok: true, json: async () => ({}) };
};
// apiPost/apiGet mirror the REAL $lib/api contract (they return PARSED JSON, throwing on !ok) —
// the first cut returned the wrapper object and every POST ack silently read `undefined.status`,
// which made busy/disk_low indistinguishable from running. Found by driving, not reading.
writeFileSync(`${GEN}/api-stub.js`, `
export const api = (...a) => globalThis.__apiStub(...a);
export const apiGet = async (p) => { const r = await globalThis.__apiStub(p); if (!r.ok) throw new Error('GET ' + p); return r.json(); };
export const apiPost = async (p, b) => { const r = await globalThis.__apiStub(p, { method: 'POST', body: JSON.stringify(b) }); if (!r.ok) throw new Error('POST ' + p); return r.json(); };
export default { api, apiGet, apiPost };
`);
writeFileSync(`${GEN}/env-stub.js`, 'export const browser = true;\n');
writeFileSync(`${GEN}/navigation-stub.js`, 'export const goto = () => { globalThis.__gotoCalls = (globalThis.__gotoCalls||0)+1; };\n');

// ── REAL stores, compiled (shared instances with the component) ─────────────────────────────
const storePlugin = {
  name: 'stub-deps',
  setup(b) {
    b.onResolve({ filter: /^\$lib\/api$/ }, () => ({ path: resolve(GEN, 'api-stub.js') }));
    b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: resolve(GEN, 'api-stub.js') }));
    b.onResolve({ filter: /^\$app\/environment$/ }, () => ({ path: resolve(GEN, 'env-stub.js') }));
  },
};
for (const [entry, out] of [
  ['src/lib/stores/activity.ts', 'activity.js'],   // ⭐ REAL — the DURING owner (IL4 identity)
  ['src/lib/stores/mindscape.ts', 'mindscape.js'], // REAL — sortedRealms/anyUndescribed derive from it
  ['src/lib/generate.ts', 'generate.js'],          // REAL — the auto-generate note render site
]) {
  await build({
    entryPoints: [entry], outfile: `${GEN}/${out}`, bundle: true, format: 'esm',
    platform: 'neutral', external: ['svelte/store'], plugins: [storePlugin], logLevel: 'silent',
  });
}

const STUB = '<script>let { ...rest } = $props();</script><div class="stub-child"></div>';
for (const name of ['ActivityBars']) {
  const out = compile(STUB, { generate: 'client', name, css: 'injected' });
  writeFileSync(`${GEN}/${name}.gen.js`, out.js.code);
}

const SRC = 'src/lib/components/mindscape/MindscapeDetail.svelte';
const out = compile(readFileSync(SRC, 'utf8'), { generate: 'client', name: 'Subject', css: 'injected' });
const rewired = out.js.code
  .replace(/from\s+['"]\$lib\/generate['"]/g, `from './generate.js'`)
  .replace(/from\s+['"]\$lib\/api['"]/g, `from './api-stub.js'`)
  .replace(/from\s+['"]\$app\/navigation['"]/g, `from './navigation-stub.js'`)
  .replace(/from\s+['"]\$lib\/stores\/mindscape['"]/g, `from './mindscape.js'`)
  .replace(/from\s+['"]\$lib\/stores\/activity['"]/g, `from './activity.js'`)
  .replace(/from\s+['"]\$lib\/components\/mindscape\/ActivityBars\.svelte['"]/g, `from './ActivityBars.gen.js'`);
writeFileSync(`${GEN}/Subject.gen.js`, rewired);
const unresolved = [...rewired.matchAll(/from\s+['"](\$(?:lib|app)\/[^'"]+)['"]/g)].map((m) => m[1]);
if (unresolved.length) throw new Error(`unrewired specifiers in ${SRC}: ${[...new Set(unresolved)].join(', ')}`);

const emit = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const { activity } = await import(pathToFileURL(resolve(GEN, 'activity.js')).href);
  const { mindscapeState } = await import(pathToFileURL(resolve(GEN, 'mindscape.js')).href);
  const { default: Subject } = await import(pathToFileURL(resolve(GEN, 'Subject.gen.js')).href);
  const { mount, unmount, flushSync } = await import('svelte');

  // Scenario-specific status fixtures BEFORE mount (the component fetches on mount).
  if (SCENARIO === 'before-wire') {
    // ⭐ IL2: an INCONSISTENT pair on purpose. A client multiplying unnamed×bound would show
    // ~52k; a client rendering THE WIRE'S OWN expectedTokensBound shows ~987k.
    globalThis.__namingFixture = { ...STATUS_BEFORE, forecast: { perUnitTokenBound: 4300, expectedTokensBound: 987_000 } };
  } else if (SCENARIO === 'before-cloud') {
    globalThis.__namingFixture = { ...STATUS_BEFORE, narrator: { ready: true, label: 'Regolo', model: null, local: false, jurisdiction: 'eu-zdr' } };
  } else if (SCENARIO === 'choice') {
    globalThis.__namingFixture = { ...STATUS_BEFORE, narrator: { ...STATUS_BEFORE.narrator, ready: false } };
  } else if (SCENARIO === 'empty') {
    globalThis.__namingFixture = { ...STATUS_BEFORE, areas: { total: 40, named: 40, unnamed: 0 }, forecast: { perUnitTokenBound: 4300, expectedTokensBound: 0 } };
  } else if (SCENARIO === 'fallback') {
    globalThis.__namingFixture = null;   // status route down → the capability must survive
  }

  // The vault that renders the list: placeholders + ONE real, distinctive name (IL8's control).
  mindscapeState.update((s) => ({
    ...s, loading: false,
    realms: { ...REALMS_AT_MOUNT },
    territories: {}, points: [], selectedRealmId: null, selectedTerritoryId: null,
  }));

  const app = mount(Subject, { target: dom.window.document.getElementById('host') });
  flushSync();
  const D = dom.window.document;
  const liveAtMount = D.querySelector('[aria-live]');
  const liveTextAtMount = liveAtMount ? liveAtMount.textContent : null;
  await sleep(80);   // onMount async loads (naming-status, providers, first activity poll)
  flushSync();

  const card = () => D.querySelector('.naming-card');
  const cardText = () => (card()?.textContent || '').replace(/\s+/g, ' ').trim();
  const listText = () => (D.querySelector('.nav-list')?.textContent || '').replace(/\s+/g, ' ').trim();
  const live = () => D.querySelector('[aria-live]');
  const liveText = () => (live()?.textContent || '').trim();
  const base = () => ({
    ok: true, scenario: SCENARIO,
    hasCard: !!card(), cardText: cardText(), listText: listText(),
    liveCount: D.querySelectorAll('[aria-live]').length,
    liveText: liveText(),
    liveExistedAtMountEmpty: !!liveAtMount && liveTextAtMount === '',
    liveSameNode: liveAtMount === live(),
    secretInCard: cardText().includes('ZZSECRET'),
    secretInList: listText().includes('ZZSECRET'),
    ctaCount: D.querySelectorAll('button.realm-cta').length,
    postCalls: globalThis.__postCalls,
    allNamedLine: (D.querySelector('.all-named-line')?.textContent || '').replace(/\s+/g, ' ').trim(),
  });

  const driveRow = (row) => {
    const v = { active: row ? [row] : [], recent: row ? [] : [{ ...ROW, status: globalThis.__terminalStatus || 'done', done: 12, etaSeconds: null, finishedAt: new Date().toISOString() }] };
    globalThis.__activityFixture = v;   // a stray poll must agree with the driven value
    activity.set(v);
  };
  const ROW = { id: 'nj1', kind: 'describe:name', stage: 'Naming your areas', done: 7, total: 12, remaining: 5, etaSeconds: 180, status: 'running', startedAt: new Date(Date.now() - 120_000).toISOString().replace('T', ' ').slice(0, 19) };

  if (SCENARIO === 'before' || SCENARIO === 'before-wire' || SCENARIO === 'before-cloud' || SCENARIO === 'empty' || SCENARIO === 'fallback') {
    emit(base());
  } else if (SCENARIO === 'choice') {
    // IL3: try EVERY button inside the card — none may reach the POST.
    for (const b of card()?.querySelectorAll('button') || []) { b.click(); }
    flushSync(); await sleep(30); flushSync();
    emit({ ...base(), choiceMuted: !!card()?.querySelector('.nc-choice') && !card()?.querySelector('.nc-err'), gotoCalls: globalThis.__gotoCalls || 0 });
  } else if (SCENARIO === 'during') {
    driveRow(ROW); flushSync();
    const snap1 = { text: cardText(), valuenow: D.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') || null, live: liveText() };
    // ⭐ IL4 identity, n≥2: move the OWNER's numbers; the render must follow.
    driveRow({ ...ROW, done: 9, etaSeconds: 60 }); flushSync();
    const snap2 = { text: cardText(), valuenow: D.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') || null, live: liveText() };
    emit({ ...base(), snap1, snap2 });
  } else if (SCENARIO === 'after-success' || SCENARIO === 'after-partial') {
    driveRow(ROW); flushSync(); await sleep(20); flushSync();
    const duringText = cardText();
    globalThis.__namingFixture = SCENARIO === 'after-success'
      ? { ...STATUS_BEFORE, areas: { total: 40, named: 40, unnamed: 0 }, forecast: { perUnitTokenBound: 4300, expectedTokensBound: 0 } }
      : { ...STATUS_BEFORE, areas: { total: 40, named: 37, unnamed: 3 }, forecast: { perUnitTokenBound: 4300, expectedTokensBound: 12_900 } };
    // The reload now serves the RENAMED vault — the AFTER reward is the list itself.
    globalThis.__mindscapeFixture = SCENARIO === 'after-success'
      ? { 0: { name: 'Morning Reflections', essence: 'e', pointCount: 40 }, 1: REALMS_AT_MOUNT[1], 7: { name: 'Deep Work', essence: 'e', pointCount: 5 } }
      : { 0: { name: 'Morning Reflections', essence: 'e', pointCount: 40 }, 1: REALMS_AT_MOUNT[1], 7: REALMS_AT_MOUNT[7] };
    driveRow(null);   // the row disappearing IS the completion signal
    flushSync(); await sleep(120); flushSync();
    const o = { ...base(), duringText, washCount: D.querySelectorAll('.realm-item.renamed').length };
    if (SCENARIO === 'after-partial') {
      // IL5: Try again must re-POST (gap-fill makes retry exactly-the-remainder).
      const posts0 = globalThis.__postCalls;
      const tryAgain = [...(card()?.querySelectorAll('button.nc-link') || [])].find((b) => /try again/i.test(b.textContent || ''));
      tryAgain?.click(); flushSync(); await sleep(30); flushSync();
      o.hadTryAgain = !!tryAgain;
      o.rePosted = globalThis.__postCalls === posts0 + 1;
      o.textAfterRetry = cardText();
    }
    emit(o);
  } else if (SCENARIO === 'busy' || SCENARIO === 'running' || SCENARIO === 'disk_low') {
    globalThis.__postResponse = SCENARIO === 'busy'
      ? { status: 'busy', note: 'A naming pass is already running.' }
      : SCENARIO === 'disk_low'
        ? { status: 'disk_low', detail: { freeGb: 2, needGb: 6 } }
        : { status: 'running', pid: 42 };
    const cta = D.querySelector('button.realm-cta');
    cta?.click(); flushSync(); await sleep(40); flushSync();
    emit({ ...base(), clicked: !!cta });
  } else {
    emit({ ok: false, scenario: SCENARIO, error: `unknown scenario ${SCENARIO}` });
  }

  unmount(app);   // runs onDestroy → stops the ref-counted poll + clears timers
} catch (e) {
  emit({ ok: false, scenario: SCENARIO, error: String(e?.stack || e) });
}
process.exit(0);

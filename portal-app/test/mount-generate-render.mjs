// Mounts the two components that RENDER the generate outcome — for REAL: real Svelte compiler,
// real jsdom, the REAL src/lib/generate.ts store driven by the REAL responses the route returns
// — and prints one JSON line for scripts/verify-generate-phase.mjs to assert on.
//
// WHY THIS EXISTS — D2 was a SOURCE REGEX, and a regex cannot prove reachability.
// D2 asserted that MindscapeDetail.svelte CONTAINS `$generate.phase === 'up-to-date'`,
// `{$generate.error}` and `class="realm-cta illuminate"`. That catches DELETION (mutation M2
// removed the button ⇒ FAIL) but NOT NEUTERING: change the CTA's guard to
// `{#if false && anyUndescribed && sortedRealms.length > 0}` and every one of those strings is
// still in the file, the user sees NOTHING, and the suite says GO (mutation M4, independent
// review of PR #190, 2026-07-16). "Dead-coded" is an OPEN SET — a literal `false`, an
// always-false variable, an unreachable branch, a parent `{#if}` that never holds — and no
// regex closes an open set. That is the same trap that beat P6 and P6e.
// ⇒ Only RENDERING proves rendering. This harness mounts and reads host.textContent.
//
// THE BUG IT GUARDS: POST /mycelium/generate returns 200 {jobId:null,status:'skipped'} when
// topology already exists (portal-mindscape.js:626). That is a SUCCESS — "nothing to do". The
// client mapped it to phase:'error', and `$generate.error` had ZERO render sites app-wide ⇒
// SILENCE. Illuminate's render condition (realms exist) IS the route's skip condition, so it
// failed 100% of the time it was visible. @see DISTILLATION-SURFACE-DESIGN §2a/§5.4:
// "representable ≠ shown."
//
// END-TO-END ON PURPOSE. The store is NOT stubbed with a plain writable — a stub would let a
// rename of the phase string sail through. The REAL store is driven by the REAL route
// responses, so this proves the whole chain the bug lived in: server response → store phase →
// pixel. G1-G5 pin the store's mapping; this pins that a user can SEE it.
//
// Run with: node --conditions browser portal-app/test/mount-generate-render.mjs  (cwd=portal-app)
// The `browser` condition is REQUIRED: without it Node resolves svelte's SERVER build via the
// exports map and mount() throws lifecycle_function_unavailable. (Learned in mount-onbox-select.)
//
// `jsdom` + `esbuild` are DECLARED devDeps of portal-app as of #194. They used to resolve only
// TRANSITIVELY (isomorphic-dompurify → jsdom; vite → esbuild) — which works until it doesn't:
// Vite 8/rolldown drops esbuild, and this gate is in `verify` AND `verify:core`. A gate that
// vanishes on an unrelated dep bump is not a gate. (Independent review of #194, finding 5.)
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-mount-generate';
rmSync(GEN, { recursive: true, force: true });
mkdirSync(GEN, { recursive: true });

// PROBE=<component>:<scenario>. Both components are driven because BOTH render the outcome and
// they are MUTUALLY EXCLUSIVE surfaces (MindscapeView:459 mounts <MindscapeDetail/> only under
// `points.length > 0`; :502 mounts <MindscapeInvite/> only in the `{:else}` — the fresh vault).
// Gating one and not the other leaves the other free to go dark, which is how MED-1 happened.
const [COMPONENT, SCENARIO] = (process.env.PROBE || 'detail:skipped').split(':');

// The REAL responses, byte-for-byte what the route returns. Shared with drive-generate-store.mjs
// by convention, not by import, because that harness bundles them into a stub string.
const RESPONSES = {
  // portal-mindscape.js:626-634 — topology already exists ⇒ nothing to do. A SUCCESS.
  skipped: { ok: true, status: 200, body: { jobId: null, status: 'skipped', reason: 'topology_exists', note: 'Map already built; pass ?force=1 to rebuild.' } },
  // 503 keys/pipeline not ready → phase:'error', carrying the server's OWN message.
  unavailable: { ok: false, status: 503, body: { error: 'mindscape generation is unavailable' } },
  // 409 preflight → phase:'embedding'. NOT an error: wait and auto-start.
  // ⚠️ embedded MUST stay under generate.ts's MIN_EMBEDDED (5), here and in the
  // /processing-status stub below. At/above it, pollEmbedding calls start() → 409 → run() →
  // an immediate tick → start()… — a live-lock that hung this probe until the fixture agreed
  // with the store's own threshold. The FIXTURE was wrong, not the component.
  embedding: { ok: false, status: 409, body: { error: 'Only 2 of 500 conversations are ready…', embedded: 2, total: 500 } },
  // A real start → phase:'running'. The LONGEST-LIVED state (clustering runs for minutes) and it
  // was ungated on the invite: dropping `|| $generate.phase === 'running'` from MindscapeInvite
  // erased all progress feedback on the fresh-vault path and the gate stayed green (independent
  // review of #194, finding 4). `running` carries no `message` — its line is the stageLabel.
  started: { ok: true, status: 200, body: { jobId: 'job-123', status: 'running' } },
  // A run that COMPLETES → phase:'done'. The fresh-vault HAPPY PATH (embedding → running → done)
  // and it was SILENT on the invite, excused as "transient" because MindscapeView:105 reloads and
  // unmounts. That reload is `mindscapeState.load()` — the same call whose catch leaves
  // `points: []` — so on failure the invite stays mounted and `done` renders nothing, then
  // resetGen() → idle → silent forever (independent review of #194 r2, finding 1).
  finished: { ok: true, status: 200, body: { jobId: 'job-123', status: 'running' } },
  // The POST that never answers → phase stays 'starting'. NOT transient: it lasts as long as the
  // request does, unbounded if the server hangs. Driven for real (the stub returns a pending
  // promise and the harness does not await start()) rather than force-set, so it is the same
  // chain as every other probe.
  hang: { ok: true, status: 200, body: {} },
  // A run that has OUTLIVED the previous run's duration → phase:'running'. Same POST as `started`;
  // the whole scenario lives in the /status stub below, which is where startedAt+priorDurationMs
  // come from. Reaches computeEta's `eta > 0` guard via a NEGATIVE projection.
  overrun: { ok: true, status: 200, body: { jobId: 'job-123', status: 'running' } },
  // A run 1s old → phase:'running'. The ONLY probe that reaches computeEta's MIN-ELAPSED guard,
  // and it exists because a mutation proved the guard was otherwise UNEXERCISED: deleting
  // `if (elapsed < ETA_MIN_ELAPSED_S) return null` outright still scored 11/11 GO. Every other
  // probe sits at elapsed≈0.03s, where the projection rounds to 0 and the `eta > 0` guard catches
  // it first — so the two guards looked equivalent when they are not. At elapsed=1s with step 1/5
  // the projection is a POSITIVE, plausible-looking "~4s left" for a run that takes minutes: no
  // zero-check can catch that, only refusing to project this early. See D2f.
  early: { ok: true, status: 200, body: { jobId: 'job-123', status: 'running' } },
};

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
// Svelte's client runtime reads DOM globals at module init, so they must exist BEFORE
// svelte/internal/client is imported. `navigator` is getter-only in Node 22 — hence try/catch.
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (k in globalThis) continue;
  try { globalThis[k] = dom.window[k]; } catch { /* getter-only global — jsdom's is fine */ }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// ── ONE api stub for the whole graph ─────────────────────────────────────────────────────────
// generate.ts imports `./api`; the components import `$lib/api`. Both are rewired HERE, to one
// path-dispatching stub, so the component's own reads (/portal/providers → is the AI connected?)
// and the store's POST are answered by the same fixture. Discriminating on path, not on module.
globalThis.__apiStub = async (path, init = {}) => {
  const method = init?.method || 'GET';
  // ⚠️ status BEFORE the generate prefix: '/portal/mycelium/generate/status/:id' startsWith
  // '/portal/mycelium/generate' too. It is a GET so the POST guard below wouldn't swallow it —
  // but the ordering is the load-bearing kind that bit the intelligence-screen harness, so it
  // stays explicit rather than relying on the method check to save it.
  if (path.startsWith('/portal/mycelium/generate/status/')) {
    if (SCENARIO === 'finished') return { ok: true, json: async () => ({ id: 'job-123', status: 'done', step: 5, totalSteps: 5, startedAt: 1, finishedAt: 2 }) };
    // The SECOND run, slower than the first — the common case (more data). The server's own
    // startedAt puts elapsed at 60s (pollStatus prefers `j.startedAt`), and priorDurationMs says
    // the last run took 5s. The projection `prior - elapsed` is therefore NEGATIVE, which the old
    // `Math.max(0, …)` floored to 0 ⇒ "~0s left" for the rest of a multi-minute run. Real values,
    // not force-set state: this drives the same store path as every other probe.
    if (SCENARIO === 'overrun') return { ok: true, json: async () => ({ id: 'job-123', status: 'running', step: 1, totalSteps: 5, stageLabel: 'Clustering your conversations…', startedAt: Date.now() - 60_000, priorDurationMs: 5_000 }) };
    // 1s in, step 1 of 5, NO priorDurationMs (a first run) ⇒ the step-fraction projection is
    // `1/0.2 - 1` = a positive, confident-looking 4s. That is the min-elapsed guard's case: the
    // number is non-zero, so it survives every zero-check, and it is still a fabrication.
    if (SCENARIO === 'early') return { ok: true, json: async () => ({ id: 'job-123', status: 'running', step: 1, totalSteps: 5, stageLabel: 'Clustering your conversations…', startedAt: Date.now() - 1_000 }) };
    return { ok: true, json: async () => ({ id: 'job-123', status: 'running', step: 1, totalSteps: 5, stageLabel: 'Clustering your conversations…' }) };
  }
  if (path.startsWith('/portal/mycelium/generate') && method === 'POST') {
    // The request that never answers — the ONLY honest way to hold `starting` still.
    if (SCENARIO === 'hang') return new Promise(() => {});
    const r = RESPONSES[SCENARIO];
    return { ok: r.ok, status: r.status, json: async () => r.body };
  }
  // MindscapeDetail's onMount: an ACTIVE provider ⇒ aiConnected ⇒ the Illuminate CTA (not
  // "Spawn intelligence"). Without this the component renders the OTHER branch and the probe
  // would test a surface that isn't the one under gate.
  if (path.startsWith('/portal/providers')) return { ok: true, json: async () => ({ providers: [{ id: 1, label: 'Ollama (local)', is_active: 1 }] }) };
  // MindscapeInvite's onMount readiness read — enough to render, not the subject of this gate.
  if (path.startsWith('/portal/readiness')) return { ok: true, json: async () => ({ data: { total: 0 }, ai: { connected: true }, channel: { connected: false } }) };
  // The embedding poll. `embedded` stays under MIN_EMBEDDED so the store REMAINS in `embedding`
  // — the phase under test. See the live-lock note on RESPONSES.embedding.
  if (path.startsWith('/portal/mycelium/processing-status')) return { ok: true, json: async () => ({ embedded: 2, total: 500 }) };
  return { ok: true, json: async () => ({}) };
};
writeFileSync(`${GEN}/api-stub.js`, `
export const api = (...a) => globalThis.__apiStub(...a);
export const apiPost = (p, b) => globalThis.__apiStub(p, { method: 'POST', body: JSON.stringify(b) });
export default { api, apiPost };
`);

// ── The REAL generate store (esbuild strips the TS types; only `./api` is redirected) ────────
// The component and this harness import the SAME generated file, so the store instance is
// shared — set the phase here and the mounted component MUST re-render, or the gate fails.
await build({
  entryPoints: ['src/lib/generate.ts'],
  outfile: `${GEN}/generate.js`,
  bundle: true, format: 'esm', platform: 'neutral',
  external: ['svelte/store'],
  plugins: [{
    name: 'stub-api',
    setup(b) { b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: resolve(GEN, 'api-stub.js') })); },
  }],
  logLevel: 'silent',
});

// ── The REAL mindscape store ─────────────────────────────────────────────────────────────────
// Compiled, not hand-faked: MindscapeDetail derives `sortedRealms` and `anyUndescribed` from it,
// and those two ARE the CTA's guard — the exact expression M4 neuters. A hand-written mirror
// would let the real store's shape drift out from under the gate.
writeFileSync(`${GEN}/env-stub.js`, 'export const browser = true;\n');
await build({
  entryPoints: ['src/lib/stores/mindscape.ts'],
  outfile: `${GEN}/mindscape.js`,
  bundle: true, format: 'esm', platform: 'neutral',
  external: ['svelte/store'],
  plugins: [{
    name: 'stub-store-deps',
    setup(b) {
      b.onResolve({ filter: /^\$lib\/api$/ }, () => ({ path: resolve(GEN, 'api-stub.js') }));
      b.onResolve({ filter: /^\$app\/environment$/ }, () => ({ path: resolve(GEN, 'env-stub.js') }));
    },
  }],
  logLevel: 'silent',
});

// ── Stub the heavy CHILDREN, never the component under test ──────────────────────────────────
// The subject is THIS component's render of the outcome; its subtree is not. Each stub is a
// real compiled Svelte component so mount() treats it normally.
// IntelligenceScreen/AISettings/TelegramConnect are the connect-ladder children #200 (E2) moved
// INTO MindscapeInvite when it made the invite the onboarding host ("two surfaces, one fact").
// They live below the gen-status block under test and never touch it, so an inert stub is faithful
// — but the specifier must still be rewired or the compiled import throws before mount. (Added
// when origin/main #200/#208 merged under #194; the gen-status assertions D2e are unchanged.)
const STUB = '<script>let { ...rest } = $props();</script><div class="stub-child"></div>';
for (const name of ['Sparkline', 'ImportField', 'ScanForData', 'SourceCatalog', 'IntelligenceScreen', 'AISettings', 'TelegramConnect']) {
  const out = compile(STUB, { generate: 'client', name, css: 'injected' });
  writeFileSync(`${GEN}/${name}.gen.js`, out.js.code);
}
writeFileSync(`${GEN}/navigation-stub.js`, 'export const goto = () => {};\nexport const beforeNavigate = () => {};\nexport const afterNavigate = () => {};\n');
// The activity store (the naming card's DURING source, Part II) — NOT this gate's subject
// (generate rendering is), and its real ref-counted setInterval would hold the probe's process
// open. An empty-feed stub renders the same "no describe:name row" state a quiet vault has.
// The card's own gate (verify:illuminate-surface / mount-illuminate-card.mjs) compiles the REAL
// store and drives it — identity there, inert here.
writeFileSync(`${GEN}/activity-stub.js`, `import { writable } from 'svelte/store';
export const activity = writable({ active: [], recent: [] });
export const startActivityPolling = () => () => {};
export const fmtEta = () => '';
export const fmtAgo = () => '';
export const fmtBytes = () => '';
`);
// onboarding-data.svelte (#208) — `importCompletedSignal()` returns a rune counter; MindscapeInvite
// reads it in an $effect and refreshes only when it goes > 0. The mount value is 0 (the component's
// own null-effect owns the first load), so a stub returning 0 exercises the exact code path the
// real store does on mount, without dragging in the readiness fetch machinery.
writeFileSync(`${GEN}/onboarding-data-stub.js`, 'export const importCompletedSignal = () => 0;\nexport const signalImportCompleted = () => {};\n');

const SOURCES = {
  detail: 'src/lib/components/mindscape/MindscapeDetail.svelte',
  invite: 'src/lib/components/mindscape/MindscapeInvite.svelte',
};
const SRC = SOURCES[COMPONENT];
if (!SRC) throw new Error(`unknown component ${COMPONENT}`);

const out = compile(readFileSync(SRC, 'utf8'), { generate: 'client', name: 'Subject', css: 'injected' });
// Rewire specifiers in the GENERATED js — the bare compiler resolves none of $lib/$app.
const rewired = out.js.code
  .replace(/from\s+['"]\$lib\/generate['"]/g, `from './generate.js'`)
  .replace(/from\s+['"]\$lib\/api['"]/g, `from './api-stub.js'`)
  .replace(/from\s+['"]\$app\/navigation['"]/g, `from './navigation-stub.js'`)
  .replace(/from\s+['"]\$lib\/stores\/mindscape['"]/g, `from './mindscape.js'`)
  .replace(/from\s+['"]\$lib\/stores\/activity['"]/g, `from './activity-stub.js'`)
  .replace(/from\s+['"]\$lib\/components\/mindscape\/Sparkline\.svelte['"]/g, `from './Sparkline.gen.js'`)
  .replace(/from\s+['"]\$lib\/components\/import\/ImportField\.svelte['"]/g, `from './ImportField.gen.js'`)
  .replace(/from\s+['"]\$lib\/components\/import\/ScanForData\.svelte['"]/g, `from './ScanForData.gen.js'`)
  .replace(/from\s+['"]\$lib\/components\/import\/SourceCatalog\.svelte['"]/g, `from './SourceCatalog.gen.js'`)
  .replace(/from\s+['"]\$lib\/stores\/onboarding-data\.svelte['"]/g, `from './onboarding-data-stub.js'`)
  .replace(/from\s+['"]\$lib\/components\/settings\/IntelligenceScreen\.svelte['"]/g, `from './IntelligenceScreen.gen.js'`)
  .replace(/from\s+['"]\$lib\/components\/settings\/AISettings\.svelte['"]/g, `from './AISettings.gen.js'`)
  .replace(/from\s+['"]\$lib\/components\/channels\/TelegramConnect\.svelte['"]/g, `from './TelegramConnect.gen.js'`);
writeFileSync(`${GEN}/Subject.gen.js`, rewired);

// A specifier we FAILED to rewire would throw at import and read as a broken gate, not a broken
// component. Fail loudly with the culprit instead of a bare ERR_MODULE_NOT_FOUND.
const unresolved = [...rewired.matchAll(/from\s+['"](\$(?:lib|app)\/[^'"]+)['"]/g)].map((m) => m[1]);
if (unresolved.length) throw new Error(`unrewired specifiers in ${SRC}: ${[...new Set(unresolved)].join(', ')}`);

const emit = (o) => console.log(JSON.stringify(o));
try {
  const { generate, start, reset } = await import(pathToFileURL(resolve(GEN, 'generate.js')).href);
  const { mindscapeState } = await import(pathToFileURL(resolve(GEN, 'mindscape.js')).href);
  const { default: Subject } = await import(pathToFileURL(resolve(GEN, 'Subject.gen.js')).href);
  const { mount, flushSync } = await import('svelte');

  // The vault that makes the CTA render: realms exist and are UNDESCRIBED. The pipeline stores a
  // literal placeholder name ("Realm 0") + empty essence until an AI chronicles it — that
  // placeholder convention is what isRealmDescribed() detects, so the fixture speaks it. `>= 3`
  // points is the component's own filter (MindscapeDetail:107).
  mindscapeState.update((s) => ({
    ...s,
    loading: false,
    realms: { 0: { name: 'Realm 0', essence: '', pointCount: 40 }, 1: { name: 'Realm 1', essence: '', pointCount: 12 } },
    territories: {},
    points: [],
    selectedRealmId: null,
    selectedTerritoryId: null,
  }));

  mount(Subject, { target: dom.window.document.getElementById('host'), props: { displayName: 'Martin' } });
  flushSync();
  await new Promise((r) => setTimeout(r, 60));   // onMount's async load() (aiConnected/readiness)
  flushSync();

  const D = dom.window.document;
  const textOf = () => D.body.textContent.replace(/\s+/g, ' ').trim();
  const before = textOf();

  // Drive the REAL store through the REAL start() — the same call the button's onclick makes
  // (illuminateRealms → startGenerate). Not a hand-set phase: this is the chain end-to-end.
  // `hang` deliberately does NOT await: its POST never resolves, which is exactly how a user
  // sits in `starting`. Awaiting it would hang the probe forever.
  if (SCENARIO === 'hang') void start(); else await start();
  flushSync();
  await new Promise((r) => setTimeout(r, 30));
  flushSync();

  const after = textOf();
  const { get } = await import('svelte/store');
  const state = get(generate);

  // ── WHERE it rendered, and whether a user could SEE it ───────────────────────────────────
  // body.textContent alone proves neither. An independent review of #194 broke the first version
  // twice on exactly this: (a) `.cta-note { display: none }` in the component's own <style> →
  // still GO; (b) moving the note out of the CTA into a hidden box at the top of the component →
  // still GO. textContent ≠ visible, and body-wide ≠ next to the button. Both are one careless
  // edit away, so both are now reported.
  //
  // needle = the string the phase is supposed to show. The `message || stageLabel` fallback
  // mirrors the components' own (`{$generate.message || $generate.stageLabel || …}`): `running`
  // has no message. It is '' for `starting` (the store holds NO text and the component shows its
  // hardcoded 'Working…'), so the gate asserts that phase on siteText being non-empty instead —
  // an empty needle makes includes() vacuously true.
  const needle = state.phase === 'error' ? state.error : (state.message || state.stageLabel);

  // ⚠️⚠️ READ THIS BEFORE TRUSTING `visible()` — IT IS A PROJECTION, AND KNOWINGLY SO.
  // This function is an ENUMERATION OF HIDING MECHANISMS, i.e. an OPEN SET — the exact
  // projection-vs-property failure this PR diagnoses three times in product code. It moved into
  // the gate, and the history is embarrassing enough to record verbatim: round 2 a reviewer named
  // `opacity`, so I added `opacity` and wrote "geometry is now the only gap"; round 3 they named
  // `color: transparent` (computes to rgba(0,0,0,0) — invisible on any background), which is not
  // geometry, WAS closable, and sailed through while the gate said 10/10 GO. Adding `color`
  // invites round 4. Each round I restated the limit one property too early.
  //
  // So: this list is NAMED AND INCOMPLETE, and no version of it will be complete. jsdom does no
  // layout and cannot resolve occlusion, so "can a human read this text" is NOT COMPUTABLE here —
  // only a real browser (`element.checkVisibility()` + elementFromPoint) closes it. That is a
  // known, filed gap, not a limit I can argue away. Do NOT read a pass as "the user can see it";
  // read it as "none of the following mechanisms is hiding it".
  // Known-uncovered: geometry (zero-height clip, off-screen transform, overflow, z-index
  // occlusion), clip-path, text-indent, ::before overlays, `-webkit-text-fill-color` (see the
  // jsdom trap on the colour check below), and whatever round 4 finds.
  // Each entry below still earns its place — every one is a real one-line regression it catches —
  // but the VALUE is defence in depth, not a guarantee.
  const visible = (el) => {
    const transparent = (c) => /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)$/.test((c || '').trim());
    for (let n = el; n && n !== D.body.parentElement; n = n.parentElement) {
      const cs = dom.window.getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true') return false;
      if (parseFloat(cs.opacity || '1') === 0) return false;
      if (cs.fontSize && parseFloat(cs.fontSize) === 0) return false;
      // Invisible INK. Element itself only — `color` inherits, so an ancestor's transparent
      // colour already shows up in the child's computed value.
      // ⚠️ `color` ONLY. `-webkit-text-fill-color` looks like the obvious companion check and is a
      // TRAP: when `color` is an unresolved CSS var — which is most of this codebase
      // (.cta-note is `color: var(--color-text-tertiary)`, and jsdom loads no tokens.css) — jsdom
      // computes -webkit-text-fill-color as `rgba(0, 0, 0, 0)` REGARDLESS. Checking it turned
      // every real render RED (6/10, a false NO-GO on good code) because a jsdom artifact is
      // indistinguishable from a real `transparent`. Caught only by running the control: a check
      // validated against the MUTATION alone would have shipped a permanently-red gate.
      // ⇒ -webkit-text-fill-color: transparent is therefore UNCOVERED, and named as such in the
      // open-set list above rather than pretended-at with a check that cannot work.
      if (n === el && transparent(cs.color)) return false;
    }
    return true;
  };
  const cta = D.querySelector('button.realm-cta.illuminate');

  // ── THE INTENDED RENDER SITE — not "some element in the body" ────────────────────────────
  // v1 elected a carrier from the WHOLE document (`querySelectorAll('*')` filtered by needle,
  // sorted by compareDocumentPosition). Two things were wrong. (a) That comparator is
  // INCONSISTENT for unrelated elements — it returns -1 for both (a,b) and (b,a) — so V8's sort
  // order, and therefore the elected carrier, was arbitrary. (b) Even sound, it asked the wrong
  // question. A reviewer planted a VISIBLE DECOY outside the CTA while the real note was hidden
  // inside it: D2a passed ON THE DECOY while the line it names was invisible.
  // ⇒ Ask the site directly. `.cta-note` / `.gen-status` IS where the outcome is supposed to
  // appear, so a decoy elsewhere is irrelevant and a hidden real note cannot hide behind one.
  // If the class is ever renamed the site goes null and this FAILS — a false red, fail-closed,
  // which is the correct direction for a gate to be wrong in.
  const SITE_SEL = COMPONENT === 'detail' ? 'p.cta-note' : '.gen-status';
  const sites = [...D.querySelectorAll(SITE_SEL)];
  const site = (needle && sites.find((el) => el.textContent.includes(needle))) || sites[0] || null;

  emit({
    ok: true,
    component: COMPONENT,
    scenario: SCENARIO,
    // What the STORE holds (cross-checks the phase the render is supposed to be showing —
    // asserting on text alone could pass against the wrong phase entirely).
    phase: state.phase,
    storeMessage: state.message,
    storeError: state.error,
    // `running` carries no `message` — its line is the stageLabel. Emitted so the gate has a
    // NON-EMPTY needle for that phase instead of a vacuous includes('').
    storeStageLabel: state.stageLabel,
    // The ETA the store WOULD have the template render. Emitted alongside `siteText` so the gate
    // can assert both halves of the countdown independently: the store must not fabricate one at
    // elapsed≈0, and the template must not render one the store doesn't hold. Note this probe
    // reads the store ~30ms after start(), i.e. exactly the elapsed≈0 window where the old
    // `elapsed / frac - elapsed` returned 0 and the invite announced "~0s left" on a run that
    // takes minutes.
    etaSeconds: state.etaSeconds,
    // ⭐ THE PROOF: what a USER can actually read on screen, after the click.
    text: after,
    textBefore: before,
    // ⭐ Is the outcome VISIBLE, and is it WHERE the user is looking? (findings 2 + 3 above)
    siteSelector: SITE_SEL,
    siteCount: sites.length,
    siteText: site ? site.textContent.replace(/\s+/g, ' ').trim() : null,
    siteVisible: site ? visible(site) : false,
    // The site must live in the CTA's own container — a message rendered elsewhere in the
    // component is not feedback for the click. Null when there is no CTA (the invite, whose
    // .gen-status is itself the site — so `siteCount`+`siteVisible` carry the locality there).
    siteWithCta: cta && site ? cta.parentElement.contains(site) : null,
    // The CTA must EXIST and be reachable — M2 deleted it, M4 dead-coded it. A count from the
    // live DOM sees both; a regex over source sees neither.
    ctaCount: D.querySelectorAll('button.realm-cta.illuminate').length,
    genStatusCount: D.querySelectorAll('.gen-status').length,
  });
  reset();   // clear any armed poll interval so the process can exit
} catch (e) {
  emit({ ok: false, component: COMPONENT, scenario: SCENARIO, error: String(e?.stack || e) });
}

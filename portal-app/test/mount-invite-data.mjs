// Mounts the REAL MindscapeInvite.svelte and drives its Data step to prove that the invite
// LEARNS ABOUT DATA FROM ANY PATH — the cross-component import-completed signal AND window focus —
// and never claims an empty vault over a full one (§3.2a). Prints one JSON line per PROBE for
// scripts/verify-invite-data.mjs to assert on.
//
// Run: node --conditions browser portal-app/test/mount-invite-data.mjs   (cwd = portal-app)
// `--conditions browser` is REQUIRED: without it Node resolves svelte's SERVER exports map and
// mount() throws lifecycle_function_unavailable (learned in mount-intelligence-screen.mjs).
//
// ⚠️ WHY A MOUNT AND NOT A REGEX. The bug is a LIVENESS property — "a fact that changed on the
// server reaches this component's render" — and this session's own history (mount-onboarding-flow,
// mount-intelligence-screen) proves a source regex passes with the wiring commented out, wrapped in
// `if (false)`, or with the import deleted (a runtime ReferenceError). And a `{#if false && …}`
// branch keeps every asserted string, so grep says GO over a dead render. Only mounting the real
// component, flipping the real server fact, and firing the real signal/event can see the wire.
//
// The store is the REAL singleton: the harness calls signalImportCompleted() on the SAME compiled
// module the component imports, so if it ever stops being a singleton this notices (dead wire).
import { JSDOM } from 'jsdom';
import { compile, compileModule } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROBE = process.env.PROBE || 'empty';
const GEN = '.gen-mount-invite';
const COMPONENT = 'src/lib/components/mindscape/MindscapeInvite.svelte';
const STORE = 'src/lib/stores/onboarding-data.svelte.ts';

// ── DOM globals before svelte/internal/client is imported ────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (k in globalThis) continue;
  try { globalThis[k] = dom.window[k]; } catch { /* getter-only global — jsdom's is fine */ }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// ── Fixtures: the two server facts, in the WIRE shape ────────────────────────────────────────
// ⚠️ WIRE CONTRACT (readiness.js get()): `data` NEVER carries an `unknown` marker — the server
// strips it (`delete out.data.unknown`) and the failure signal is `canGenerate.reason ===
// 'unknown'`, emitted whenever `data` is requested. A fixture with `data.unknown` models a
// response the server cannot send, and a gate fed that fixture proves nothing about the wire
// (this exact fixture error hid a live regression until 2026-07-17). `evidence.unknown` IS
// surfaced — only data's marker is stripped.
// EMPTY = a fresh vault (data.total 0, evidence unknown). FULL = a vault with real data, whose
// evidence slice carries distinctive COUNTS the gate asserts render (not "any text").
const EMPTY = { data: { total: 0 }, canGenerate: { ok: false, reason: 'no_messages' }, evidence: { unknown: true, sources: [], dateRange: { yearStart: null, yearEnd: null }, conversationCount: 0, peopleCount: 0 }, ai: { connected: false }, channel: { connected: false } };
const FULL = {
  data: { total: 847 },
  canGenerate: { ok: true, reason: null },
  evidence: {
    sources: [{ source: 'chatgpt', count: 500 }, { source: 'claude', count: 347 }],
    dateRange: { yearStart: 2019, yearEnd: 2024 },
    conversationCount: 61,
    peopleCount: 12,
  },
  ai: { connected: false },
  channel: { connected: false },
};

// The FRESH-MACHINE unknown: the very FIRST readiness read fails to count (SQLCipher scan), and
// there is no prior known-good value to hold (§3.2a has nothing to latch). WIRE shape: data is
// bare zeros (the `unknown` marker is stripped server-side) and the only failure signal is
// canGenerate.reason === 'unknown'. This must NOT render the empty-state — a vault we could not
// READ is not a vault the user never filled.
const FRESH_UNKNOWN = { data: { total: 0 }, canGenerate: { ok: false, reason: 'unknown' }, evidence: { unknown: true, sources: [], dateRange: { yearStart: null, yearEnd: null }, conversationCount: 0, peopleCount: 0 }, ai: { connected: false }, channel: { connected: false } };

globalThis.__readiness = PROBE === 'freshunknown' ? FRESH_UNKNOWN : EMPTY;  // the CURRENT server fact — flipped mid-test by some probes
globalThis.__failReadiness = false;  // when true, the readiness read THROWS (a failed re-read)
globalThis.__readinessReads = 0;
globalThis.__readinessPaths = [];    // every readiness request path, in order (probe vs full)

// The component debounces every event-driven refresh (REFRESH_DEBOUNCE_MS = 1000). Probes that
// fire an event must wait PAST the trailing debounce (+ the fetch) before reading the DOM. The
// focus path is TWO debounced steps (cheap probe → full refresh), so it gets a second window.
const DEBOUNCE_WAIT = 1400;

// ── The stubbed leaves ───────────────────────────────────────────────────────────────────────
mkdirSync(GEN, { recursive: true });

// `api`: records every readiness read (WITH its slices, so the gate can tell the cheap
// change-probe from the full evidence read), serves the current fact, or fails on demand.
writeFileSync(`${GEN}/api-stub.js`, `
export async function api(path) {
  const p = String(path);
  if (p.includes('/portal/readiness')) {
    globalThis.__readinessReads++;
    globalThis.__readinessPaths.push(p);
    if (globalThis.__failReadiness) throw new Error('readiness read failed (simulated)');
    // The slices=data change-probe gets the data slice PLUS canGenerate — like the real
    // route: readiness.js get() emits canGenerate whenever the data slice is requested,
    // so a data-only response is a shape the server cannot send (the phantom-fixture
    // class this file's WIRE CONTRACT note exists to prevent).
    if (/slices=data(&|$)/.test(p)) return { ok: true, json: async () => ({ data: globalThis.__readiness.data, canGenerate: globalThis.__readiness.canGenerate }) };
    return { ok: true, json: async () => globalThis.__readiness };
  }
  return { ok: true, json: async () => ({}) };
}
`);
// `generate`: a real svelte store at phase 'idle' so the pipeline-voice banner stays hidden.
writeFileSync(`${GEN}/generate-stub.js`, `
import { readable } from 'svelte/store';
export const generate = readable({ phase: 'idle' });
export const fmtSeconds = (s) => String(s);
export const retry = () => {};
`);
// The store — the REAL rune module, compiled. compileModule can't parse TS return annotations,
// so strip them (mount-onboarding-flow.mjs does the same for the guidance store).
const storeSrc = readFileSync(STORE, 'utf8').replace(/\)\s*:\s*(?:number|void)\s*\{/g, ') {');
writeFileSync(`${GEN}/store.js`, compileModule(storeSrc, { generate: 'client', filename: 'onboarding-data.svelte.ts' }).js.code);
// A minimal REAL child component (compiled), standing in for every <ImportField>/<ScanForData>/…
// the invite renders — they are not under test here, but must instantiate so the parent mounts.
writeFileSync(`${GEN}/child.js`, compile('<div data-stub-child></div>', { generate: 'client', name: 'StubChild', css: 'injected' }).js.code);

// ── The component under test: REAL source, only its leaf specifiers rewired ───────────────────
let js = compile(readFileSync(COMPONENT, 'utf8'), { generate: 'client', name: 'MindscapeInvite', css: 'injected' }).js.code
  .replace(/from ['"]\$lib\/api['"]/g, `from './api-stub.js'`)
  .replace(/from ['"]\$lib\/generate['"]/g, `from './generate-stub.js'`)
  .replace(/from ['"]\$lib\/stores\/onboarding-data\.svelte['"]/g, `from './store.js'`)
  .replace(/from ['"]\$lib\/components\/[^'"]+\.svelte['"]/g, `from './child.js'`)
  .replace(/from ['"]\$lib\/components\/settings\/[^'"]+\.svelte['"]/g, `from './child.js'`)
  .replace(/from ['"]\$lib\/components\/channels\/[^'"]+\.svelte['"]/g, `from './child.js'`);
writeFileSync(`${GEN}/Invite.js`, js);

const norm = () => document.body.textContent.replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => console.log(JSON.stringify(o));

try {
  const { mount, flushSync } = await import('svelte');
  const Invite = (await import(pathToFileURL(resolve(GEN, 'Invite.js')).href)).default;
  const { signalImportCompleted } = await import(pathToFileURL(resolve(GEN, 'store.js')).href);

  mount(Invite, { target: document.getElementById('host') });
  flushSync();
  await sleep(40);          // the mount-time readiness load
  flushSync();

  // Drive into the Data step — click the first invite card (its onclick sets step='data').
  const card = document.querySelectorAll('.invite-card')[0];
  if (card) { card.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); flushSync(); await sleep(20); }

  const out = { ok: true, probe: PROBE };

  if (PROBE === 'empty') {
    // G1 — a fresh vault shows the empty-state invitation, no evidence counts.
    out.text = norm();
    out.readsCount = globalThis.__readinessReads;
  } else if (PROBE === 'freshunknown') {
    // G9 — the fresh-machine unknown (no prior to hold). The Data step must show the honest
    // "couldn't read your vault" + Retry, and NEITHER the empty-state copy NOR a fabricated count.
    out.text = norm();
    out.hasRetry = [...document.querySelectorAll('button')].some((b) => /retry/i.test(b.textContent || ''));
    out.readsCount = globalThis.__readinessReads;
  } else if (PROBE === 'signal' || PROBE === 'focus') {
    // G2 / G2b — mounted EMPTY; capture the before, then FLIP the server fact and either fire the
    // cross-component signal or a window focus, and capture the after. The after must show the
    // evidence COUNTS and must have DROPPED the empty-state copy.
    out.before = norm();
    out.readsBefore = globalThis.__readinessReads;
    globalThis.__readiness = FULL;
    if (PROBE === 'signal') signalImportCompleted();
    else window.dispatchEvent(new dom.window.Event('focus'));
    flushSync();
    await sleep(DEBOUNCE_WAIT);
    flushSync();
    out.after = norm();
    out.readsAfter = globalThis.__readinessReads;
    out.paths = globalThis.__readinessPaths.slice();
  } else if (PROBE === 'control-absence') {
    // G3a — the harness can SEE ABSENCE: a string the component never contains must not be found
    // (validates the detection method the other gates rely on — an always-true regex is worthless).
    globalThis.__readiness = FULL;
    signalImportCompleted();
    flushSync(); await sleep(DEBOUNCE_WAIT); flushSync();
    out.text = norm();
  } else if (PROBE === 'control-silent') {
    // G3b — THE WIRE, NOT A POLL. Mounted EMPTY; FLIP the fact but fire NEITHER signal NOR focus.
    // The display must NOT update (no interval re-reads readiness), and no extra read must occur.
    out.before = norm();
    out.readsBefore = globalThis.__readinessReads;
    globalThis.__readiness = FULL;
    flushSync();
    await sleep(DEBOUNCE_WAIT + 200);   // past the debounce window too — a poll OR a stray armed timer would betray itself
    flushSync();
    out.after = norm();
    out.readsAfter = globalThis.__readinessReads;
  } else if (PROBE === 'flurry') {
    // G5 / MED-1 — mounted EMPTY, fact UNCHANGED; 5 focus events inside 200ms must collapse into
    // EXACTLY ONE readiness request, and that request must be the CHEAP change-probe
    // (slices=data), never the evidence aggregates. This is the debounce + probe-not-refresh cost
    // contract: a cmd-tab flurry over an unchanged vault costs one cached COUNT, zero scans.
    out.readsBefore = globalThis.__readinessReads;
    for (let i = 0; i < 5; i++) { window.dispatchEvent(new dom.window.Event('focus')); await sleep(40); }
    flushSync();
    await sleep(DEBOUNCE_WAIT + 200);
    flushSync();
    out.readsAfter = globalThis.__readinessReads;
    out.paths = globalThis.__readinessPaths.slice(1);   // drop the mount read; keep the flurry's
    out.after = norm();
  } else if (PROBE === 'hold') {
    // G4 / §3.2a — mounted FULL so the evidence renders; then make the readiness read FAIL and fire
    // the signal (which re-reads). The failed read must HOLD the last answer — the nonzero display
    // must NOT regress to the empty state.
    globalThis.__readiness = FULL;
    signalImportCompleted();
    flushSync(); await sleep(DEBOUNCE_WAIT); flushSync();
    out.beforeFail = norm();
    globalThis.__failReadiness = true;
    signalImportCompleted();
    flushSync();
    await sleep(DEBOUNCE_WAIT);
    flushSync();
    out.afterFail = norm();
  } else if (PROBE === 'unknown') {
    // G4b / §3.2a-the-FACT — the transport SUCCEEDS but the slice failed INSIDE the 200.
    // ⚠️ THE WIRE SHAPE, not the internal one: when the backlog read throws (SQLITE_BUSY
    // mid-import) the response's `data` is bare zeros — the `unknown` marker is stripped
    // server-side — and the failure is visible ONLY as canGenerate.reason === 'unknown'.
    // After a nonzero render, that answer must NOT regress the display — unknown is
    // "could not look", never "empty". (The previous fixture carried data.unknown, a shape
    // the server cannot emit; the gate was green while the real wire regressed the invite.)
    globalThis.__readiness = FULL;
    signalImportCompleted();
    flushSync(); await sleep(DEBOUNCE_WAIT); flushSync();
    out.beforeUnknown = norm();
    globalThis.__readiness = {
      data: { total: 0 },
      canGenerate: { ok: false, reason: 'unknown' },
      evidence: { unknown: true, sources: [], dateRange: { yearStart: null, yearEnd: null }, conversationCount: 0, peopleCount: 0 },
      ai: { connected: false },
      channel: { connected: false },
    };
    signalImportCompleted();
    flushSync();
    await sleep(DEBOUNCE_WAIT);
    flushSync();
    out.afterUnknown = norm();
    out.readsTotal = globalThis.__readinessReads;   // proves the unknown answer WAS fetched (not skipped)
  } else if (PROBE === 'focusunknown') {
    // G4c — the PROBE PATH under a wire-unknown. Mounted FULL (counts rendered), then the data
    // slice fails (WIRE shape: bare zeros + canGenerate.reason 'unknown') and a window FOCUS
    // fires. The cheap change-probe must read 'unknown' as "could not look": EXACTLY ONE probe
    // read, NO full evidence refresh (zeros-with-unknown are not a KNOWN changed total), display
    // holds. The dead-marker keying reads those zeros as a known total-0 (0 !== 847) and buys
    // the full evidence read every focus for the whole outage — the cost regression this pins.
    globalThis.__readiness = FULL;
    signalImportCompleted();
    flushSync(); await sleep(DEBOUNCE_WAIT); flushSync();
    out.beforeUnknown = norm();
    out.readsBefore = globalThis.__readinessReads;
    globalThis.__readiness = {
      data: { total: 0 },
      canGenerate: { ok: false, reason: 'unknown' },
      evidence: { unknown: true, sources: [], dateRange: { yearStart: null, yearEnd: null }, conversationCount: 0, peopleCount: 0 },
      ai: { connected: false },
      channel: { connected: false },
    };
    window.dispatchEvent(new dom.window.Event('focus'));
    flushSync();
    await sleep(DEBOUNCE_WAIT + 400);   // past BOTH debounce windows — a bought full refresh would land
    flushSync();
    out.afterUnknown = norm();
    out.readsAfter = globalThis.__readinessReads;
    out.paths = globalThis.__readinessPaths.slice();
  }
  emit(out);
} catch (e) {
  emit({ ok: false, probe: PROBE, error: String(e?.stack || e) });
} finally {
  rmSync(GEN, { recursive: true, force: true });
}
// Exit explicitly so a leaked timer cannot keep the event loop alive — a POLL mutation must
// FAIL the gate (updated display / extra reads), never HANG it. The JSON has already been emitted.
process.exit(0);

// Mounts IntelligenceScreen.svelte for REAL — real Svelte compiler, real DOM (jsdom), real
// change events, a stubbed `api` that RECORDS what the screen sends — and prints one JSON line
// for scripts/verify-intelligence-screen.mjs to assert on.
//
// WHY A MOUNT TEST AND NOT A SOURCE REGEX. This session proved twice that the cheap check is
// worthless here: (1) M6b regexed the component source and passed with the option COMMENTED
// OUT; (2) `vite build` passed with a deliberate SYNTAX ERROR in this very component, because
// an unimported component is not in the build graph at all. Only driving the real control
// catches the bugs that actually shipped.
//
// Run with: node --conditions browser portal-app/test/mount-intelligence-screen.mjs  (cwd=portal-app)
// The `browser` condition is REQUIRED: without it Node resolves svelte's SERVER build via the
// exports map and mount() throws lifecycle_function_unavailable. (Learned in mount-onbox-select.)
import { JSDOM } from 'jsdom';
import { compile, compileModule } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-mount-intel';
const SCREEN = 'src/lib/components/settings/IntelligenceScreen.svelte';
const SELECT = 'src/lib/components/settings/OnboxTaskSelect.svelte';
// The whisper rail moved INTO the screen's Transcription row (Part I §9) — it is part of
// the mounted tree now, so it compiles like the select child. Its api calls hit the stub.
const TRANS = 'src/lib/components/settings/TranscriptionSetup.svelte';

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
// Svelte's client runtime reads DOM globals at module init, so they must exist BEFORE
// svelte/internal/client is imported. `navigator` is getter-only in Node 22 — hence try/catch.
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (k in globalThis) continue;
  try { globalThis[k] = dom.window[k]; } catch { /* getter-only global — jsdom's is fine */ }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// ── The spine — THE REAL CONSTANT, not a mirror of it ────────────────────────────────────
// Imported from src/inference/role-models.js (a frozen, side-effect-free leaf) so the fixture
// CANNOT drift from what the server serves. An earlier version hand-copied it, and the gate's
// banner claimed "from the served spine" while testing a hardcoded list one level removed
// (independent review, 2026-07-16). P10b pins that the ROUTE serves this same constant, so the
// two gates together cover "the screen renders what the server actually sends".
const { INTELLIGENCE_FUNCTIONS } = await import('../../src/inference/role-models.js');
const FUNCTIONS = INTELLIGENCE_FUNCTIONS;
// Providers as publicRow ACTUALLY serves them — `jurisdiction` computed server-side by
// presets.js jurisdictionForBaseUrl. The corpus deliberately spans every jurisdiction so the
// screen's rendering is tested against a realistic mix, not a clean one. Since 2026-07-19 narrate
// is NOT §4g-sensitive, so Descriptions (jurisdiction 'any') must offer EVERY one of these,
// exactly like Conversation — including the US and subscription rows.
const PROVIDERS = [
  { id: 1, label: 'Regolo (EU)', provider: 'custom', is_active: 1, base_url: 'https://api.regolo.ai/v1', jurisdiction: 'eu-zdr' },
  { id: 2, label: 'OpenAI (US)', provider: 'openai', is_active: 0, base_url: 'https://api.openai.com/v1', jurisdiction: 'us-standard' },
  { id: 3, label: 'Lookalike (US)', provider: 'custom', is_active: 0, base_url: 'https://localhost.attacker.io/v1', jurisdiction: 'us-standard' },
  { id: 4, label: 'Ollama (local)', provider: 'custom', is_active: 0, base_url: 'http://127.0.0.1:11434', jurisdiction: 'local' },
  // The user's OWN Claude subscription (US). It used to be offered to Descriptions ONLY under the
  // §4g exemption; now Descriptions is 'any', so it is offered like any other provider.
  { id: 5, label: 'Claude (subscription)', provider: 'anthropic', is_active: 0, auth_type: 'oauth', jurisdiction: 'us-standard' },
];
// PROBE=exempt flips the (now Descriptions-irrelevant) subscription opt-in ON. The gate drives
// this to prove the exemption no longer GATES Descriptions — with narrate non-sensitive, the row
// offers every provider whether the flag is on or off. The toggle still governs the claims path
// (sensitive:true), which this screen does not surface.
const EXEMPT = process.env.PROBE === 'exempt';
// PROBE=poll — the stale-badge fix (2026-07-18): approve must REFETCH the models slice, then
// poll ONLY while a member is unsettled, and STOP (zero further fetches) once settled. The
// fixture is a mutable PHASE the driver advances: initial (settled, nothing approved) →
// busy (a download in flight) → settled (everything ok). Every readiness URL is recorded so
// the gate can also pin that the poll buys ONLY the models slice.
const POLL = process.env.PROBE === 'poll';
let pollPhase = 'initial';
const readinessUrls = [];

// ── D-075 fixture: the two selections the screen must tell apart ─────────────────────────────
// taskModels carries ONE explicit assignment (chat → OpenAI, id 2). narrate has NONE — the
// resolver falls back to the vault's ACTIVE provider, the Claude subscription (id 5). That is
// the exact shape #360 (D-029) produces: connect a subscription and it serves chat + narration
// WITHOUT writing taskModels. The pre-fix screen highlighted from taskModels alone, so the
// Narration row showed nothing selected while narrate was already running on Claude.
// PROBE=divergent — the pin that CANNOT run. narrate is explicitly pinned to provider 1 while
// the resolver still reports provider 5 as effective, which is exactly what happens when the
// pinned row is unresolvable (deleted, or status='pending' from a vault import — resolve.js
// falls through to the active provider). The screen must show BOTH facts: the pin, and that it
// isn't what runs. Keying the highlight on the resolver alone rendered the pin unlit and turned
// its click into a silent clear (independent review, MED).
const DIVERGENT = process.env.PROBE === 'divergent';
// PROBE=noeff — the effective-models read FAILS (500 / an older backend with no such route / a
// transient blip). The screen must render UNKNOWN, not "nothing runs": with a pin present, the
// collapsed version painted the pinned provider amber and tagged it "chosen · not running",
// fabricating a fault, and the obvious click then DELETED the pin (independent review ×2, HIGH).
const NO_EFFECTIVE = process.env.PROBE === 'noeff';
const TASK_MODELS = DIVERGENT
  ? { chat: { providerId: 2 }, narrate: { providerId: 1 } }
  : { chat: { providerId: 2 } };
// Mutable server-side copy, so the PUT stub can merge into it the way the real route does.
let liveTaskModels = { ...TASK_MODELS };
// What the RESOLVER says (GET /portal/providers/effective-models → resolveEffectiveAssignment).
// Deliberately NOT derivable from TASK_MODELS: narrate names a provider that appears nowhere in
// it, so a screen that recomputed the selection locally cannot produce this answer.
const EFFECTIVE = {
  chat:       { source: 'explicit', providerId: 2, model: 'gpt-4o' },
  narrate:    { source: 'active',   providerId: 5, model: null },
  harness:    { source: 'active',   providerId: 5, model: null },
  reflection: { source: 'active',   providerId: 5, model: null },
};

const sent = [];   // every write the screen makes — the behavioural evidence
globalThis.__apiStub = async (path, options = {}) => {
  if (options.method === 'PUT') {
    const body = JSON.parse(options.body);
    sent.push({ path, body });
    // ⚠️ MERGE, don't replace — this mirrors applyTaskModelWrite (src/portal-providers.js), which
    // copies existing settings.taskModels and edits only the written function's tasks.
    //
    // The first version of this stub returned a FIXED {categorize, enrich} object. Because the
    // driver approves Understanding first, every later provider click saw taskModels wiped, so
    // `explicitId` was always undefined and the write path's actual key was NEVER exercised: a
    // mutation removing the un-pin branch entirely (`assign(f, p.id)`) left both gates GREEN
    // (independent review, MED). A fixture that is more forgiving than the product is a gate
    // with no teeth on the difference.
    //
    // ⚠️ KNOWN LIMITATIONS — this imitates applyTaskModelWrite's MERGE semantics, which is what
    // the write-path checks need, but it is still MORE PERMISSIVE than the real route in ways a
    // broken write path could hide behind (independent review ×2, LOW). It does not: reject a
    // body carrying BOTH `task` and `function`; validate the function key against the served
    // spine; refuse an unknown/absent providerId row; distinguish ONBOX tasks (which store a
    // model NAME, not a providerId); or fail the request atomically. Those are gated
    // server-side by verify:task-models and verify:intelligence-bundle — this harness proves the
    // CLIENT sends the right shape, not that the server validates it. Do not add a client check
    // that depends on validation this stub does not perform.
    const tm = { ...liveTaskModels };
    const fnTasks = { understanding: ['categorize', 'enrich'], conversation: ['chat', 'harness', 'reflection'], descriptions: ['narrate'], transcription: ['transcribe'], voice: ['speak'] };
    for (const t of (fnTasks[body.function] || [])) {
      if (body.providerId != null) tm[t] = { providerId: body.providerId };
      else if (body.model) tm[t] = { model: body.model };
      else delete tm[t];                                  // clear ⇒ NOT approved / falls back
    }
    liveTaskModels = tm;
    return { ok: true, json: async () => ({ taskModels: tm }) };
  }
  // ⚠️ SPECIFIC PATHS BEFORE THE GENERAL PREFIX: '/portal/providers' startsWith-matches
  // '/portal/providers/sensitive-subscription' too, and would swallow it.
  if (path.startsWith('/portal/providers/sensitive-subscription')) {
    return { ok: true, json: async () => ({ allowed: EXEMPT }) };
  }
  // The moved whisper rail (TranscriptionSetup) — a quiet, non-downloading fixture so the
  // Transcription row renders its own catalog instead of the old "Set up below" pointer.
  if (path.startsWith('/portal/transcription/status')) {
    return { ok: true, json: async () => ({ ok: true, health: { status: 'no_model', message: null, progress: null }, model: null, catalog: [
      { model: 'large-v3-turbo', label: 'Whisper large-v3 turbo', sizeMB: 1620, blurb: 'Best quality', recommended: true },
      { model: 'small', label: 'Whisper small', sizeMB: 480, blurb: 'Light and fast', recommended: false },
    ] }) };
  }
  if (path.startsWith('/portal/providers/presets')) return { ok: true, json: async () => ({ functions: FUNCTIONS }) };
  // ⚠️ BEFORE the generic '/portal/providers' prefix, which would otherwise swallow it.
  if (path.startsWith('/portal/providers/effective-models')) {
    // A real failure shape: r.ok false, and a body the screen must not mine for an answer.
    if (NO_EFFECTIVE) return { ok: false, status: 500, json: async () => ({ ok: false, error: 'failed to resolve the effective model selection' }) };
    return { ok: true, json: async () => ({ ok: true, effective: EFFECTIVE }) };
  }
  if (path.startsWith('/portal/providers/task-models')) return { ok: true, json: async () => ({ taskModels: TASK_MODELS }) };
  if (path.startsWith('/portal/providers')) return { ok: true, json: async () => ({ providers: PROVIDERS }) };
  // ⚠️ DISCRIMINATING ON PURPOSE: labeler ok / enricher no_model. Understanding owns BOTH tasks,
  // so it must show the WORSE of them — if it showed only the labeler it would report "Labeling
  // with qwen" over a vault whose L2 is dead, which is the dormancy this round exists to end.
  if (path.startsWith('/portal/readiness')) {
    if (POLL) {
      readinessUrls.push(path);
      const M = (labeler) => ({ models: { labeler, enricher: labeler, embedder: { status: 'ok', message: 'Ready.', model: null, progress: null } } });
      const byPhase = {
        // settled AND consistent with "nothing approved": no poll may start at mount.
        initial: M({ status: 'no_model', message: 'No labeling model approved.', model: null, progress: null }),
        busy: M({ status: 'downloading', message: 'Downloading qwen3.5:4b…', model: 'qwen3.5:4b', progress: { pct: 40 } }),
        // settled AND consistent with the approval the driver made: the poll must STOP here.
        settled: M({ status: 'ok', message: 'Labeling with qwen3.5:4b.', model: 'qwen3.5:4b', progress: null }),
      };
      const body = byPhase[pollPhase];
      return { ok: true, json: async () => body };
    }
    return { ok: true, json: async () => ({ models: { labeler: { status: 'ok', message: 'Labeling with qwen3.5:4b.', model: 'qwen3.5:4b', progress: null }, enricher: { status: 'no_model', message: 'No enrich model approved.', model: null, progress: null }, embedder: { status: 'ok', message: 'Ready.', model: null, progress: null } } }) };
  }
  return { ok: true, json: async () => ({}) };
};

// Compile both components. The screen imports `$lib/api` and './OnboxTaskSelect.svelte', neither
// of which the bare compiler resolves — so rewrite those specifiers in the GENERATED js:
// `api` → the recording stub above; the child → its own compiled file.
mkdirSync(GEN, { recursive: true });
// The shared §4g store is a RUNE MODULE (.svelte.ts) — it must go through the compiler too, or
// its $state is inert. The screen still reads it (load() seeds it), even though no function
// depends on it now, so keep compiling it so the mount matches production exactly.
const storeSrc = readFileSync('src/lib/stores/sensitive-exempt.svelte.ts', 'utf8')
  .replace(/:\s*boolean/g, '').replace(/export function setSensitiveExempt\(allowed\)/, 'export function setSensitiveExempt(allowed)');
const storeOut = compileModule(storeSrc, { generate: 'client', filename: 'sensitive-exempt.svelte.ts' });
writeFileSync(`${GEN}/sensitive-exempt.gen.js`, storeOut.js.code);
const child = compile(readFileSync(SELECT, 'utf8'), { generate: 'client', name: 'OnboxTaskSelect', css: 'injected' });
writeFileSync(`${GEN}/OnboxTaskSelect.gen.js`, child.js.code);
const transChild = compile(readFileSync(TRANS, 'utf8'), { generate: 'client', name: 'TranscriptionSetup', css: 'injected' });
writeFileSync(`${GEN}/TranscriptionSetup.gen.js`, transChild.js.code
  .replace(/import\s+\{\s*api\s*\}\s+from\s+['"]\$lib\/api['"];?/, 'const api = (...a) => globalThis.__apiStub(...a);'));
// VoiceSection folded UNDER the Voice function row (Phase 3) — a MARKER STUB here (its internals
// are gated by verify:tts-voice / mount-voice-section); this harness asserts the row EXISTS.
const voiceStub = compile('<div data-stub="VoiceSection"></div>', { generate: 'client', name: 'VoiceSection', css: 'injected' });
writeFileSync(`${GEN}/VoiceSection.gen.js`, voiceStub.js.code);
// EngineSelector folded INTO the Conversation function row (2026-07-19) — a MARKER STUB here (its
// own behaviour is gated by verify:harness-connect); this harness asserts nothing about it.
const engineStub = compile('<div data-stub="EngineSelector"></div>', { generate: 'client', name: 'EngineSelector', css: 'injected' });
writeFileSync(`${GEN}/EngineSelector.gen.js`, engineStub.js.code);
const screen = compile(readFileSync(SCREEN, 'utf8'), { generate: 'client', name: 'IntelligenceScreen', css: 'injected' });
const rewired = screen.js.code
  .replace(/import\s+\{\s*api\s*\}\s+from\s+['"]\$lib\/api['"];?/, 'const api = (...a) => globalThis.__apiStub(...a);')
  .replace(/from\s+['"]\.\/OnboxTaskSelect\.svelte['"]/, `from './OnboxTaskSelect.gen.js'`)
  .replace(/from\s+['"]\.\/TranscriptionSetup\.svelte['"]/, `from './TranscriptionSetup.gen.js'`)
  .replace(/from\s+['"]\.\/VoiceSection\.svelte['"]/, `from './VoiceSection.gen.js'`)
  .replace(/from\s+['"]\.\/EngineSelector\.svelte['"]/, `from './EngineSelector.gen.js'`)
  .replace(/from\s+['"]\$lib\/stores\/sensitive-exempt\.svelte['"]/, `from './sensitive-exempt.gen.js'`);
writeFileSync(`${GEN}/IntelligenceScreen.gen.js`, rewired);

const emit = (o) => console.log(JSON.stringify(o));
try {
  const { default: Screen } = await import(pathToFileURL(resolve(GEN, 'IntelligenceScreen.gen.js')).href);
  const { mount, flushSync } = await import('svelte');
  mount(Screen, { target: dom.window.document.getElementById('host') });
  flushSync();
  await new Promise((r) => setTimeout(r, 60));   // onMount's async load()
  flushSync();

  const D = dom.window.document;

  // ── PROBE=poll: the stale-badge fix, driven at its own timescale ─────────────────────────
  // (Its own probe because it takes ~15s of real timer time; the default probe stays fast.)
  if (POLL) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const afterMount = readinessUrls.length;
    await wait(2500);                                  // > one poll interval
    const preApprove = readinessUrls.length;           // settled at mount ⇒ NO poll may have run
    const psel = D.querySelector('select');
    psel.value = 'qwen3.5:4b';
    psel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    flushSync();
    await wait(150);                                   // write + immediate refetch, < one tick
    const afterApprove = readinessUrls.length;
    pollPhase = 'busy';                                // the drainer is now visibly downloading
    await wait(5200);                                  // room for ≥2 ticks
    const afterBusyWindow = readinessUrls.length;
    pollPhase = 'settled';                             // download done, health consistent with the approval
    await wait(3000);                                  // the settling tick lands and the poll stops
    const w1 = readinessUrls.length;
    await wait(4500);                                  // two more would-be ticks…
    const w2 = readinessUrls.length;                   // …which must buy ZERO fetches (the cost gate)
    emit({ ok: true, poll: { afterMount, preApprove, afterApprove, afterBusyWindow, w1, w2, urls: readinessUrls } });
    process.exit(0);
  }

  const text = D.body.textContent.replace(/\s+/g, ' ');
  const sections = [...D.querySelectorAll('section.fn')];

  // ── D-075: what the screen SAYS is selected, captured before any control is driven ───────
  // Reported per function row as {label, on:[…], auto:[…]} so the gate can compare it against
  // the resolver's answer instead of against a string.
  const pickState = sections.map((sec) => ({
    label: sec.querySelector('strong')?.textContent?.trim(),
    on: [...sec.querySelectorAll('button.pick.on')].map((b) => b.textContent.trim()),
    auto: [...sec.querySelectorAll('button.pick.auto')].map((b) => b.textContent.trim()),
    pinned: [...sec.querySelectorAll('button.pick.pinned')].map((b) => b.textContent.trim()),
    all: [...sec.querySelectorAll('button.pick')].map((b) => b.textContent.trim()),
  })).filter((r) => r.all.length);
  // How many writes had happened by the time the screen finished rendering — i.e. writes caused
  // by RENDERING, before the driver touches anything. Must be 0 in every probe.
  const sentAtSnapshot = sent.length;

  // Drive the REAL control: approve Understanding's recommendation.
  const sel = D.querySelector('select');
  if (sel) {
    sel.value = 'qwen3.5:4b';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    flushSync();
    await new Promise((r) => setTimeout(r, 30));
  }

  // The Narration section (the `descriptions` function; DISPLAY label renamed Descriptions →
  // Narration, IM-1 2026-07-20 — the function key + narrate task are UNCHANGED) + its provider
  // buttons — the whole point of the 2026-07-19 change: it must offer EVERY provider, print no
  // limit, and reach no dead-end. Locate by the "★ recommended for Narration" reason line, which
  // is unique to this row and stable across the rename.
  const descSection = [...D.querySelectorAll('section.fn')].find((s) => /Narration/.test(s.textContent));
  const descText = descSection?.textContent || '';
  const descButtons = [...(descSection?.querySelectorAll('button.pick') || [])];
  const descButtonLabels = descButtons.map((b) => b.textContent.trim());

  // Drive the PROVIDER buttons too. S2b: a provider button must SEND its provider, not clear the
  // assignment. The first button is Regolo (EU) — providerId 1.
  const beforeProviderClicks = sent.length;
  if (descButtons[0]) {
    descButtons[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    flushSync();
    await new Promise((r) => setTimeout(r, 30));
  }
  const providerSent = sent.slice(beforeProviderClicks).map((s) => s.body);

  // ── D-075: click the AUTO-SELECTED button itself ──────────────────────────────────────────
  // The one click that separates "display the effective selection" from "toggle it". The
  // Narration row's Claude button is lit because the RESOLVER says Claude serves narrate, not
  // because anything is stored — so this click must PIN it (providerId 5). A screen that keyed
  // its toggle on the effective value would send providerId:null ("clear"), i.e. a lit button
  // whose click does nothing observable. Without this drive the mutation passes: the earlier
  // click lands on Regolo, which is NOT the effective provider, so both rules agree there.
  const autoBtn = descSection?.querySelector('button.pick.on');
  const beforeAutoClick = sent.length;
  if (autoBtn) {
    autoBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    flushSync();
    await new Promise((r) => setTimeout(r, 30));
  }
  const autoPinSent = sent.slice(beforeAutoClick).map((s) => s.body);

  // ── The UN-PIN path: click the SAME button again ──────────────────────────────────────────
  // After the click above, narrate is explicitly pinned to provider 5 (the stub merged it, as
  // the real route does). Clicking it once more must CLEAR the pin — providerId:null — which is
  // the only way a user un-does a choice. Nothing covered this before: with the old
  // replace-everything stub the component never held a non-empty explicit id at click time, so a
  // mutation deleting the un-pin branch passed (see the stub note above).
  const rePin = descSection?.querySelector('button.pick.pinned') || descSection?.querySelector('button.pick.on');
  const beforeUnpin = sent.length;
  if (rePin) {
    rePin.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    flushSync();
    await new Promise((r) => setTimeout(r, 30));
  }
  const unpinSent = sent.slice(beforeUnpin).map((s) => s.body);

  emit({
    ok: true,
    // D-075 — the rendered selection per row, and the fixture it must agree with.
    pickState,
    // Writes caused by RENDERING alone (pre-drive). Always 0 — display is never a write.
    sentAtSnapshot,
    // H1 — the honest "we could not check" line (absent when the run-state IS known).
    unknownRunNotes: [...D.querySelectorAll('.unknown-run')].map((n) => n.textContent.trim()),
    // …and what clicking the AUTO-selected provider sends (pin, never clear).
    autoPinSent,
    // …and what clicking the now-PINNED provider sends (clear — the un-pin path).
    unpinSent,
    effectiveFixture: EFFECTIVE,
    taskModelsFixture: TASK_MODELS,
    // What the PROVIDER button actually sends — it must identify its provider.
    providerSent,
    // ── Descriptions is now jurisdiction 'any' (§4g limit lifted) ──────────────────────────
    descriptionsButtonLabels: descButtonLabels,
    descriptionsOffersUS: /OpenAI \(US\)/.test(descText),
    descriptionsOffersEU: /Regolo \(EU\)/.test(descText),
    descriptionsOffersSubscription: /Claude \(subscription\)/.test(descText),
    // The false-privacy copy the operator removed must NOT render, and there is no dead-end
    // because every provider is offerable.
    descriptionsStatesLimit: /stay in the EU or on your device/.test(text),
    descriptionsPrintsDeadEnd: /Connect an EU or on-device model/.test(descText),
    // Every §3.11b row rendered — from the SERVED spine, not a hardcoded list.
    renderedKeys: sections.length,
    labels: sections.map((s) => s.querySelector('strong')?.textContent?.trim()),
    // Understanding drives a real <select> carrying the recommendation.
    understandingHasSelect: !!sel,
    recommendationSelectable: sel ? [...sel.options].some((o) => o.value === 'qwen3.5:4b') : false,
    offOptionIsEmpty: sel ? [...sel.options].some((o) => o.value === '' && /off/i.test(o.textContent)) : false,
    // THE dormancy fix: the screen must send {function}, never {task}.
    sentBodies: sent.map((s) => s.body),
    // §3.10d-c: the bundled embedder renders as "Included", never as a picker.
    searchSaysIncluded: /Included · nomic-v1\.5/.test(text),
    searchHasNoControl: !(sections.find((s) => /Search/.test(s.textContent))?.querySelector('select,button.pick')),
    // §3.11c: recommendation-FIRST — every card carries its reason.
    everyCardHasWhy: sections.every((s) => !!s.querySelector('.why')?.textContent?.trim()),
    // Honest states: a choice is not a fault.
    understandingHealth: sections.find((s) => /Labeling/.test(s.textContent))?.querySelector('.health')?.textContent?.trim(),
  });
  // The screen may now hold a live while-unsettled poll (the driven approve leaves the
  // enricher LAGGING in this fixture) — exit explicitly so the interval cannot keep node
  // alive until the gate's timeout (the mount-intelligence-flow precedent).
  process.exit(0);
} catch (e) {
  emit({ ok: false, error: String(e?.stack || e) });
  process.exit(0);
}

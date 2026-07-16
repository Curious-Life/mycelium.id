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
// presets.js jurisdictionForBaseUrl. The lookalike is the one that matters: the first version
// classified it client-side with an unanchored regex and offered it to a §4g-limited function.
// It is included so the filter is tested against the case that really broke it, not a clean one.
const PROVIDERS = [
  { id: 1, label: 'Regolo (EU)', provider: 'custom', is_active: 1, base_url: 'https://api.regolo.ai/v1', jurisdiction: 'eu-zdr' },
  { id: 2, label: 'OpenAI (US)', provider: 'openai', is_active: 0, base_url: 'https://api.openai.com/v1', jurisdiction: 'us-standard' },
  { id: 3, label: 'Lookalike (US)', provider: 'custom', is_active: 0, base_url: 'https://localhost.attacker.io/v1', jurisdiction: 'us-standard' },
  { id: 4, label: 'Ollama (local)', provider: 'custom', is_active: 0, base_url: 'http://127.0.0.1:11434', jurisdiction: 'local' },
  // The user's OWN Claude subscription: US, but §4g-exemptible — the one US provider the router
  // will run a sensitive task on, and ONLY with the explicit opt-in (resolve.js).
  { id: 5, label: 'Claude (subscription)', provider: 'anthropic', is_active: 0, auth_type: 'oauth', jurisdiction: 'us-standard' },
];
// Flip via PROBE=exempt — the gate drives BOTH configurations, because the screen's §4g rule is
// only equivalent to the router's if it honours the exemption clause too.
const EXEMPT = process.env.PROBE === 'exempt';
// The vault whose ONLY provider is the Claude subscription: the sole configuration in which
// offerable() can be empty for Descriptions, and therefore the only one that reaches the
// dead-end. Without it, asserting "no dead-end" tests a branch that never runs.
const NO_EU = process.env.PROBE === 'softfail-noeu';
// PROBE=noeu-known — the §4g flag reads FINE and says not-exempt, and the vault has no EU/local
// provider. This is the one state where the dead-end is the TRUE thing to say, and no probe
// reached it: deleting the guidance entirely left the gate GREEN, restoring the dead row the fix
// exists to prevent (independent review ×7, 2026-07-16). Assert the positive case, not only the
// negative.
const NO_EU_KNOWN = process.env.PROBE === 'noeu-known';

const sent = [];   // every write the screen makes — the behavioural evidence
globalThis.__apiStub = async (path, options = {}) => {
  if (options.method === 'PUT') {
    sent.push({ path, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ taskModels: { categorize: { model: 'qwen3.5:4b' }, enrich: { model: 'qwen3.5:4b' } } }) };
  }
  // ⚠️ SPECIFIC PATHS BEFORE THE GENERAL PREFIX: '/portal/providers' startsWith-matches
  // '/portal/providers/sensitive-subscription' too, and swallowed it — so the screen read
  // `allowed: undefined` and the exempt probe silently tested the non-exempt path.
  if (path.startsWith('/portal/providers/sensitive-subscription')) {
    // PROBE=softfail: the ONE read that decides the §4g guarantee fails. Before the fix the
    // setter never fired, `allowed` stayed at its false default, and the screen printed the
    // opt-in-OFF privacy claim PERMANENTLY on an exempt vault (independent review ×4).
    if (process.env.PROBE === 'softfail' || NO_EU) return { ok: false, status: 503, json: async () => ({ ok: false }) };
    if (NO_EU_KNOWN) return { ok: true, json: async () => ({ allowed: false }) };   // known, and NOT exempt
    return { ok: true, json: async () => ({ allowed: EXEMPT }) };
  }
  if (path.startsWith('/portal/providers/presets')) return { ok: true, json: async () => ({ functions: FUNCTIONS }) };
  if (path.startsWith('/portal/providers/task-models')) return { ok: true, json: async () => ({ taskModels: {} }) };
  if (path.startsWith('/portal/providers')) return { ok: true, json: async () => ({ providers: (NO_EU || NO_EU_KNOWN) ? PROVIDERS.filter((p) => p.auth_type === 'oauth') : PROVIDERS }) };
  // ⚠️ DISCRIMINATING ON PURPOSE: labeler ok / enricher no_model. Understanding owns BOTH tasks,
  // so it must show the WORSE of them — if it showed only the labeler it would report "Labeling
  // with qwen" over a vault whose L2 is dead, which is the dormancy this round exists to end.
  // The earlier fixture had both members no_model, so S7 passed either way and the claim was
  // unpinned (independent review, 2026-07-16).
  if (path.startsWith('/portal/readiness')) return { ok: true, json: async () => ({ models: { labeler: { status: 'ok', message: 'Labeling with qwen3.5:4b.', model: 'qwen3.5:4b', progress: null }, enricher: { status: 'no_model', message: 'No enrich model approved.', model: null, progress: null }, embedder: { status: 'ok', message: 'Ready.', model: null, progress: null } } }) };
  return { ok: true, json: async () => ({}) };
};

// Compile both components. The screen imports `$lib/api` and './OnboxTaskSelect.svelte', neither
// of which the bare compiler resolves — so rewrite those specifiers in the GENERATED js:
// `api` → the recording stub above; the child → its own compiled file.
mkdirSync(GEN, { recursive: true });
// The shared §4g store is a RUNE MODULE (.svelte.ts) — it must go through the compiler too, or
// its $state is inert and the live-flip probe would silently test nothing.
const storeSrc = readFileSync('src/lib/stores/sensitive-exempt.svelte.ts', 'utf8')
  .replace(/:\s*boolean/g, '').replace(/export function setSensitiveExempt\(allowed\)/, 'export function setSensitiveExempt(allowed)');
const storeOut = compileModule(storeSrc, { generate: 'client', filename: 'sensitive-exempt.svelte.ts' });
writeFileSync(`${GEN}/sensitive-exempt.gen.js`, storeOut.js.code);
const child = compile(readFileSync(SELECT, 'utf8'), { generate: 'client', name: 'OnboxTaskSelect', css: 'injected' });
writeFileSync(`${GEN}/OnboxTaskSelect.gen.js`, child.js.code);
const screen = compile(readFileSync(SCREEN, 'utf8'), { generate: 'client', name: 'IntelligenceScreen', css: 'injected' });
const rewired = screen.js.code
  .replace(/import\s+\{\s*api\s*\}\s+from\s+['"]\$lib\/api['"];?/, 'const api = (...a) => globalThis.__apiStub(...a);')
  .replace(/from\s+['"]\.\/OnboxTaskSelect\.svelte['"]/, `from './OnboxTaskSelect.gen.js'`)
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
  const text = D.body.textContent.replace(/\s+/g, ' ');
  const sections = [...D.querySelectorAll('section.fn')];

  // Drive the REAL control: approve Understanding's recommendation.
  const sel = D.querySelector('select');
  if (sel) {
    sel.value = 'qwen3.5:4b';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    flushSync();
    await new Promise((r) => setTimeout(r, 30));
  }

  // Drive the PROVIDER buttons too. S2 only ever drove the <select>, so 4 of 6 rows had no gate
  // on their write path — which is exactly where both HIGHs hid (independent review).
  const descSection = [...D.querySelectorAll('section.fn')].find((s) => /Descriptions/.test(s.textContent));
  const descButtons = [...(descSection?.querySelectorAll('button.pick') || [])];
  const beforeProviderClicks = sent.length;
  if (descButtons[0]) {
    descButtons[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    flushSync();
    await new Promise((r) => setTimeout(r, 30));
  }
  const providerSent = sent.slice(beforeProviderClicks).map((s) => s.body);

  // ⭐ THE STALE-PROMISE REGRESSION. AISettings owns the §4g toggle and is mounted as a SIBLING
  // in this same pane. Flipping it must re-render THIS screen's guarantee — when the flag was a
  // private onMount snapshot, the copy kept claiming "EU or on your device" while the router
  // already sent narrate to us-standard, one scroll away (independent review ×3).
  // Snapshot everything the OFF-configuration assertions need, BEFORE mutating shared state.
  const preFlip = {
    text: D.body.textContent.replace(/\s+/g, ' '),
    descText: [...D.querySelectorAll('section.fn')].find((s) => /Descriptions/.test(s.textContent))?.textContent || '',
    descButtons: [...([...D.querySelectorAll('section.fn')].find((s) => /Descriptions/.test(s.textContent))?.querySelectorAll('button.pick') || [])].map((b) => b.textContent.trim()),
  };
  const { setSensitiveExempt } = await import(pathToFileURL(resolve(GEN, 'sensitive-exempt.gen.js')).href);
  const descOf = () => [...D.querySelectorAll('section.fn')].find((s) => /Descriptions/.test(s.textContent));
  const descButtonsNow = () => [...(descOf()?.querySelectorAll('button.pick') || [])].map((b) => b.textContent.trim());
  const beforeFlip = {
    descOffersSubscription: descButtonsNow().some((l) => /Claude \(subscription\)/.test(l)),
    saysException: /except.*Claude subscription/is.test(D.body.textContent.replace(/\s+/g, ' ')),
  };
  setSensitiveExempt(true);
  flushSync();
  const afterFlipText = D.body.textContent.replace(/\s+/g, ' ');
  const afterFlip = {
    descOffersSubscription: descButtonsNow().some((l) => /Claude \(subscription\)/.test(l)),
    saysException: /except.*Claude subscription/is.test(afterFlipText),
    stillClaimsEuOnly: /stay in the EU or on your device\. Models outside/.test(afterFlipText),
  };

  emit({
    ok: true,
    liveToggle: { beforeFlip, afterFlip },
    // When the flag is UNKNOWN the screen must claim nothing — neither the EU-only promise nor
    // the exception. "Checking…" is the only honest thing to print.
    claimsWhileUnknown: {
      printsEuOnly: /stay in the EU or on your device\. Models outside/.test(preFlip.text),
      printsChecking: /Checking where they’re allowed to run/.test(preFlip.text),
      printsException: /except.*Claude subscription/is.test(preFlip.text),
      // ⭐ THE BEHAVIOUR, not the sentence. While the §4g flag is unknown the screen must render
      // NO provider list and NO dead-end for Descriptions — offerable() would hide the user's own
      // subscription, and the empty-list branch would then tell an exempt vault to "Connect an EU
      // or on-device model": connect the thing you already have and may use.
      descButtonCount: preFlip.descButtons.length,
      descButtonLabels: preFlip.descButtons,
      printsDeadEnd: /Connect an EU or on-device model/.test(preFlip.descText),
    },
    // What the PROVIDER button actually sends — it must identify its provider.
    providerSent,
    descriptionsButtonLabels: preFlip.descButtons,
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
    // §3.11d: an eu-or-local function must not OFFER a US provider, and must say why.
    // ⚠️ ALL PRE-FLIP: the live-flip probe below mutates shared state, so these must describe
    // the opt-in-OFF configuration S4c asserts on. Reading them after the flip made S4c fail for
    // a reason unrelated to its claim — a probe must not contaminate its neighbours.
    descriptionsOffersUS: /OpenAI \(US\)/.test(preFlip.descText),
    descriptionsOffersEU: /Regolo \(EU\)/.test(preFlip.descText),
    descriptionsStatesLimit: /stay in the EU or on your device/.test(preFlip.text),
    descriptionsOffersSubscription: /Claude \(subscription\)/.test(preFlip.descText),
    limitMentionsException: /except.*Claude subscription/is.test(preFlip.text),
    // §3.11c: recommendation-FIRST — every card carries its reason.
    everyCardHasWhy: sections.every((s) => !!s.querySelector('.why')?.textContent?.trim()),
    // Honest states: a choice is not a fault.
    understandingHealth: sections.find((s) => /Understanding/.test(s.textContent))?.querySelector('.health')?.textContent?.trim(),
  });
} catch (e) {
  emit({ ok: false, error: String(e?.stack || e) });
}

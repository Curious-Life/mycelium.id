// Mounts the REAL OnboardingFlow.svelte and COUNTS whether the un-dismiss signal makes it
// re-read `dismissed`. Run: node --conditions browser portal-app/test/mount-onboarding-flow.mjs
// (cwd = portal-app). Without --conditions browser, svelte resolves its server exports map and
// mount() throws lifecycle_function_unavailable (see mount-onbox-select.mjs:15).
//
// ⚠️ WHY A MOUNT AND NOT A REGEX. U3's source-regex predecessor passed with the real
// `void refresh()` DELETED and replaced by a trailing `// TODO: should call refresh() here` —
// because the comment-stripper only removed FULL-LINE `//` comments. A gate written to stop
// comment-satisfaction, satisfied by a comment. It also passed with the effect body wrapped in
// `if (false) { … }` and with the import deleted (a runtime ReferenceError). Three ways to a
// dead feature, all green (independent review MED-2, 2026-07-16).
// The property is LIVENESS — "the signal reaches the rail" — and only running it can see that.
//
// The bug this defends: OnboardingFlow's only re-read of `dismissed` is
//   `else if (railVisible) refresh()` where `railVisible` requires `!dismissed`
// — the one path that can clear the flag is GATED ON the flag. So "Show setup guidance again"
// wrote the DB, said it worked, and changed nothing until the app was RESTARTED.
import { compile, compileModule } from 'svelte/compiler';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const S_WAIT = process.env.FLIP_GENERATED === '1' || process.env.UNKNOWN_AFTER_FIRST_READ === '1';
const GEN = '.gen-mount-onbflow';
rmSync(GEN, { recursive: true, force: true });
mkdirSync(GEN, { recursive: true });

// The REAL store, compiled — not a double. If it stops being a singleton, this notices.
// The store is a RUNE MODULE (.svelte.ts) — it MUST go through compileModule or its $state is
// inert and this probe would silently test nothing. compileModule cannot parse TS annotations,
// so strip them the way mount-intelligence-screen.mjs:105 does for the §4g store.
const storeSrc = readFileSync('src/lib/stores/onboarding-guidance.svelte.ts', 'utf8')
  .replace(/\)\s*:\s*number\s*\{/g, ') {');
const store = compileModule(storeSrc, { generate: 'client', filename: 'onboarding-guidance.svelte.ts' });
writeFileSync(`${GEN}/store.js`, store.js.code);

// Count every GET of /portal/readiness — that read IS `refresh()` doing its job.
// ⚠️ It was /onboarding/status until E2. The rail now delegates to the ONE readiness model, and
// this harness noticing is the point: a source-grep gate would not have.
// The scenario drives the vault's SHAPE, so one harness can prove both the signal (U3) and the
// §3.7a exclusivity (X1) — the rail must appear iff generated && something-missing.
writeFileSync(`${GEN}/api-stub.js`, `
const S = ${JSON.stringify({
  generated: process.env.GENERATED === '1',
  ai: process.env.AI === '1',
  channel: process.env.CHANNEL === '1',
  dismissed: process.env.DISMISSED === '1',
  // ⚠️ the DB's welcome_shown_at, NOT the rail's derived welcomeSeen. The rail reconstructs
  // `welcome_shown_at || total > 0` (because showWelcome is `!seen && total === 0`), so a stub
  // that hardcodes welcomeSeen:true makes the `|| total > 0` arm untestable — a TOTAL knob with
  // welcomeSeen pinned true proves nothing.
  welcomeStamped: process.env.WELCOME_STAMPED !== '0',
  total: Number(process.env.TOTAL ?? 5),
  // ⚠️ TRANSITION: start ungenerated, flip to generated after the first read. Every other knob is
  // baked at mount, and that blindness is why X1 could not see HIGH-3 — the rail's poll was gated
  // on `generated`, the very fact only the poll could learn, so it never ran again and the rail
  // never appeared in the session the user generates. A guard matrix without a TIME dimension
  // cannot catch a deadlock that only exists across time.
  flipAfterFirstRead: process.env.FLIP_GENERATED === '1',
  mindscapeUnknown: process.env.MINDSCAPE_UNKNOWN === '1',
  // known-true first, then the count fails — the only shape that distinguishes HOLDING an answer
  // from SETTING one (at mount `generated` is false, so "unknown ⇒ hidden" is vacuous).
  unknownAfterFirstRead: process.env.UNKNOWN_AFTER_FIRST_READ === '1',
})};
let reads = 0;
export async function api(path) {
  const p = String(path);
  if (p.includes('/portal/readiness')) { globalThis.__statusReads.push(p); reads++; }
  const gen = S.flipAfterFirstRead ? reads > 1 : S.generated;
  return { ok: true, json: async () => ({
    data: { total: S.total, embedded: S.total, pending: 0 },
    ai: { connected: S.ai, activeProvider: S.ai ? 'local' : null },
    channel: { connected: S.channel },
    mindscape: (S.mindscapeUnknown || (S.unknownAfterFirstRead && reads > 1))
      ? { generated: false, pointCount: 0, unknown: true }
      : { generated: gen },
    onboarding: { welcomeSeen: S.welcomeStamped, dismissed: S.dismissed },
  }) };
}
`);
writeFileSync(`${GEN}/nav-stub.js`, `import { writable } from 'svelte/store';\nexport const navigationState = writable({});\n`);
writeFileSync(`${GEN}/env-stub.js`, 'export const browser = true;\n');
writeFileSync(`${GEN}/goto-stub.js`, 'export function goto() {}\n');
writeFileSync(`${GEN}/canvas.js`, "export default function () { return { $$: {} }; }\n");

// The component under test: REAL source, only its leaf specifiers rewired.
let src = readFileSync('src/lib/components/onboarding/OnboardingFlow.svelte', 'utf8');
const out = compile(src, { generate: 'client', name: 'OnboardingFlow', css: 'injected' });
let js = out.js.code
  .replace(/from ['"]\$lib\/stores\/onboarding-guidance\.svelte['"]/g, `from './store.js'`)
  .replace(/from ['"]\$lib\/api['"]/g, `from './api-stub.js'`)
  .replace(/from ['"]\$lib\/stores\/navigation['"]/g, `from './nav-stub.js'`)
  .replace(/from ['"]\$app\/environment['"]/g, `from './env-stub.js'`)
  .replace(/from ['"]\$app\/navigation['"]/g, `from './goto-stub.js'`)
  .replace(/from ['"]\.\/MyceliumCanvas\.svelte['"]/g, `from './canvas.js'`);
writeFileSync(`${GEN}/Flow.js`, js);

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'SVGElement', 'CustomEvent', 'Event', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'location', 'history']) {
  if (globalThis[k] === undefined) globalThis[k] = dom.window[k];
}
globalThis.__statusReads = [];

const { mount, flushSync } = await import('svelte');
const Flow = (await import(pathToFileURL(`${process.cwd()}/${GEN}/Flow.js`).href)).default;
const { signalGuidanceRestored } = await import(pathToFileURL(`${process.cwd()}/${GEN}/store.js`).href);

const result = { ok: false };
try {
  mount(Flow, { target: dom.window.document.getElementById('host') });
  flushSync();
  await new Promise((r) => setTimeout(r, 30));
  const afterMount = globalThis.__statusReads.length;

  // ⚠️ THE TRANSITION PROBE MUST NOT SHARE A RUN WITH THE SIGNAL PROBE. U3 fires
  // signalGuidanceRestored() twice, each triggering a refresh — so by the time we measured, the
  // read counter had already passed the flip threshold and the rail was up for the wrong reason.
  // A probe contaminated by another probe reports the right answer for the wrong reason, which is
  // worse than failing. Separate runs.
  if (S_WAIT) {
    result.ok = true;
    result.railAtMount = !!dom.window.document.querySelector('.rail');   // must be FALSE: ungenerated
    await new Promise((r) => setTimeout(r, 9000));                        // 2 poll ticks @4s
    result.railAfterPolls = !!dom.window.document.querySelector('.rail');
    result.readsAfterPolls = globalThis.__statusReads.length;
    console.log(JSON.stringify(result));
    rmSync(GEN, { recursive: true, force: true });
    process.exit(0);
  }

  // The user clicks "Show setup guidance again" in Settings → the store bumps.
  signalGuidanceRestored();
  flushSync();
  await new Promise((r) => setTimeout(r, 30));
  const afterSignal = globalThis.__statusReads.length;

  signalGuidanceRestored();
  flushSync();
  await new Promise((r) => setTimeout(r, 30));
  const afterSecond = globalThis.__statusReads.length;

  result.ok = true;
  result.afterMount = afterMount;
  result.refreshedOnSignal = afterSignal - afterMount;
  result.refreshedOnSecond = afterSecond - afterSignal;
  // §3.7a: is the RAIL actually on screen? Read the DOM, not a variable — `railVisible` being
  // true means nothing if nothing renders it (that mistake shipped twice in this build).
  const railEl = dom.window.document.querySelector('.rail');
  result.railRendered = !!railEl;
  // ⚠️ CONTENT, not just presence. `railRendered` alone blessed a rail that rendered as a titled
  // box with one ticked step and no action (review HIGH-1) — a <div> satisfies "it rendered".
  result.railText = railEl ? railEl.textContent.replace(/\s+/g, ' ').trim() : '';
  // ⚠️ BUTTONS, because text is not action. `railText` matched the step's <span class="step-name">
  // — which renders UNCONDITIONALLY in .step-head — so deleting the actual CTA left the gate GREEN:
  // a rail that NAMES the messenger but cannot link one (review MED-5). That is HIGH-1 reborn one
  // level up, inside the gate written for HIGH-1. A step the user cannot act on is not a step.
  result.railButtons = railEl
    ? [...railEl.querySelectorAll('button')].map((b) => b.textContent.replace(/\s+/g, ' ').trim())
    : [];
} catch (e) {
  result.error = String(e?.message || e);
}
console.log(JSON.stringify(result));
rmSync(GEN, { recursive: true, force: true });
process.exit(0);

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

// Count every GET of /portal/onboarding/status — that read IS `refresh()` doing its job.
writeFileSync(`${GEN}/api-stub.js`, `
export async function api(path) {
  if (String(path).includes('/onboarding/status')) globalThis.__statusReads.push(path);
  return { ok: true, json: async () => ({ dismissed: false, welcomeSeen: true, messageCount: 0 }) };
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
} catch (e) {
  result.error = String(e?.message || e);
}
console.log(JSON.stringify(result));
rmSync(GEN, { recursive: true, force: true });
process.exit(0);

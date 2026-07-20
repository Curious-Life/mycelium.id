// Mounts the REAL ImportView.svelte and reports the text a user sees BEFORE committing to an
// import. Run: node --conditions browser portal-app/test/mount-import-view.mjs (cwd = portal-app).
// Without --conditions browser, svelte resolves its server exports map and mount() throws
// lifecycle_function_unavailable (see mount-onbox-select.mjs:15).
//
// ⚠️ WHY A MOUNT AND NOT A REGEX. §3.9/R2's copy is a claim about COST, and the failure mode is
// that it stops being shown. A source-grep cannot tell a deleted paragraph from a live one:
// `{#if false && …}` keeps every asserted string and greps GO (verify-readiness's X1 predecessor,
// MED-2 2026-07-16). PROVEN, not assumed — wrapping the copy in `{#if false}` leaves
// `grep -c "40 messages a minute"` returning 2 while this harness reds.
//
// ⚠️ WHAT IT DOES *NOT* CATCH, STATED BECAUSE THE COMMENT USED TO CLAIM OTHERWISE. An earlier
// version of this note advertised that it also catches copy "collapsed behind a disclosure". IT
// DOES NOT: a reviewer wrapped the paragraph in a closed `<details>` and added a `display:none`
// sibling, and `textContent` returns BOTH — gate GREEN. `textContent` sees the DOM, not visibility.
// It catches REMOVAL (`{#if false}`, deletion) and, via R2f, ORDER. Catching visibility needs
// getComputedStyle/offsetParent — and per this repo's own memory, `visible()` is an OPEN SET
// (`-webkit-text-fill-color` reds all good code), so it needs a control before it is worth adding.
// A gate comment that claims a case it does not cover is how a hole gets laundered.
// The property here is "the user READS this before they can start an import" — and only a mount
// can see the first half of that.
import { compile } from 'svelte/compiler';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-mount-importview';
rmSync(GEN, { recursive: true, force: true });
mkdirSync(GEN, { recursive: true });

// Stubs for everything ImportView reaches for. None of them can affect the expectation copy —
// which is the point: the copy must be unconditional, so no stub state can make it disappear.
writeFileSync(`${GEN}/api-stub.js`, `
export const api = {
  get: async () => ({ connectors: [] }),
  post: async () => ({ ok: true }),
  delete: async () => ({ ok: true }),
};
export const getJSON = async () => ({});
export const apiPost = async () => ({});
export default api;
`);
writeFileSync(`${GEN}/upload-stub.js`, 'export async function uploadFile() { return {}; }\n');
writeFileSync(`${GEN}/prepare-stub.js`, 'export async function prepareFile(f) { return f; }\nexport async function filesFromDataTransfer() { return { files: [], hadDirectory: false }; }\n');
writeFileSync(`${GEN}/empty-component.js`, `
import { createRawSnippet } from 'svelte';
export default function Noop() { return { $$: {} }; }
`);
writeFileSync(`${GEN}/nav-stub.js`, `import { writable } from 'svelte/store';\nexport const navigationState = writable({});\n`);
writeFileSync(`${GEN}/env-stub.js`, 'export const browser = true;\n');
writeFileSync(`${GEN}/goto-stub.js`, 'export function goto() {}\n');
// The import-completed signal (fix/invite-stale-data): a no-op HERE — this gate asserts the
// expectation COPY, not the emission (verify:invite-data drives the emission with the REAL store).
writeFileSync(`${GEN}/onboarding-data-stub.js`, 'export function signalImportCompleted() {}\nexport function importCompletedSignal() { return 0; }\n');

const { readFileSync } = await import('node:fs');
const src = readFileSync('src/lib/views/ImportView.svelte', 'utf8');
const out = compile(src, { generate: 'client', name: 'ImportView', css: 'injected' });
const js = out.js.code
  .replace(/from ['"]\$lib\/api['"]/g, `from './api-stub.js'`)
  .replace(/from ['"]\$lib\/chunked-upload['"]/g, `from './upload-stub.js'`)
  .replace(/from ['"]\$lib\/import\/upload-handlers['"]/g, `from './prepare-stub.js'`)
  .replace(/from ['"]\$lib\/components\/import\/[^'"]+['"]/g, `from './empty-component.js'`)
  .replace(/from ['"]\$lib\/stores\/navigation['"]/g, `from './nav-stub.js'`)
  .replace(/from ['"]\$lib\/stores\/onboarding-data\.svelte['"]/g, `from './onboarding-data-stub.js'`)
  .replace(/from ['"]\$app\/environment['"]/g, `from './env-stub.js'`)
  .replace(/from ['"]\$app\/navigation['"]/g, `from './goto-stub.js'`);
writeFileSync(`${GEN}/ImportView.js`, js);

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'SVGElement', 'CustomEvent', 'Event', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'location', 'history']) {
  if (globalThis[k] === undefined) globalThis[k] = dom.window[k];
}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

let text = '';
let error = null;
try {
  // The module imports live INSIDE the try/finally: a rewired specifier that fails to resolve
  // (ERR_MODULE_NOT_FOUND) used to crash ABOVE the cleanup line and leave .gen-mount-importview/
  // debris in the tree (found when fix/invite-stale-data's new store import did exactly that).
  const { mount, flushSync } = await import('svelte');
  const Comp = (await import(pathToFileURL(`${process.cwd()}/${GEN}/ImportView.js`).href)).default;
  mount(Comp, { target: document.getElementById('app') });
  flushSync();
  await new Promise((r) => setTimeout(r, 60));
  flushSync();
  text = (document.body.textContent || '').replace(/\s+/g, ' ').trim();
} catch (e) {
  error = String(e?.message || e);
} finally {
  rmSync(GEN, { recursive: true, force: true });
}

console.log(JSON.stringify({ mounted: !error, error, text }, null, 2));

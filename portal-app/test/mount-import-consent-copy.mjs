// Mounts the REAL onboarding ImportStep.svelte (wizard step 4) — including the REAL
// ScanForData child — and prints the text a user actually reads before consenting to an
// import. Run (cwd = portal-app):
//   node --conditions browser test/mount-import-consent-copy.mjs
//
// ⚠️ WHY A MOUNT AND NOT A GREP (D-069, the deceptive privacy claim). Two failure modes a
// source-grep cannot see, both live in this repo's history:
//   • absence-by-grep is not absence-on-screen — the deceptive sentence can be reintroduced
//     in a sibling component, a snippet, or an interpolated string and still render here;
//   • presence-by-grep is not presence-on-screen — `{#if false}` keeps every asserted string
//     while the paragraph is gone (proven in mount-import-view.mjs's header).
//
// ⚠️ WHY ScanForData IS NOT STUBBED — this harness's own near-miss, recorded so it is not
// undone. The first version replaced every `$lib/components/import/*` with a no-op, on the
// note that "the scan row's own claim is covered separately". It was not: an independent
// adversarial review mounted the step WITH the real child and found
// `ScanForData.svelte`'s sub-label still rendering "…nothing leaves your device" on the very
// screen D-069 was filed against, while this gate printed GREEN. A stub of the component
// under test is not a test, and a cross-reference to checks that assert something else
// (S1–S4 are importer-level DB assertions) is coverage theatre — the M-001 pattern.
// The child is compiled for real here. Only `$lib/api` is stubbed, and only to keep the
// harness offline.
//
// KNOWN LIMIT, stated rather than laundered: textContent sees the DOM, not visibility. A
// paragraph hidden with display:none or collapsed into a closed <details> still counts as
// present (mount-import-view.mjs hit exactly that). This catches removal, replacement and
// reintroduction — not concealment.
//
// Emits ONE JSON object on stdout; scripts/verify-import-consent.mjs does the asserting.
import { compile } from 'svelte/compiler';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-mount-consentcopy';
rmSync(GEN, { recursive: true, force: true });
mkdirSync(GEN, { recursive: true });

writeFileSync(`${GEN}/api-stub.js`, `
export const api = async () => ({ ok: true, json: async () => ({ ok: true }) });
export const apiGet = async () => ({ ok: true, sources: [], blocked: [] });
export const apiPost = async () => ({ status: 'idle' });
export default api;
`);
writeFileSync(`${GEN}/prepare-stub.js`, 'export async function filesFromDataTransfer() { return { files: [], hadDirectory: false }; }\n');
writeFileSync(`${GEN}/onboarding-data-stub.js`, 'export function signalImportCompleted() {}\n');

const { transform } = await import('esbuild');
const tsToJs = async (file, out, rewrite = (s) => s) => {
  const code = (await transform(readFileSync(file, 'utf8'), { loader: 'ts', format: 'esm' })).code;
  writeFileSync(`${GEN}/${out}`, rewrite(code));
};
await tsToJs('src/lib/import/detect.ts', 'detect.js', (s) => s.replace(/from ['"]\$lib\/api['"]/g, `from './api-stub.js'`));
await tsToJs('src/lib/import/catalog.ts', 'catalog.js');

// The REAL child — its idle-phase sub-label is the copy the review found surviving.
const scan = compile(readFileSync('src/lib/components/import/ScanForData.svelte', 'utf8'), {
  generate: 'client', name: 'ScanForData', css: 'injected',
});
writeFileSync(`${GEN}/ScanForData.js`, scan.js.code
  .replace(/from ['"]\$lib\/import\/detect['"]/g, `from './detect.js'`)
  .replace(/from ['"]\$lib\/import\/catalog['"]/g, `from './catalog.js'`)
  .replace(/from ['"]\$lib\/api['"]/g, `from './api-stub.js'`));

const out = compile(readFileSync('src/lib/components/onboarding/wizard/ImportStep.svelte', 'utf8'), {
  generate: 'client', name: 'ImportStep', css: 'injected',
});
writeFileSync(`${GEN}/ImportStep.js`, out.js.code
  .replace(/from ['"]\$lib\/api['"]/g, `from './api-stub.js'`)
  .replace(/from ['"]\$lib\/import\/upload-handlers['"]/g, `from './prepare-stub.js'`)
  .replace(/from ['"]\$lib\/stores\/onboarding-data\.svelte['"]/g, `from './onboarding-data-stub.js'`)
  .replace(/from ['"]\$lib\/components\/import\/ScanForData\.svelte['"]/g, `from './ScanForData.js'`));

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLMediaElement', 'HTMLInputElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'SVGElement', 'CustomEvent', 'Event', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'location', 'history']) {
  if (globalThis[k] === undefined) globalThis[k] = dom.window[k];
}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const result = { mounted: false, error: null, text: '', childMounted: false };
try {
  const { mount, flushSync } = await import('svelte');
  const Comp = (await import(pathToFileURL(`${process.cwd()}/${GEN}/ImportStep.js`).href)).default;
  mount(Comp, { target: document.getElementById('app'), props: { onNext: () => {}, onOpenImport: () => {} } });
  flushSync();
  await new Promise((r) => setTimeout(r, 40));
  flushSync();
  result.text = (document.body.textContent || '').replace(/\s+/g, ' ').trim();
  // Proof the child really rendered — otherwise "the claim is absent" would be absence of the
  // whole component, which is how the first version of this harness went green while blind.
  result.childMounted = result.text.includes('Scan this Mac for data');
  result.mounted = true;
} catch (e) {
  result.error = String(e?.stack || e?.message || e);
} finally {
  rmSync(GEN, { recursive: true, force: true });
}

console.log(JSON.stringify(result, null, 2));

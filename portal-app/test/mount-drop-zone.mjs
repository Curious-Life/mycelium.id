// Mounts the REAL ImportDropZone.svelte and reports what a user sees DURING a drag — i.e. before
// the drop commits an import. Run: node --conditions browser portal-app/test/mount-drop-zone.mjs
// (cwd = portal-app). Without --conditions browser, mount() throws lifecycle_function_unavailable.
//
// WHY THIS EXISTS: the drop zone is mounted once in the app layout and takes a file dropped
// ANYWHERE over the window into the same import pipeline ImportView drives — so a user can start
// hours of on-device work having never seen ImportView's expectation copy (review HIGH-3,
// 2026-07-17). The overlay renders WHILE DRAGGING, before the drop, so it is this path's last
// moment to decline — and its copy was the one claim in #204 shipped without a gate.
//
// The drag is driven the way a browser drives it: window-level dragenter with
// dataTransfer.types = ['Files'] (what a real .zip drag carries). The CONTROL is a text-only drag
// (types = ['text/plain']) — the overlay must NOT appear for it, which proves the harness can see
// absence rather than echoing the source (P4a's lesson).
import { compile } from 'svelte/compiler';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-mount-dropzone';
rmSync(GEN, { recursive: true, force: true });
mkdirSync(GEN, { recursive: true });

// Stubs: none of these can affect whether the overlay renders — dragging is driven purely by the
// window drag events, which is the point.
writeFileSync(`${GEN}/toast-stub.js`, `
export const toasts = { info: () => 1, success: () => {}, error: () => {}, remove: () => {} };
`);
writeFileSync(`${GEN}/upload-stub.js`, 'export async function importFiles() { return { imported: 0, failed: 0 }; }\n');
writeFileSync(`${GEN}/env-stub.js`, 'export const browser = true;\n');

const src = readFileSync('src/lib/components/shell/ImportDropZone.svelte', 'utf8');
const out = compile(src, { generate: 'client', name: 'ImportDropZone', css: 'injected' });
const js = out.js.code
  .replace(/from ['"]\$lib\/stores\/toast['"]/g, `from './toast-stub.js'`)
  .replace(/from ['"]\$lib\/import\/upload-handlers['"]/g, `from './upload-stub.js'`)
  .replace(/from ['"]\$app\/environment['"]/g, `from './env-stub.js'`);
writeFileSync(`${GEN}/DropZone.js`, js);

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost' });
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'SVGElement', 'CustomEvent', 'Event', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'location', 'history']) {
  if (globalThis[k] === undefined) globalThis[k] = dom.window[k];
}

const { mount, flushSync } = await import('svelte');
const Comp = (await import(pathToFileURL(`${process.cwd()}/${GEN}/DropZone.js`).href)).default;

const bodyText = () => (dom.window.document.body.textContent || '').replace(/\s+/g, ' ').trim();
// A drag event the way the component reads it: e.dataTransfer.types. jsdom has no DragEvent
// constructor, so build an Event and attach the dataTransfer the handler will consult.
function drag(type, types) {
  const ev = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { types, files: [] } });
  dom.window.dispatchEvent(ev);
  flushSync();
}

let result = { mounted: false, error: null };
try {
  mount(Comp, { target: dom.window.document.getElementById('app') });
  flushSync();
  await new Promise((r) => setTimeout(r, 20));
  flushSync();
  result.mounted = true;
  result.beforeDrag = bodyText();

  drag('dragenter', ['text/plain']);            // the CONTROL: a text drag must NOT show the overlay
  result.textDrag = bodyText();
  drag('dragleave', ['text/plain']);

  drag('dragenter', ['Files']);                  // what a real .zip drag carries
  result.filesDrag = bodyText();
  result.overlayRole = dom.window.document.querySelector('.drop-overlay')?.getAttribute('role') ?? null;
  result.overlayAriaHidden = dom.window.document.querySelector('.drop-overlay')?.getAttribute('aria-hidden') ?? null;
} catch (e) {
  result.error = String(e?.message || e);
}

console.log(JSON.stringify(result, null, 2));
rmSync(GEN, { recursive: true, force: true });

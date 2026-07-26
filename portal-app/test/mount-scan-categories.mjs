// Mounts the REAL ScanForData.svelte, drives the category deselection → Import click, and
// reports the EXACT request payload the component put on the wire. Run (cwd = portal-app):
//   node --conditions browser test/mount-scan-categories.mjs
// Without --conditions browser, svelte resolves its server exports map and mount() throws
// lifecycle_function_unavailable (see mount-onbox-select.mjs:15).
//
// ⚠️ WHY A MOUNT AND NOT A REGEX (D-070, the consent violation). The property under test is
// "a category the user switched OFF is not in the request, and switching them ALL off sends
// nothing at all" — the runtime result of $state toggling, a filter, a disabled predicate and
// a click handler. A source-grep over ScanForData.svelte sees `selectedCats(s)` being passed
// and says GO with the toggle wired to the wrong key, the filter inverted, the button
// re-enabled, or the payload dropped one module downstream in detect.ts. Only a mount that
// clicks the real buttons and captures the real body can tell consent-honoured from
// consent-shaped-code.
//
// detect.ts is compiled and used FOR REAL (it carries the payload-shaping line the pre-fix
// fail-open lived on: `categories?.length ? { categories } : {}`). Only $lib/api is stubbed,
// and only so the request can be recorded.
//
// Emits ONE JSON object on stdout; scripts/verify-import-consent.mjs does the asserting.
import { compile } from 'svelte/compiler';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GEN = '.gen-mount-scancats';
rmSync(GEN, { recursive: true, force: true });
mkdirSync(GEN, { recursive: true });

// What the detector returns for a Mac with loose files, in the operator's QA9 shape:
// ~9.7K documents against ~9K photos/videos/audio.
const DETECTED = {
  source: 'local-files', found: true, path: '/Users/x/Documents', count: 18700,
  unit: 'files', importable: true, action: 'import-local-files',
  categories: [
    { key: 'document', label: 'Documents & notes', count: 9700 },
    { key: 'image', label: 'Photos & images', count: 5200 },
    { key: 'video', label: 'Video', count: 2100 },
    { key: 'audio', label: 'Audio & voice memos', count: 1700 },
  ],
};

writeFileSync(`${GEN}/api-stub.js`, `
export const calls = [];
// Flipped by the G4 run so /progress reports a sweep that is ALREADY running — the
// state a page reload lands in, where nothing in this component started the job.
// It reports 'running' for a bounded number of polls, then 'done' — a real job ends, and an
// endless 'running' would just hang the harness instead of testing anything.
export const state = { runningSweep: 0 };
export async function apiGet(path) {
  calls.push({ method: 'GET', path });
  if (path === '/portal/import/detect') return { ok: true, sources: [${JSON.stringify(DETECTED)}], blocked: [] };
  if (path.endsWith('/progress')) {
    // Deliberately a DOCUMENTS-ONLY job while the mount's chips default to ALL FOUR: the
    // adopted row must describe the SERVER's job (9,700 · documents only), never the chips
    // (18,700 · all four). That mismatch is the round-2 CRITICAL.
    if (state.runningSweep > 0) { state.runningSweep -= 1; return { status: 'running', total: 9700, processed: 120, imported: 118, deduped: 0, skipped: 2, failed: 0, categories: ['document'] }; }
    return { status: 'done', total: 9700, processed: 9700, imported: 9698, deduped: 0, skipped: 2, failed: 0, categories: ['document'] };
  }
  return {};
}
export async function apiPost(path, body) {
  calls.push({ method: 'POST', path, body });
  // Echo the enforced selection back, like the real route does.
  return { status: 'done', total: 0, processed: 0, imported: 0, deduped: 0, skipped: 0, failed: 0, categories: body?.categories ?? [] };
}
export const api = { get: apiGet, post: apiPost };
export default api;
`);

const { transform } = await import('esbuild');
const tsToJs = async (file, out, rewrite = (s) => s) => {
  const code = (await transform(readFileSync(file, 'utf8'), { loader: 'ts', format: 'esm' })).code;
  writeFileSync(`${GEN}/${out}`, rewrite(code));
};
await tsToJs('src/lib/import/detect.ts', 'detect.js', (s) => s.replace(/from ['"]\$lib\/api['"]/g, `from './api-stub.js'`));
await tsToJs('src/lib/import/catalog.ts', 'catalog.js');

const out = compile(readFileSync('src/lib/components/import/ScanForData.svelte', 'utf8'), {
  generate: 'client', name: 'ScanForData', css: 'injected',
});
writeFileSync(`${GEN}/ScanForData.js`, out.js.code
  .replace(/from ['"]\$lib\/import\/detect['"]/g, `from './detect.js'`)
  .replace(/from ['"]\$lib\/import\/catalog['"]/g, `from './catalog.js'`)
  .replace(/from ['"]\$lib\/api['"]/g, `from './api-stub.js'`));

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'SVGElement', 'CustomEvent', 'Event', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'location', 'history']) {
  if (globalThis[k] === undefined) globalThis[k] = dom.window[k];
}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const result = { mounted: false, error: null, runs: {} };
try {
  const { mount, flushSync } = await import('svelte');
  const api = await import(pathToFileURL(`${process.cwd()}/${GEN}/api-stub.js`).href);
  const Comp = (await import(pathToFileURL(`${process.cwd()}/${GEN}/ScanForData.js`).href)).default;

  // One FRESH mount per gesture: a completed run disables the row's Import button, so
  // reusing a mount would make "no request was sent" pass for the wrong reason.
  async function drive(deselect, { adopt = false } = {}) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    api.state.runningSweep = adopt ? 3 : 0;
    api.calls.length = 0;
    // Spy on the completion callback: an ADOPTED job (one the user did not start) must
    // never fire it — firing it tells onboarding "your data is in" for someone else's run.
    let importedFired = 0;
    mount(Comp, { target: host, props: { onImported: () => { importedFired += 1; } } });
    flushSync();
    const settle = async () => { for (let i = 0; i < 8; i++) { flushSync(); await new Promise((r) => setTimeout(r, 60)); flushSync(); } };
    const btns = () => [...host.querySelectorAll('button')];
    const byText = (re) => btns().find((b) => re.test((b.textContent || '').trim()));
    const chipEls = () => [...(host.querySelector('[aria-label="What to import"]')?.querySelectorAll('button') || [])];

    byText(/^Scan this Mac for data$/)?.click();
    await settle();
    const chips = chipEls().map((b) => (b.textContent || '').trim());
    // Is there a Cancel affordance for a job this component did not start?
    const cancelAfterScan = !!byText(/^Cancel$/);
    for (const label of deselect) {
      chipEls().find((b) => (b.textContent || '').trim().startsWith(label))?.click();
      await settle();
    }
    const on = chipEls().filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => (b.textContent || '').trim());
    // In the adopt run the row is already busy, so its action button IS the Cancel — clicking
    // it would just measure the harness. The adopt run asserts `cancelAfterScan` and nothing else.
    const imp = adopt ? null : (byText(/Import$/) || btns().find((b) => b.className.includes('imp-btn')));
    const disabledBefore = !!imp?.disabled;
    imp?.click();
    await settle();
    const posts = api.calls.filter((c) => c.method === 'POST').map((c) => ({ path: c.path, body: c.body }));
    const text = (host.textContent || '').replace(/\s+/g, ' ').trim();
    // The row's action button state AFTER the adopt has had a chance to land.
    const actionBtn = btns().find((b) => b.className.includes('imp-btn'));
    const actionLabel = (actionBtn?.textContent || '').trim();
    const importDisabledNow = !!btns().find((b) => b.className.includes('imp-btn') && !b.className.includes('cancel'))?.disabled;
    host.remove();
    return { chips, on, disabledBefore, posts, text, cancelAfterScan, importedFired, actionLabel, importDisabledNow };
  }

  // G1 — the operator's exact gesture: keep Documents, drop Photos/Video/Audio.
  result.runs.documentsOnly = await drive(['Photos', 'Video', 'Audio']);
  // G2 — fail-closed: switch EVERY category off. Nothing may be sent.
  result.runs.noneSelected = await drive(['Documents', 'Photos', 'Video', 'Audio']);
  // G3 — untouched default: all four are on and all four are sent (a control that proves
  //      G1/G2 are not passing because the component simply never posts).
  result.runs.untouched = await drive([]);
  // G4 — a sweep is ALREADY running when the component mounts (page reload / navigate-back).
  //      The row must adopt it and offer Cancel, or the 409 on a different selection is a
  //      dead end: "cancel it first" with nothing on screen to cancel.
  result.runs.adopt = await drive([], { adopt: true });

  // W — the wire helper itself, called directly: an EMPTY selection must still be sent as
  // `{ categories: [] }`. The pre-fix `categories?.length ? { categories } : {}` turned the
  // user's "none of it" into a body the server read as "no opinion" → import everything.
  {
    api.calls.length = 0;
    const detect = await import(pathToFileURL(`${process.cwd()}/${GEN}/detect.js`).href);
    await detect.startLocalSweep([]);
    await detect.startLocalSweep(['document']);
    result.wire = api.calls.filter((c) => c.method === 'POST').map((c) => ({ path: c.path, body: c.body }));
  }

  result.mounted = true;
} catch (e) {
  result.error = String(e?.stack || e?.message || e);
} finally {
  rmSync(GEN, { recursive: true, force: true });
}

console.log(JSON.stringify(result, null, 2));

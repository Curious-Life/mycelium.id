// Mounts the REAL ImportView.svelte / ChatFloat.svelte with the REAL onboarding-data store and
// proves each import-success path actually EMITS the import-completed signal (WS-A item 1d,
// review HIGH-3). Keep-alive panes (Pane.svelte renders every tab display:none and never
// unmounts) mean no remount ever heals a missed emission — the wire must fire, or the invite
// panel lies forever. Prints one JSON line per PROBE for scripts/verify-invite-data.mjs.
//
// Run: node --conditions browser portal-app/test/mount-import-emitters.mjs   (cwd = portal-app)
//
// ⚠️ WHY A MOUNT AND NOT A REGEX. `grep signalImportCompleted` is satisfied by a call inside a
// dead branch, a comment, or an unwired import. The property is "the SUCCESS PATH reaches the
// store" — so the store here is the REAL compiled rune module, and the probes drive the real
// handlers (a child invoking its prop, a real button click, a real file-input change) and then
// read the store's counter. PROBES:
//   scan  — ImportView's <ScanForData onImported> wiring (its default is a NO-OP — the bug).
//   sync  — ImportView's connector "Sync now" success path (d.created > 0).
//   chat  — ChatFloat's uploadFiles success path (archive importResult / loose attachment).
import { JSDOM } from 'jsdom';
import { compile, compileModule } from 'svelte/compiler';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROBE = process.env.PROBE || 'scan';
const GEN = '.gen-mount-emitters';
const STORE = 'src/lib/stores/onboarding-data.svelte.ts';

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (k in globalThis) continue;
  try { globalThis[k] = dom.window[k]; } catch { /* getter-only global */ }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// jsdom has no matchMedia; ChatFloat reads it on mount for layout only.
if (!dom.window.matchMedia) {
  dom.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} });
}

mkdirSync(GEN, { recursive: true });

// ── The REAL store, compiled (compileModule can't parse TS return annotations — strip) ────────
const storeSrc = readFileSync(STORE, 'utf8').replace(/\)\s*:\s*(?:number|void)\s*\{/g, ') {');
writeFileSync(`${GEN}/store.js`, compileModule(storeSrc, { generate: 'client', filename: 'onboarding-data.svelte.ts' }).js.code);

// ── Shared stubs ───────────────────────────────────────────────────────────────────────────────
// api: serves the connectors fixture for the sync probe and records POSTs.
writeFileSync(`${GEN}/api-stub.js`, `
export async function api(path, options = {}) {
  const p = String(path);
  globalThis.__apiCalls.push({ path: p, method: options.method || 'GET' });
  if (p.includes('/portal/connectors') && p.endsWith('/sync')) {
    return { ok: true, json: async () => (globalThis.__syncResult) };
  }
  if (p.includes('/portal/connectors')) {
    return { ok: true, json: async () => ({ connectors: globalThis.__connectors }) };
  }
  if (p.includes('/portal/agents')) {
    return { ok: true, json: async () => ({ agents: [] }) };
  }
  return { ok: true, json: async () => ({}) };
}
export async function apiGet(path) { const r = await api(path); return r.json(); }
export async function apiPostForm() { return { ok: true, json: async () => ({}) }; }
export default api;
`);
// chunked-upload: a SUCCESSFUL upload whose response carries an importResult (the archive case).
writeFileSync(`${GEN}/upload-stub.js`, `
export async function uploadFile() {
  globalThis.__uploads = (globalThis.__uploads || 0) + 1;
  return globalThis.__uploadResult;
}
`);
// upload-handlers: ChatFloat + ImportView import prepareFile from it; identity is enough here.
// (The REAL upload-handlers' own emission is exercised by importFiles' unit path — this harness
// gates the per-component wires, so a stub keeps the probes single-sourced.)
writeFileSync(`${GEN}/prepare-stub.js`, 'export async function prepareFile(f) { return f; }\nexport async function importFiles() { return { imported: 0, skipped: 0, failed: 0, detail: "" }; }\nexport async function importFolder() { return { imported: 0, skipped: 0, failed: 0, detail: "" }; }\n');
// A child that INVOKES its onImported prop once — stands in for ScanForData, whose real success
// path calls onImported after a one-click import. Components given no such prop are inert.
writeFileSync(`${GEN}/invoker-child.js`, compile(
  `<script>let { onImported = null } = $props(); $effect(() => { if (onImported && !globalThis.__invoked) { globalThis.__invoked = true; onImported(); } });</script><div data-invoker></div>`,
  { generate: 'client', name: 'InvokerChild', css: 'injected' }).js.code);
writeFileSync(`${GEN}/child.js`, compile('<div data-stub-child></div>', { generate: 'client', name: 'StubChild', css: 'injected' }).js.code);
writeFileSync(`${GEN}/nav-stub.js`, `import { writable } from 'svelte/store';\nexport const navigationState = writable({});\nexport const spaceScope = writable(null);\nexport const docScope = writable(null);\n`);
writeFileSync(`${GEN}/env-stub.js`, 'export const browser = true;\n');
writeFileSync(`${GEN}/goto-stub.js`, 'export function goto() {}\n');
writeFileSync(`${GEN}/toast-stub.js`, `
const noop = () => 't';
export const toasts = { info: noop, success: noop, error: noop, remove: () => {} };
`);
// chatMessages is a CUSTOM store (createChatStore) with methods ChatFloat calls on mount —
// mirror the method surface as async no-ops; the store value stays an empty message list.
writeFileSync(`${GEN}/chat-stores-stub.js`, `
import { writable } from 'svelte/store';
const base = writable([]);
export const chatMessages = {
  subscribe: base.subscribe,
  addMessage: () => {},
  updateMessage: () => {},
  clear: () => {},
  newConversation: () => {},
  getConversationId: () => null,
  loadHistory: async () => {},
  recoverHistory: async () => {},
  loadChannelConversations: async () => {},
  openChannel: async () => {},
  exitChannel: () => {},
};
export const connectionStatus = writable('connected');
export const activeModel = writable(null);
export const noModelMessage = writable(null);
export const recoverableCount = writable(0);
export const channelConversations = writable([]);
export const channelView = writable(null);
`);
writeFileSync(`${GEN}/vps-stub.js`, 'export function isSecureChannelConfigured() { return false; }\nexport default {};\n');
// timeline/utils — exactly the names ChatFloat imports (formatters/parsers; none load-bearing
// for uploadFiles, which is the path under test).
writeFileSync(`${GEN}/timeline-stub.js`, `
export const extractReplyContext = () => null;
export const stripAttachmentPlaceholder = (s) => s;
export const parseSource = () => ({});
export const getSourceStyle = () => ({});
export const formatChannelLabel = () => '';
export default {};
`);

globalThis.__apiCalls = [];
globalThis.__connectors = [];
globalThis.__syncResult = { ok: true, created: 0, updated: 0, deduped: 0 };
globalThis.__uploadResult = {};
globalThis.__invoked = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => console.log(JSON.stringify(o));

function compileView(srcPath, name, extraRewrites = (s) => s) {
  let js = compile(readFileSync(srcPath, 'utf8'), { generate: 'client', name, css: 'injected' }).js.code
    .replace(/from ['"]\$lib\/api['"]/g, `from './api-stub.js'`)
    .replace(/from ['"]\$lib\/chunked-upload['"]/g, `from './upload-stub.js'`)
    .replace(/from ['"]\$lib\/import\/upload-handlers['"]/g, `from './prepare-stub.js'`)
    .replace(/from ['"]\$lib\/stores\/onboarding-data\.svelte['"]/g, `from './store.js'`)
    .replace(/from ['"]\$lib\/stores\/navigation['"]/g, `from './nav-stub.js'`)
    .replace(/from ['"]\$lib\/stores\/toast['"]/g, `from './toast-stub.js'`)
    .replace(/from ['"]\$lib\/stores\/chat['"]/g, `from './chat-stores-stub.js'`)
    .replace(/from ['"]\$lib\/vps-identity['"]/g, `from './vps-stub.js'`)
    .replace(/from ['"]\$lib\/timeline\/utils['"]/g, `from './timeline-stub.js'`)
    .replace(/from ['"]\$app\/environment['"]/g, `from './env-stub.js'`)
    .replace(/from ['"]\$app\/navigation['"]/g, `from './goto-stub.js'`);
  js = extraRewrites(js);
  const outPath = resolve(GEN, `${name}.gen.js`);
  writeFileSync(outPath, js);
  return outPath;
}

try {
  const { mount, flushSync } = await import('svelte');
  const { importCompletedSignal } = await import(pathToFileURL(resolve(GEN, 'store.js')).href);
  const out = { ok: true, probe: PROBE };

  if (PROBE === 'scan' || PROBE === 'sync') {
    // ImportView: ScanForData → the invoker child (calls onImported); every other import
    // component → the inert child.
    const gen = compileView('src/lib/views/ImportView.svelte', 'ImportView', (js) => js
      .replace(/from ['"]\$lib\/components\/import\/ScanForData\.svelte['"]/g, `from './invoker-child.js'`)
      .replace(/from ['"]\$lib\/components\/import\/[^'"]+['"]/g, `from './child.js'`));
    if (PROBE === 'sync') {
      globalThis.__connectors = [{ id: 'gmail', label: 'Gmail', provider: 'google', oauth: true, status: 'connected', connectedAt: null, lastSyncAt: null, lastError: null, itemsLastSync: null }];
      globalThis.__syncResult = { ok: true, created: 3, updated: 1, deduped: 2 };
    }
    const Comp = (await import(pathToFileURL(gen).href)).default;
    mount(Comp, { target: document.getElementById('host') });
    flushSync();
    await sleep(60);
    flushSync();
    out.bumpAfterMount = importCompletedSignal();

    if (PROBE === 'sync') {
      const buttons = [...document.querySelectorAll('button')];
      const syncBtn = buttons.find((b) => /Sync now/.test(b.textContent));
      out.foundSyncButton = !!syncBtn;
      if (syncBtn) {
        syncBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        flushSync();
        await sleep(60);
        flushSync();
      }
      out.bumpAfterSync = importCompletedSignal();
      // CONTROL — a sync that created NOTHING must not emit (an idle poll-sync is not an import).
      globalThis.__syncResult = { ok: true, created: 0, updated: 0, deduped: 5 };
      if (syncBtn) {
        syncBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        flushSync();
        await sleep(60);
        flushSync();
      }
      out.bumpAfterIdleSync = importCompletedSignal();
    }
  } else if (PROBE === 'chat') {
    const gen = compileView('src/lib/components/chat/ChatFloat.svelte', 'ChatFloat', (js) => js
      .replace(/from ['"]\.\/[^'"]+\.svelte['"]/g, `from './child.js'`)
      .replace(/from ['"]\$lib\/components\/[^'"]+\.svelte['"]/g, `from './child.js'`));
    const Comp = (await import(pathToFileURL(gen).href)).default;
    mount(Comp, { target: document.getElementById('host') });
    flushSync();
    await sleep(60);
    flushSync();
    out.bumpAfterMount = importCompletedSignal();

    // A successful archive upload: chunkedUpload resolves with an importResult.
    globalThis.__uploadResult = { attachmentId: 'a1', type: 'import', content: '', filename: 'export.zip', importResult: { type: 'claude', imported: 42, skipped: 0, stats: { messages: 42, conversations: 3 } } };
    const input = document.querySelector('input[type="file"]');
    out.foundFileInput = !!input;
    if (input) {
      const file = new dom.window.File(['zipbytes'], 'export.zip', { type: 'application/zip' });
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      flushSync();
      await sleep(120);
      flushSync();
    }
    out.bumpAfterUpload = importCompletedSignal();
    out.uploads = globalThis.__uploads || 0;
  }
  emit(out);
} catch (e) {
  emit({ ok: false, probe: PROBE, error: String(e?.stack || e) });
} finally {
  rmSync(GEN, { recursive: true, force: true });
}
// A leaked timer must fail an assertion, never hang the gate.
process.exit(0);

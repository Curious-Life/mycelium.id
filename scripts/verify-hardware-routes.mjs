// verify:hardware-routes — the S6 portal routes (detect · recommend · start · pull).
//   HR1 GET /hardware → specs + ollamaUp
//   HR2 GET /hardware/recommend → full ranked list (incl. won't-fit) + installed + ollamaInstalled + quality
//   HR3 POST /hardware/pull {catalog model} → SSE progress + ok + [DONE]
//   HR4 POST /hardware/pull {unknown model} → 400 (constrained to the catalog)
//   HR5 POST /hardware/pull {injection} → 400 (name validation)
//   HR6 POST /hardware/start → daemon ensureUp result
//   HR7 POST /hardware/pull → auto-starts the daemon BEFORE pulling
//   HR8 POST /hardware/pull when Ollama not installed → SSE not_installed, NO pull
// Mounts the router on a throwaway app with INJECTED detect + a mock Ollama fetch
// + (where relevant) an injected daemon. No real network; CWD-independent. Never
// logs a secret.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import express from 'express';
import { portalHardwareRouter } from '../src/portal-hardware.js';
import { CATALOG } from '../src/hardware/catalog.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// Mock Ollama daemon: /api/tags lists one installed model; /api/pull streams NDJSON.
const mockFetch = async (url, opts) => {
  if (/\/api\/tags$/.test(url)) {
    return { ok: true, async json() { return { models: [{ name: 'qwen3:8b' }] }; } };
  }
  if (/\/api\/pull$/.test(url)) {
    const ndjson = ['{"status":"pulling manifest"}', '{"status":"downloading","completed":500,"total":1000}', '{"status":"success"}'].join('\n') + '\n';
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(ndjson)); c.close(); } }) };
  }
  throw new Error(`unexpected url ${url}`);
};

// Injected hardware: a 16GB box with an 8GB NVIDIA GPU.
const detect = async () => ({
  totalRamGb: 16, availableRamGb: 9, cpuCores: 8, cpuName: 'Test CPU', arch: 'x64', platform: 'linux',
  hasGpu: true, gpuName: 'Test GPU 8GB', gpuVramGb: 8, gpuCount: 1, unifiedMemory: false, backend: 'cuda',
});

const app = express();
app.use(express.json());
app.use('/portal', portalHardwareRouter({ fetch: mockFetch, detect }));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const J = async (r) => ({ status: r.status, body: await r.json() });

// HR1
{
  const r = await J(await fetch(`${base}/portal/hardware`));
  rec('HR1. GET /hardware → specs + ollamaUp', r.status === 200 && r.body.ok && r.body.hardware.gpuVramGb === 8 && r.body.ollamaUp === true, `vram=${r.body.hardware?.gpuVramGb} up=${r.body.ollamaUp}`);
}

// HR2 — full ranked list (incl. won't-fit), installed + ollamaInstalled + quality.
{
  const r = await J(await fetch(`${base}/portal/hardware/recommend`));
  const recs = r.body.recommendations || [];
  const inst = recs.find((m) => m.name === 'qwen3:8b');
  const hasUnfit = recs.some((m) => m.fitScore === 0 && m.fitLevel === 'too_tight'); // big models shown, not filtered
  const hasQuality = recs.every((m) => Number.isFinite(m.quality) && typeof m.bestFor === 'string');
  const installedFlag = typeof r.body.ollamaInstalled === 'boolean';
  rec('HR2. recommend → full ranked list + installed + ollamaInstalled + quality',
    r.status === 200 && r.body.ok && recs.length === CATALOG.length && hasUnfit && hasQuality && installedFlag && inst && inst.installed === true && r.body.available === 8,
    `n=${recs.length}/${CATALOG.length} unfit=${hasUnfit} quality=${hasQuality} ollamaInstalled=${r.body.ollamaInstalled} qwen3Installed=${inst?.installed}`);
}

// HR3 — pull a catalog model → SSE stream.
{
  const res = await fetch(`${base}/portal/hardware/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'gemma3:4b' }) });
  const sse = await res.text();
  const sawProgress = sse.includes('"status":"downloading"') && sse.includes('"completed":500');
  const sawDone = /"done":true,"ok":true/.test(sse) && sse.includes('data: [DONE]');
  rec('HR3. POST /hardware/pull (catalog) → SSE progress + done + [DONE]', res.status === 200 && sawProgress && sawDone, `progress=${sawProgress} done=${sawDone}`);
}

// HR4 — a model NOT in our catalog is rejected (even if it is a valid Ollama tag).
{
  const r = await J(await fetch(`${base}/portal/hardware/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'mistral:latest' }) }));
  rec('HR4. pull non-catalog model → 400', r.status === 400 && r.body.ok === false, `status=${r.status}`);
}

// HR5 — an injection-shaped name is rejected.
{
  const r = await J(await fetch(`${base}/portal/hardware/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'llama3.2:3b; rm -rf /' }) }));
  rec('HR5. pull injection-shaped name → 400', r.status === 400 && r.body.ok === false, `status=${r.status}`);
}

// Helper: mount a fresh router (with an injected daemon) on a throwaway app.
const mountWith = async (deps) => {
  const a = express();
  a.use(express.json());
  a.use('/portal', portalHardwareRouter({ fetch: mockFetch, detect, ...deps }));
  const s = await new Promise((r) => { const x = a.listen(0, '127.0.0.1', () => r(x)); });
  return { base: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) };
};

// HR6 — POST /hardware/start returns the daemon's ensureUp() result.
{
  const fake = { ensureUp: async () => ({ ok: true, running: true, installed: true, adopted: false }), isInstalled: () => true, stop() {} };
  const app2 = await mountWith({ daemon: fake });
  const r = await J(await fetch(`${app2.base}/portal/hardware/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  rec('HR6. POST /hardware/start → ensureUp result', r.status === 200 && r.body.ok === true && r.body.running === true, `ok=${r.body.ok} running=${r.body.running}`);
  await app2.close();
}

// HR7 — POST /hardware/pull auto-starts the daemon BEFORE pulling.
{
  let startedBeforePull = false;
  const fake = {
    ensureUp: async () => { startedBeforePull = true; return { ok: true, running: true, installed: true, adopted: true }; },
    isInstalled: () => true, stop() {},
  };
  const app2 = await mountWith({ daemon: fake });
  const res = await fetch(`${app2.base}/portal/hardware/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'gemma3:4b' }) });
  const sse = await res.text();
  const ok = res.status === 200 && startedBeforePull && sse.includes('starting ollama') && sse.includes('"completed":500') && /"done":true,"ok":true/.test(sse);
  rec('HR7. pull auto-starts daemon then streams', ok, `started=${startedBeforePull}`);
  await app2.close();
}

// HR8 — pull when Ollama not installed → SSE not_installed, NO /api/pull fetch.
{
  let pullFetched = false;
  const fetchSpy = async (url, opts) => { if (/\/api\/pull$/.test(url)) pullFetched = true; return mockFetch(url, opts); };
  const fake = { ensureUp: async () => ({ ok: false, running: false, installed: false, reason: 'not_installed' }), isInstalled: () => false, stop() {} };
  const app2 = await mountWith({ daemon: fake, fetch: fetchSpy });
  const res = await fetch(`${app2.base}/portal/hardware/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'gemma3:4b' }) });
  const sse = await res.text();
  const ok = res.status === 200 && /"done":true,"ok":false,"error":"not_installed"/.test(sse) && !pullFetched;
  rec('HR8. pull when not installed → not_installed, no pull', ok, `pullFetched=${pullFetched}`);
  await app2.close();
}

// HR9 — pull auto-DOWNLOADS Ollama (when missing) and streams download progress.
{
  const fake = {
    ensureUp: async (onProgress) => { onProgress?.(42, 42, 100); return { ok: true, running: true, installed: true, adopted: false }; },
    isInstalled: () => false, stop() {},
  };
  const app2 = await mountWith({ daemon: fake });
  const res = await fetch(`${app2.base}/portal/hardware/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'gemma3:4b' }) });
  const sse = await res.text();
  const ok = res.status === 200 && sse.includes('downloading Ollama') && sse.includes('"completed":42') && /"done":true,"ok":true/.test(sse);
  rec('HR9. pull auto-downloads Ollama + streams progress', ok, `dl=${sse.includes('downloading Ollama')}`);
  await app2.close();
}

// HR10 — a too-old daemon (ensureUp → incompatible_runtime) surfaces the ACTIONABLE upgrade copy
// over SSE, not the generic failure — the fault code alone would leave a client rendering "check
// your network" (N1/N2). The message + host-version detail both ride the stream.
{
  const fake = {
    ensureUp: async () => ({ ok: false, running: true, installed: true, adopted: false, reason: 'incompatible_runtime', detail: 'Ollama 0.12.9 is running but this model needs 0.17.4+' }),
    isInstalled: () => true, stop() {},
  };
  const app2 = await mountWith({ daemon: fake });
  const res = await fetch(`${app2.base}/portal/hardware/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'gemma3:4b' }) });
  const sse = await res.text();
  const ok = res.status === 200 && sse.includes('"error":"incompatible_runtime"')
    && /too old for this model/.test(sse) && !/check your network/.test(sse) && sse.includes('0.12.9');
  rec('HR10. too-old daemon → SSE carries upgrade copy + detail, not generic failure', ok, `sse=${sse.replace(/\n/g, ' ').slice(0, 160)}`);
  await app2.close();
}

// ── QA6 P1 §1: the Ollama un-strand — GET /hardware/ollama + POST /hardware/retry ──

// HR11 — GET /hardware/ollama returns the daemon's TRUE health, normalized to the shared
// taxonomy (state/retryable), NOT the raw ensureUp attempt. A 'down' daemon reads
// state:'failed' + retryable:true — the actionable state a bare isUp() boolean could not carry.
{
  const fake = {
    ensureUp: async () => ({ ok: false }),
    isInstalled: () => true, stop() {}, getBaseUrl: () => 'http://127.0.0.1:11434',
    health: async () => ({ status: 'down', message: 'The local model runtime isn’t running.', detail: 'start_timeout', installed: true, running: false, baseUrl: 'http://127.0.0.1:11434' }),
  };
  const app2 = await mountWith({ daemon: fake });
  const r = await J(await fetch(`${app2.base}/portal/hardware/ollama`));
  const ok = r.status === 200 && r.body.ok && r.body.ollama.status === 'down'
    && r.body.ollama.state === 'failed' && r.body.ollama.retryable === true && r.body.ollama.installed === true;
  rec('HR11. GET /hardware/ollama → true health + shared state/retryable', ok, `state=${r.body.ollama?.state} retryable=${r.body.ollama?.retryable}`);
  await app2.close();
}

// HR12 — POST /hardware/retry RE-ATTEMPTS bring-up via ensureUp() AND answers with the RE-READ
// health, never the attempt's claim. Here ensureUp is called (spy) and health() reports 'ok' →
// ok:true. Proves the route presses the ONE bring-up path and reflects the real world.
{
  let ensured = false;
  const fake = {
    ensureUp: async () => { ensured = true; return { ok: true }; },
    isInstalled: () => true, stop() {}, getBaseUrl: () => 'http://127.0.0.1:11434',
    health: async () => ({ status: 'ok', message: 'running', detail: null, installed: true, running: true, baseUrl: 'http://127.0.0.1:11434' }),
  };
  const app2 = await mountWith({ daemon: fake });
  const r = await J(await fetch(`${app2.base}/portal/hardware/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  const ok = r.status === 200 && ensured === true && r.body.ok === true && r.body.ollama.state === 'ready';
  rec('HR12. POST /hardware/retry → calls ensureUp + reports RE-READ health', ok, `ensured=${ensured} ok=${r.body.ok} state=${r.body.ollama?.state}`);
  await app2.close();
}

// HR13 — a retry that DID NOT help must NOT claim success. ensureUp is called but health() still
// reports 'down' → ok:false + state:'failed' + retryable:true. The mirror of #318's contract.
// ⚠️ STUB-ONLY (LOW-4): the `fake` daemon here is a hand-written stub, so HR11–HR14 prove the ROUTE's
// contract (presses ensureUp, answers with the re-read health, is session-gated) but NOT that the real
// ollama-daemon.js health()/ensureUp() emit these shapes — that wiring is covered by verify:hardware
// against the genuine daemon. Read these as route-logic assertions, not end-to-end proof.
{
  const fake = {
    ensureUp: async () => ({ ok: false, reason: 'start_timeout' }),
    isInstalled: () => true, stop() {}, getBaseUrl: () => 'http://127.0.0.1:11434',
    health: async () => ({ status: 'down', message: 'didn’t start', detail: 'start_timeout', installed: true, running: false, baseUrl: 'http://127.0.0.1:11434' }),
  };
  const app2 = await mountWith({ daemon: fake });
  const r = await J(await fetch(`${app2.base}/portal/hardware/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  const ok = r.status === 200 && r.body.ok === false && r.body.ollama.state === 'failed' && r.body.ollama.retryable === true;
  rec('HR13. retry that failed stays honestly failed (never a fake ✓)', ok, `ok=${r.body.ok} state=${r.body.ollama?.state}`);
  await app2.close();
}

// HR14 — POST /hardware/retry is SESSION-GATED when an authenticator is wired: an unauthenticated
// request 401s and NEVER touches the daemon (ensureUp not called). Mirror of #318's P12b.
{
  let ensured = false;
  const fake = {
    ensureUp: async () => { ensured = true; return { ok: true }; },
    isInstalled: () => true, stop() {}, getBaseUrl: () => 'http://127.0.0.1:11434',
    health: async () => ({ status: 'ok', installed: true, running: true }),
  };
  const a = express();
  a.use(express.json());
  a.use('/portal', portalHardwareRouter({ fetch: mockFetch, detect, daemon: fake, authenticatePortalRequest: () => null }));
  const s = await new Promise((r) => { const x = a.listen(0, '127.0.0.1', () => r(x)); });
  const base = `http://127.0.0.1:${s.address().port}`;
  const r = await J(await fetch(`${base}/portal/hardware/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  const ok = r.status === 401 && ensured === false;
  rec('HR14. POST /hardware/retry → 401 + daemon untouched when unauthenticated', ok, `status=${r.status} ensured=${ensured}`);
  await new Promise((r2) => s.close(r2));
}

// HR15 — LOW-6: a retry that would trigger a SLOW runtime download (ensureUp downloading hundreds of
// MB) must NOT hang the request. Bounded by the answer budget, the route returns promptly with the
// honest in-progress health ('starting' ⇒ state 'loading') while the download continues in the
// daemon's single-flight; the client polls GET /hardware/ollama for progress. Budget driven low here.
{
  process.env.MYCELIUM_RETRY_BRINGUP_MS = '60';
  let ensureResolved = false;   // becomes true ONLY if the download runs to completion
  let aborted = false;          // a daemon.stop() mid-download flips this (kills a spawnedByUs bring-up)
  let resolveEnsure = null;
  const fake = {
    // A long runtime download. stop() aborts it (real ollama-daemon.stop() kills the spawned
    // process); an aborted bring-up never reaches the completion that sets ensureResolved.
    ensureUp: async () => {
      await new Promise((resolve) => { resolveEnsure = resolve; setTimeout(resolve, 400); });
      if (aborted) return { ok: false, aborted: true };
      ensureResolved = true; return { ok: true };
    },
    isInstalled: () => false,
    stop() { aborted = true; resolveEnsure?.(); },   // a real stop() kills the in-flight download
    getBaseUrl: () => 'http://127.0.0.1:11434',
    health: async () => ({ status: 'starting', message: 'Downloading the Ollama runtime…', detail: null, installed: false, running: false, baseUrl: 'http://127.0.0.1:11434' }),
  };
  const app2 = await mountWith({ daemon: fake });
  const t0 = Date.now();
  const r = await J(await fetch(`${app2.base}/portal/hardware/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
  const elapsed = Date.now() - t0;
  // (1) the retry answers PROMPTLY with the honest in-progress state — never blocks on the download.
  const promptAndHonest = r.status === 200 && elapsed < 2000 && ensureResolved === false
    && r.body.ok === false && r.body.ollama.state === 'loading';
  // (2) …AND the background download must SURVIVE to completion. The route may NOT stop() the daemon
  //     after the Promise.race — that kills a spawnedByUs bring-up and the model never lands, leaving
  //     the owner staring at "loading" forever. Wait past the download duration and prove it resolved.
  //     Mutation: add `ollamaDaemon.stop()` after the race → aborted → ensureResolved stays false → reds.
  await new Promise((res) => setTimeout(res, 700));
  const survived = ensureResolved === true && aborted === false;
  rec('HR15. slow runtime download: retry answers in-progress promptly AND the download survives to completion (not aborted)',
    promptAndHonest && survived, `elapsed=${elapsed}ms resolvedAtResponse=false? ${r?.body?.ollama?.state === 'loading'} survived=${survived} aborted=${aborted}`);
  await app2.close();
  delete process.env.MYCELIUM_RETRY_BRINGUP_MS;
}

await new Promise((r) => server.close(r));
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — S6 routes: detect · recommend · catalog-constrained streaming pull' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

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

await new Promise((r) => server.close(r));
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — S6 routes: detect · recommend · catalog-constrained streaming pull' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

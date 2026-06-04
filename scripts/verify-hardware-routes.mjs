// verify:hardware-routes — the S6 portal routes (detect · recommend · pull).
//   HR1 GET /hardware → specs + ollamaUp
//   HR2 GET /hardware/recommend → ranked models, installed flag set
//   HR3 POST /hardware/pull {catalog model} → SSE progress + ok + [DONE]
//   HR4 POST /hardware/pull {unknown model} → 400 (constrained to the catalog)
//   HR5 POST /hardware/pull {injection} → 400 (name validation)
// Mounts the router on a throwaway app with INJECTED detect + a mock Ollama fetch.
// No real network; CWD-independent. Never logs a secret.
import express from 'express';
import { portalHardwareRouter } from '../src/portal-hardware.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// Mock Ollama daemon: /api/tags lists one installed model; /api/pull streams NDJSON.
const mockFetch = async (url, opts) => {
  if (/\/api\/tags$/.test(url)) {
    return { ok: true, async json() { return { models: [{ name: 'llama3.1:8b' }] }; } };
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

// HR2
{
  const r = await J(await fetch(`${base}/portal/hardware/recommend`));
  const recs = r.body.recommendations || [];
  const llama = recs.find((m) => m.name === 'llama3.1:8b');
  const allFit = recs.every((m) => m.fitScore > 0);
  rec('HR2. GET /hardware/recommend → ranked + installed flag', r.status === 200 && r.body.ok && recs.length > 0 && allFit && llama && llama.installed === true && r.body.available === 8, `n=${recs.length} llamaInstalled=${llama?.installed} avail=${r.body.available}`);
}

// HR3 — pull a catalog model → SSE stream.
{
  const res = await fetch(`${base}/portal/hardware/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'llama3.2:3b' }) });
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

await new Promise((r) => server.close(r));
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — S6 routes: detect · recommend · catalog-constrained streaming pull' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

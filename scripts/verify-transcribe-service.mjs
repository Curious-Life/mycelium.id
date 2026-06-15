// verify:transcribe — the dedicated Whisper transcription path (design:
// docs/WHISPER-TRANSCRIPTION-DESIGN-2026-06-11.md). Hermetic: a mock HTTP
// service plays transcribe-service.py; no python, no model download.
// Proves: (1) the supervisor is OPT-IN (no model → no start) and maps service
// health states honestly; (2) the portal router validates models, persists the
// choice, and proxies /download; (3) transcribeAudio prefers Whisper when
// healthy, falls back to the LLM path on whisper failure, and never throws.
import { createServer } from 'node:http';
import express from 'express';

const PORT = 18093;
process.env.MYCELIUM_TRANSCRIBE_PORT = String(PORT); // before module import

const { ensureTranscribeSupervisor, getTranscriberHealth, _resetTranscribeSupervisor } =
  await import('../src/transcribe/supervisor.js');
const { portalTranscriptionRouter } = await import('../src/portal-transcription.js');
const { transcribeAudio } = await import('../src/enrich/transcribe-audio.js');

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Mock transcribe-service ──
let svcState = { status: 'ok', model: 'small' };
let downloadCalls = [];
let transcribeBehavior = 'ok'; // ok | fail
const svc = createServer((req, res) => {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url === '/health') return json(200, svcState);
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/download') { downloadCalls.push(JSON.parse(body || '{}')); return json(202, { ok: true }); }
    if (req.url === '/transcribe') {
      if (transcribeBehavior === 'fail') return json(500, { error: 'boom' });
      return json(200, { text: 'whisper transcript here', language: 'en', ms: 12 });
    }
    return json(404, {});
  });
});
await new Promise((r) => svc.listen(PORT, '127.0.0.1', r));

// T1. opt-in gate: no model → supervisor does not start
_resetTranscribeSupervisor();
rec('T1. ensureTranscribeSupervisor without a model is a no-op (opt-in)',
  ensureTranscribeSupervisor({}) === null && getTranscriberHealth().status === 'unknown');

// T2. with a model it adopts the (mock) service and maps health
const sup = ensureTranscribeSupervisor({ model: 'small' });
await sleep(300); // first tick probes
rec('T2. supervisor adopts a healthy service → status ok', getTranscriberHealth().status === 'ok', JSON.stringify(getTranscriberHealth()));

svcState = { status: 'downloading', model: 'small', progress: { pct: 41 } };
sup.nudge(); await sleep(300);
rec('T3. downloading state + progress pct surface', getTranscriberHealth().status === 'downloading' && getTranscriberHealth().progress?.pct === 41, JSON.stringify(getTranscriberHealth()));

svcState = { status: 'deps_missing' };
sup.nudge(); await sleep(300);
rec('T4. deps_missing surfaces actionable message', getTranscriberHealth().status === 'deps_missing' && /pip install/.test(getTranscriberHealth().message));
svcState = { status: 'ok', model: 'small' };
sup.nudge(); await sleep(300);

// ── Portal router (in-process express) ──
const settingsStore = {};
const db = {
  users: {
    getSettings: async () => ({ ...settingsStore }),
    updateSettings: async (_u, s) => { Object.assign(settingsStore, s); },
  },
};
const app = express();
app.use(express.json());
app.use('/portal', portalTranscriptionRouter({
  db, userId: 'local-user',
  authenticatePortalRequest: () => ({ id: 'local-user' }),
  detectHardware: async () => ({ memoryGB: 32 }),
}));
const api = createServer(app);
await new Promise((r) => api.listen(18094, '127.0.0.1', r));
const base = 'http://127.0.0.1:18094/portal';

const st = await (await fetch(`${base}/transcription/status`)).json();
rec('R1. status returns health + catalog with RAM-based recommendation',
  st.ok && st.health?.status === 'ok' && st.catalog?.length === 2 && st.catalog.find((c) => c.model === 'large-v3-turbo')?.recommended === true,
  JSON.stringify(st.catalog?.map((c) => [c.model, c.recommended])));

const bad = await fetch(`${base}/transcription/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'huge-v9' }) });
rec('R2. unknown model → 400 (curated catalog only)', bad.status === 400);

const dl = await (await fetch(`${base}/transcription/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'large-v3-turbo' }) })).json();
rec('R3. download persists the choice + proxies the service',
  dl.ok === true && settingsStore.transcribeModel === 'large-v3-turbo' && downloadCalls.some((c) => c.model === 'large-v3-turbo'),
  `setting=${settingsStore.transcribeModel} calls=${JSON.stringify(downloadCalls)}`);

// ── transcribeAudio preference order ──
const wavBuf = Buffer.from('RIFFfakewav');
let llmCalled = false;
const llmFetch = async (url, init) => {
  const u = String(url);
  if (u.includes(`:${PORT}/transcribe`)) {
    // pass through to the real mock service so behavior switching works
    return fetch(url, init);
  }
  if (u.includes('/v1/chat/completions')) {
    llmCalled = true;
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'llm transcript here' } }] }) };
  }
  if (u.includes('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'gemma4:12b' }] }) };
  if (u.includes('/api/show')) return { ok: true, json: async () => ({ capabilities: ['completion', 'audio'] }) };
  return { ok: false, json: async () => ({}) };
};

transcribeBehavior = 'ok'; llmCalled = false;
const t1 = await transcribeAudio({ bytes: wavBuf, mimeType: 'audio/wav', fetch: llmFetch });
rec('A1. whisper healthy → whisper transcript, LLM never called', t1 === 'whisper transcript here' && llmCalled === false, `got="${t1}" llm=${llmCalled}`);

transcribeBehavior = 'fail'; llmCalled = false;
const t2 = await transcribeAudio({ bytes: wavBuf, mimeType: 'audio/wav', fetch: llmFetch });
rec('A2. whisper failure → falls back to the LLM path (never lost)', t2 === 'llm transcript here' && llmCalled === true, `got="${t2}"`);

svcState = { status: 'no_model' };
sup.nudge(); await sleep(300);
transcribeBehavior = 'ok'; llmCalled = false;
const t3 = await transcribeAudio({ bytes: wavBuf, mimeType: 'audio/wav', fetch: llmFetch });
rec('A3. whisper not ready → straight to the LLM path', t3 === 'llm transcript here' && llmCalled === true);

// T5. (static) the python service caps Content-Length BEFORE allocating the
// read buffer — a loopback memory-DoS guard that this hermetic mock (which
// stands in for transcribe-service.py) cannot exercise at runtime.
{
  const { readFileSync } = await import('node:fs');
  const py = readFileSync(new URL('../pipeline/transcribe-service.py', import.meta.url), 'utf8');
  const capPos = py.indexOf('if n > MAX_BODY');
  const readPos = py.indexOf('self.rfile.read(');
  rec('T5. transcribe-service caps Content-Length (413) before rfile.read (loopback DoS guard)',
    /MAX_BODY\s*=/.test(py) && capPos > -1 && readPos > -1 && capPos < readPos);
}

sup.stop(); svc.close(); api.close();
const okAll = ledger.every(Boolean);
console.log(`VERDICT: ${okAll ? 'GO' : 'NO-GO'} — whisper transcription: opt-in supervisor + portal routes + whisper-first fallback chain  EXIT=${okAll ? 0 : 1}`);
process.exit(okAll ? 0 : 1);

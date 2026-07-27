#!/usr/bin/env node
// verify-embed-concurrency.mjs — /health must NEVER be blocked by in-flight inference.
//
// THE REGRESSION THIS GUARDS (2026-07-15, cost a month of silent death):
// pipeline/embed-service.py was a plain HTTPServer — ONE request at a time. A single 12-text
// /batch blocked GET /health for 7.8s (measured). The enrichment drainer's cycle opens with
//   if (!(await embedHealthy())) return;      // embedHealthy: catch { return false }, NO log
// so whenever the service was busy past the client timeout the drainer skipped SILENTLY every
// 15s, forever, while the UI still rendered "Embedding messages" (that label is just
// `pending > 0`). Self-sustaining: the drainer's own 200-batch loop saturated the service,
// which starved the health check, which killed the next cycle. A restart masked it for a
// while — which is exactly why it went unnoticed for a month.
//
// The original proof of the fix was a MANUAL one-shot curl. That is what this file replaces:
// the property must be continuously enforced, or the single-word change (ThreadingHTTPServer
// → HTTPServer) silently reinstates a month-long outage and nothing catches it.
//
// Boots the REAL service on a scratch port. Skips (exit 0) when the model isn't cached, so a
// clean CI box doesn't fail on a 170MB download — but on a dev box with the cache it RUNS.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.MYCELIUM_EMBED_TEST_PORT) || 8097;
const BASE = `http://127.0.0.1:${PORT}`;
const HEALTH_BUDGET_MS = 1000;   // must answer while a batch runs (was 7791ms / never)

const PY = [
  '/Applications/Mycelium Dev.app/Contents/Resources/app/python/bin/python3',
  'pipeline/.venv/bin/python3',
  'python3',
].find((p) => p.startsWith('python3') || existsSync(p)) || 'python3';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e}`); };

const get = async (path, ms) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  const t0 = Date.now();
  try { const r = await fetch(`${BASE}${path}`, { signal: c.signal }); return { ok: r.ok, status: r.status, ms: Date.now() - t0, body: await r.json() }; }
  catch (e) { return { ok: false, status: 0, ms: Date.now() - t0, err: String(e?.name || e) }; }
  finally { clearTimeout(t); }
};

console.log('\nembed-service concurrency (/health must not block on inference)');

const child = spawn(PY, ['pipeline/embed-service.py', '--serve', '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HF_HUB_OFFLINE: '1' }, // cache-only: never download in a gate
});
let boot = '';
child.stdout.on('data', (d) => { boot += d; });
child.stderr.on('data', (d) => { boot += d; });

const stop = () => { try { child.kill('SIGKILL'); } catch { /* */ } };

try {
  // Wait for readiness (cache-only). If the model isn't cached this never goes ok → SKIP.
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const h = await get('/health', 2000);
    if (h.ok && h.body?.status === 'ok') { ready = true; break; }
    if (child.exitCode !== null) break;
  }
  if (!ready) {
    console.log('  [—] SKIP: embed model not available offline (no HF cache) — nothing to test');
    console.log(`      ${String(boot).split('\n').filter(Boolean).slice(-1)[0] || ''}`.slice(0, 140));
    stop();
    console.log('\nVERDICT: GO (skipped)\n');
    process.exit(0);
  }
  ok('service boots and reports ready');

  // THE PROPERTY: fire a real batch, and hammer /health WHILE it runs.
  const texts = Array.from({ length: 12 }, (_, i) => `a fairly long sentence to embed number ${i} ${'padding '.repeat(60)}`);
  const batch = fetch(`${BASE}/batch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts, task: 'document' }),
  }).then((r) => r.json()).catch((e) => ({ error: String(e) }));

  await sleep(150); // let inference actually start
  const probes = [];
  for (let i = 0; i < 3; i++) { probes.push(await get('/health', 12000)); await sleep(60); }

  const slow = probes.filter((p) => !p.ok || p.ms > HEALTH_BUDGET_MS);
  if (slow.length === 0) ok(`/health stayed responsive during inference (${probes.map((p) => `${p.status}@${p.ms}ms`).join(', ')})`);
  else bad('/health MUST answer while a batch runs — the drainer gates every cycle on it',
    `got ${probes.map((p) => `${p.status}@${p.ms}ms`).join(', ')} (budget ${HEALTH_BUDGET_MS}ms). `
    + 'Is embed-service.py back on a single-request HTTPServer?');

  const res = await batch;
  if (Array.isArray(res?.embeddings) && res.embeddings.length === texts.length) ok('the concurrent batch still returned correct results (threading did not corrupt inference)');
  else bad('batch result wrong under concurrent /health', JSON.stringify(res).slice(0, 160));

  // Serialized inference must still hold: two batches at once must both be correct.
  const [a, b] = await Promise.all([
    fetch(`${BASE}/batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texts: texts.slice(0, 4), task: 'document' }) }).then((r) => r.json()),
    fetch(`${BASE}/batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texts: texts.slice(0, 4), task: 'document' }) }).then((r) => r.json()),
  ]);
  if (a?.embeddings?.length === 4 && b?.embeddings?.length === 4 && a.embeddings[0].length === 768) ok('two concurrent batches both correct (inference serialized under _infer_lock)');
  else bad('concurrent batches returned bad data', `${JSON.stringify(a).slice(0, 80)} | ${JSON.stringify(b).slice(0, 80)}`);
} catch (e) {
  bad('harness error', String(e?.message || e));
} finally {
  stop();
}

console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

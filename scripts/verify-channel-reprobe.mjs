#!/usr/bin/env node
// verify-channel-reprobe.mjs — the channel daemon must UPGRADE capture-only → replies-on
// when the model becomes reachable, without a restart.
//
// THE BUG THIS PINS (found live 2026-07-15, urgent since #161). The daemon is spawned BY
// server-rest and probes it for a model within 3s of boot — but on a 2GB vault the server
// is still opening/migrating, so the probe times out and the daemon LATCHED capture-only
// for its entire life: telegram received every message and silently never replied, while
// the Channels card said "select an AI model to enable replies" — advice that could not
// work because nothing ever re-checked. And since #161 supervises server-rest (auto
// respawn), every respawn re-rolled this race. The fix re-probes until the model is
// reachable and swaps the reply pipeline in LIVE (handlers hold a trampoline; /healthz
// reads the shared replies object per request).
//
// Drives the REAL buildDaemon against a stub vault server whose /internal/agent/
// model-status flips hasModel false → true mid-run. No mocks of the daemon itself.

import http from 'node:http';
import assert from 'node:assert/strict';
import { buildDaemon } from '../packages/channel-daemon/index.js';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── stub vault/server: model-status flips on demand; everything else 200 {} ─────
let hasModel = false;
let probes = 0;
const stub = http.createServer((req, res) => {
  if (req.url === '/internal/agent/model-status') {
    probes++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ hasModel }));
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end('{}');
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${stub.address().port}`;

const cfg = {
  vaultBaseUrl: base,
  channelRouter: 'native',       // the production default path (the one that latched)
  modelRecheckMs: 40,            // fast re-probe for the test; prod default 15s
  coalesceWindowMs: 0,
  rateLimitMax: 5,
  rateLimitWindowMs: 1000,
  agentId: 'test-agent',
  // buildDaemon requires ≥1 platform (createDaemonApp needs a send handler). The token
  // is fake and the poller is returned UNSTARTED — nothing here touches the network.
  botToken: 'test:fake-token-never-polled',
  ownerTelegramId: '1',
};

console.log('\nchannel daemon re-probe (capture-only must be able to HEAL)');

const daemon = await buildDaemon(cfg);
const app = http.createServer(daemon.app);
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const healthz = async () => (await (await fetch(`http://127.0.0.1:${app.address().port}/healthz`)).json());

await t('boot with NO model reachable → honestly capture-only (RT4-B1 preserved)', async () => {
  const h = await healthz();
  assert.equal(h.replies, 'capture-only', 'must never claim replies before a model is reachable');
  assert.equal(h.backend, null);
});

await t('the daemon KEEPS PROBING (the old code probed exactly once, then gave up forever)', async () => {
  const before = probes;
  await sleep(150);
  assert.ok(probes > before, `expected re-probes after boot; got none (probes=${probes}) — the boot-race latch is back`);
});

await t('model becomes reachable → upgrades to replies-on LIVE, no restart', async () => {
  hasModel = true;
  const deadline = Date.now() + 3000;
  let h = null;
  while (Date.now() < deadline) {
    h = await healthz();
    if (h.replies === 'on') break;
    await sleep(40);
  }
  assert.equal(h?.replies, 'on', `healthz still says ${h?.replies} 3s after the model appeared`);
  assert.equal(h?.backend, 'native', 'the upgraded lane is the native backend');
});

await t('the re-probe STOPS once upgraded (no probe churn forever after)', async () => {
  await sleep(120);
  const settled = probes;
  await sleep(150);
  assert.equal(probes, settled, 'probing must stop after the upgrade');
});

await t('lastTurn stays wired across the late lane build (getLastTurn is a closure, not a boot snapshot)', async () => {
  const h = await healthz();
  assert.ok('lastTurn' in h, 'healthz keeps its lastTurn field');
  assert.equal(h.lastTurn, null, 'no turn has run — null, not undefined/crash');
});

app.close(); stub.close();
// The daemon's poller/gateway were never started (no tokens); its re-probe timer is
// cleared on upgrade and unref'd besides — nothing holds the process open.
console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

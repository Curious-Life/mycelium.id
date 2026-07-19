#!/usr/bin/env node
// smoke-relay.mjs — prove the E2E dial-out relay is LIVE after a control-plane deploy.
// Run against the deployed control plane (edge or loopback), e.g.:
//   node scripts/smoke-relay.mjs https://connect.mycelium.id:8443
//   node scripts/smoke-relay.mjs http://127.0.0.1:8790     (on the VPS, before the edge)
//
// Read-only: it does NOT mutate any registry / provision anything. It confirms the
// route is mounted + reachable + fail-closed. A FULL box↔phone round-trip needs a
// real box dialed in (that's the app smoke, not this).

const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!base) { console.error('usage: node scripts/smoke-relay.mjs <control-plane-base-url>'); process.exit(2); }

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(Boolean(p)); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const get = (p, opts) => fetch(`${base}${p}`, opts);

try {
  // 1. control plane reachable + issues challenge nonces (the box needs these to connect)
  const ch = await get('/v1/challenge');
  const cj = await ch.json().catch(() => ({}));
  rec('S1 /v1/challenge reachable + issues a nonce', ch.status === 200 && typeof cj.nonce === 'string', `status=${ch.status}`);

  // 2. the relay router is MOUNTED (edge routes /relay/*) and recv is fail-closed
  const recv = await get('/relay/recv');
  rec('S2 /relay/recv mounted + rejects a missing session token (401)', recv.status === 401, `status=${recv.status}`);

  // 3. /send is routed + validates input (400 on a bad frame, never a 404)
  const send = await get('/relay/smoketest/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  rec('S3 /relay/:handle/send is routed (400 bad frame, not 404)', send.status === 400, `status=${send.status}`);

  // 4. reply is fail-closed too
  const reply = await get('/relay/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reqId: 'x', frame: {} }) });
  rec('S4 /relay/reply rejects a missing session token (401)', reply.status === 401, `status=${reply.status}`);
} catch (e) {
  rec('S0 control plane reachable', false, e.message);
}

const allPass = ledger.length > 0 && ledger.every(Boolean);
console.log('\n' + '='.repeat(60));
console.log(allPass
  ? `LIVE — the E2E dial-out relay is deployed + reachable at ${base}`
  : `NOT READY — see FAIL rows (route not mounted? edge not reloaded? service not restarted?)`);
console.log('='.repeat(60));
process.exit(allPass ? 0 : 1);

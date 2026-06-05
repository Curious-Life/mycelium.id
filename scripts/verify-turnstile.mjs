// verify:turnstile — the Cloudflare Turnstile bot-gate (O2 / SEC-4).
//   Unit (the verifier — mycelium-managed/src/turnstile.js):
//   T1 OPT-IN: no secret + no mock → disabled, verify() passes through (true)
//   T2 MOCK (hermetic CI, mirrors MYC_ACME_DNS_MOCK): enabled; only 'mock-pass' passes
//   T3 FAIL-CLOSED on absent/empty token even when enabled
//   T4 REAL secret (mock fetch): siteverify success:true → true
//   T5 FAIL-CLOSED on siteverify success:false (bad/expired/forged token)
//   T6 FAIL-CLOSED on network/parse error (never throws → reject)
//   T7 the remoteip is forwarded to siteverify (Cloudflare scopes the token to the IP)
//   Integration (the control-plane gate — mycelium-managed/src/server.js):
//   T8 gate OFF (back-compat / self-hosted): /v1/challenge issues a nonce with no token
//   T9 gate ON, NO token → 403 'bot check failed', NO nonce leaked
//   T10 gate ON, BAD token → 403 (fail-closed)
//   T11 gate ON, GOOD token → 200 nonce; that nonce then provisions (proof carried forward)
//   T12 LEAK: the secret never appears in any response body
// In-process Express on 127.0.0.1:0 + mocks; no Cloudflare contact (mock fetch / mock gate).
import crypto from 'node:crypto';
import os from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createTurnstileVerifier } from '../mycelium-managed/src/turnstile.js';
import { openRegistry } from '../mycelium-managed/src/registry.js';
import { createNonceStore } from '../mycelium-managed/src/nonce.js';
import { createDnsClient } from '../mycelium-managed/src/dns.js';
import { createAcmeDnsClient } from '../mycelium-managed/src/acmedns.js';
import { createControlPlane } from '../mycelium-managed/src/server.js';
import { createRateLimiter, createDailyCap } from '../mycelium-managed/src/ratelimit.js';
import { buildClaim } from '../src/remote/managed-claim.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// ── Unit: the verifier ──────────────────────────────────────────────────────
const off = createTurnstileVerifier({});
rec('T1. opt-in: no secret/mock → disabled, verify() passes through',
  off.enabled === false && (await off.verify('')) === true && (await off.verify('anything')) === true,
  `enabled=${off.enabled}`);

const mock = createTurnstileVerifier({ mock: true });
rec('T2. mock: enabled; only "mock-pass" passes (hermetic)',
  mock.enabled === true && (await mock.verify('mock-pass')) === true && (await mock.verify('nope')) === false,
  `enabled=${mock.enabled}`);

rec('T3. fail-closed on absent/empty token when enabled',
  (await mock.verify('')) === false && (await mock.verify(undefined)) === false && (await mock.verify(null)) === false, '');

const okFetch = async () => ({ json: async () => ({ success: true }) });
const noFetch = async () => ({ json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) });
const throwFetch = async () => { throw new Error('network down'); };
const badJson = async () => ({ json: async () => { throw new Error('not json'); } });

const sOk = createTurnstileVerifier({ secret: 'top-secret', fetch: okFetch });
rec('T4. real secret + siteverify success:true → true', sOk.enabled === true && (await sOk.verify('tok')) === true, '');

const sNo = createTurnstileVerifier({ secret: 'top-secret', fetch: noFetch });
rec('T5. fail-closed on siteverify success:false', (await sNo.verify('tok')) === false, '');

const sErr = createTurnstileVerifier({ secret: 'top-secret', fetch: throwFetch });
const sBad = createTurnstileVerifier({ secret: 'top-secret', fetch: badJson });
rec('T6. fail-closed on network/parse error (never throws)',
  (await sErr.verify('tok')) === false && (await sBad.verify('tok')) === false, '');

// T7 — the remoteip rides along to siteverify (Cloudflare can scope to IP).
let sentBody = null, sentSecret = null;
const captureFetch = async (_url, opts) => {
  const params = new URLSearchParams(opts.body.toString());
  sentBody = params.get('remoteip'); sentSecret = params.get('secret');
  return { json: async () => ({ success: true }) };
};
const sCap = createTurnstileVerifier({ secret: 'top-secret', fetch: captureFetch });
await sCap.verify('tok', '198.51.100.4');
rec('T7. remoteip forwarded to siteverify; secret in POST body (not URL)',
  sentBody === '198.51.100.4' && sentSecret === 'top-secret', `remoteip=${sentBody}`);

// ── Integration: the control-plane gate ─────────────────────────────────────
const DB = join(os.tmpdir(), `myc-turnstile-${process.pid}.db`);
rmSync(DB, { force: true });
const registry = openRegistry(DB);
const dnsRecords = [];

function mkPlane(turnstile) {
  const nonces = createNonceStore();
  const dns = createDnsClient({ provider: 'mock', zone: 'mycelium.id', relayIp: '203.0.113.7', records: dnsRecords });
  const acmeDns = createAcmeDnsClient({ mock: true });
  const { app } = createControlPlane({
    registry, dns, acmeDns, nonces, relayAddr: 'relay.mycelium.id:7000', zone: 'mycelium.id',
    acmeDnsServer: 'https://acme-dns.mycelium.id',
    rateLimit: createRateLimiter({ capacity: 1000, refillPerMin: 1000 }), dailyCap: createDailyCap({ max: 1000 }),
    turnstile,
  });
  return app;
}
const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const getRaw = async (u) => { const r = await fetch(u); return { status: r.status, text: await r.text() }; };
const postJson = async (u, body) => { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };

const offServer = await listen(mkPlane(createTurnstileVerifier({})));
const onServer = await listen(mkPlane(createTurnstileVerifier({ secret: 'GATE-SECRET-DO-NOT-LEAK', fetch: okFetch })));
const OFF = `http://127.0.0.1:${offServer.address().port}`;
const ON = `http://127.0.0.1:${onServer.address().port}`;

try {
  // T8 — gate off: challenge works with no token (back-compat / self-hosted).
  const c8 = await getRaw(`${OFF}/v1/challenge`);
  const n8 = JSON.parse(c8.text);
  rec('T8. gate OFF → /v1/challenge issues a nonce, no token needed',
    c8.status === 200 && typeof n8.nonce === 'string' && n8.nonce.length >= 8, `status=${c8.status}`);

  // T9 — gate on, no token → 403, no nonce.
  const c9 = await getRaw(`${ON}/v1/challenge`);
  rec('T9. gate ON + no token → 403, no nonce leaked',
    c9.status === 403 && !/nonce/.test(c9.text), `status=${c9.status} body=${c9.text}`);

  // T10 — gate on, bad token → 403.
  const c10 = await getRaw(`${ON}/v1/challenge?cf_turnstile=${encodeURIComponent('')}`);
  // okFetch always returns success — so to force a fail-closed at the gate we use a
  // server whose fetch rejects the token:
  const noServer = await listen(mkPlane(createTurnstileVerifier({ secret: 'GATE-SECRET-DO-NOT-LEAK', fetch: noFetch })));
  const NO = `http://127.0.0.1:${noServer.address().port}`;
  const c10b = await getRaw(`${NO}/v1/challenge?cf_turnstile=bad-token`);
  noServer.close();
  rec('T10. gate ON + bad/empty token → 403 (fail-closed)',
    c10.status === 403 && c10b.status === 403, `empty=${c10.status} bad=${c10b.status}`);

  // T11 — gate on, good token → 200 nonce; that nonce provisions (proof carried forward).
  const c11 = await getRaw(`${ON}/v1/challenge?cf_turnstile=good-token`);
  const n11 = JSON.parse(c11.text);
  const master = crypto.randomBytes(32).toString('hex');
  const claim = buildClaim({ action: 'provision', handle: 'gated', nonce: n11.nonce, masterHex: master });
  const prov = await postJson(`${ON}/v1/provision`, claim);
  rec('T11. gate ON + good token → 200 nonce; nonce provisions (single-side proof carried forward)',
    c11.status === 200 && typeof n11.nonce === 'string' && prov.status === 200 && prov.data.host === 'gated.mycelium.id',
    `chStatus=${c11.status} provStatus=${prov.status} host=${prov.data.host}`);

  // T12 — the secret never appears in any response body.
  const bodies = [c8.text, c9.text, c10.text, c11.text, JSON.stringify(prov.data)].join('\n');
  rec('T12. LEAK: the Turnstile secret never appears in any response body',
    !bodies.includes('GATE-SECRET-DO-NOT-LEAK') && !bodies.includes('top-secret'), '');
} finally {
  try { offServer.close(); onServer.close(); registry.close(); rmSync(DB, { force: true }); } catch { /* */ }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — Turnstile bot-gate: opt-in, fail-closed, secret-tight, single-side proof' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

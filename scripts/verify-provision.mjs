// verify:provision — the managed control-plane provision flow (mocked DNS+acme-dns).
//   P1 /v1/challenge issues a nonce
//   P2 a signed claim provisions: 200 + host/relayAddr/relayToken/acmeDns; 2 DNS records; registry row
//   P3 replaying the same nonce is rejected (single-use)
//   P4 a different key claiming the same handle → 409
//   P5 the same key re-provisions (fresh nonce) → 200 reclaimed, token rotated
//   P6 a tampered signature → 401
//   P7 /v1/handle availability reflects the registry + reserved names
// In-process Express on 127.0.0.1:0 + mocks; no real network. Uses the SAME
// buildClaim the client uses → proves both sides agree on the claim message.
import crypto from 'node:crypto';
import os from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openRegistry } from '../mycelium-managed/src/registry.js';
import { createNonceStore } from '../mycelium-managed/src/nonce.js';
import { createDnsClient } from '../mycelium-managed/src/dns.js';
import { createAcmeDnsClient } from '../mycelium-managed/src/acmedns.js';
import { createControlPlane } from '../mycelium-managed/src/server.js';
import { buildClaim } from '../src/remote/managed-claim.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const DB = join(os.tmpdir(), `myc-reg-${process.pid}.db`);
rmSync(DB, { force: true });

const registry = openRegistry(DB);
const nonces = createNonceStore();
const dnsRecords = [];
const dns = createDnsClient({ provider: 'mock', zone: 'mycelium.id', relayIp: '203.0.113.7', records: dnsRecords });
const acmeDns = createAcmeDnsClient({ mock: true });
const { app } = createControlPlane({ registry, dns, acmeDns, nonces, relayAddr: 'relay.mycelium.id:7000', zone: 'mycelium.id', acmeDnsServer: 'https://acme-dns.mycelium.id' });

const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;
const getJson = async (u) => (await fetch(u)).json();
const postJson = async (u, body) => { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };

try {
  const masterA = crypto.randomBytes(32).toString('hex');
  const masterB = crypto.randomBytes(32).toString('hex');

  const ch1 = await getJson(`${BASE}/v1/challenge`);
  rec('P1. /v1/challenge issues a nonce', typeof ch1.nonce === 'string' && ch1.nonce.length >= 8, `nonceLen=${ch1.nonce?.length}`);

  const claimA = buildClaim({ handle: 'alice', nonce: ch1.nonce, masterHex: masterA });
  const p2 = await postJson(`${BASE}/v1/provision`, claimA);
  const okShape = p2.data.host === 'alice.mycelium.id' && p2.data.relayAddr === 'relay.mycelium.id:7000' && !!p2.data.relayToken && !!p2.data.acmeDns?.username;
  const dns2 = dnsRecords.filter((r) => r.name.includes('alice'));
  rec('P2. signed claim provisions + 2 DNS records + registry row',
    p2.status === 200 && okShape && dns2.length === 2 && !!registry.get('alice'),
    `status=${p2.status} host=${p2.data.host} dnsRecs=${dns2.length}`);

  const p3 = await postJson(`${BASE}/v1/provision`, claimA);
  rec('P3. replay same nonce → rejected (single-use)', p3.status === 401, `status=${p3.status}`);

  const ch4 = await getJson(`${BASE}/v1/challenge`);
  const claimB = buildClaim({ handle: 'alice', nonce: ch4.nonce, masterHex: masterB });
  const p4 = await postJson(`${BASE}/v1/provision`, claimB);
  rec('P4. different key claiming a taken handle → 409', p4.status === 409, `status=${p4.status}`);

  const ch5 = await getJson(`${BASE}/v1/challenge`);
  const before = registry.get('alice').frps_token;
  const p5 = await postJson(`${BASE}/v1/provision`, buildClaim({ handle: 'alice', nonce: ch5.nonce, masterHex: masterA }));
  const after = registry.get('alice').frps_token;
  rec('P5. same key re-provisions → 200 reclaimed, token rotated',
    p5.status === 200 && p5.data.reclaimed === true && after !== before, `status=${p5.status} rotated=${after !== before}`);

  const ch6 = await getJson(`${BASE}/v1/challenge`);
  const claimC = buildClaim({ handle: 'carol', nonce: ch6.nonce, masterHex: masterB });
  const p6 = await postJson(`${BASE}/v1/provision`, { ...claimC, signature: `${claimC.signature.slice(0, -2)}AA` });
  rec('P6. tampered signature → 401', p6.status === 401, `status=${p6.status}`);

  const a1 = await getJson(`${BASE}/v1/handle/alice`);
  const a2 = await getJson(`${BASE}/v1/handle/bobby`);
  const a3 = await getJson(`${BASE}/v1/handle/admin`);
  rec('P7. availability reflects registry + reserved names',
    a1.available === false && a2.available === true && a3.available === false,
    `alice=${a1.available} bobby=${a2.available} admin=${a3.available}`);
} finally {
  try { server.close(); registry.close(); rmSync(DB, { force: true }); } catch { /* */ }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — control-plane provisions; nonce single-use; per-key handle binding' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

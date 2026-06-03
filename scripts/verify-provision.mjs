// verify:provision — the managed control-plane flow (mocked DNS+acme-dns).
//   P1 /v1/challenge issues a nonce
//   P2 a signed provision claim provisions: 200 + host/relay/token/acmeDns; 2 DNS records; finalized registry row
//   P3 replaying the same nonce is rejected (single-use)
//   P4 a different key claiming the same handle → 409 (and NO extra DNS side-effects)
//   P5 the same key re-provisions (fresh nonce) → 200 reclaimed, token rotated
//   P6 a tampered signature → 401
//   P7 /v1/handle availability reflects the registry + reserved names
//   P8 ACTION-CONFUSION: a provision-signed claim POSTed to /release → 401 (action-bound)
//   P9 RELEASE: tears down DNS + drops the registry row (handle freed)
//   P10 rate limiter: capacity exhausted → blocks
//   P11 daily cap: max reached → blocks; refund restores
// In-process Express on 127.0.0.1:0 + mocks; uses the SAME buildClaim the client uses.
import crypto from 'node:crypto';
import os from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openRegistry } from '../mycelium-managed/src/registry.js';
import { createNonceStore } from '../mycelium-managed/src/nonce.js';
import { createDnsClient } from '../mycelium-managed/src/dns.js';
import { createAcmeDnsClient } from '../mycelium-managed/src/acmedns.js';
import { createControlPlane } from '../mycelium-managed/src/server.js';
import { createRateLimiter, createDailyCap } from '../mycelium-managed/src/ratelimit.js';
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
// Generous limits so the functional tests aren't throttled; abuse controls get their own pure tests (P10/P11).
const { app } = createControlPlane({
  registry, dns, acmeDns, nonces, relayAddr: 'relay.mycelium.id:7000', zone: 'mycelium.id', acmeDnsServer: 'https://acme-dns.mycelium.id',
  rateLimit: createRateLimiter({ capacity: 1000, refillPerMin: 1000 }), dailyCap: createDailyCap({ max: 1000 }),
});

const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;
const getJson = async (u) => (await fetch(u)).json();
const postJson = async (u, body) => { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
const aliceRecs = () => dnsRecords.filter((r) => r.name.includes('alice'));

try {
  const masterA = crypto.randomBytes(32).toString('hex');
  const masterB = crypto.randomBytes(32).toString('hex');

  const ch1 = await getJson(`${BASE}/v1/challenge`);
  rec('P1. /v1/challenge issues a nonce', typeof ch1.nonce === 'string' && ch1.nonce.length >= 8, `nonceLen=${ch1.nonce?.length}`);

  const claimA = buildClaim({ action: 'provision', handle: 'alice', nonce: ch1.nonce, masterHex: masterA });
  const p2 = await postJson(`${BASE}/v1/provision`, claimA);
  const okShape = p2.data.host === 'alice.mycelium.id' && p2.data.relayAddr === 'relay.mycelium.id:7000' && !!p2.data.relayToken && !!p2.data.acmeDns?.username;
  rec('P2. provision claim → 200; 2 DNS records; finalized registry row',
    p2.status === 200 && okShape && aliceRecs().length === 2 && !!registry.get('alice')?.frps_token,
    `status=${p2.status} host=${p2.data.host} dnsRecs=${aliceRecs().length} token=${!!registry.get('alice')?.frps_token}`);

  const p3 = await postJson(`${BASE}/v1/provision`, claimA);
  rec('P3. replay same nonce → rejected (single-use)', p3.status === 401, `status=${p3.status}`);

  const ch4 = await getJson(`${BASE}/v1/challenge`);
  const recsBeforeP4 = aliceRecs().length;
  const p4 = await postJson(`${BASE}/v1/provision`, buildClaim({ action: 'provision', handle: 'alice', nonce: ch4.nonce, masterHex: masterB }));
  rec('P4. different key claiming a taken handle → 409, no extra DNS side-effects', p4.status === 409 && aliceRecs().length === recsBeforeP4, `status=${p4.status} recs=${aliceRecs().length}`);

  const ch5 = await getJson(`${BASE}/v1/challenge`);
  const before = registry.get('alice').frps_token;
  const p5 = await postJson(`${BASE}/v1/provision`, buildClaim({ action: 'provision', handle: 'alice', nonce: ch5.nonce, masterHex: masterA }));
  const after = registry.get('alice').frps_token;
  rec('P5. same key re-provisions → 200 reclaimed, token rotated', p5.status === 200 && p5.data.reclaimed === true && after !== before, `status=${p5.status} rotated=${after !== before}`);

  const ch6 = await getJson(`${BASE}/v1/challenge`);
  const claimC = buildClaim({ action: 'provision', handle: 'carol', nonce: ch6.nonce, masterHex: masterB });
  const p6 = await postJson(`${BASE}/v1/provision`, { ...claimC, signature: `${claimC.signature.slice(0, -2)}AA` });
  rec('P6. tampered signature → 401', p6.status === 401, `status=${p6.status}`);

  const a1 = await getJson(`${BASE}/v1/handle/alice`);
  const a2 = await getJson(`${BASE}/v1/handle/bobby`);
  const a3 = await getJson(`${BASE}/v1/handle/admin`);
  rec('P7. availability reflects registry + reserved names', a1.available === false && a2.available === true && a3.available === false, `alice=${a1.available} bobby=${a2.available} admin=${a3.available}`);

  // P8 — action confusion: a PROVISION-signed claim sent to /release must fail.
  const ch8 = await getJson(`${BASE}/v1/challenge`);
  const provForRelease = buildClaim({ action: 'provision', handle: 'erin', nonce: ch8.nonce, masterHex: masterA });
  const p8 = await postJson(`${BASE}/v1/release`, provForRelease);
  rec('P8. provision claim replayed to /release → 401 (action-bound)', p8.status === 401, `status=${p8.status}`);

  // P9 — release tears down DNS + drops the row.
  const ch9 = await getJson(`${BASE}/v1/challenge`);
  const relClaim = buildClaim({ action: 'release', handle: 'alice', nonce: ch9.nonce, masterHex: masterA });
  const p9 = await postJson(`${BASE}/v1/release`, relClaim);
  rec('P9. release → 200; DNS torn down; registry row gone; handle freed',
    p9.status === 200 && aliceRecs().length === 0 && !registry.get('alice'),
    `status=${p9.status} aliceRecs=${aliceRecs().length} row=${!!registry.get('alice')}`);

  // P10 — rate limiter blocks past capacity.
  const rl = createRateLimiter({ capacity: 2, refillPerMin: 0 });
  rec('P10. rate limiter: capacity 2 → 3rd request blocked', rl.allow('x') && rl.allow('x') && !rl.allow('x'), '');

  // P11 — daily cap blocks, refund restores.
  const cap = createDailyCap({ max: 1 });
  const t1 = cap.tryConsume(); const t2 = cap.tryConsume(); cap.refund(); const t3 = cap.tryConsume();
  rec('P11. daily cap: max 1 → 2nd blocked; refund restores', t1 === true && t2 === false && t3 === true, `t1=${t1} t2=${t2} t3=${t3}`);

  // P12 — registry-backed nonce store: HA (a nonce issued by one instance is
  // consumable by ANOTHER sharing the DB) + single-use across instances.
  const ns1 = createNonceStore({ db: registry.db });
  const ns2 = createNonceStore({ db: registry.db });
  const hn = ns1.issue();
  const crossConsume = ns2.consume(hn); // different instance, same DB
  const replay = ns1.consume(hn);       // already consumed → false
  rec('P12. registry-backed nonce: cross-instance consume once (HA), replay rejected',
    crossConsume === true && replay === false, `cross=${crossConsume} replay=${replay}`);

  // P13 — a name already present in the zone (legacy site / infra) is refused even
  // though it's not in the registry or RESERVED: auto-collision via live DNS. The
  // claim is rolled back and NO new records are created.
  dnsRecords.push({ type: 'A', name: 'legacy.mycelium.id', content: '198.51.100.9' });
  const avLegacy = await getJson(`${BASE}/v1/handle/legacy`);
  const ch13 = await getJson(`${BASE}/v1/challenge`);
  const p13 = await postJson(`${BASE}/v1/provision`, buildClaim({ action: 'provision', handle: 'legacy', nonce: ch13.nonce, masterHex: masterB }));
  const legacyRecs = dnsRecords.filter((r) => r.name.includes('legacy')).length;
  rec('P13. pre-existing zone record → unavailable + provision refused (claim rolled back, no new records)',
    avLegacy.available === false && p13.status === 409 && !registry.get('legacy') && legacyRecs === 1,
    `avail=${avLegacy.available} status=${p13.status} row=${!!registry.get('legacy')} recs=${legacyRecs}`);
} finally {
  try { server.close(); registry.close(); rmSync(DB, { force: true }); } catch { /* */ }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — provision/release hardened: action-bound, single-use, per-key, rate-limited, teardown' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

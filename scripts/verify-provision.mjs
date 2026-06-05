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
import { createBilling } from '../mycelium-managed/src/billing.js';
import { buildClaim } from '../src/remote/managed-claim.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const DB = join(os.tmpdir(), `myc-reg-${process.pid}.db`);
const DB2 = join(os.tmpdir(), `myc-reg-pay-${process.pid}.db`);
rmSync(DB, { force: true });
rmSync(DB2, { force: true });

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
  // Tamper DETERMINISTICALLY: flip the FIRST base64url char (full 6-bit entropy →
  // always changes signature byte 0 → ed25519 always rejects). The old
  // slice(0,-2)+'AA' tamper was a silent no-op ~6% of the time — a 64-byte sig's
  // LAST char has only 4 valid values, so it often already ended in 'A', leaving
  // the (still-valid) signature unchanged and flaking P6 to a false 200.
  const tampered = (claimC.signature[0] === 'A' ? 'B' : 'A') + claimC.signature.slice(1);
  const p6 = await postJson(`${BASE}/v1/provision`, { ...claimC, signature: tampered });
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

  // ── P14–P16 — reserve-then-pay (O4/O5) on a SECOND, billing-ENABLED plane ──
  // (The plane above has billing off → P1–P13 provision for free, unchanged.)
  const reg2 = openRegistry(DB2);
  const recs2 = [];
  const dns2 = createDnsClient({ provider: 'mock', zone: 'mycelium.id', relayIp: '203.0.113.7', records: recs2 });
  const WH2 = 'whsec_test_secret';
  let checkoutCalls = 0;
  const billing = createBilling({
    secret: 'sk_test', webhookSecret: WH2, priceMonthly: 'price_m',
    returnUrl: 'https://connect.mycelium.id/billing/return',
    fetch: async (url) => {
      if (url.endsWith('/checkout/sessions')) { checkoutCalls++; return { ok: true, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_1', id: 'cs_1' }) }; }
      return { ok: true, json: async () => ({}) };
    },
  });
  const { app: app2 } = createControlPlane({
    registry: reg2, dns: dns2, acmeDns, nonces: createNonceStore(), relayAddr: 'relay.mycelium.id:7000',
    zone: 'mycelium.id', acmeDnsServer: 'https://acme-dns.mycelium.id',
    rateLimit: createRateLimiter({ capacity: 1000, refillPerMin: 1000 }), dailyCap: createDailyCap({ max: 1000 }), billing,
  });
  const server2 = await new Promise((r) => { const s = app2.listen(0, '127.0.0.1', () => r(s)); });
  const B2 = `http://127.0.0.1:${server2.address().port}`;
  const daveRecs = () => recs2.filter((r) => r.name.includes('dave'));
  try {
    const masterD = crypto.randomBytes(32).toString('hex');
    const claimSpec = (nonce) => buildClaim({ action: 'provision', handle: 'dave', nonce, masterHex: masterD });

    // P14 — unpaid → 402 + checkoutUrl; placeholder HELD (no token, hold set); no DNS, no cap spend.
    const cN1 = await getJson(`${B2}/v1/challenge`);
    const claimD = claimSpec(cN1.nonce);
    const pkDave = claimD.publicKey;
    const p14 = await postJson(`${B2}/v1/provision`, claimD);
    const row14 = reg2.get('dave');
    rec('P14. billing on + unpaid → 402 checkoutUrl; placeholder held; no side-effects',
      p14.status === 402 && typeof p14.data.checkoutUrl === 'string' && p14.data.checkoutUrl.startsWith('https://checkout.stripe.com/')
      && checkoutCalls === 1 && !!row14 && row14.frps_token === '' && row14.hold_expires_at != null && daveRecs().length === 0,
      `status=${p14.status} held=${row14?.hold_expires_at != null} recs=${daveRecs().length} calls=${checkoutCalls}`);

    // P15 — a SIGNED Stripe webhook entitles the key; re-provision now completes (no 2nd checkout).
    const evt = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { client_reference_id: pkDave, customer: 'cus_dave' } } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', WH2).update(`${ts}.${evt}`).digest('hex');
    const whRes = await fetch(`${B2}/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` }, body: evt });
    const entitledNow = reg2.getEntitlement(pkDave);
    const cN2 = await getJson(`${B2}/v1/challenge`);
    const p15 = await postJson(`${B2}/v1/provision`, claimSpec(cN2.nonce));
    const row15 = reg2.get('dave');
    rec('P15. signed webhook → entitled; re-provision → 200 finalized; no 2nd checkout',
      whRes.status === 200 && !!entitledNow && Number(entitledNow.paid_until) > Date.now()
      && p15.status === 200 && p15.data.host === 'dave.mycelium.id' && !!row15.frps_token && row15.hold_expires_at == null
      && daveRecs().length === 2 && checkoutCalls === 1,
      `wh=${whRes.status} prov=${p15.status} token=${!!row15.frps_token} recs=${daveRecs().length} calls=${checkoutCalls}`);

    // P16 — an entitled reclaim rotates the token WITHOUT a new Checkout (no double-charge).
    const cN3 = await getJson(`${B2}/v1/challenge`);
    const before = reg2.get('dave').frps_token;
    const p16 = await postJson(`${B2}/v1/provision`, claimSpec(cN3.nonce));
    rec('P16. entitled reclaim → 200, token rotated, NO new checkout (no double-charge)',
      p16.status === 200 && p16.data.reclaimed === true && reg2.get('dave').frps_token !== before && checkoutCalls === 1,
      `status=${p16.status} calls=${checkoutCalls}`);

    // P17 — a forged webhook signature changes nothing (fail-closed at the boundary).
    const forged = await fetch(`${B2}/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${'0'.repeat(64)}` }, body: evt });
    rec('P17. forged webhook signature → 400, no entitlement mutation', forged.status === 400, `status=${forged.status}`);
  } finally {
    try { server2.close(); reg2.close(); rmSync(DB2, { force: true }); } catch { /* */ }
  }
} finally {
  try { server.close(); registry.close(); rmSync(DB, { force: true }); } catch { /* */ }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — provision/release hardened: action-bound, single-use, per-key, rate-limited, teardown' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

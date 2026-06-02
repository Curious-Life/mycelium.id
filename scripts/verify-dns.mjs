// verify:dns — the real DNS-provider request shapes (Cloudflare DNS-only + deSEC),
// exercised by STUBBING global fetch and asserting the calls createDnsClient makes.
// No live creds / network — closes the "real-provider DNS untested (mock only)"
// residual by pinning the request shapes (incl. Cloudflare proxied:false / grey).
import { createDnsClient } from '../mycelium-managed/src/dns.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

let calls = [];
const orig = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, auth: (opts.headers || {}).authorization });
  return { ok: true, status: 200, json: async () => ({ result: [{ id: 'rec-1' }] }) };
};

try {
  process.env.MYC_CF_ZONE_ID = 'zone123';
  const ZONE = 'mycelium.id';
  const IP = '203.0.113.7';
  const FULL = 'sub-1.auth.mycelium.id';

  // ── Cloudflare (must be DNS-only / proxied:false) ──
  const cf = createDnsClient({ provider: 'cloudflare', token: 'cf-tok', zone: ZONE, relayIp: IP });
  calls = [];
  await cf.createHandleRecords({ handle: 'alice', acmeFulldomain: FULL });
  const posts = calls.filter((c) => c.method === 'POST');
  const aRec = posts.find((c) => c.body?.type === 'A');
  const cRec = posts.find((c) => c.body?.type === 'CNAME');
  rec('DNS1. CF create: 2 records, grey (proxied:false), correct A + CNAME, Bearer auth',
    posts.length === 2
    && aRec?.url.includes('/zones/zone123/dns_records') && aRec.body.name === 'alice.mycelium.id' && aRec.body.content === IP && aRec.body.proxied === false
    && cRec?.body.name === '_acme-challenge.alice.mycelium.id' && cRec.body.content === FULL && cRec.body.proxied === false
    && aRec.auth === 'Bearer cf-tok',
    `posts=${posts.length}`);

  calls = [];
  await cf.deleteHandleRecords({ handle: 'alice' });
  const gets = calls.filter((c) => c.method === 'GET');
  const dels = calls.filter((c) => c.method === 'DELETE');
  rec('DNS2. CF delete: GET-by-name then DELETE-by-id, both records',
    gets.length === 2 && dels.length === 2
    && gets.some((c) => c.url.includes('name=alice.mycelium.id')) && gets.some((c) => c.url.includes('name=_acme-challenge.alice.mycelium.id'))
    && dels.every((c) => c.url.includes('/dns_records/rec-1')),
    `gets=${gets.length} dels=${dels.length}`);

  // ── deSEC ──
  const de = createDnsClient({ provider: 'desec', token: 'de-tok', zone: ZONE, relayIp: IP });
  calls = [];
  await de.createHandleRecords({ handle: 'bob', acmeFulldomain: FULL });
  const dp = calls.filter((c) => c.method === 'POST');
  const da = dp.find((c) => c.body?.type === 'A');
  const dc = dp.find((c) => c.body?.type === 'CNAME');
  rec('DNS3. deSEC create: 2 rrsets, subname + records (CNAME trailing dot), Token auth',
    dp.length === 2
    && da?.url.includes('/domains/mycelium.id/rrsets/') && da.body.subname === 'bob' && da.body.records[0] === IP
    && dc?.body.subname === '_acme-challenge.bob' && dc.body.records[0] === `${FULL}.`
    && da.auth === 'Token de-tok',
    `posts=${dp.length}`);

  calls = [];
  await de.deleteHandleRecords({ handle: 'bob' });
  const dd = calls.filter((c) => c.method === 'DELETE');
  rec('DNS4. deSEC delete: DELETE rrsets/<subname>/<type>/ for A + CNAME',
    dd.length === 2
    && dd.some((c) => c.url.includes('/rrsets/bob/A/')) && dd.some((c) => c.url.includes('/rrsets/_acme-challenge.bob/CNAME/')),
    `dels=${dd.length}`);
} finally {
  globalThis.fetch = orig;
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — DNS provider request shapes correct (CF grey + deSEC)' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

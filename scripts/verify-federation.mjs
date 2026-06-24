// scripts/verify-federation.mjs — Tier-0 federation verify gate.
//
// Drives the PRODUCTION handlers (src/federation/handlers.js) + the REAL
// connections.receiveRemote (src/db/connections.js, mock d1Query) end-to-end over
// loopback node:http: two boxes (alice = subject, bob = remote sender), with a
// fetch-shim mapping https://<host> → 127.0.0.1:<port> so did:web resolution and
// the signed connect are exercised for real. The express wrapper (router.js) is a
// thin pass-through over these same handlers (syntax-checked separately).
//
// Prints a [✓]/[✗] ledger and `VERDICT: GO` / exit 0 when all pass.

import http from 'node:http';
import crypto from 'node:crypto';
import { createIdentity } from '../src/identity/identity.js';
import { createFederationHandlers } from '../src/federation/handlers.js';
import { createConnectionsNamespace } from '../src/db/connections.js';
import { canonicalize } from '../src/federation/sign.js';
import { isPrivateAddress, assertResolvesPublic, safeFetch } from '../src/federation/ssrf.js';

const ledger = [];
const rec = (name, pass, detail = '') => { ledger.push(pass); console.log(`${pass ? '[✓]' : '[✗]'} ${name}${detail ? ` — ${detail}` : ''}`); };

// ── SSRF guard: the IPv6 byte-parser must catch every internal-address form ──
function ssrfChecks() {
  // Forms that the old string-prefix matcher MISSED (H4) — must now be private:
  const mustBlock = [
    '127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe',
    'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '64:ff9b::7f00:1', '2002:7f00:1::', '2002:a9fe:a9fe::', '2001:0:0:0::1',
    '[::ffff:7f00:1]', '::1%eth0',
  ];
  const mustAllow = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1::', '2620:fe::fe'];
  let ok = true;
  for (const ip of mustBlock) if (!isPrivateAddress(ip)) { ok = false; console.log(`    SSRF MISS (should block): ${ip}`); }
  for (const ip of mustAllow) if (isPrivateAddress(ip)) { ok = false; console.log(`    SSRF FALSE-POSITIVE (should allow): ${ip}`); }
  return ok;
}

const HOST_PORT = {};
function shimFetch(urlStr, init = {}) {
  const u = new URL(urlStr);
  const port = HOST_PORT[u.hostname];
  if (u.protocol !== 'https:' || !port) return Promise.reject(new Error(`shim: bad target ${urlStr}`));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: init.method || 'GET', path: u.pathname + u.search, headers: init.headers || {} }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, async json() { return JSON.parse(d); }, async text() { return d; } }));
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

// safeFetch is fail-CLOSED, so the test boxes (alice/bob.mycelium.id, which do not
// resolve in real DNS) need an injected lookup that maps them to a PUBLIC literal —
// the resolve+validate guard then passes and shimFetch performs the loopback call.
const testLookup = async (host) => {
  if (HOST_PORT[host] != null || /\.mycelium\.id$/.test(host)) return [{ address: '93.184.216.34', family: 4 }];
  throw new Error(`testLookup: unmapped host ${host}`);
};

// Mount a box's federation handlers behind a tiny node:http server.
function startBox(handle, host, { withConnections } = {}) {
  const inserts = [];
  const fakeD1 = async (sql, params) => {
    if (/FROM user_profiles WHERE user_id/.test(sql)) return { results: [{ handle, signature: null }] };
    if (/SELECT id, status FROM connections/.test(sql)) return { results: [] };
    if (/INSERT INTO/.test(sql)) { inserts.push({ sql, params }); return { results: [] }; }
    return { results: [] };
  };
  const db = withConnections ? { connections: createConnectionsNamespace({ d1Query: fakeD1, fetch: shimFetch, lookup: testLookup }) } : {};
  const identity = createIdentity({ masterHex: BOX_KEYS[handle], handle });
  const h = createFederationHandlers({ db, userId: `${handle}-user`, identity, getHost: () => host, getHandle: () => handle, fetch: shimFetch, lookup: testLookup });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (r) => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body)); };
    if (req.method === 'GET' && u.pathname === '/.well-known/did.json') return send(h.didJson());
    if (req.method === 'GET' && u.pathname === '/.well-known/webfinger') return send(h.webfinger(u.searchParams.get('resource')));
    if (req.method === 'POST' && (u.pathname === '/federation/connect' || u.pathname === '/federation/connect-response')) {
      let raw = ''; req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        let payload; try { payload = JSON.parse(raw); } catch { return send({ status: 400, body: { error: 'bad json' } }); }
        const headers = { 'x-myc-did': req.headers['x-myc-did'], 'x-myc-sig': req.headers['x-myc-sig'] };
        const fn = u.pathname.endsWith('-response') ? h.connectResponse : h.connect;
        // Pass the RAW received bytes (as express does via req.rawBody) so the gate
        // exercises the production signature-over-raw-bytes path, not the test-only
        // canonicalize(payload) fallback.
        send(await fn({ payload, headers, ip: req.socket.remoteAddress, rawBody: Buffer.from(raw) }));
      });
      return;
    }
    send({ status: 404, body: { error: 'not found' } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { HOST_PORT[host] = server.address().port; resolve({ server, identity, inserts, host }); }));
}

const BOX_KEYS = { alice: crypto.randomBytes(32).toString('hex'), bob: crypto.randomBytes(32).toString('hex'), nohandle: crypto.randomBytes(32).toString('hex') };

async function main() {
  console.log('\n=== verify:federation — Tier-0 did:web + WebFinger + signed connect ===\n');
  const alice = await startBox('alice', 'alice.mycelium.id', { withConnections: true });
  const bob = await startBox('bob', 'bob.mycelium.id');

  // SSRF guard (H4): IPv6 byte-parser catches every internal form; rebinding to a
  // private IP throws even when the hostname looks public.
  rec('SSRF guard: every internal IPv4/IPv6 form is blocked, public IPs allowed', ssrfChecks());
  let rebindThrew = false;
  try { await assertResolvesPublic('evil.example', { lookup: async () => [{ address: '::ffff:7f00:1' }] }); }
  catch { rebindThrew = true; }
  rec('SSRF guard: rebinding to ::ffff:7f00:1 (hex-grouped loopback) throws', rebindThrew);

  // safeFetch fail-CLOSED layer-1 (resolve-once + validate-every-address). The
  // undici connect-pin (layer-2, TOCTOU defense) is validated live, not here.
  {
    let unresolvable = false, privateBlocked = false, mixedBlocked = false, publicOk = false;
    try { await safeFetch('https://x.test/', { lookup: async () => { throw new Error('nx'); } }); } catch { unresolvable = true; }
    try { await safeFetch('https://x.test/', { lookup: async () => [{ address: '127.0.0.1', family: 4 }] }); } catch { privateBlocked = true; }
    try { await safeFetch('https://x.test/', { lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] }); } catch { mixedBlocked = true; }
    try { const r = await safeFetch('https://x.test/', { lookup: async () => [{ address: '93.184.216.34', family: 4 }], fetch: async () => ({ status: 207 }) }); publicOk = r.status === 207; } catch { publicOk = false; }
    rec('SSRF safeFetch fail-closed: unresolvable host throws (was fail-open)', unresolvable);
    rec('SSRF safeFetch fail-closed: a private resolution throws', privateBlocked);
    rec('SSRF safeFetch fail-closed: a mixed [public, private] set throws (validates ALL addresses)', mixedBlocked);
    rec('SSRF safeFetch: a fully-public resolution proceeds via the seam', publicOk);
  }

  // M-FED-RL: rotating the (spoofable) source IP must NOT mint unlimited buckets;
  // the global backstop caps total inbound connects regardless of per-request IP.
  {
    const h = createFederationHandlers({ db: {}, userId: 'u', identity: { publicKeyB64: 'x' }, getHost: () => 'rl.test', getHandle: () => 'rl', now: () => Date.now() });
    let blocked = 0;
    for (let i = 0; i < 200; i++) {
      const r = await h.connect({ payload: { ts: Date.now(), nonce: `n${i}` }, headers: {}, ip: `1.2.3.${i % 256}` });
      if (r.status === 429) blocked++;
    }
    rec('federation rate-limit holds under rotated source IPs (global backstop)', blocked > 0);
  }

  // did.json + webfinger
  const did = await (await shimFetch('https://alice.mycelium.id/.well-known/did.json')).json();
  rec('did.json served with did:web id + multibase key', did.id === 'did:web:alice.mycelium.id' && !!did.verificationMethod?.[0]?.publicKeyMultibase);
  const wf = await (await shimFetch('https://alice.mycelium.id/.well-known/webfinger?resource=acct:alice@alice.mycelium.id')).json();
  rec('webfinger exposes a rel-includes-"federation" link', !!wf.links?.find((l) => l.rel.includes('federation')));
  const foreign = await shimFetch('https://alice.mycelium.id/.well-known/webfinger?resource=acct:eve@alice.mycelium.id');
  rec('webfinger fails closed for a foreign acct (404)', foreign.status === 404);

  // signed connect bob → alice
  const mkBody = () => ({ $type: 'social.mycelium.connect-request.v1', from_handle: 'bob', from_instance: 'bob.mycelium.id', from_did: 'did:web:bob.mycelium.id', to_handle: 'alice', nonce: crypto.randomUUID(), ts: Date.now(), profile: { signature: 'thinks in graphs' } });
  const post = (body, sig) => shimFetch('https://alice.mycelium.id/federation/connect', { method: 'POST', headers: { 'content-type': 'application/json', 'x-myc-did': 'did:web:bob.mycelium.id', 'x-myc-sig': sig }, body: canonicalize(body) });

  const good = mkBody(); const goodRes = await post(good, bob.identity.sign(canonicalize(good)));
  rec('valid signed connect verifies via did:web → 202 + persisted', goodRes.status === 202 && alice.inserts.some((i) => /INSERT INTO connections/.test(i.sql)));

  const tam = mkBody(); const sig = bob.identity.sign(canonicalize(tam)); tam.to_handle = 'mallory';
  rec('tampered body rejected (401)', (await post(tam, sig)).status === 401);

  const replay = mkBody(); const rsig = bob.identity.sign(canonicalize(replay));
  await post(replay, rsig);
  rec('replayed nonce rejected (401)', (await post(replay, rsig)).status === 401);

  // signed connect-response (the accept callback) verifies the same way
  const resp = { $type: 'social.mycelium.connect-response.v1', from_handle: 'bob', from_instance: 'bob.mycelium.id', from_did: 'did:web:bob.mycelium.id', to_handle: 'alice', action: 'accept', nonce: crypto.randomUUID(), ts: Date.now(), profile: { signature: 'graphs' } };
  const postResp = (body, sig) => shimFetch('https://alice.mycelium.id/federation/connect-response', { method: 'POST', headers: { 'content-type': 'application/json', 'x-myc-did': 'did:web:bob.mycelium.id', 'x-myc-sig': sig }, body: canonicalize(body) });
  rec('signed connect-response verifies (202)', (await postResp(resp, bob.identity.sign(canonicalize(resp)))).status === 202);
  rec('unsigned connect-response rejected (401)', (await postResp(resp, '')).status === 401);

  // fail-closed no-handle box
  const nohandle = await startBox('nohandle', '', {});
  const r404 = await new Promise((res) => http.request({ host: '127.0.0.1', port: nohandle.server.address().port, path: '/.well-known/did.json' }, (rs) => res(rs.statusCode)).end());
  rec('no-handle box fails closed on did.json (404)', r404 === 404);

  alice.server.close(); bob.server.close(); nohandle.server.close();
  const pass = ledger.every(Boolean);
  console.log(`\n${'='.repeat(64)}\nVERDICT: ${pass ? 'GO' : 'NO-GO'} — ${ledger.filter(Boolean).length}/${ledger.length} checks passed\n${'='.repeat(64)}\n`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error('verify:federation crashed:', e); process.exit(2); });

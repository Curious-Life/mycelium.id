// THROWAWAY SPIKE — Federation Tier-0 (did:web + WebFinger + signed connect)
//
// De-risks the spike assumptions from
// docs/DESIGN-federation-inter-instance-2026-06-05.md §5:
//   A3 — did:web/WebFinger serve cleanly + a box→box connect completes & verifies.
//   A4 — the connect-request payload the dormant connections.js sends carries
//        NO embedding/invertible material (security gate, CLAUDE.md §7).
//
// HOW: stand up two boxes (alice, bob) as node:http servers on loopback, each
// serving /.well-known/did.json, /.well-known/webfinger and POST /federation/
// connect. We run the REAL src/db/connections.js requestRemote (with an
// in-memory fake d1Query + a fetch-shim that maps https://<handle>.mycelium.id
// -> 127.0.0.1:<port>) so we exercise the actual dormant code, and we prototype
// the Tier-0 signing layer (sign with the real src/identity ed25519 identity;
// verify on the receiver via the sender's published did:web key).
//
// Zero install: node:crypto + node:http + the two real src modules only.

import http from 'node:http';
import crypto from 'node:crypto';
import { createIdentity, verifyWithPublicKey } from '../../src/identity/identity.js';
import { createConnectionsNamespace } from '../../src/db/connections.js';

// ── tiny test ledger ────────────────────────────────────────────────────────
const ledger = [];
const rec = (name, pass, detail = '') => {
  ledger.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

// ── minimal base58btc (for publicKeyMultibase, the did:web/did:key std form) ──
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}
function b58decode(str) {
  let zeros = 0; while (zeros < str.length && str[zeros] === '1') zeros++;
  const bytes = [0];
  for (let i = zeros; i < str.length; i++) {
    let carry = B58.indexOf(str[i]); if (carry < 0) throw new Error('bad base58');
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + bytes.length - 1 - i] = bytes[i];
  return out;
}
// multicodec ed25519-pub = 0xed 0x01 prefix, then base58btc, then 'z' multibase
const ED25519_MULTICODEC = Buffer.from([0xed, 0x01]);
function toMultibase(pubB64url) {
  const raw = Buffer.from(pubB64url, 'base64url');
  return 'z' + b58encode(Buffer.concat([ED25519_MULTICODEC, raw]));
}
function fromMultibase(mb) {
  if (mb[0] !== 'z') throw new Error('only z-base58btc supported');
  const decoded = b58decode(mb.slice(1));
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) throw new Error('not an ed25519 multikey');
  return Buffer.from(decoded.subarray(2)).toString('base64url');
}

// ── Tier-0 documents (what server-http.js would serve at :4711) ──────────────
function buildDidDocument(handle) {
  const id = createIdentity({ masterHex: BOX_KEYS[handle], handle });
  const did = `did:web:${handle}.mycelium.id`;
  const vm = `${did}#key-1`;
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: did,
    verificationMethod: [{ id: vm, type: 'Multikey', controller: did, publicKeyMultibase: toMultibase(id.publicKeyB64) }],
    authentication: [vm],
    assertionMethod: [vm],
    service: [
      { id: `${did}#federation`, type: 'MyceliumFederation', serviceEndpoint: `https://${handle}.mycelium.id/federation` },
    ],
  };
}
function buildWebfinger(handle, resource) {
  const domain = `${handle}.mycelium.id`;
  const expected = `acct:${handle}@${domain}`;
  if (resource !== expected) return null; // fail closed: only our own acct
  return {
    subject: expected,
    links: [
      { rel: 'self', type: 'application/did+json', href: `https://${domain}/.well-known/did.json` },
      // connections.js looks for a link whose rel includes 'federation':
      { rel: 'https://mycelium.id/rel/federation', href: `https://${domain}/federation` },
    ],
  };
}

// canonical bytes a sender signs / a receiver verifies (stable key order)
function canonicalize(body) {
  return JSON.stringify(body, Object.keys(body).sort());
}

// ── loopback fetch-shim: https://<handle>.mycelium.id/...  ->  127.0.0.1:<port>
const HOST_PORT = {}; // 'alice.mycelium.id' -> port
const BOX_KEYS = {};  // handle -> master hex (so did docs are reproducible)
function shimFetch(urlStr, init = {}) {
  const u = new URL(urlStr);
  if (u.protocol !== 'https:') throw new Error(`shim expects https, got ${u.protocol}`);
  const port = HOST_PORT[u.hostname];
  if (!port) throw new Error(`shim: unknown host ${u.hostname}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: init.method || 'GET', path: u.pathname + u.search, headers: init.headers || {} },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            async json() { return JSON.parse(data); },
            async text() { return data; },
          }));
      },
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

// did:web resolution using the shim (fetch the sender's published key)
async function resolveDidKey(did) {
  const m = /^did:web:([a-z0-9.-]+)$/.exec(did);
  if (!m) throw new Error(`unsupported did ${did}`);
  const res = await shimFetch(`https://${m[1]}/.well-known/did.json`);
  if (!res.ok) throw new Error(`did doc ${res.status}`);
  const doc = await res.json();
  return fromMultibase(doc.verificationMethod[0].publicKeyMultibase);
}

// ── a box: node:http server serving the Tier-0 surface ───────────────────────
function startBox(handle, { inbox }) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1`);
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET' && u.pathname === '/.well-known/did.json') {
      // mirror server-http.js fail-closed posture: no handle -> 404
      if (!handle) return send(404, { error: 'no public identity' });
      return send(200, buildDidDocument(handle));
    }
    if (req.method === 'GET' && u.pathname === '/.well-known/webfinger') {
      const wf = buildWebfinger(handle, u.searchParams.get('resource'));
      return wf ? send(200, wf) : send(404, { error: 'not found' });
    }
    if (req.method === 'POST' && u.pathname === '/federation/connect') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        try {
          const sigB64 = req.headers['x-myc-sig'];
          const senderDid = req.headers['x-myc-did'];
          if (!sigB64 || !senderDid) {
            // Part 1: the REAL dormant connections.js sends NO signature today.
            inbox.unsigned.push(JSON.parse(raw));
            return send(202, { accepted: true, verified: false, note: 'UNSIGNED — current connections.js behaviour' });
          }
          // Part 2: Tier-0 signed path — verify against the sender's did:web key.
          const pubB64 = await resolveDidKey(senderDid);
          const ok = verifyWithPublicKey(pubB64, raw, sigB64);
          if (!ok) { inbox.rejected.push({ reason: 'bad-signature' }); return send(401, { error: 'signature failed' }); }
          inbox.verified.push(JSON.parse(raw));
          return send(200, { accepted: true, verified: true });
        } catch (e) {
          inbox.rejected.push({ reason: e.message });
          return send(400, { error: e.message });
        }
      });
      return;
    }
    send(404, { error: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      HOST_PORT[`${handle}.mycelium.id`] = port;
      resolve({ server, port });
    });
  });
}

// in-memory fake d1Query so the REAL connections.js runs without better-sqlite3
function makeFakeDb(profile) {
  const inserts = [];
  const d1Query = async (sql, params) => {
    if (/FROM user_profiles WHERE user_id/.test(sql)) return { results: [profile] };
    if (/COUNT\(\*\)/.test(sql)) return { results: [{ c: 0 }] };
    if (/INSERT INTO connections/.test(sql)) { inserts.push({ sql, params }); return { results: [] }; }
    return { results: [] };
  };
  return { d1Query, inserts };
}

async function main() {
  console.log('\n=== Federation Tier-0 spike: did:web + WebFinger + signed connect ===\n');

  BOX_KEYS['alice'] = crypto.randomBytes(32).toString('hex');
  BOX_KEYS['bob'] = crypto.randomBytes(32).toString('hex');
  const aliceId = createIdentity({ masterHex: BOX_KEYS['alice'], handle: 'alice' });

  const bobInbox = { unsigned: [], verified: [], rejected: [] };
  const aliceBox = await startBox('alice', { inbox: { unsigned: [], verified: [], rejected: [] } });
  const bobBox = await startBox('bob', { inbox: bobInbox });
  const noHandleBox = await startBox(null, { inbox: { unsigned: [], verified: [], rejected: [] } });

  // ── A3.1 — did:web document shape + key fidelity ──────────────────────────
  {
    const res = await shimFetch('https://alice.mycelium.id/.well-known/did.json');
    const doc = await res.json();
    const idOk = doc.id === 'did:web:alice.mycelium.id';
    const keyBack = fromMultibase(doc.verificationMethod[0].publicKeyMultibase);
    const keyOk = keyBack === aliceId.publicKeyB64;
    const svcOk = doc.service?.[0]?.serviceEndpoint === 'https://alice.mycelium.id/federation';
    rec('A3.1 did.json shape + key round-trips through multibase', idOk && keyOk && svcOk,
      `id=${doc.id} keyMatches=${keyOk} service=${svcOk}`);
  }

  // ── A3.2 — fail-closed: a box with no handle serves no DID ─────────────────
  {
    const res = await shimFetch(`https://${'x'}`.replace('x', `127.0.0.1`) ? `https://alice.mycelium.id/.well-known/did.json` : '');
    // direct loopback check on the no-handle box:
    const r = await new Promise((resolve) => {
      const rq = http.request({ host: '127.0.0.1', port: noHandleBox.port, path: '/.well-known/did.json' }, (rs) => resolve(rs.statusCode));
      rq.end();
    });
    rec('A3.2 no-handle box fails closed on did.json (404)', r === 404, `status=${r}`);
  }

  // ── A3.3 — WebFinger returns a `federation` rel connections.js can find ────
  {
    const res = await shimFetch('https://bob.mycelium.id/.well-known/webfinger?resource=acct:bob@bob.mycelium.id');
    const wf = await res.json();
    const fed = wf.links?.find((l) => l.rel?.includes('federation'));
    rec('A3.3 WebFinger exposes a rel-includes-"federation" link with href', !!fed?.href, `href=${fed?.href}`);
    const bad = await shimFetch('https://bob.mycelium.id/.well-known/webfinger?resource=acct:eve@bob.mycelium.id');
    rec('A3.3b WebFinger fails closed for a foreign acct (404)', bad.status === 404, `status=${bad.status}`);
  }

  // ── A4 + A3.4 — run the REAL connections.js requestRemote (unsigned today) ─
  {
    const profile = { handle: 'alice', signature: null, depth_score: 0.71, breadth_score: 0.42, public_realms_json: JSON.stringify(['systems', 'networks']) };
    // also prove computeFingerprint never sets signature: it's user-bio only.
    const { d1Query, inserts } = makeFakeDb(profile);
    const conns = createConnectionsNamespace({
      d1Query,
      workerUrl: () => 'https://alice.mycelium.id',
      workerAuth: () => 'spike-token',
      fetch: shimFetch,
    });
    const connId = await conns.request('alice-user-id', 'bob@bob.mycelium.id');

    // give the fire-and-forget POST a tick to land
    await new Promise((r) => setTimeout(r, 50));

    const got = bobInbox.unsigned[0];
    const reachedBob = !!got && got.$type === 'social.mycelium.connect-request.v1' && got.to_handle === 'bob';
    rec('A3.4 real connections.js → WebFinger discovery → POST reached bob', reachedBob,
      `$type=${got?.$type} from=${got?.from_handle}@${got?.from_instance}`);

    // A4: the payload that crossed the wire carries no embedding/vector material
    const wire = JSON.stringify(got || {});
    const embeddingKeys = ['centroid_256', 'embedding_768', 'centroid_3d', 'vector', 'embedding'];
    const leak = embeddingKeys.find((k) => wire.includes(k));
    const sigField = got?.profile?.signature;
    const sigSafe = sigField === null || (typeof sigField === 'string' && sigField.length <= 500);
    rec('A4 connect payload contains NO embedding/invertible field (CLAUDE.md §7)', !leak && sigSafe,
      `embeddingLeak=${leak || 'none'} signatureField=${JSON.stringify(sigField)} keys=${Object.keys(got?.profile || {})}`);

    rec('A3.4b local pending connection row written before federation POST', inserts.length === 1 && /pending/.test(inserts[0].sql),
      `inserts=${inserts.length} connId=${connId?.slice(0, 8)}…`);
  }

  // ── A3.5 — Tier-0 SIGNED connect verifies via did:web (valid / tamper / wrong-key)
  {
    const body = {
      $type: 'social.mycelium.connect-request.v1',
      from: 'did:web:alice.mycelium.id',
      from_handle: 'alice',
      to_handle: 'bob',
      nonce: crypto.randomUUID(),
      ts: Date.now(),
    };
    const canonical = canonicalize(body);
    const sig = aliceId.sign(canonical);

    const post = (raw, headers) => shimFetch('https://bob.mycelium.id/federation/connect', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });

    const before = bobInbox.verified.length;
    const okRes = await post(canonical, { 'x-myc-did': 'did:web:alice.mycelium.id', 'x-myc-sig': sig });
    rec('A3.5 valid signed connect verifies against published did:web key', okRes.status === 200 && bobInbox.verified.length === before + 1,
      `status=${okRes.status} verifiedInbox=${bobInbox.verified.length}`);

    const tampered = canonicalize({ ...body, to_handle: 'mallory' }); // signature no longer matches
    const tamRes = await post(tampered, { 'x-myc-did': 'did:web:alice.mycelium.id', 'x-myc-sig': sig });
    rec('A3.5b tampered body is rejected (fail closed, 401)', tamRes.status === 401, `status=${tamRes.status}`);

    // wrong-key: sign with a different identity but claim alice's did
    const evil = createIdentity({ masterHex: crypto.randomBytes(32).toString('hex'), handle: 'alice' });
    const evilSig = evil.sign(canonical);
    const wkRes = await post(canonical, { 'x-myc-did': 'did:web:alice.mycelium.id', 'x-myc-sig': evilSig });
    rec('A3.5c forged sender (wrong key, real did) is rejected (401)', wkRes.status === 401, `status=${wkRes.status}`);
  }

  // ── teardown ──────────────────────────────────────────────────────────────
  aliceBox.server.close(); bobBox.server.close(); noHandleBox.server.close();

  const passed = ledger.filter((l) => l.pass).length;
  const all = ledger.length;
  console.log('\n' + '='.repeat(72));
  console.log(`VERDICT: ${passed === all ? 'GO' : 'NO-GO'} — ${passed}/${all} checks passed`);
  console.log('='.repeat(72) + '\n');
  process.exit(passed === all ? 0 : 1);
}

main().catch((e) => { console.error('spike crashed:', e); process.exit(2); });

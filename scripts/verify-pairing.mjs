#!/usr/bin/env node
// verify-pairing.mjs — Unit B gate (docs/PHONE-QR-PAIRING-DESIGN-2026-07-19.md §6).
//
// PART 1 — FROZEN INTEROP VECTOR. Fixed inputs → fixed ck/sas/AEAD outputs. If the
//   KDF/AEAD algorithm drifts, these asserts fail. The iOS PairingCrypto unit test
//   pins the SAME constants (Unit D), guaranteeing byte-for-byte parity with no device.
// PART 2 — END-TO-END over a real HTTP server driving the pairing routers:
//   P1 happy path (start→claim→approve→result → phone opens the sealed token)
//   P2 SAS determinism + QR-swap control (different epk ⇒ different sas)
//   P3 pid single-use (second claim → 409); result before approve → no sealed
//   P4 ceremony is LOOPBACK-ONLY (approve with X-Forwarded-For → 403)  [MUTATION: drop the gate → 200]
//   P5 no-approval invariant (result never yields sealed before approve)
//   P6 channel confidentiality (encLabel + sealed carry no plaintext substring)
//   P7 result needs proof-of-ck (no/wrong proof → 403)              [MUTATION: drop proof check → leaks]

import crypto from 'node:crypto';
import express from 'express';
import { ecdh, deriveChannel, sealDir, openDir, resultProof, proofEquals } from '../src/crypto/pair-channel.js';
import { createPairRouters } from '../src/portal-pair.js';
import { createPathThrottle } from '../src/http/rate-limit.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(Boolean(p)); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const mkPriv = (seed) => crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8, seed]), format: 'der', type: 'pkcs8' });
const pubRaw = (k) => Buffer.from(crypto.createPublicKey(k).export({ format: 'der', type: 'spki' }).subarray(-32));

// ---- PART 1: frozen interop vector -------------------------------------------
const FROZEN = {
  epk: 'e06Qm75__kTEZaIgA31gjuNYl9Me-XLwf3SJLLD3PxM',
  phonePub: 'D6poTtKIZ7l_Smot7l34zpdOdrcBjj8iocTPJnhXDyA',
  pidHex: '33333333333333333333333333333333',
  ckC2S: 'dd387b6e56d7aa00c19bfcd416688013e7afd0043d31ef536e29325eada24e8b',
  ckS2C: '16137cc5695680b30524b44fc2e1aee3b9b39edf6901c450a90b515846a209d8',
  ckProof: '2f691ea17a465bca7188e0895b19607b762aa599e66aea15921f26aaf2ecd9ed',
  proof: 'b6512cc7e8b543cb831ced1733dd2dc456258be785775f3ba6735da06255bd3e',
  sas: '443682',
  aeadC2S: { plaintext: 'Pixel 9', ivB64: 'RERERERERERERERE', ctB64: 'WAJp4MAU7A==', tagB64: 'ztLLA7U4ypHDR5JCbw6jog==' },
};
function part1() {
  const ephPriv = mkPriv(Buffer.alloc(32, 0x11));
  const phonePubRaw = Buffer.from(FROZEN.phonePub, 'base64url');
  const epkRaw = pubRaw(ephPriv);
  const pid = Buffer.from(FROZEN.pidHex, 'hex');
  rec('P0a epk derives from the frozen ephemeral seed', epkRaw.toString('base64url') === FROZEN.epk);
  const shared = ecdh(ephPriv, FROZEN.phonePub);
  const ch = deriveChannel({ shared, pidBytes: pid, epkRaw, phonePubRaw });
  rec('P0b ckC2S matches frozen vector', ch.ckC2S.toString('hex') === FROZEN.ckC2S, ch.ckC2S.toString('hex'));
  rec('P0c ckS2C matches frozen vector', ch.ckS2C.toString('hex') === FROZEN.ckS2C);
  rec('P0d SAS matches frozen vector (6 digits)', ch.sas === FROZEN.sas, ch.sas);
  rec('P0d2 ckProof matches frozen vector (dedicated proof key)', ch.ckProof.toString('hex') === FROZEN.ckProof);
  rec('P0d3 resultProof matches frozen vector', resultProof(ch.ckProof, pid) === FROZEN.proof);
  // decrypt the frozen AEAD blob → proves AES-256-GCM + AAD(pid‖0x01) parity
  const opened = openDir(ch.ckC2S, { iv: FROZEN.aeadC2S.ivB64, ct: FROZEN.aeadC2S.ctB64, tag: FROZEN.aeadC2S.tagB64 }, pid, 'c2s');
  rec('P0e frozen c2s AEAD decrypts to expected plaintext', opened.toString('utf8') === FROZEN.aeadC2S.plaintext);
}

// ---- PART 2: end-to-end over HTTP --------------------------------------------
function fakeDeviceTokens() {
  let last = null;
  return { async mint(label) { last = crypto.randomBytes(32).toString('hex'); return { token: last, hash: 'x', id: 1 }; }, _last: () => last, async list() { return []; }, async revoke() {} };
}
const j = (r) => r.json();

async function part2() {
  const db = { deviceTokens: fakeDeviceTokens() };
  const TEST_BOX_KEY = 'BoxKeyAgreementPublicKeyBase64urlXXXXXXXXXX'; // stand-in box X25519 pub
  const { ownerRouter, publicRouter } = createPairRouters({ db, userId: 'owner', boxKeyAgreementPub: TEST_BOX_KEY });
  const app = express();
  app.use('/api/v1/portal', ownerRouter);
  app.use(createPathThrottle({ method: 'POST', path: '/pair/claim', max: 10, windowMs: 60_000 }));
  app.use(createPathThrottle({ method: 'GET', path: '/pair/result', max: 30, windowMs: 60_000 }));
  app.use(publicRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const OWN = `${base}/api/v1/portal`;

  try {
    // P1 — happy path
    const start = await j(await fetch(`${OWN}/pair/start`, { method: 'POST' }));
    rec('P1a /pair/start returns pid+epk (loopback)', start.ok && start.pid && start.epk && start.sasDigits === 6);
    const pid = start.pid, pidBytes = Buffer.from(pid, 'base64url');

    // phone side
    const phonePriv = crypto.generateKeyPairSync('x25519').privateKey;
    const phonePubRaw = pubRaw(phonePriv);
    const phonePubB64 = phonePubRaw.toString('base64url');
    const shared = ecdh(phonePriv, start.epk);
    const epkRaw = Buffer.from(start.epk, 'base64url');
    const ch = deriveChannel({ shared, pidBytes, epkRaw, phonePubRaw });
    const encLabel = sealDir(ch.ckC2S, 'Pixel 9', pidBytes, 'c2s');

    const claim = await fetch(`${base}/pair/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid, phonePub: phonePubB64, encLabel }) });
    const claimB = await claim.json();
    rec('P1b /pair/claim accepts sealed handshake → claimed', claim.status === 200 && claimB.state === 'claimed');

    const pending = await j(await fetch(`${OWN}/pair/pending`));
    const shown = pending.pending?.find((p) => p.pid === pid);
    rec('P1c /pair/pending shows device label + SAS', Boolean(shown && shown.deviceLabel === 'Pixel 9' && shown.sas));
    rec('P2 server SAS == phone SAS (same channel)', shown?.sas === ch.sas);

    const postResult = (body) => fetch(`${base}/pair/result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const proof = resultProof(ch.ckProof, pidBytes);

    // P5 — result before approve yields NO sealed
    const early = await j(await postResult({ pid, proof }));
    rec('P5 result before approve → no sealed', early.state === 'claimed' && !('sealed' in early));

    // P4 — ceremony is loopback-only: approve with a proxy header → 403 (MUTATION target)
    const spoof = await fetch(`${OWN}/pair/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify({ pid }) });
    rec('P4 approve with X-Forwarded-For → 403 (loopback-only)', spoof.status === 403);

    // approve (loopback)
    const appr = await fetch(`${OWN}/pair/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid }) });
    rec('P1d /pair/approve (loopback) → ok', appr.status === 200);

    // P7 — result needs proof-of-ck
    const noProof = await postResult({ pid });
    rec('P7a result without proof → 403', noProof.status === 403);
    const wrongProof = await postResult({ pid, proof: '0'.repeat(64) });
    rec('P7b result with wrong proof → 403', wrongProof.status === 403);

    // P1e — real proof → sealed → phone opens the token
    const result = await j(await postResult({ pid, proof }));
    rec('P1e result with proof → approved + sealed', result.state === 'approved' && Boolean(result.sealed));
    // Phase 1: the sealed s2c payload is JSON { v, token, boxKey }.
    const payload = JSON.parse(openDir(ch.ckS2C, result.sealed, pidBytes, 's2c').toString('utf8'));
    const token = payload.token;
    rec('P1f phone opens the sealed per-device token (64 hex)', /^[0-9a-f]{64}$/.test(token) && token === db.deviceTokens._last());
    rec('P1g phone pins the box X25519 key delivered in the sealed payload', payload.boxKey === TEST_BOX_KEY);

    // P6 — confidentiality: wire carries no plaintext (token, label, or box key)
    const wire = JSON.stringify(encLabel) + JSON.stringify(result.sealed);
    rec('P6 encLabel + sealed contain no plaintext token/label/boxKey', !wire.includes('Pixel 9') && !wire.includes(token) && !wire.includes(TEST_BOX_KEY));

    // P3 — pid single-use (a fresh claim on the consumed pid → 409)
    const reclaim = await fetch(`${base}/pair/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid, phonePub: phonePubB64, encLabel }) });
    rec('P3a re-claim on used pid → 409', reclaim.status === 409);

    // P2 QR-swap control — a different epk ⇒ a different SAS (attacker card won't match)
    const start2 = await j(await fetch(`${OWN}/pair/start`, { method: 'POST' }));
    const ch2 = deriveChannel({ shared: ecdh(phonePriv, start2.epk), pidBytes: Buffer.from(start2.pid, 'base64url'), epkRaw: Buffer.from(start2.epk, 'base64url'), phonePubRaw });
    rec('P2b different epk ⇒ different SAS (QR-swap detectable)', ch2.sas !== ch.sas);
  } finally {
    server.close();
  }
}

async function main() {
  part1();
  await part2();
  const allPass = ledger.length > 0 && ledger.every(Boolean);
  console.log('\n' + '='.repeat(66));
  console.log(`VERDICT: ${allPass ? 'GO — pairing handshake: frozen-vector parity, loopback-only ceremony, proof-gated sealed token, single-use, confidential' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
  console.log('='.repeat(66));
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error('verify-pairing threw:', e); process.exit(1); });

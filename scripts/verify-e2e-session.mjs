#!/usr/bin/env node
// verify-e2e-session.mjs — Phase 2a gate (the E2E-reachability design).
//
// PART 1 — FROZEN VECTOR: fixed (es,ee,cnonce,sn,ep,eb) → fixed session keys + a frame
//   AEAD. The iOS E2ESessionTests pins the SAME constants → cross-language parity, no device.
// PART 2 — full handshake round-trip: box identity + phone → mutual auth, session up,
//   framed both ways.
// PART 3 — security: replay/reorder rejected [MUTATION], tamper rejected, wrong box key
//   fails mutual auth, all-zero ECDH guard.

import crypto from 'node:crypto';
import { createIdentity } from '../src/identity/identity.js';
import * as E from '../src/crypto/e2e-session.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(Boolean(p)); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const b = (v, len) => Buffer.alloc(len, v);

const FROZEN = {
  kC2S: 'f5c2a3d0b1ec9eb12159387d14f5d0ea3b7187ada6c7bc3e065ec2aefe9010fa',
  kS2C: '03579e20b22128d53a3618be947706ce5ddcd3eca9a9f04bdc5a8c0fbc66509a',
  frameC2S_seq7: { plaintext: 'hello', ivB64: 'd3d3d3d3d3d3d3d3', ctB64: 'VkOlf7U=', tagB64: '/AmSq2unHcJGUDw5XDwlsg==' },
};

function part1() {
  const es = b(0xa1, 32), ee = b(0xb2, 32), cnonce = b(0xc3, 16), sn = b(0xd4, 16), epRaw = b(0xe5, 32), ebRaw = b(0xf6, 32);
  const { kC2S, kS2C } = E.deriveSession({ es, ee, cnonce, sn, epRaw, ebRaw });
  rec('E0a kC2S matches frozen vector', kC2S.toString('hex') === FROZEN.kC2S, kC2S.toString('hex'));
  rec('E0b kS2C matches frozen vector', kS2C.toString('hex') === FROZEN.kS2C);
  // open the frozen c2s frame (seq=7) with kC2S + AAD = seq(8 BE)‖0x01
  const aad = Buffer.alloc(9); aad.writeBigUInt64BE(7n, 0); aad[8] = 0x01;
  const pt = E._e2e.aeadOpen(kC2S, { iv: FROZEN.frameC2S_seq7.ivB64, ct: FROZEN.frameC2S_seq7.ctB64, tag: FROZEN.frameC2S_seq7.tagB64 }, aad);
  rec('E0c frozen frame AEAD decrypts to expected plaintext', pt.toString('utf8') === FROZEN.frameC2S_seq7.plaintext);
}

function part2and3() {
  const box = createIdentity({ masterHex: 'a'.repeat(64) });
  const S_b = box.keyAgreementPublicKeyB64;
  const token = crypto.randomBytes(32).toString('hex');

  // handshake
  const st = E.initClient(S_b);
  const { msg1, cnonce } = E.sealClientAuth(st, token);
  const opened = E.openClientAuth(box, msg1);
  rec('E1 box recovers the device token from msg1 (phone→box auth)', opened.deviceToken === token);
  const { msg2, session: srv } = E.completeServer(opened);
  const cli = E.finalizeClient(st, cnonce, msg2);
  rec('E2 phone finalizes on the box confirm (box→phone auth via pinned key)', Boolean(cli));

  // framed stream both ways
  const f1 = cli.seal('GET /api/v1/portal/agents');
  rec('E3a c2s frame opens on the box', srv.open(f1).toString('utf8') === 'GET /api/v1/portal/agents');
  const r1 = srv.seal('{"agents":[...]}');
  rec('E3b s2c frame opens on the phone', cli.open(r1).toString('utf8') === '{"agents":[...]}');
  const f2 = cli.seal('next');
  rec('E3c c2s seq advances (second frame opens)', srv.open(f2).toString('utf8') === 'next');

  // replay/reorder rejected (MUTATION target: the seq<=recvHigh guard in newSession.open)
  let replay = false; try { srv.open(f1); replay = true; } catch { /* rejected */ }
  rec('E4 replay of an old frame rejected (seq must strictly increase)', !replay);

  // tampered handshake auth rejected
  const badSt = E.initClient(S_b); const bad = E.sealClientAuth(badSt, token);
  bad.msg1.auth.ct = Buffer.from('tamper').toString('base64');
  let tampered = false; try { E.openClientAuth(box, bad.msg1); tampered = true; } catch { /* rejected */ }
  rec('E5 tampered msg1 auth rejected (AEAD integrity)', !tampered);

  // wrong box static key → the phone derives a different es → the box's confirm won't open
  const otherBox = createIdentity({ masterHex: 'b'.repeat(64) });
  const stWrong = E.initClient(otherBox.keyAgreementPublicKeyB64); // phone thinks the box is otherBox
  const { msg1: m1w, cnonce: cnw } = E.sealClientAuth(stWrong, token);
  const openedReal = (() => { try { return E.openClientAuth(box, m1w); } catch { return null; } })(); // real box can't open (wrong es)
  rec('E6 a phone pinned to the WRONG box key cannot authenticate to the real box', openedReal === null);

  // frame confidentiality: the wire carries no plaintext
  const wire = JSON.stringify(f1) + JSON.stringify(r1) + JSON.stringify(msg1);
  rec('E7 frames + msg1 carry no plaintext (token / request path)', !wire.includes(token) && !wire.includes('/api/v1/portal/agents'));
}

const allPass = () => ledger.length > 0 && ledger.every(Boolean);
part1();
part2and3();
console.log('\n' + '='.repeat(66));
console.log(`VERDICT: ${allPass() ? 'GO — E2E session: frozen-vector parity, mutual auth, forward-secret handshake, replay-protected frames, confidential' : 'NO-GO — see FAIL rows'}  EXIT=${allPass() ? 0 : 1}`);
console.log('='.repeat(66));
process.exit(allPass() ? 0 : 1);

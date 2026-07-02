// verify:space-cek — BU-CEK gate (E2E shared spaces, 2026-06-30).
//
// The CEK-management layer ties space-seal (distribute the key) + space-content
// (encrypt items) into the lockbox. Proves: independent CSPRNG generations (E7); a
// member can open a CEK sealed to them and read; a key ring reads old generations it
// held and writes the current one; and the HEADLINE forward-secrecy property — after a
// rekey, a REMOVED member (whose ring lacks the new generation) cannot decrypt new
// content, while surviving members can.

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createIdentity } from '../src/identity/identity.js';
import { generateCek, sealCekToMember, openCekGrant, SpaceKeyRing } from '../src/crypto/space-cek.js';

let pass = 0, fail = 0;
const rec = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`); ok ? pass++ : fail++; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const SPACE = 'space-1';
const aliceId = createIdentity({ masterHex: 'a1'.repeat(32) });
const bobId = createIdentity({ masterHex: 'b2'.repeat(32) });
const alice = { did: 'did:web:alice.example', keyAgreementPublicKeyB64: aliceId.keyAgreementPublicKeyB64 };
const bob = { did: 'did:web:bob.example', keyAgreementPublicKeyB64: bobId.keyAgreementPublicKeyB64 };

// ── CEK generation (E7 independence) ────────────────────────────────────────
const c1 = generateCek(), c2 = generateCek();
rec(Buffer.isBuffer(c1) && c1.length === 32 && !c1.equals(c2), 'K1. generateCek → independent 32-byte CSPRNG keys (never derived/chained)');

// K1b/K1c (review MEDIUM): forward secrecy ALSO requires CEK_{g+1} is UNDERIVABLE from
// CEK_g — not merely absent from the removed member's ring. K11 alone would pass even
// if generateCek chained (sha256(prev)), letting a removed member compute the new key.
// Defend the E7 independence assumption directly: (b) SOURCE — generateCek must be pure
// crypto.randomBytes with no derivation; (c) BEHAVIORAL — consecutive CEKs are not a
// hash/HKDF chain of each other.
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src/crypto/space-cek.js'), 'utf8');
const genBody = SRC.match(/export function generateCek\([\s\S]*?\n\}/)?.[0] ?? '';
rec(/crypto\.randomBytes\(\s*32\s*\)/.test(genBody) && !/(hkdf|createHash|createHmac|prev|chain|derive|sha256|ratchet|__)/i.test(genBody),
  'K1b. generateCek is pure crypto.randomBytes(32), no chaining/derivation (E7 source guard — catches a chained-CEK regression)');
const ga = generateCek(), gb = generateCek();
const sha = crypto.createHash('sha256').update(ga).digest();
const hk = Buffer.from(crypto.hkdfSync('sha256', ga, Buffer.alloc(0), Buffer.from('mycelium-cek'), 32));
rec(!gb.equals(sha) && !gb.equals(hk) && !gb.equals(ga), 'K1c. a fresh CEK is not sha256/HKDF/equal of the prior CEK (E7 behavioral non-derivation)');

// ── seal → open round-trip (space-seal integration) ────────────────────────
const cekG = generateCek();
const grantToAlice = sealCekToMember(cekG, 3, SPACE, alice);
rec(openCekGrant(grantToAlice, aliceId, SPACE, alice.did).equals(cekG), 'K2. member opens a CEK sealed to them (full seal→grant→open)');
rec(throws(() => openCekGrant(grantToAlice, bobId, SPACE, alice.did)), 'K3. a non-recipient (bob) cannot open alice’s grant');
rec(throws(() => openCekGrant(grantToAlice, aliceId, SPACE, bob.did)), 'K4. wrong recipient_did context → FAILS CLOSED');
rec(throws(() => openCekGrant({ ...grantToAlice, gen: 4 }, aliceId, SPACE, alice.did)), 'K5. wrong generation context → FAILS CLOSED');

// ── key ring: write current, read by-generation ────────────────────────────
const ring = new SpaceKeyRing(SPACE);
ring.setCek(3, cekG);
const env3 = ring.encryptItem('doc-1', 'hello at gen 3', { op_type: 'put', author_did: alice.did });
rec(env3.gen === 3 && ring.decryptItem(env3) === 'hello at gen 3', 'K6. ring encrypts under current gen + decrypts round-trip');
rec(throws(() => ring.decryptItem({ ...env3, space_id: 'space-2' })), 'K7. envelope for a different space → rejected');

// ── multi-generation: a member who held both gens reads both ───────────────
const cekG4 = generateCek();
ring.setCek(4, cekG4);
rec(ring.current().gen === 4, 'K8. adopting CEK_4 advances the current generation to 4');
const env4 = ring.encryptItem('doc-2', 'new at gen 4', {});
rec(ring.decryptItem(env3) === 'hello at gen 3' && ring.decryptItem(env4) === 'new at gen 4',
  'K9. a ring holding CEK_3 + CEK_4 decrypts BOTH generations (survivors keep reading old content)');

// ── THE HEADLINE: forward secrecy on removal ────────────────────────────────
// Owner shares a space with alice + bob at gen 3, then REMOVES bob and rekeys to gen 4
// (sealed only to alice). Bob's ring only ever held CEK_3.
const ownerRing = new SpaceKeyRing(SPACE);
ownerRing.setCek(3, cekG); ownerRing.setCek(4, cekG4);
const bobRing = new SpaceKeyRing(SPACE);
bobRing.setCek(3, openCekGrant(sealCekToMember(cekG, 3, SPACE, bob), bobId, SPACE, bob.did)); // bob got gen-3 while a member
const aliceRing = new SpaceKeyRing(SPACE);
aliceRing.setCek(3, openCekGrant(grantToAlice, aliceId, SPACE, alice.did));
aliceRing.setCek(4, openCekGrant(sealCekToMember(cekG4, 4, SPACE, alice), aliceId, SPACE, alice.did)); // alice got gen-4 too

const postRemoval = ownerRing.encryptItem('doc-3', 'secret added AFTER bob was removed', { author_did: alice.did });
rec(aliceRing.decryptItem(postRemoval) === 'secret added AFTER bob was removed', 'K10. a SURVIVING member (alice) decrypts post-removal (gen-4) content');
rec(throws(() => bobRing.decryptItem(postRemoval)),
  'K11. the REMOVED member (bob, ring has only CEK_3) CANNOT decrypt the gen-4 post-removal content — FORWARD SECRECY');
rec(bobRing.decryptItem(env3) === 'hello at gen 3',
  'K12. bob can still read gen-3 content he was a member for (you cannot claw back already-delivered bytes — expected)');

console.log(`\n${pass} pass · ${fail} fail`);
console.log(fail === 0
  ? 'VERDICT: GO — CEK lifecycle: seal→open, multi-gen reads, forward-secret on removal (BU-CEK)'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(fail === 0 ? 0 : 1);

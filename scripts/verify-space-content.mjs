// verify:space-content — BU-AAD gate (E2E shared spaces, 2026-06-30).
//
// The space content envelope (encryptSpaceItem/decryptSpaceItem) must give E2E
// confidentiality + integrity: round-trips under the right CEK, and FAILS CLOSED on
// any header relabel (the untrusted owner/relay must not be able to relabel a
// ciphertext's generation/item — E6), ciphertext tamper, or wrong CEK. Per-item keys
// (HKDF(CEK,item_id)) bound a single-item leak (E5).

import crypto from 'node:crypto';
import { encryptSpaceItem, decryptSpaceItem, _internal } from '../src/crypto/space-content.js';

let pass = 0, fail = 0;
const rec = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`); ok ? pass++ : fail++; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const cek = crypto.randomBytes(32);
const header = { space_id: 'space-1', gen: 3, item_id: 'doc-42', op_type: 'put', author_did: 'did:web:alice.example' };
const BODY = 'the most intimate data a human produces';

// ── round-trip ──────────────────────────────────────────────────────────────
const env = encryptSpaceItem(cek, header, BODY);
rec(env.v === 4 && env.kf === 'space' && env.ct && env.tag, 'C1. produces a v4 space envelope (header plaintext, body ciphertext)');
rec(!Buffer.from(env.ct, 'base64').toString('latin1').includes('intimate'), 'C2. body is ciphertext — plaintext does not appear in the envelope');
rec(decryptSpaceItem(cek, env) === BODY, 'C3. round-trips under the correct CEK');

// ── header is AAD-bound: any relabel breaks the tag (E6, the relay/owner attack) ──
const relabel = (mut) => { const e = { ...env, ...mut }; return throws(() => decryptSpaceItem(cek, e)); };
rec(relabel({ gen: 4 }), 'C4. RELABEL gen 3→4 → FAILS CLOSED (owner/relay cannot promote a ciphertext to a new generation)');
rec(relabel({ item_id: 'doc-99' }), 'C5. RELABEL item_id → FAILS CLOSED (double-bound: per-item KEY + AAD; the pure-AAD path is proven by C6/C7/C8 which do not affect the key)');
rec(relabel({ space_id: 'space-2' }), 'C6. RELABEL space_id → FAILS CLOSED');
rec(relabel({ op_type: 'delete' }), 'C7. RELABEL op_type → FAILS CLOSED');
rec(relabel({ author_did: 'did:web:mallory.example' }), 'C8. RELABEL author_did → FAILS CLOSED (cannot reattribute authorship)');

// ── ciphertext / tag tamper ─────────────────────────────────────────────────
const flip = (b64) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 0x01; return b.toString('base64'); };
rec(throws(() => decryptSpaceItem(cek, { ...env, ct: flip(env.ct) })), 'C9. flipped ciphertext byte → FAILS CLOSED');
rec(throws(() => decryptSpaceItem(cek, { ...env, tag: flip(env.tag) })), 'C10. flipped auth tag → FAILS CLOSED');

// ── wrong CEK ───────────────────────────────────────────────────────────────
rec(throws(() => decryptSpaceItem(crypto.randomBytes(32), env)), 'C11. wrong CEK (a non-member / removed member) → FAILS CLOSED');
rec(throws(() => decryptSpaceItem(Buffer.alloc(16), env)) && throws(() => encryptSpaceItem(Buffer.alloc(16), header, BODY)),
  'C12. non-32-byte CEK → rejected');

// ── per-item key isolation (E5) ─────────────────────────────────────────────
const k1 = _internal.itemKey(cek, 'doc-42');
const k2 = _internal.itemKey(cek, 'doc-43');
rec(!k1.equals(k2), 'C13. distinct item_id → distinct per-item key (a leaked item key does not unlock the space)');
// same plaintext, different items → different ciphertext (also: random IV per encryption)
const eA = encryptSpaceItem(cek, { ...header, item_id: 'a' }, BODY);
const eB = encryptSpaceItem(cek, { ...header, item_id: 'b' }, BODY);
rec(eA.ct !== eB.ct, 'C14. same body under different items → different ciphertext');

// ── the cross-generation relabel attack (the critique’s central E6 case) ──
// A removed member kept gen-3 ciphertext + CEK_3. New content is gen-4 under CEK_4.
// The owner/relay tries to pass a gen-3 body off as gen-4 by editing the header.
const cek4 = crypto.randomBytes(32);
rec(throws(() => decryptSpaceItem(cek4, { ...env, gen: 4 })), 'C15. gen-3 ciphertext relabeled to gen-4 + opened with CEK_4 → FAILS CLOSED (non-transplantable across generations)');

// ── F1: representation-relabel (Number-equal rewrite) must fail closed ──
rec(throws(() => decryptSpaceItem(cek, { ...env, gen: '3' })) && throws(() => decryptSpaceItem(cek, { ...env, gen: '3.0' })) && throws(() => decryptSpaceItem(cek, { ...env, gen: 3.5 })),
  'C16. gen rewritten to a Number-equal string ("3"/"3.0") or non-integer → FAILS CLOSED (canonical-form guard, review F1)');
rec(throws(() => decryptSpaceItem(cek, { ...env, space_id: 5 })) && throws(() => decryptSpaceItem(cek, { ...env, item_id: 7 })),
  'C17. space_id/item_id rewritten from string to Number-equal value → FAILS CLOSED');
// ── F3: non-string body fails closed (no silent "null"/"undefined") ──
rec(throws(() => encryptSpaceItem(cek, header, null)) && throws(() => encryptSpaceItem(cek, header, undefined)) && throws(() => encryptSpaceItem(cek, header, 42)),
  'C18. non-string body → rejected at encrypt (no silent "null"/"undefined" corruption, review F3)');
rec(throws(() => encryptSpaceItem(cek, { ...header, gen: 3.5 }, BODY)) && throws(() => encryptSpaceItem(cek, { ...header, gen: '3' }, BODY)),
  'C19. non-integer gen → rejected at encrypt (canonical generation)');

console.log(`\n${pass} pass · ${fail} fail`);
console.log(fail === 0
  ? 'VERDICT: GO — space content is E2E + AAD-integrity-bound; relabel/tamper/wrong-key fail closed (BU-AAD)'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(fail === 0 ? 0 : 1);

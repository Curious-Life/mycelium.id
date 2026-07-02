// verify:space-crypto — SpaceCrypto boundary gate (E2E shared spaces, BU-OPLOG-E2E O2).
//
// The SpaceCrypto seam is where identity (signing) + the oplog (ordering/storage) +
// the content/seal crypto compose into SIGNED, ORDERED, CIPHERTEXT entries. This gate
// runs the WHOLE seam end-to-end against the REAL space-oplog namespace (in-memory
// SQLite + the real 0044 migration) and a REAL identity:
//   • an entry is AUTHOR-signed over its content header (not the owner-assigned seq);
//   • verifyEntry fails closed on ANY tamper (payload, author_did, kind) or wrong key;
//   • validateInboundEntry bounds a hostile/malformed entry before it is applied;
//   • a grantee holding the CEK can verify authorship AND decrypt the ciphertext payload.

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createIdentity } from '../src/identity/identity.js';
import { createSpaceOplogNamespace } from '../src/db/space-oplog.js';
import { createSpaceCrypto } from '../src/crypto/space-crypto.js';
import { encryptSpaceItem, decryptSpaceItem } from '../src/crypto/space-content.js';
import { generateCek } from '../src/crypto/space-cek.js';

let pass = 0, fail = 0;
const rec = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`); ok ? pass++ : fail++; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(':memory:');
db.exec(readFileSync(join(ROOT, 'migrations/0044_shared_spaces_e2e.sql'), 'utf8'));
const d1Query = async (sql, params = []) => {
  if (/^\s*SELECT/i.test(sql)) return { results: db.prepare(sql).all(...(params || [])) };
  db.prepare(sql).run(...(params || [])); return { results: [] };
};
const oplog = createSpaceOplogNamespace({ d1Query });
const dbFacade = { spaceOplog: oplog };

const ownerId = createIdentity({ masterHex: 'a1'.repeat(32) });
const bobId = createIdentity({ masterHex: 'b2'.repeat(32) });
const OWNER_DID = 'did:web:owner.example';
const SP = 'space-1';
const SC = createSpaceCrypto({ identity: ownerId, db: dbFacade });
await oplog.ensureOrigin(SP, { isHome: 1 });

// ── construction guards (fail closed) ───────────────────────────────────────
rec(throws(() => createSpaceCrypto({ identity: null, db: dbFacade })), 'SC1. createSpaceCrypto without an identity throws');
rec(throws(() => createSpaceCrypto({ identity: ownerId, db: {} })), 'SC2. createSpaceCrypto without db.spaceOplog throws');
rec(SC.signingPublicKeyB64 === ownerId.publicKeyB64, 'SC3. exposes the owner signing key for grantee verification');

// ── author-sign + append (real ciphertext payload) ──────────────────────────
const cek = generateCek();
const itemId = 'doc-1';
const header = { space_id: SP, gen: 0, item_id: itemId, op_type: 'put', author_did: OWNER_DID };
const envelope = encryptSpaceItem(cek, header, 'a private space note'); // v4 'space' envelope
const r0 = await SC.appendEntry(SP, {
  op_id: 'op-a', author_did: OWNER_DID, kind: 'content', action: 'put',
  item_ref: itemId, gen: 0, item_lamport: 0, payload: JSON.stringify(envelope),
});
rec(r0.seq === 0 && !r0.deduped, 'SC4. appendEntry author-signs + appends → owner-assigned seq 0');
const stored = (await oplog.listSince(SP, -1))[0];
rec(typeof stored.header_sig === 'string' && stored.header_sig.length > 40, 'SC5. the appended row carries a non-empty author header_sig');

// ── verifyEntry: valid, and fail-closed on every tamper ─────────────────────
rec(SC.verifyEntry(stored, ownerId.publicKeyB64) === true, 'SC6. verifyEntry → true for an untampered entry against the author key');
rec(SC.verifyEntry({ ...stored, payload: stored.payload + 'x' }, ownerId.publicKeyB64) === false, 'SC7. verifyEntry → false when the ciphertext PAYLOAD is tampered (payload is signed)');
rec(SC.verifyEntry({ ...stored, author_did: 'did:web:bob.example' }, ownerId.publicKeyB64) === false, 'SC8. verifyEntry → false when author_did is re-attributed (relay can’t forge authorship)');
rec(SC.verifyEntry({ ...stored, action: 'delete' }, ownerId.publicKeyB64) === false, 'SC9. verifyEntry → false when action is flipped put→delete');
rec(SC.verifyEntry({ ...stored, gen: 1 }, ownerId.publicKeyB64) === false, 'SC10. verifyEntry → false when gen is relabeled');
rec(SC.verifyEntry(stored, bobId.publicKeyB64) === false, 'SC11. verifyEntry → false against the WRONG signer key (bob)');
rec(SC.verifyEntry({ ...stored, header_sig: undefined }, ownerId.publicKeyB64) === false, 'SC12. verifyEntry → false when the signature is absent');
rec(SC.verifyEntry(stored, null) === false, 'SC13. verifyEntry → false when no key is supplied');

// ── validateInboundEntry: shape + bounds + §7 (grantee-side blast bound) ─────
rec(SC.validateInboundEntry(stored).ok === true, 'SC14. validateInboundEntry → ok for a well-formed content entry');
rec(SC.validateInboundEntry({ ...stored, kind: 'evil' }).ok === false, 'SC15. validateInboundEntry rejects an unknown kind');
rec(SC.validateInboundEntry({ ...stored, action: 'append' }).ok === false, 'SC16. validateInboundEntry rejects a content action ∉ {put,delete}');
rec(SC.validateInboundEntry({ ...stored, gen: 1.5 }).ok === false, 'SC17. validateInboundEntry rejects a non-integer gen');
rec(SC.validateInboundEntry({ ...stored, op_id: 42 }).ok === false, 'SC18. validateInboundEntry rejects a non-string op_id');
rec(SC.validateInboundEntry({ ...stored, payload: 'x'.repeat(1024 * 1024 + 1) }).ok === false, 'SC19. validateInboundEntry rejects a payload over 1 MB (DoS bound)');
rec(SC.validateInboundEntry({ ...stored, embedding: [0.1, 0.2] }).ok === false, 'SC20. validateInboundEntry rejects a vector/embedding key (CLAUDE.md §7)');
rec(SC.validateInboundEntry(null).ok === false && SC.validateInboundEntry([]).ok === false, 'SC21. validateInboundEntry rejects non-objects / arrays');

// ── HOSTILE-INPUT self-defense (review M1/M2): both functions are documented
//    "never throws / fail closed" — a relay-supplied object/BigInt payload must NOT be
//    able to overflow the stack or throw and abort a per-entry grantee hydrate loop. ──
const deepObj = (() => { let o = {}; const root = o; for (let i = 0; i < 200000; i++) { o.n = {}; o = o.n; } return root; })();
const verifyNoThrow = (e) => { try { return { threw: false, val: SC.verifyEntry(e, ownerId.publicKeyB64) }; } catch { return { threw: true }; } };
const validNoThrow = (e) => { try { return { threw: false, val: SC.validateInboundEntry(e) }; } catch { return { threw: true }; } };
const vDeepV = verifyNoThrow({ ...stored, payload: deepObj });
rec(!vDeepV.threw && vDeepV.val === false, 'SC26. verifyEntry on a ~200k-deep OBJECT payload → false, never throws (no stack-overflow DoS)');
const vBigV = verifyNoThrow({ ...stored, payload: 10n });
rec(!vBigV.threw && vBigV.val === false, 'SC27. verifyEntry on a BigInt payload → false, never throws');
const vDeepI = validNoThrow({ ...stored, payload: deepObj });
rec(!vDeepI.threw && vDeepI.val.ok === false, 'SC28. validateInboundEntry on a ~200k-deep OBJECT payload → {ok:false}, never throws (blast bound holds)');
const vBigI = validNoThrow({ ...stored, payload: 10n });
rec(!vBigI.threw && vBigI.val.ok === false, 'SC29. validateInboundEntry on a BigInt payload → {ok:false}, never throws');

// ── grantee end-to-end: verify authorship → validate → DECRYPT ──────────────
// The grantee holds the CEK (sealed to them out-of-band) + the owner signing key.
const inbound = (await oplog.listSince(SP, -1))[0];
const authOk = SC.verifyEntry(inbound, SC.signingPublicKeyB64);
const shapeOk = SC.validateInboundEntry(inbound).ok;
const plain = (authOk && shapeOk) ? decryptSpaceItem(cek, JSON.parse(inbound.payload)) : null;
rec(authOk && shapeOk && plain.toString('utf8') === 'a private space note', 'SC22. grantee verifies authorship + shape, then DECRYPTS the ciphertext payload (full E2E read)');
// a relay holding the entry but NOT the CEK cannot read it
rec(throws(() => decryptSpaceItem(generateCek(), JSON.parse(inbound.payload))), 'SC23. without the CEK the payload is undecryptable (relay sees only ciphertext)');

// ── putKeyGrant pass-through ─────────────────────────────────────────────────
await SC.putKeyGrant(SP, 0, bobId.publicKeyB64, JSON.stringify({ sealed: 'blob' }), 0);
const grants = await oplog.getCekGrants(SP, bobId.publicKeyB64);
rec(grants.length === 1 && grants[0].gen === 0, 'SC24. putKeyGrant stores a sealed-CEK grant retrievable by recipient');

// ── idempotency rides through the boundary ──────────────────────────────────
const rDup = await SC.appendEntry(SP, { op_id: 'op-a', author_did: OWNER_DID, kind: 'content', action: 'put', item_ref: itemId, gen: 0, item_lamport: 0, payload: JSON.stringify(envelope) });
rec(rDup.deduped === true && rDup.seq === 0, 'SC25. appendEntry replays idempotently through the boundary (oplog dedup honored)');

db.close();
console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — SpaceCrypto boundary: author-signed, fail-closed, bounded, E2E-decryptable (BU-OPLOG-E2E O2)');

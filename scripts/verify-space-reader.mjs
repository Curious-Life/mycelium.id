// verify:space-reader — GRANTEE decrypt path gate (E2E shared spaces, O3-SERVE-B).
//
// Closes the loop END-TO-END against the real 0044 oplog + real identities: the owner
// WRITES ciphertext (space-content-writer) + grants a member, the SERVE shape is built
// from the oplog (entries + the member's sealed grants), and the grantee DECODES it
// locally — verifying authorship + shape + gen-binding, decrypting under its own sealed
// CEK, resolving LWW by seq. Adversarial: a forged/spliced entry, a gen-relabel, and a
// removed member are all rejected (no plaintext to a non-holder).

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createIdentity } from '../src/identity/identity.js';
import { createSpaceOplogNamespace } from '../src/db/space-oplog.js';
import { createSpaceCrypto } from '../src/crypto/space-crypto.js';
import { createSpaceKeyManager } from '../src/crypto/space-key-manager.js';
import { createSpaceContentWriter } from '../src/crypto/space-content-writer.js';
import { decodeSharedSpace } from '../src/crypto/space-reader.js';

let pass = 0, fail = 0;
const rec = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`); ok ? pass++ : fail++; };

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
const aliceId = createIdentity({ masterHex: 'b2'.repeat(32) });
const malloryId = createIdentity({ masterHex: 'e5'.repeat(32) });
const OWNER = 'did:web:owner.example', ALICE = 'did:web:alice.example';
const alice = { did: ALICE, keyAgreementPublicKeyB64: aliceId.keyAgreementPublicKeyB64 };

const ownerSC = createSpaceCrypto({ identity: ownerId, db: dbFacade });
const km = createSpaceKeyManager({ identity: ownerId, db: dbFacade, selfDid: OWNER, spaceCrypto: ownerSC });
const writer = createSpaceContentWriter({ keyManager: km, spaceCrypto: ownerSC, oplog, selfDid: OWNER });
// the GRANTEE's own crypto seam (alice's identity)
const aliceSC = createSpaceCrypto({ identity: aliceId, db: dbFacade });
const aliceKm = createSpaceKeyManager({ identity: aliceId, db: dbFacade, selfDid: ALICE, spaceCrypto: aliceSC });
const malloryKm = createSpaceKeyManager({ identity: malloryId, db: dbFacade, selfDid: 'did:web:mallory.example', spaceCrypto: createSpaceCrypto({ identity: malloryId, db: dbFacade }) });

const SP = 'space-1';

// Build the SERVE shape exactly as handlers.sharedContent does for a peer (entries +
// that peer's sealed grants + head).
async function serveTo(recipientDid) {
  const entries = await oplog.listSince(SP, -1, 1000);
  const grants = await oplog.getCekGrants(SP, recipientDid);
  const head = await oplog.head(SP);
  return { kind: 'space', name: 'Work', head, entries, grants };
}
const decodeAs = (kmgr, sc, served, ownerPub = ownerId.publicKeyB64) =>
  decodeSharedSpace({ ref: SP, name: served.name, entries: served.entries, grants: served.grants, ownerSigningKeyB64: ownerPub, keyManager: kmgr, spaceCrypto: sc });

// ── owner writes + grants alice ─────────────────────────────────────────────
await writer.putItem(SP, 'doc-1', 'the first secret');
await writer.putItem(SP, 'doc-2', 'the second secret');
await km.addMember(SP, alice);

// ── grantee decodes → plaintext ─────────────────────────────────────────────
const served = await serveTo(ALICE);
const view = decodeAs(aliceKm, aliceSC, served);
const got = Object.fromEntries(view.knowledge.map((k) => [k.item_id, k.content]));
rec(view.kind === 'space' && view.name === 'Work', 'R1. decodeSharedSpace returns the space view (kind + name)');
rec(got['doc-1'] === 'the first secret' && got['doc-2'] === 'the second secret', 'R2. ★ grantee DECRYPTS both items end-to-end (write→serve→decode→plaintext)');

// ── non-member (mallory) gets ciphertext it cannot open → empty ─────────────
const servedM = await serveTo('did:web:mallory.example'); // no grant rows for mallory
const viewM = decodeAs(malloryKm, createSpaceCrypto({ identity: malloryId, db: dbFacade }), servedM);
rec(viewM.knowledge.length === 0, 'R3. ★ a non-member holds no CEK → decodes to NOTHING (relay/served ciphertext is useless without a grant)');

// ── LWW by seq: edit doc-1, grantee sees the latest ─────────────────────────
await writer.putItem(SP, 'doc-1', 'the first secret (edited)');
const view2 = decodeAs(aliceKm, aliceSC, await serveTo(ALICE));
rec(view2.knowledge.find((k) => k.item_id === 'doc-1').content === 'the first secret (edited)', 'R4. LWW by seq — the highest-seq edit wins');

// ── delete tombstone removes the item ───────────────────────────────────────
await writer.deleteItem(SP, 'doc-2');
const view3 = decodeAs(aliceKm, aliceSC, await serveTo(ALICE));
rec(!view3.knowledge.some((k) => k.item_id === 'doc-2'), 'R5. a delete tombstone (higher seq) removes the item from the decoded view');

// ── adversarial: a FORGED entry (mallory-signed, claims owner author) is dropped ─
const { canonicalize } = await import('../src/federation/sign.js');
const signHeader = (e, id) => id.sign(canonicalize({ op_id: e.op_id, author_did: e.author_did, kind: e.kind, action: e.action, item_ref: e.item_ref, gen: e.gen, item_lamport: e.item_lamport, payload: e.payload }));
const servedForge = await serveTo(ALICE);
// mallory forges a content entry claiming OWNER authorship but signs it with HER key.
const forged = { seq: 9999, op_id: 'forge', author_did: OWNER, kind: 'content', action: 'put', item_ref: 'doc-3', gen: 0, item_lamport: 99, payload: servedForge.entries[0].payload };
forged.header_sig = signHeader(forged, malloryId); // signed by MALLORY, not the owner
const servedWithForge = { ...servedForge, entries: [...servedForge.entries, forged] };
const viewForge = decodeAs(aliceKm, aliceSC, servedWithForge);
rec(!viewForge.knowledge.some((k) => k.item_id === 'doc-3'), 'R6. ★ a FORGED entry (signed by mallory, not the owner) is dropped — authorship verified against the owner key');

// ── adversarial: a gen-RELABEL (outer gen ≠ inner envelope gen) is dropped ───
const servedRelabel = await serveTo(ALICE);
const target = servedRelabel.entries.find((e) => e.kind === 'content' && e.action === 'put');
const innerEnv = JSON.parse(target.payload);
// relabel the OUTER gen to a different value, re-sign as the owner (a malicious owner/relay
// with the signing key still cannot make inner≠outer pass — the reader rejects the mismatch)
const relabeled = { ...target, gen: innerEnv.gen + 5 };
relabeled.header_sig = ownerId.sign(canonicalize({ op_id: relabeled.op_id, author_did: relabeled.author_did, kind: relabeled.kind, action: relabeled.action, item_ref: relabeled.item_ref, gen: relabeled.gen, item_lamport: relabeled.item_lamport, payload: relabeled.payload }));
const viewRelabel = decodeAs(aliceKm, aliceSC, { ...servedRelabel, entries: [relabeled] });
rec(viewRelabel.knowledge.length === 0, 'R7. ★ a gen-RELABEL (outer entry.gen ≠ inner envelope.gen) is rejected even with a valid owner signature');

// ── forward secrecy through the read path: remove alice, she can't read gen-1 ─
await km.removeMember(SP, { did: ALICE, keyAgreementPublicKeyB64: aliceId.keyAgreementPublicKeyB64 }, []);
await writer.putItem(SP, 'doc-4', 'post-removal secret');
const viewAfter = decodeAs(aliceKm, aliceSC, await serveTo(ALICE));
rec(!viewAfter.knowledge.some((k) => k.item_id === 'doc-4'), 'R8. ★ a REMOVED member cannot decode gen-1 content (forward secrecy through the grantee read path)');
// but the owner (still a member) can
const ownerView = decodeAs(km, ownerSC, await serveTo(OWNER));
rec(ownerView.knowledge.find((k) => k.item_id === 'doc-4')?.content === 'post-removal secret', 'R9. the owner (member) still decodes the gen-1 content');

// ── guards ──────────────────────────────────────────────────────────────────
let threw = false; try { decodeSharedSpace({ ref: SP, entries: [], grants: [], keyManager: aliceKm, spaceCrypto: aliceSC }); } catch { threw = true; }
rec(threw, 'R10. decodeSharedSpace requires ownerSigningKeyB64 (fail-closed)');

db.close();
console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — grantee decrypt path: authorship-verified, gen-bound, forward-secret, LWW-by-seq (BU-OPLOG-E2E O3-SERVE-B)');

// verify:space-key-manager — SpaceKeyManager gate (E2E shared spaces, BU-OPLOG-E2E O3-KM).
//
// The CEK lifecycle linchpin, run END-TO-END against the REAL 0044 oplog (in-memory
// SQLite) + REAL identities + the REAL SpaceCrypto boundary. Proves the headline
// security property of the whole lockbox through the ACTUAL grant store + origin:
//   • mint CEK_0 sealed to self, idempotent;
//   • owner encrypts/decrypts current content; a granted member opens the SAME CEK and
//     reads the owner's content (full E2E read across two boxes);
//   • membership changes are author-signed, auditable oplog entries;
//   • FORWARD SECRECY: after removeMember, content under gen+1 is readable by survivors
//     but NOT by the removed member (who never received the gen+1 seal) — while the
//     removed member can STILL read the old gen-g content they legitimately held.

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createIdentity } from '../src/identity/identity.js';
import { createSpaceOplogNamespace } from '../src/db/space-oplog.js';
import { createSpaceCrypto } from '../src/crypto/space-crypto.js';
import { createSpaceKeyManager } from '../src/crypto/space-key-manager.js';
import { openCekGrant } from '../src/crypto/space-cek.js';

let pass = 0, fail = 0;
const rec = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`); ok ? pass++ : fail++; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const throwsA = async (fn) => { try { await fn(); return false; } catch { return true; } };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(':memory:');
db.exec(readFileSync(join(ROOT, 'migrations/0044_shared_spaces_e2e.sql'), 'utf8'));
const d1Query = async (sql, params = []) => {
  if (/^\s*SELECT/i.test(sql)) return { results: db.prepare(sql).all(...(params || [])) };
  db.prepare(sql).run(...(params || [])); return { results: [] };
};
const oplog = createSpaceOplogNamespace({ d1Query });
const dbFacade = { spaceOplog: oplog };

// three boxes: owner (home), alice (granted), carol (survivor)
const ownerId = createIdentity({ masterHex: 'a1'.repeat(32) });
const aliceId = createIdentity({ masterHex: 'b2'.repeat(32) });
const carolId = createIdentity({ masterHex: 'c3'.repeat(32) });
const OWNER = 'did:web:owner.example', ALICE = 'did:web:alice.example', CAROL = 'did:web:carol.example';
const alice = { did: ALICE, keyAgreementPublicKeyB64: aliceId.keyAgreementPublicKeyB64 };
const carol = { did: CAROL, keyAgreementPublicKeyB64: carolId.keyAgreementPublicKeyB64 };

const SP = 'space-1';
const ownerSC = createSpaceCrypto({ identity: ownerId, db: dbFacade });
const km = createSpaceKeyManager({ identity: ownerId, db: dbFacade, selfDid: OWNER, spaceCrypto: ownerSC });
// each member runs their OWN key manager over the SAME oplog (their box) to unseal grants
const aliceKm = createSpaceKeyManager({ identity: aliceId, db: dbFacade, selfDid: ALICE, spaceCrypto: createSpaceCrypto({ identity: aliceId, db: dbFacade }) });
const carolKm = createSpaceKeyManager({ identity: carolId, db: dbFacade, selfDid: CAROL, spaceCrypto: createSpaceCrypto({ identity: carolId, db: dbFacade }) });

// ── construction guards ──────────────────────────────────────────────────────
rec(throws(() => createSpaceKeyManager({ identity: ownerId, db: dbFacade, selfDid: OWNER })), 'KM0. construction without spaceCrypto throws');
rec(throws(() => createSpaceKeyManager({ identity: ownerId, db: dbFacade, spaceCrypto: ownerSC })), 'KM0b. construction without selfDid throws');

// ── mint CEK_0, idempotent ───────────────────────────────────────────────────
const e0 = await km.ensureSpaceKey(SP);
const e0b = await km.ensureSpaceKey(SP);
const ownerGrants0 = await oplog.getCekGrants(SP, OWNER);
rec(e0.gen === 0 && e0b.gen === 0 && ownerGrants0.length === 1, 'KM1. ensureSpaceKey mints CEK_0 sealed to self, idempotent (one self-grant)');

// ── owner reads its own current CEK + round-trips content ───────────────────
const ring0 = await km.ring(SP);
const env = ring0.encryptItem('doc-1', 'a private space note', { author_did: OWNER });
rec(env.gen === 0 && ring0.decryptItem(env).toString('utf8') === 'a private space note', 'KM2. owner ring encrypts+decrypts current-gen content (gen 0)');

// ── add alice → she opens the SAME CEK and reads owner content (E2E read) ────
const a0 = await km.addMember(SP, alice);
const aliceRing = await aliceKm.ring(SP);
rec(a0.gen === 0 && aliceRing.decryptItem(env).toString('utf8') === 'a private space note', 'KM3. addMember seals current CEK to alice; her box DECRYPTS owner content (full E2E read)');

// membership entries are author-signed + auditable
const log = await oplog.listSince(SP, -1);
const addEntry = log.find((x) => x.kind === 'member-add' && x.item_ref === ALICE);
const grantEntry = log.find((x) => x.kind === 'key-grant' && x.item_ref === ALICE && x.gen === 0);
rec(!!addEntry && ownerSC.verifyEntry(addEntry, ownerId.publicKeyB64), 'KM4. member-add is an author-signed oplog entry (auditable membership log)');
rec(!!grantEntry && ownerSC.verifyEntry(grantEntry, ownerId.publicKeyB64), 'KM5. key-grant is an author-signed oplog entry');

// a stranger (carol, not yet a member) cannot read
const carolRingBefore = await carolKm.ring(SP);
rec(throws(() => carolRingBefore.decryptItem(env)), 'KM6. a non-member (carol) holds no CEK → cannot decrypt (fail-closed)');

// add carol too (she will SURVIVE alice's removal)
await km.addMember(SP, carol);
const carolRing0 = await carolKm.ring(SP);
rec(carolRing0.decryptItem(env).toString('utf8') === 'a private space note', 'KM7. carol added → also reads gen-0 content');

// ── FORWARD SECRECY: remove alice, rekey to gen 1 (survivor: carol) ─────────
const r1 = await km.removeMember(SP, { did: ALICE, keyAgreementPublicKeyB64: aliceId.keyAgreementPublicKeyB64 }, [carol]);
const origin = await oplog.getOrigin(SP);
rec(r1.gen === 1 && origin.current_gen === 1, 'KM8. removeMember mints CEK_1 + advances current_gen to 1');
// alice got NO gen-1 grant; carol + owner did
rec((await oplog.getCekGrants(SP, ALICE)).every((g) => g.gen !== 1), 'KM9. the REMOVED member (alice) received NO gen-1 seal');
rec((await oplog.getCekGrants(SP, CAROL)).some((g) => g.gen === 1) && (await oplog.getCekGrants(SP, OWNER)).some((g) => g.gen === 1), 'KM10. survivors (carol + owner) received the gen-1 seal');

// owner writes NEW content under gen 1
const ring1 = await km.ring(SP);
const env1 = ring1.encryptItem('doc-2', 'post-removal secret', { author_did: OWNER });
rec(env1.gen === 1, 'KM11. owner now encrypts new content under the current gen (1)');

// HEADLINE: removed alice CANNOT read gen-1 content, survivor carol CAN
const aliceRingAfter = await aliceKm.ring(SP);
const carolRingAfter = await carolKm.ring(SP);
rec(throws(() => aliceRingAfter.decryptItem(env1)), 'KM12. ★ FORWARD SECRECY: removed alice CANNOT decrypt gen-1 content (no gen-1 CEK, even with full oplog ciphertext)');
rec(carolRingAfter.decryptItem(env1).toString('utf8') === 'post-removal secret', 'KM13. ★ survivor carol CAN decrypt gen-1 content');
// alice can STILL read the OLD gen-0 content she legitimately held (read-what-you-had)
rec(aliceRingAfter.decryptItem(env).toString('utf8') === 'a private space note', 'KM14. removed alice can STILL read the gen-0 content she held (no retroactive lockout)');

// ── E7 independence: CEK_1 is not derivable from CEK_0 ──────────────────────
const cek0 = ring1.cek(0), cek1 = ring1.cek(1);
rec(!cek0.equals(cek1), 'KM15. CEK_1 is independent of CEK_0 (fresh CSPRNG, never chained — E7)');

// ── membership-change idempotency (replay-safe) ─────────────────────────────
// A genuine replay: add a FRESH member twice at the same gen. The 2nd call appends
// nothing (deterministic op_ids → oplog dedups), proving an at-least-once announce/grant
// retry can't double-apply. (Using a fresh did avoids colliding with the survivor
// key-grant removeMember already seeded for carol/owner.)
const daveId = createIdentity({ masterHex: 'd4'.repeat(32) });
const dave = { did: 'did:web:dave.example', keyAgreementPublicKeyB64: daveId.keyAgreementPublicKeyB64 };
await km.addMember(SP, dave);                       // 1st add at gen 1
const before = (await oplog.listSince(SP, -1)).length;
await km.addMember(SP, dave);                       // replay → must be a no-op
const after = (await oplog.listSince(SP, -1)).length;
rec(after === before, 'KM16. replaying addMember (same member, same gen) dedups — no double-apply (announce/grant retry-safe)', `before ${before} after ${after}`);

// ── KM17 (review F1): removal excludes by KEY, not just DID ──────────────────
// A survivor list carrying the REMOVED member's key under a did:web VARIANT (case +
// trailing slash) must NOT receive the new seal — else the removed member, controlling
// their own box, queries that variant recipient_did and unseals gen+1 with their key.
const SP2 = 'space-2';
await km.ensureSpaceKey(SP2);
await km.addMember(SP2, alice);
const aliceVariant = { did: 'did:web:Alice.example/', keyAgreementPublicKeyB64: aliceId.keyAgreementPublicKeyB64 };
await km.removeMember(SP2, { did: ALICE, keyAgreementPublicKeyB64: aliceId.keyAgreementPublicKeyB64 }, [carol, aliceVariant]);
// Direct check: NO gen-1 grant row anywhere is openable by alice's key (under that row's
// OWN recipient_did context — exactly what a malicious removed box would do).
const gen1Rows = db.prepare('SELECT recipient_did, gen, blob FROM space_cek_grants WHERE space_id=? AND gen=1').all(SP2);
const aliceOpensAny = gen1Rows.some((row) => { try { openCekGrant({ gen: row.gen, blob: JSON.parse(row.blob) }, aliceId, SP2, row.recipient_did); return true; } catch { return false; } });
rec(!aliceOpensAny && gen1Rows.length > 0, 'KM17. ★ removal excludes by KEY — no gen-1 grant is openable by the removed key, even under a did:web VARIANT recipient_did (E9 holds vs DID-variant bypass)', `gen1 grants ${gen1Rows.length}`);
rec(await throwsA(async () => { await km.removeMember(SP2, ALICE, [carol]); }), 'KM17b. removeMember REQUIRES the removed member key (bare-DID call fails closed)');

// ── KM18 (review F2): ensureSpaceKey mints past an unopenable self-grant ─────
const SP3 = 'space-3';
await oplog.ensureOrigin(SP3, { isHome: 1, originDid: OWNER });
db.prepare('INSERT INTO space_cek_grants (space_id, gen, recipient_did, blob, seq) VALUES (?,0,?,?,NULL)').run(SP3, OWNER, JSON.stringify({ bogus: true }));
await km.ensureSpaceKey(SP3);
const ring3 = await km.ring(SP3);
let canWrite = false; try { ring3.encryptItem('d', 'x', { author_did: OWNER }); canWrite = true; } catch { canWrite = false; }
rec(canWrite, 'KM18. ensureSpaceKey mints an OPENABLE CEK even when a foreign/unopenable self-grant sits at the current gen (no mint-skip brick)');

db.close();
console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — SpaceKeyManager: mint/seal/unseal + forward-secret rekey, E2E through the real oplog (BU-OPLOG-E2E O3-KM)');

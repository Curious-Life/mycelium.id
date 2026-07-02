// verify:space-membership — BU-REKEY gate (E2E shared spaces). The bridge from the
// portal share/revoke actions to the SpaceKeyManager: grant seals the current CEK to the
// new member's resolved X25519 key; revoke ALLOWLIST-rekeys so the evicted peer can't read
// new content. Fail-closed UX-soft: an unresolvable key never leaks plaintext.

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createIdentity } from '../src/identity/identity.js';
import { createSpaceOplogNamespace } from '../src/db/space-oplog.js';
import { createSpaceCrypto } from '../src/crypto/space-crypto.js';
import { createSpaceKeyManager } from '../src/crypto/space-key-manager.js';
import { createSpaceContentWriter } from '../src/crypto/space-content-writer.js';
import { applyShareGrant, applyShareRevoke } from '../src/federation/space-membership.js';

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

const ownerId = createIdentity({ masterHex: 'a1'.repeat(32) });
const aliceId = createIdentity({ masterHex: 'b2'.repeat(32) });
const carolId = createIdentity({ masterHex: 'c3'.repeat(32) });
const OWNER = 'did:web:owner.example', ALICE = 'did:web:alice.example', CAROL = 'did:web:carol.example';

const ownerSC = createSpaceCrypto({ identity: ownerId, db: { spaceOplog: oplog } });
const km = createSpaceKeyManager({ identity: ownerId, db: { spaceOplog: oplog }, selfDid: OWNER, spaceCrypto: ownerSC });
const writer = createSpaceContentWriter({ keyManager: km, spaceCrypto: ownerSC, oplog, selfDid: OWNER });
// the owner box's `db` facade (what the helper receives)
const dbFacade = { spaceOplog: oplog, spaceKeyManager: km, spaceCrypto: ownerSC };

// stub resolver: did -> X25519 key (the published #key-enc). mallory's did is unresolvable.
const KEYS = { [ALICE]: aliceId.keyAgreementPublicKeyB64, [CAROL]: carolId.keyAgreementPublicKeyB64 };
const resolveKey = async (did) => { if (did === 'did:web:offline.example') throw new Error('peer unreachable'); return KEYS[did] || null; };

// grantee-side rings (each peer unseals their own grants)
const ringFor = (id, did) => createSpaceKeyManager({ identity: id, db: { spaceOplog: oplog }, selfDid: did, spaceCrypto: createSpaceCrypto({ identity: id, db: { spaceOplog: oplog } }) });
const aliceKm = ringFor(aliceId, ALICE);
const carolKm = ringFor(carolId, CAROL);
const SP = 'space-1';

// ── grant seals the CEK; member decrypts ────────────────────────────────────
await writer.putItem(SP, 'doc-1', 'a shared secret');
const g1 = await applyShareGrant({ db: dbFacade, spaceId: SP, memberDid: ALICE, resolveKey });
const env1 = JSON.parse((await oplog.listSince(SP, -1)).find((e) => e.item_ref === 'doc-1').payload);
rec(g1.sealed === true, 'M1. applyShareGrant seals the current CEK to the resolved member key');
rec((aliceKm.ringFromGrants(SP, await oplog.getCekGrants(SP, ALICE))).decryptItem(env1).toString('utf8') === 'a shared secret', 'M2. ★ the granted member DECRYPTS owner content (grant → seal → unseal)');

// ── grant with an UNRESOLVABLE key → no seal, no throw, no leak ──────────────
const gOff = await applyShareGrant({ db: dbFacade, spaceId: SP, memberDid: 'did:web:offline.example', resolveKey });
rec(gOff.sealed === false && gOff.reason === 'key-unresolved', 'M3. grant with an unresolvable key → {sealed:false}, never throws (fail-closed UX-soft)');
rec((await oplog.getCekGrants(SP, 'did:web:offline.example')).length === 0, 'M4. an unsealed member receives NO CEK grant (no leak)');

// ── grant when E2E is off (no keyManager) → clean no-op ──────────────────────
const gNo = await applyShareGrant({ db: { spaceOplog: oplog }, spaceId: SP, memberDid: ALICE, resolveKey });
rec(gNo.sealed === false && gNo.reason === 'e2e-off', 'M5. grant with no spaceKeyManager (remote off) → {e2e-off}, no crash');

// ── revoke rekeys: survivor reads new content, evicted member cannot ────────
await applyShareGrant({ db: dbFacade, spaceId: SP, memberDid: CAROL, resolveKey }); // carol also a member
const rev = await applyShareRevoke({ db: dbFacade, spaceId: SP, removedDid: ALICE, survivorDids: [CAROL], resolveKey });
rec(rev.rekeyed === true && rev.survivors === 1, 'M6. applyShareRevoke rekeys, sealing to the resolvable survivors only');
await writer.putItem(SP, 'doc-2', 'post-revoke secret');
const env2 = JSON.parse((await oplog.listSince(SP, -1)).find((e) => e.item_ref === 'doc-2').payload);
rec(env2.gen === 1, 'M7. the next write is under the new generation (1)');
let aliceCanRead = true; try { aliceKm.ringFromGrants(SP, await oplog.getCekGrants(SP, ALICE)).decryptItem(env2); } catch { aliceCanRead = false; }
rec(!aliceCanRead, 'M8. ★ the EVICTED member (alice) cannot decrypt post-revoke content (forward secrecy via rekey)');
rec(carolKm.ringFromGrants(SP, await oplog.getCekGrants(SP, CAROL)).decryptItem(env2).toString('utf8') === 'post-revoke secret', 'M9. ★ the survivor (carol) CAN decrypt post-revoke content');
// alice retains the gen-0 content she held
rec(aliceKm.ringFromGrants(SP, await oplog.getCekGrants(SP, ALICE)).decryptItem(env1).toString('utf8') === 'a shared secret', 'M10. the evicted member can still read the gen-0 content she held (no retroactive lockout)');

// ── revoke with an UNRESOLVABLE survivor → skipped, rekey still happens ──────
await applyShareGrant({ db: dbFacade, spaceId: SP, memberDid: CAROL, resolveKey }); // re-add carol at gen1 (already has it)
const rev2 = await applyShareRevoke({ db: dbFacade, spaceId: SP, removedDid: CAROL, survivorDids: ['did:web:offline.example'], resolveKey });
rec(rev2.rekeyed === true && rev2.survivors === 0, 'M11. revoke skips an unresolvable survivor but STILL rekeys (gen advances; they re-sync later)');

// ── revoke on a never-keyed space → clean no-op ─────────────────────────────
const revNone = await applyShareRevoke({ db: dbFacade, spaceId: 'space-never', removedDid: ALICE, survivorDids: [], resolveKey });
rec(revNone.rekeyed === false && revNone.reason === 'not-keyed', 'M12. revoke on a never-keyed space → {not-keyed}, no throw');

// ── F1: a did:web VARIANT of the evicted peer in survivorDids gets NO new grant ──
const SPv = 'space-variant';
await writer.putItem(SPv, 'd', 'x');
await applyShareGrant({ db: dbFacade, spaceId: SPv, memberDid: ALICE, resolveKey });
// hostile/duplicate survivor: alice's identity under a case+slash variant DID
const ALICE_VARIANT = 'did:web:Alice.example/';
const resolveWithVariant = async (did) => { if (did === ALICE_VARIANT) return aliceId.keyAgreementPublicKeyB64; return resolveKey(did); };
await applyShareRevoke({ db: dbFacade, spaceId: SPv, removedDid: ALICE, survivorDids: [ALICE_VARIANT], resolveKey: resolveWithVariant });
const gen1Variant = db.prepare('SELECT recipient_did, gen, blob FROM space_cek_grants WHERE space_id=? AND gen=1').all(SPv);
const aliceOpensVariant = gen1Variant.some((row) => { try { aliceKm.ringFromGrants(SPv, [{ gen: row.gen, blob: JSON.parse(row.blob) }]); const r = aliceKm.ringFromGrants(SPv, [{ gen: row.gen, blob: JSON.parse(row.blob) }]); return r.hasGen(1); } catch { return false; } });
rec(!aliceOpensVariant, 'M13. ★ revoke excludes a did:web VARIANT of the evicted peer from the rekey — no gen-1 grant openable by the removed key (F1 fix)');

// ── F2: a FAILED rekey is surfaced (rekeyed:false, reason:rekey-failed), not swallowed ──
const failingDb = { spaceOplog: { getOrigin: async () => ({ current_gen: 0 }) }, spaceKeyManager: { rekeyTo: async () => { throw new Error('oplog write failed'); } } };
const revFail = await applyShareRevoke({ db: failingDb, spaceId: SP, removedDid: ALICE, survivorDids: [CAROL], resolveKey });
rec(revFail.rekeyed === false && revFail.reason === 'rekey-failed', 'M14. a FAILED rekey returns {rekeyed:false, reason:rekey-failed} — surfaced, never thrown/swallowed (F2 fix)');

// ── M15: rekeyTo's OWN exclusion layer (defense in depth) — a future caller that passes
//    a variant survivor directly to rekeyTo (bypassing applyShareRevoke) is still safe. ──
const SPd = 'space-direct';
await writer.putItem(SPd, 'd', 'x');
await applyShareGrant({ db: dbFacade, spaceId: SPd, memberDid: ALICE, resolveKey });
// call rekeyTo DIRECTLY with the evicted peer's key under a variant DID in survivors
const ALICE_VAR = 'did:web:Alice.example/';
await km.rekeyTo(SPd, [{ did: ALICE_VAR, keyAgreementPublicKeyB64: aliceId.keyAgreementPublicKeyB64 }], { removedDid: ALICE, removedKey: aliceId.keyAgreementPublicKeyB64 });
const dRows = db.prepare('SELECT gen, blob FROM space_cek_grants WHERE space_id=? AND gen=1').all(SPd);
// the attacker controls their box → uses the VARIANT did as selfDid to open a variant-bound seal
const aliceVarKm = createSpaceKeyManager({ identity: aliceId, db: { spaceOplog: oplog }, selfDid: ALICE_VAR, spaceCrypto: createSpaceCrypto({ identity: aliceId, db: { spaceOplog: oplog } }) });
const aliceHoldsDirect = dRows.some((row) => { try { return aliceVarKm.ringFromGrants(SPd, [{ gen: row.gen, blob: JSON.parse(row.blob) }]).hasGen(1); } catch { return false; } });
rec(!aliceHoldsDirect, 'M15. ★ rekeyTo itself excludes a variant-DID / matching-key survivor (defense-in-depth layer, independent of applyShareRevoke)');

db.close();
console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — BU-REKEY membership bridge: grant seals, revoke forward-secret-rekeys, fail-closed UX-soft (E2E shared spaces)');

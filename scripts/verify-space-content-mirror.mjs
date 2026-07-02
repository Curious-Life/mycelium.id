// verify:space-content-mirror — O3-HOOK gate. Mirroring the owner's LOCAL plaintext
// space-knowledge writes into the E2E ciphertext oplog, proven END-TO-END: the owner adds
// knowledge → it's mirrored as ciphertext → a granted member DECODES it (real owner edits
// flow to grantees); a revoke tombstones it; a backfill brings pre-existing content into a
// newly-shared space; and the mirror is a clean no-op when E2E is off.

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
import { applyShareGrant } from '../src/federation/space-membership.js';
import { mirrorKnowledgeWrite, mirrorKnowledgeDelete, backfillSpace } from '../src/federation/space-content-mirror.js';

let pass = 0, fail = 0;
const rec = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`); ok ? pass++ : fail++; };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(':memory:');
db.exec(readFileSync(join(ROOT, 'migrations/0044_shared_spaces_e2e.sql'), 'utf8'));
// minimal space_knowledge table for the backfill list() — mirrors the real status column
db.exec(`CREATE TABLE space_knowledge (id TEXT PRIMARY KEY, space_id TEXT, content TEXT, status TEXT DEFAULT 'active', version INTEGER DEFAULT 1);`);
const d1Query = async (sql, params = []) => {
  if (/^\s*SELECT/i.test(sql)) return { results: db.prepare(sql).all(...(params || [])) };
  db.prepare(sql).run(...(params || [])); return { results: [] };
};
const oplog = createSpaceOplogNamespace({ d1Query });

const ownerId = createIdentity({ masterHex: 'a1'.repeat(32) });
const aliceId = createIdentity({ masterHex: 'b2'.repeat(32) });
const OWNER = 'did:web:owner.example', ALICE = 'did:web:alice.example';

const ownerSC = createSpaceCrypto({ identity: ownerId, db: { spaceOplog: oplog } });
const km = createSpaceKeyManager({ identity: ownerId, db: { spaceOplog: oplog }, selfDid: OWNER, spaceCrypto: ownerSC });
const writer = createSpaceContentWriter({ keyManager: km, spaceCrypto: ownerSC, oplog, selfDid: OWNER });
// a minimal space_knowledge namespace (list, for backfill)
const spaceKnowledge = { async list(spaceId, { status = 'active', limit = 100 } = {}) { return db.prepare('SELECT id, content, version FROM space_knowledge WHERE space_id=? AND status=? LIMIT ?').all(spaceId, status, limit); } };
const dbFacade = { spaceOplog: oplog, spaceKeyManager: km, spaceCrypto: ownerSC, spaceContent: writer, spaceKnowledge };

const aliceKm = createSpaceKeyManager({ identity: aliceId, db: { spaceOplog: oplog }, selfDid: ALICE, spaceCrypto: createSpaceCrypto({ identity: aliceId, db: { spaceOplog: oplog } }) });
const aliceSC = createSpaceCrypto({ identity: aliceId, db: { spaceOplog: oplog } });
const SP = 'space-1';

// grantee view: serve shape (oplog entries + alice's grants) → decode
const granteeView = async () => decodeSharedSpace({
  ref: SP, name: 'Work',
  entries: await oplog.listSince(SP, -1, 1000),
  grants: await oplog.getCekGrants(SP, ALICE),
  ownerSigningKeyB64: ownerId.publicKeyB64, keyManager: aliceKm, spaceCrypto: aliceSC,
});
const resolveKey = async (did) => (did === ALICE ? aliceId.keyAgreementPublicKeyB64 : null);

// ── owner shares (keys the space + seals to alice) ──────────────────────────
await km.ensureSpaceKey(SP);
await applyShareGrant({ db: dbFacade, spaceId: SP, memberDid: ALICE, resolveKey });

// ── add knowledge → mirrored → grantee sees plaintext ───────────────────────
const e1 = 'know-1';
db.prepare('INSERT INTO space_knowledge (id, space_id, content) VALUES (?,?,?)').run(e1, SP, 'shared insight one');
const m1 = await mirrorKnowledgeWrite(dbFacade, SP, e1, 'shared insight one');
rec(m1.mirrored === true, 'H1. mirrorKnowledgeWrite appends a ciphertext oplog entry for the knowledge row');
const v1 = await granteeView();
rec(v1.knowledge.find((k) => k.item_id === e1)?.content === 'shared insight one', 'H2. ★ the granted member DECODES the mirrored knowledge (real owner edit flows E2E)');
// the raw oplog payload is ciphertext, not the plaintext
const rawEntry = (await oplog.listSince(SP, -1)).find((e) => e.item_ref === e1);
rec(!rawEntry.payload.includes('shared insight one'), 'H3. the mirrored oplog payload is CIPHERTEXT (relay sees nothing)');

// ── idempotent: re-mirror the same entry → no duplicate ─────────────────────
await mirrorKnowledgeWrite(dbFacade, SP, e1, 'shared insight one');
const dupCount = db.prepare('SELECT COUNT(*) c FROM space_oplog WHERE space_id=? AND item_ref=? AND kind=?').get(SP, e1, 'content').c;
rec(dupCount === 1, 'H4. re-mirroring the same entry dedups (deterministic op_id kn:<id>) — one entry');

// ── revoke → tombstone → grantee no longer sees it ──────────────────────────
await mirrorKnowledgeDelete(dbFacade, SP, e1);
const v2 = await granteeView();
rec(!v2.knowledge.some((k) => k.item_id === e1), 'H5. a revoke mirrors a delete tombstone → the member no longer sees the item (LWW delete)');

// ── backfill: pre-existing content (added before keying) reaches a new share ─
const SP2 = 'space-2';
db.prepare('INSERT INTO space_knowledge (id, space_id, content) VALUES (?,?,?)').run('pre-1', SP2, 'written before sharing');
db.prepare('INSERT INTO space_knowledge (id, space_id, content) VALUES (?,?,?)').run('pre-2', SP2, 'also pre-existing');
// share SP2 — applyShareGrant ensureSpaceKey + addMember + BACKFILL
await applyShareGrant({ db: dbFacade, spaceId: SP2, memberDid: ALICE, resolveKey });
const v3 = decodeSharedSpace({ ref: SP2, name: 'S2', entries: await oplog.listSince(SP2, -1, 1000), grants: await oplog.getCekGrants(SP2, ALICE), ownerSigningKeyB64: ownerId.publicKeyB64, keyManager: aliceKm, spaceCrypto: aliceSC });
const got3 = Object.fromEntries(v3.knowledge.map((k) => [k.item_id, k.content]));
rec(got3['pre-1'] === 'written before sharing' && got3['pre-2'] === 'also pre-existing', 'H6. ★ backfill-on-share brings PRE-EXISTING knowledge into the oplog → the new member decodes it');

// ── backfill is idempotent (re-share doesn't duplicate) ─────────────────────
const bf = await backfillSpace(dbFacade, SP2);
const preCount = db.prepare('SELECT COUNT(*) c FROM space_oplog WHERE space_id=? AND item_ref=?').get(SP2, 'pre-1').c;
rec(bf.backfilled === 2 && preCount === 1, 'H7. backfill is idempotent — re-running does not duplicate entries');

// ── e2e off (no spaceContent) → clean no-op ─────────────────────────────────
const off = await mirrorKnowledgeWrite({ spaceKnowledge }, SP, 'x', 'y');
rec(off.mirrored === false, 'H8. mirror is a clean no-op when E2E is off (no spaceContent)');

// ── F3 (edit-safety): an in-place edit BUMPS version → the version-keyed op_id changes →
//    a NEW oplog entry. A bare kn:<id> (or a same-version retry) would hit the idempotency
//    fast-path and silently drop the edit. The op_id carries NO content hash (no relay
//    guess-and-confirm side channel) — version is benign metadata. ──
const SPe = 'space-edit';
db.prepare("INSERT INTO space_knowledge (id, space_id, content, status, version) VALUES ('ed-1',?, 'version A', 'active', 1)").run(SPe);
await km.ensureSpaceKey(SPe);
await applyShareGrant({ db: dbFacade, spaceId: SPe, memberDid: ALICE, resolveKey });
await mirrorKnowledgeWrite(dbFacade, SPe, 'ed-1', 'version A', { version: 1 });
await mirrorKnowledgeWrite(dbFacade, SPe, 'ed-1', 'version A', { version: 1 }); // retry same version → dedup
const afterSame = db.prepare("SELECT COUNT(*) c FROM space_oplog WHERE space_id=? AND item_ref='ed-1' AND kind='content'").get(SPe).c;
// the op_id must NOT contain a content hash — only the version-keyed form
const opIds = db.prepare("SELECT op_id FROM space_oplog WHERE space_id=? AND item_ref='ed-1'").all(SPe).map((r) => r.op_id);
rec(opIds.every((o) => /^kn:ed-1:v\d+$/.test(o)), 'H9a. the op_id is version-keyed (kn:<id>:v<n>) — NO content hash leaked into plaintext oplog metadata');
// simulate an in-place edit: bump version + change content, then backfill (or an edit-mirror)
db.prepare("UPDATE space_knowledge SET content='version B (edited)', version=2 WHERE id='ed-1'").run();
await mirrorKnowledgeWrite(dbFacade, SPe, 'ed-1', 'version B (edited)', { version: 2 }); // EDIT → new version
const afterEdit = db.prepare("SELECT COUNT(*) c FROM space_oplog WHERE space_id=? AND item_ref='ed-1' AND kind='content'").get(SPe).c;
rec(afterSame === 1 && afterEdit === 2, 'H9. ★ an EDIT (version bump) appends a NEW oplog entry — version-keyed op_id, no silent dedup (F3)');
const ve = decodeSharedSpace({ ref: SPe, name: 'E', entries: await oplog.listSince(SPe, -1, 1000), grants: await oplog.getCekGrants(SPe, ALICE), ownerSigningKeyB64: ownerId.publicKeyB64, keyManager: aliceKm, spaceCrypto: aliceSC });
rec(ve.knowledge.find((k) => k.item_id === 'ed-1')?.content === 'version B (edited)', 'H10. the grantee sees the EDITED content (LWW by seq shows the latest)');

// ── F1 (failed-tombstone heals): a revoked row gets a tombstone re-emitted by backfill ──
const SPt = 'space-tomb';
db.prepare("INSERT INTO space_knowledge (id, space_id, content, status) VALUES ('t-1',?, 'to be deleted', 'active')").run(SPt);
await km.ensureSpaceKey(SPt);
await applyShareGrant({ db: dbFacade, spaceId: SPt, memberDid: ALICE, resolveKey }); // backfills the active row
// simulate a LOST delete-mirror: revoke locally WITHOUT mirroring the tombstone
db.prepare("UPDATE space_knowledge SET status='revoked' WHERE id='t-1'").run();
const beforeHeal = decodeSharedSpace({ ref: SPt, name: 'T', entries: await oplog.listSince(SPt, -1, 1000), grants: await oplog.getCekGrants(SPt, ALICE), ownerSigningKeyB64: ownerId.publicKeyB64, keyManager: aliceKm, spaceCrypto: aliceSC });
rec(beforeHeal.knowledge.some((k) => k.item_id === 't-1'), 'H11. (setup) a lost delete-mirror leaves revoked content visible to the grantee');
await backfillSpace(dbFacade, SPt); // re-grant/backfill RECONCILES the delete
const afterHeal = decodeSharedSpace({ ref: SPt, name: 'T', entries: await oplog.listSince(SPt, -1, 1000), grants: await oplog.getCekGrants(SPt, ALICE), ownerSigningKeyB64: ownerId.publicKeyB64, keyManager: aliceKm, spaceCrypto: aliceSC });
rec(!afterHeal.knowledge.some((k) => k.item_id === 't-1'), 'H12. ★ backfill re-emits a tombstone for the revoked row → the grantee no longer sees it (F1 heal)');

db.close();
console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — O3-HOOK: local knowledge writes mirror to the ciphertext oplog, grantee-decodable, backfilled, idempotent (E2E shared spaces)');

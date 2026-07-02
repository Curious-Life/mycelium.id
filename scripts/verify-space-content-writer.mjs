// verify:space-content-writer — owner WRITE path gate (E2E shared spaces, O3-WRITE).
//
// Proves the owner-side write turns a plaintext item into a SIGNED CIPHERTEXT oplog entry
// a grantee can decrypt, END-TO-END against the real 0044 oplog + real identities + the
// real SpaceKeyManager/SpaceCrypto: ciphertext-only on the wire (relay sees no plaintext),
// per-item LWW lamport, delete tombstones, and eager-on-next-write rekey (a write after a
// membership removal re-encrypts under the new generation automatically).

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createIdentity } from '../src/identity/identity.js';
import { createSpaceOplogNamespace } from '../src/db/space-oplog.js';
import { createSpaceCrypto } from '../src/crypto/space-crypto.js';
import { createSpaceKeyManager } from '../src/crypto/space-key-manager.js';
import { createSpaceContentWriter } from '../src/crypto/space-content-writer.js';

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

const ownerId = createIdentity({ masterHex: 'a1'.repeat(32) });
const aliceId = createIdentity({ masterHex: 'b2'.repeat(32) });
const carolId = createIdentity({ masterHex: 'c3'.repeat(32) });
const OWNER = 'did:web:owner.example', ALICE = 'did:web:alice.example', CAROL = 'did:web:carol.example';
const alice = { did: ALICE, keyAgreementPublicKeyB64: aliceId.keyAgreementPublicKeyB64 };
const carol = { did: CAROL, keyAgreementPublicKeyB64: carolId.keyAgreementPublicKeyB64 };

const ownerSC = createSpaceCrypto({ identity: ownerId, db: dbFacade });
const km = createSpaceKeyManager({ identity: ownerId, db: dbFacade, selfDid: OWNER, spaceCrypto: ownerSC });
const writer = createSpaceContentWriter({ keyManager: km, spaceCrypto: ownerSC, oplog, selfDid: OWNER });
const aliceKm = createSpaceKeyManager({ identity: aliceId, db: dbFacade, selfDid: ALICE, spaceCrypto: createSpaceCrypto({ identity: aliceId, db: dbFacade }) });
const carolKm = createSpaceKeyManager({ identity: carolId, db: dbFacade, selfDid: CAROL, spaceCrypto: createSpaceCrypto({ identity: carolId, db: dbFacade }) });

const SP = 'space-1';

// ── construction guards ──────────────────────────────────────────────────────
rec(throws(() => createSpaceContentWriter({ keyManager: km, spaceCrypto: ownerSC, oplog })), 'W0. writer construction without selfDid throws');
rec(throws(() => createSpaceContentWriter({ spaceCrypto: ownerSC, oplog, selfDid: OWNER })), 'W0b. writer construction without keyManager throws');

// ── putItem → signed ciphertext oplog entry ─────────────────────────────────
const SECRET = 'a private space note — never plaintext on the wire';
const w0 = await writer.putItem(SP, 'doc-1', SECRET);
const entries = await oplog.listSince(SP, -1);
const contentEntry = entries.find((e) => e.kind === 'content' && e.item_ref === 'doc-1');
rec(w0.gen === 0 && !!contentEntry && contentEntry.action === 'put', 'W1. putItem appends a content/put entry under gen 0');
rec(ownerSC.verifyEntry(contentEntry, ownerId.publicKeyB64), 'W2. the content entry is author-signed (verifyEntry true)');
// THE wire bytes are ciphertext-only
rec(!contentEntry.payload.includes('private space note') && !contentEntry.payload.includes(SECRET), 'W3. ★ the oplog payload is CIPHERTEXT — the plaintext never appears on the wire (relay sees nothing)');

// ── a granted member decrypts; a stranger cannot ───────────────────────────
await km.addMember(SP, alice);
const aliceRing = await aliceKm.ring(SP);
const env = JSON.parse(contentEntry.payload);
rec(aliceRing.decryptItem(env).toString('utf8') === SECRET, 'W4. ★ a granted member (alice) DECRYPTS the written item → exact plaintext (full E2E write→read)');
const carolRing = await carolKm.ring(SP); // carol not yet a member
rec(throws(() => carolRing.decryptItem(env)), 'W5. a non-member (carol) cannot decrypt the item (fail-closed)');

// ── per-item LWW lamport + idempotent retry ─────────────────────────────────
const w1 = await writer.putItem(SP, 'doc-1', 'edit 2');
rec(w1.gen === 0 && w1.seq > w0.seq, 'W6. a second putItem to the same item appends a new entry (distinct seq)');
const lamports = (await oplog.listSince(SP, -1)).filter((e) => e.item_ref === 'doc-1' && e.kind === 'content').map((e) => e.item_lamport);
rec(lamports.length === 2 && lamports[1] > lamports[0], 'W7. item_lamport increments per item (LWW ordering for concurrent edits)');
const wRetry = await writer.putItem(SP, 'doc-1', 'edit 2', { opId: w1.op_id });
rec(wRetry.deduped === true && wRetry.seq === w1.seq, 'W8. a retried putItem with the same opId dedups (idempotent write)');

// ── delete tombstone ────────────────────────────────────────────────────────
const wd = await writer.deleteItem(SP, 'doc-1');
const del = (await oplog.listSince(SP, -1)).find((e) => e.action === 'delete' && e.item_ref === 'doc-1');
rec(!!del && del.payload == null && del.item_lamport > lamports[1], 'W9. deleteItem appends a signed tombstone (no payload, higher lamport → LWW resolves deleted)');

// ── eager-on-next-write rekey ───────────────────────────────────────────────
await km.addMember(SP, carol);
await km.removeMember(SP, { did: ALICE, keyAgreementPublicKeyB64: aliceId.keyAgreementPublicKeyB64 }, [carol]);
const w2 = await writer.putItem(SP, 'doc-2', 'post-removal secret');
rec(w2.gen === 1, 'W10. ★ eager-on-next-write — a write AFTER removal auto-encrypts under the new gen (1)');
const env2 = JSON.parse((await oplog.listSince(SP, -1)).find((e) => e.item_ref === 'doc-2').payload);
const aliceRingAfter = await aliceKm.ring(SP);
const carolRingAfter = await carolKm.ring(SP);
rec(throws(() => aliceRingAfter.decryptItem(env2)), 'W11. ★ the removed member (alice) CANNOT decrypt the gen-1 write (forward secrecy through the write path)');
rec(carolRingAfter.decryptItem(env2).toString('utf8') === 'post-removal secret', 'W12. ★ the survivor (carol) CAN decrypt the gen-1 write');

// ── input validation ────────────────────────────────────────────────────────
rec(await throwsA(async () => writer.putItem(SP, 'd', { obj: 1 })), 'W13. putItem rejects a non-string plaintext (no object/JSON smuggling)');
rec(await throwsA(async () => writer.putItem('', 'd', 'x')), 'W14. putItem rejects a missing spaceId/itemId');

db.close();
console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — owner write path: plaintext → signed ciphertext oplog, member-decryptable, forward-secret (BU-OPLOG-E2E O3-WRITE)');

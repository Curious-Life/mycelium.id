// verify:space-oplog — BU-OPLOG-E2E O1 gate (E2E shared spaces, 2026-06-30).
//
// Exercises migration 0044 (space_oplog / space_cek_grants / space_origin) + the
// db.spaceOplog namespace against a REAL in-memory SQLite DB: owner-assigned monotonic
// total order, op_id idempotency (no double-apply on replay), ordered pull (listSince),
// per-item LWW lamport, sealed-CEK grant store/fetch, owner-authority origin row, and
// per-space isolation. The DB layer is content-agnostic — payload/blob are opaque.

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSpaceOplogNamespace } from '../src/db/space-oplog.js';

let pass = 0, fail = 0;
const rec = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`); ok ? pass++ : fail++; };
const throwsAsync = async (fn) => { try { await fn(); return false; } catch { return true; } };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(':memory:');
db.exec(readFileSync(join(ROOT, 'migrations/0044_shared_spaces_e2e.sql'), 'utf8')); // runs the REAL migration

const d1Query = async (sql, params = []) => {
  if (/^\s*SELECT/i.test(sql)) return { results: db.prepare(sql).all(...(params || [])) };
  db.prepare(sql).run(...(params || [])); return { results: [] };
};
const op = createSpaceOplogNamespace({ d1Query });

const SP = 'space-1';
const entry = (op_id, over = {}) => ({ op_id, author_did: 'did:web:alice.example', kind: 'content', action: 'put', item_ref: 'doc-1', gen: 0, item_lamport: 0, payload: 'CIPHERTEXT', header_sig: 'SIG', ...over });

// ── origin ──────────────────────────────────────────────────────────────────
await op.ensureOrigin(SP, { isHome: 1 });
await op.ensureOrigin(SP); // idempotent
const origin = await op.getOrigin(SP);
rec(origin && origin.is_home === 1 && origin.current_gen === 0, 'O1. ensureOrigin creates the owner-authority row (is_home=1, gen=0), idempotent');

// ── append: monotonic seq + op_id idempotency ───────────────────────────────
const r0 = await op.append(SP, entry('op-a'));
const r1 = await op.append(SP, entry('op-b', { item_lamport: 5 }));
rec(r0.seq === 0 && r1.seq === 1 && !r0.deduped, 'O2. append assigns a monotonic 0-based seq');
const rDup = await op.append(SP, entry('op-a', { payload: 'DIFFERENT' }));
const count = db.prepare('SELECT COUNT(*) c FROM space_oplog WHERE space_id=?').get(SP).c;
rec(rDup.deduped === true && rDup.seq === 0 && count === 2, 'O3. duplicate op_id → deduped (same seq, no double-apply; replay-safe)');
rec((await op.head(SP)) === 1, 'O4. head() returns the highest seq');

// ── ordered pull ────────────────────────────────────────────────────────────
const all = await op.listSince(SP, -1);
const since0 = await op.listSince(SP, 0);
rec(all.length === 2 && all[0].seq === 0 && all[1].seq === 1, 'O5. listSince(-1) returns all entries in seq order');
rec(since0.length === 1 && since0[0].seq === 1, 'O6. listSince(0) returns only entries after seq 0 (incremental pull)');

// ── per-item LWW lamport ────────────────────────────────────────────────────
rec((await op.itemLamport(SP, 'doc-1')) === 5, 'O7. itemLamport returns the highest item_lamport for an item (LWW ordering)');
rec((await op.itemLamport(SP, 'nope')) === -1, 'O8. itemLamport for an unseen item → -1');

// ── sealed CEK grants ───────────────────────────────────────────────────────
await op.putCekGrant(SP, 0, 'did:web:alice.example', { eph: 'E0', iv: 'I', ct: 'C', tag: 'T' }, 0);
await op.putCekGrant(SP, 1, 'did:web:alice.example', { eph: 'E1', iv: 'I', ct: 'C', tag: 'T' }, 3);
await op.putCekGrant(SP, 0, 'did:web:bob.example', { eph: 'EB', iv: 'I', ct: 'C', tag: 'T' }, 0);
const aliceGrants = await op.getCekGrants(SP, 'did:web:alice.example', -1);
rec(aliceGrants.length === 2 && aliceGrants[0].gen === 0 && aliceGrants[1].gen === 1 && aliceGrants[0].blob.eph === 'E0',
  'O9. CEK grants stored + fetched per recipient, gen-ordered, blob JSON round-trips');
rec((await op.getCekGrants(SP, 'did:web:alice.example', 0)).length === 1, 'O10. getCekGrants sinceGen filter (gen > sinceGen)');
await op.putCekGrant(SP, 0, 'did:web:alice.example', { eph: 'E0b', iv: 'I', ct: 'C', tag: 'T' }, 0); // upsert
const grantCount = db.prepare('SELECT COUNT(*) c FROM space_cek_grants WHERE space_id=? AND gen=0 AND recipient_did=?').get(SP, 'did:web:alice.example').c;
rec(grantCount === 1 && (await op.getCekGrants(SP, 'did:web:alice.example', -1))[0].blob.eph === 'E0b', 'O11. putCekGrant is idempotent (upsert) on (space,gen,recipient)');

// ── rekey: advance current gen ──────────────────────────────────────────────
await op.setCurrentGen(SP, 1);
rec((await op.getOrigin(SP)).current_gen === 1, 'O12. setCurrentGen advances the space generation (BU-REKEY hook)');

// ── per-space isolation ─────────────────────────────────────────────────────
await op.ensureOrigin('space-2');
await op.append('space-2', entry('op-x'));
rec((await op.listSince('space-2', -1)).length === 1 && (await op.listSince(SP, -1)).length === 2 && (await op.head('space-2')) === 0,
  'O13. spaces are isolated — entries + seqs do not bleed across spaces');
rec((await op.getCekGrants('space-2', 'did:web:alice.example', -1)).length === 0, 'O14. CEK grants are per-space isolated');

// ── fail-closed ─────────────────────────────────────────────────────────────
rec(await throwsAsync(() => op.append(SP, { op_id: 'x', author_did: 'd', kind: 'content' /* no header_sig */ })),
  'O15. append without an owner header_sig → rejected (every entry must be signed)');

// ── concurrency (review F2): the gate must catch the seq race ───────────────
// Two CONCURRENT appends with distinct op_ids must both persist with DISTINCT seqs
// (the old read-then-insert lost one to a PK collision). The async d1Query yields at
// each await, so Promise.all genuinely interleaves the two appends.
await op.ensureOrigin('space-cc');
const [ca, cb] = await Promise.all([op.append('space-cc', entry('c-a')), op.append('space-cc', entry('c-b'))]);
const ccount = db.prepare('SELECT COUNT(*) c FROM space_oplog WHERE space_id=?').get('space-cc').c;
rec(ccount === 2 && ca.seq !== cb.seq, 'O16. two CONCURRENT appends (distinct op_ids) → both persist with DISTINCT seqs (no race / lost write)',
  `seqs ${ca.seq},${cb.seq} rows ${ccount}`);
// Two CONCURRENT appends with the SAME op_id (a retry racing the original) → both
// resolve, exactly one row, both report the same seq (idempotency holds under race).
await op.ensureOrigin('space-cc2');
const dr = await Promise.allSettled([op.append('space-cc2', entry('dup')), op.append('space-cc2', entry('dup'))]);
const dcount = db.prepare('SELECT COUNT(*) c FROM space_oplog WHERE space_id=?').get('space-cc2').c;
const bothOk = dr.every((x) => x.status === 'fulfilled');
const sameSeq = bothOk && dr[0].value.seq === dr[1].value.seq;
rec(bothOk && dcount === 1 && sameSeq, 'O17. two CONCURRENT same-op_id appends → both resolve, exactly ONE row, same seq (idempotency under race)',
  `fulfilled=${bothOk} rows=${dcount} sameSeq=${sameSeq}`);

db.close();
console.log(`\n${pass} pass · ${fail} fail`);
console.log(fail === 0
  ? 'VERDICT: GO — signed ciphertext oplog + sealed-CEK store: ordered, idempotent, isolated (BU-OPLOG-E2E O1)'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(fail === 0 ? 0 : 1);

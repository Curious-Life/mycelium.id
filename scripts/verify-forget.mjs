// verify:forget — Context Bank Phase 1. Boots the real MCP server and drives the
// forget + mark tools on a LOCAL vault, asserting soft-redact correctness:
// content + both embedding fingerprints nulled, clustering point deleted, in-RAM
// index evicted, row tombstoned (no hard delete), audited WITHOUT plaintext, and
// idempotent; mark sets salience and getContext surfaces pinned. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-forget.db', KCV = 'data/verify-forget-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close, tools, handlers, searchHelpers } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const SECRET = 'secret thought to forget xyzzy';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const one = async (sql, params) => (await db.rawQuery(sql, params)).results?.[0] || {};

const names = tools.map((t) => t.name);
rec('F1. forget + mark registered; total tools = 30', names.includes('forget') && names.includes('mark') && tools.length === 30, `${tools.length} tools`);

// Seed a message + fingerprints + clustering point, and index it (BM25, no embedder).
const id = 'm-forget';
await db.messages.insert([{ id, user_id: U, role: 'user', content: SECRET, scope: 'personal', created_at: '2026-06-02T10:00:00.000Z' }]);
await db.rawQuery(`UPDATE messages SET embedding_768 = ? WHERE id = ? AND user_id = ?`, ['ENVELOPE', id, U]);
await db.rawQuery(`INSERT INTO clustering_points (id, user_id, source_type, source_id, content) VALUES (?,?,?,?,?)`, ['cp', U, 'message', id, 'x']);
await searchHelpers.backend.add({ id, text: SECRET, ts: 1 });
const hitBefore = (await searchHelpers.backend.query({ text: 'xyzzy', topK: 5 })).hits.some((h) => h.id === id);
rec('F2. message searchable before forget', hitBefore, `found via 'xyzzy'`);

const out = await handlers.forget({ type: 'message', id });
rec('F3. forget tool reports success', /Forgotten: message/.test(out), out);

const raw = await one(`SELECT content, embedding_768, forgotten_at FROM messages WHERE id = ? AND user_id = ?`, [id, U]);
rec('F4. content + embedding nulled, forgotten_at stamped', raw.content == null && raw.embedding_768 == null && !!raw.forgotten_at, `content=${raw.content} emb=${raw.embedding_768} forgotten=${!!raw.forgotten_at}`);

const exists = (await one(`SELECT COUNT(*) AS c FROM messages WHERE id = ?`, [id])).c;
rec('F5. row still exists (soft-redact, no hard delete)', exists === 1, `rows=${exists}`);

const cp = (await one(`SELECT COUNT(*) AS c FROM clustering_points WHERE source_id = ?`, [id])).c;
rec('F6. clustering point deleted', cp === 0, `count=${cp}`);

const hitAfter = (await searchHelpers.backend.query({ text: 'xyzzy', topK: 5 })).hits.some((h) => h.id === id);
rec('F7. evicted from in-RAM search index', !hitAfter, `searchable after = ${hitAfter}`);

const recent = await db.messages.selectRecent(U, { scope: 'personal', limit: 10 });
rec('F8. excluded from selectRecent', !recent.some((m) => m.id === id), `ids=${recent.map((m) => m.id).join(',') || '(none)'}`);

let events = [];
let auditErr = '';
try { events = await db.audit.recent({ eventType: 'forget' }); } catch (e) { auditErr = e.message; }
const ev = events.find((e) => e.method === id);
const det = ev?.details || '';
const auditOk = !!ev && /[0-9a-f]{64}/.test(det) && !det.includes('secret thought') && ev.event_type === 'forget' && ev.endpoint === 'message';
rec('F9. audit row written with hash, NO plaintext', auditOk, auditErr ? `audit.recent threw: ${auditErr}` : `details=${det}`);

const out2 = await handlers.forget({ type: 'message', id });
rec('F10. re-forget is idempotent (already forgotten)', /Already forgotten/.test(out2), out2);

const id2 = 'm-keep';
await db.messages.insert([{ id: id2, user_id: U, role: 'user', content: 'important note', scope: 'personal', created_at: '2026-06-02T11:00:00.000Z' }]);
const m = await handlers.mark({ type: 'message', id: id2, pinned: true });
rec('F11. mark pins a message', /pinned/.test(m), m);

const ctx = await handlers.getContext({});
rec('F12. getContext surfaces pinned with 📌 marker', ctx.includes('📌') && ctx.includes('important note'), `has marker=${ctx.includes('📌')}`);

let failClosed = false;
try { await handlers.forget({ type: 'bogus', id: 'x' }); } catch { failClosed = true; }
rec('F13. unknown ref type fails closed', failClosed, failClosed ? 'threw' : 'did NOT throw');

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — forget + mark: redact, evict, tombstone, audit (no plaintext), idempotent' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

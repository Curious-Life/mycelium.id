// verify:related — Context Bank Phase 2. Boots the real MCP server (embedder
// NULL, so BM25-only) and drives searchMindscape's `relatedTo` proactive-recall
// mode on a LOCAL vault, asserting: relatedTo surfaces related messages without
// query craft; sensitive messages are EXCLUDED from proactive recall but INCLUDED
// in an explicit query; forgotten messages never resurface; BM25-only path works.
// PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-related.db', KCV = 'data/verify-related-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close, handlers, searchHelpers } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// Seed 3 messages: one related+public, one related+sensitive, one unrelated.
// Distinctive tokens (zorptoken / hushword) let us assert presence/absence in
// the formatted result string.
await db.messages.insert([
  { id: 'm-rel',   user_id: U, role: 'user', content: 'I went kayaking on the calm lake at dawn zorptoken', scope: 'personal', created_at: '2026-06-02T09:00:00.000Z' },
  { id: 'm-sens',  user_id: U, role: 'user', content: 'kayaking budget overspend on the lake hushword',     scope: 'personal', created_at: '2026-06-02T09:05:00.000Z' },
  { id: 'm-other', user_id: U, role: 'user', content: 'grocery list bananas and oat milk',                  scope: 'personal', created_at: '2026-06-02T09:10:00.000Z' },
]);
// Mark the sensitive one via the real verb, then build the index from the db.
await handlers.mark({ type: 'message', id: 'm-sens', sensitive: true });
await searchHelpers.rebuild();

// ── relatedTo: proactive recall, sensitive excluded ──
const rel = await handlers.searchMindscape({ relatedTo: 'kayaking on the lake this morning' });
rec('R1. relatedTo frames results as "Related context"', /Related context/.test(rel), rel.split('\n')[0]);
rec('R2. relatedTo surfaces the related public message', rel.includes('zorptoken'), `hasRel=${rel.includes('zorptoken')}`);
rec('R3. relatedTo EXCLUDES the sensitive message', !rel.includes('hushword'), `leaked=${rel.includes('hushword')}`);
rec('R4. BM25-only (no embedder) still returns results', rel.includes('zorptoken') && /## Messages/.test(rel), 'matched via BM25');

// ── explicit query: sensitive INCLUDED (distinct from proactive) ──
const exp = await handlers.searchMindscape({ query: 'kayaking budget lake' });
rec('R5. explicit query INCLUDES the sensitive message', exp.includes('hushword'), `hasSens=${exp.includes('hushword')}`);

// ── forgotten messages never resurface in relatedTo ──
await handlers.forget({ type: 'message', id: 'm-rel' });
const rel2 = await handlers.searchMindscape({ relatedTo: 'kayaking on the lake this morning' });
rec('R6. forgotten message absent from relatedTo (evicted + hydration-guarded)', !rel2.includes('zorptoken'), `resurrected=${rel2.includes('zorptoken')}`);

// ── neither query nor relatedTo → guided refusal ──
const none = await handlers.searchMindscape({});
rec('R7. no query/relatedTo returns a guided message (no crash)', /Provide either query or relatedTo/.test(none), none);

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — relatedTo: proactive recall, sensitive-excluded, forgotten-guarded, BM25-only' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

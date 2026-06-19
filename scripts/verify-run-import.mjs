// Verify — the import spine (src/ingest/run-import.js) routes every archive
// source to the right adapter and returns the uniform {importResult}|{error}
// shape. Guards the Phase-2a seam: a new `kind`/adapter must not regress
// detection, dispatch, the zip-bomb guard, or the unsupported-format errors.
//
//   R1 claude zip       → { importResult: { type:'claude', imported≥1 } }
//   R2 chatgpt zip      → { importResult: { type:'chatgpt', imported≥1 } }
//   R3 obsidian zip     → { error } (NOT success-shaped) pointing at folder import
//   R4 garbage bytes    → { error } unrecognized (no throw)
//   R5 unknown kind     → throws (fail-closed, not a silent no-op)
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { applyMigrations } from '../src/db/migrate.js';
import { boot } from '../src/index.js';
import { runImport } from '../src/ingest/run-import.js';

const DB = 'data/verify-run-import.db';
const KCV = 'data/verify-run-import-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
mkdirSync('data', { recursive: true });
{ const seed = new Database(DB); applyMigrations(seed); seed.close(); }

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex() });
const ctx = { db, userId: 'verify-spine-user', enqueueEnrichment: null };
const zipBytes = (files) => { const z = new JSZip(); for (const [n, c] of Object.entries(files)) z.file(n, c); return z.generateAsync({ type: 'nodebuffer' }); };

// R1 — Claude export routes to the claude adapter.
const claudeBuf = await zipBytes({ 'conversations.json': JSON.stringify([
  { uuid: 'c1', name: 'C', chat_messages: [{ uuid: 'm1', sender: 'human', text: 'hi from claude', created_at: '2021-01-01T00:00:00Z' }] },
]) });
const r1 = await runImport({ kind: 'archive', buffer: claudeBuf }, ctx);
rec('R1 claude zip → importResult.type=claude, imported≥1',
  r1.importResult?.type === 'claude' && r1.importResult?.imported >= 1, JSON.stringify(r1.importResult || r1));

// R2 — ChatGPT export routes to the chatgpt adapter.
const chatgptBuf = await zipBytes({ 'conversations.json': JSON.stringify([
  { id: 'g1', title: 'G', mapping: { root: { id: 'root', children: ['n1'] },
    n1: { id: 'n1', message: { author: { role: 'user' }, create_time: 1609459200, content: { content_type: 'text', parts: ['hi from chatgpt'] } }, children: [] } } },
]) });
const r2 = await runImport({ kind: 'archive', buffer: chatgptBuf }, ctx);
rec('R2 chatgpt zip → importResult.type=chatgpt, imported≥1',
  r2.importResult?.type === 'chatgpt' && r2.importResult?.imported >= 1, JSON.stringify(r2.importResult || r2));

// R3 — Obsidian zip → error (not success-shaped), points at the folder importer.
const obsidianBuf = await zipBytes({ 'notes/idea.md': '# Idea\nbody' });
const r3 = await runImport({ kind: 'archive', buffer: obsidianBuf }, ctx);
rec('R3 obsidian zip → error (not {imported:0}), mentions folder',
  typeof r3.error === 'string' && /folder/i.test(r3.error) && r3.importResult === undefined, JSON.stringify(r3));

// R4 — garbage bytes → unrecognized error, no throw.
let r4;
try { r4 = await runImport({ kind: 'archive', buffer: Buffer.from('not a zip at all') }, ctx); }
catch (e) { r4 = { threw: String(e?.message || e) }; }
rec('R4 garbage bytes → {error}, no throw',
  typeof r4.error === 'string' && !r4.threw, JSON.stringify(r4));

// R5 — unknown kind → throws (fail-closed).
let threw = false;
try { await runImport({ kind: 'banana' }, ctx); } catch { threw = true; }
rec('R5 unknown kind throws (fail-closed)', threw, `threw=${threw}`);

const ok = ledger.every(Boolean);
console.log(`\nVERDICT: ${ok ? 'GO' : 'NO-GO'} — import spine routes archives, fails closed, no silent success`);
await close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
console.log(`EXIT=${ok ? 0 : 1}`);
process.exit(ok ? 0 : 1);

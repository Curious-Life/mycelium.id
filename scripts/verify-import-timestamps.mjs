// Verify — imported messages keep their ORIGINAL timestamps (not import-time).
//
// Regression guard for the bug where captureMessage let the DB default-stamp
// created_at = "now", so every imported Claude/ChatGPT message collapsed onto
// the upload moment (breaking the timeline + time-decayed co-firing). The fix:
// captureMessage accepts msg.createdAt (normalizeCreatedAt → schema ISO) and the
// import parsers pass each message's source time.
//
//   T1 explicit ISO createdAt   → stored verbatim (ms-normalized)
//   T2 epoch-seconds createdAt  → converted to the right ISO instant
//   T3 no createdAt             → falls back to DB default ≈ now (live capture)
//   T4 Claude parser            → message lands with the export's created_at
//   T5 ChatGPT parser           → message lands with create_time (epoch→ISO)
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { boot } from '../src/index.js';
import { captureMessage } from '../src/ingest/capture.js';
import {
  detectExportType, processClaudeExport, processOpenAIExport,
} from '../src/ingest/import-parsers.js';
import JSZip from 'jszip';
import { normalizeTimestamp, deriveCreatedAt, TS_PROVENANCE } from '../src/ingest/timestamp.js';
import { restoreTable } from '../src/ingest/vault-import.js';

const DB = 'data/verify-ts.db';
const KCV = 'data/verify-ts-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
mkdirSync('data', { recursive: true });
{ const seed = new Database(DB); applyMigrations(seed); seed.close(); }

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex() });
const userId = 'verify-ts-user';
const raw = new Database(DB, { readonly: true });
const createdAtOf = (id) => raw.prepare('select created_at from messages where id = ?').get(id)?.created_at;

// T1 — explicit ISO original time is stored verbatim (ms-normalized).
const id1 = 'ts-iso';
await captureMessage(db, { userId, id: id1, content: 'iso ts', createdAt: '2021-03-15T08:30:00Z' }, null);
rec('T1 explicit ISO createdAt stored', createdAtOf(id1) === '2021-03-15T08:30:00.000Z', `got ${createdAtOf(id1)}`);

// T2 — epoch SECONDS (ChatGPT create_time shape) → correct instant, not 1970.
const id2 = 'ts-epoch';
const epochSec = 1615797000; // 2021-03-15T08:30:00Z
const wantEpoch = new Date(epochSec * 1000).toISOString();
await captureMessage(db, { userId, id: id2, content: 'epoch ts', createdAt: epochSec }, null);
rec('T2 epoch-seconds createdAt converted', createdAtOf(id2) === wantEpoch, `got ${createdAtOf(id2)} want ${wantEpoch}`);

// T3 — no createdAt → DB default ≈ now (live-capture path unchanged).
const id3 = 'ts-now';
await captureMessage(db, { userId, id: id3, content: 'live capture' }, null);
const now = createdAtOf(id3);
const driftMs = Math.abs(Date.now() - Date.parse(now));
rec('T3 absent createdAt defaults to ~now', driftMs < 10_000, `created_at=${now} drift=${driftMs}ms`);

// T4 — Claude parser threads the export's created_at through to the row.
const claudeZip = await (async () => {
  const z = new JSZip();
  z.file('conversations.json', JSON.stringify([{
    uuid: 'cv1', name: 'C', chat_messages: [
      { uuid: 'cm1', sender: 'human', text: 'claude original time', created_at: '2019-07-04T12:00:00Z' },
    ],
  }]));
  return z.generateAsync({ type: 'nodebuffer' });
})();
{
  const zip = await JSZip.loadAsync(claudeZip);
  const detected = await detectExportType(zip);
  await processClaudeExport(zip, { conversations: detected.conversations, capture: (m) => captureMessage(db, { userId, ...m }, null) });
  rec('T4 Claude parser preserves created_at', createdAtOf('claude-cm1') === '2019-07-04T12:00:00.000Z', `got ${createdAtOf('claude-cm1')}`);
}

// T5 — ChatGPT parser threads create_time (epoch seconds) through.
{
  const t = 1562241600; // 2019-07-04T12:00:00Z
  const convs = [{ id: 'gx', title: 'G', mapping: {
    root: { id: 'root', children: ['n1'] },
    n1: { id: 'n1', message: { author: { role: 'user' }, create_time: t, content: { content_type: 'text', parts: ['chatgpt original time'] } }, children: [] },
  } }];
  await processOpenAIExport(convs, { capture: (m) => captureMessage(db, { userId, ...m }, null) });
  const want = new Date(t * 1000).toISOString();
  rec('T5 ChatGPT parser preserves create_time', createdAtOf('chatgpt-n1') === want, `got ${createdAtOf('chatgpt-n1')} want ${want}`);
}

// ── T6 — shared normalizer: naive/local strings → UTC (no calendar-day shift) ──
rec('T6a naive datetime → UTC (no local shift)', normalizeTimestamp('2026-02-04 09:30:00') === '2026-02-04T09:30:00.000Z',
  `got ${normalizeTimestamp('2026-02-04 09:30:00')}`);
rec('T6b date-only → midnight UTC', normalizeTimestamp('2026-02-04') === '2026-02-04T00:00:00.000Z',
  `got ${normalizeTimestamp('2026-02-04')}`);
rec('T6c epoch-ms preserved', normalizeTimestamp(1615797000000) === '2021-03-15T08:30:00.000Z', `got ${normalizeTimestamp(1615797000000)}`);
rec('T6d garbage → null', normalizeTimestamp('not a date') === null && normalizeTimestamp('') === null, '');

// ── T7 — deriveCreatedAt provenance + future-skew rejection + fallback ──
const d7a = deriveCreatedAt([{ value: undefined, provenance: 'x' }, { value: '2020-01-02T03:04:05Z', provenance: TS_PROVENANCE.SOURCE_FIELD }]);
rec('T7a picks first usable candidate w/ provenance', d7a.iso === '2020-01-02T03:04:05.000Z' && d7a.provenance === 'source-field', JSON.stringify(d7a));
const future = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
const d7b = deriveCreatedAt([{ value: future, provenance: TS_PROVENANCE.FILE_MTIME }]);
rec('T7b future-skew candidate rejected → inferred-now', d7b.provenance === TS_PROVENANCE.INFERRED_NOW, JSON.stringify(d7b));
const d7c = deriveCreatedAt([{ value: null, provenance: 'x' }]);
rec('T7c no usable source → inferred-now (FLAGGED, not silent)', d7c.provenance === 'inferred-now', JSON.stringify(d7c));

// ── T8 — documents.created_at is IMMUTABLE across re-import (Fix A) ──
const dPath = 'agents/test/immutable.md';
await db.documents.upsert({ user_id: userId, path: dPath, title: 'v1', content: 'first content here', created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z' });
await db.documents.upsert({ user_id: userId, path: dPath, title: 'v2', content: 'edited content later', created_at: '2026-06-15T10:14:56.000Z', updated_at: '2026-06-15T10:14:56.000Z' });
const docRow = raw.prepare('select created_at, updated_at from documents where user_id=? and path=?').get(userId, dPath);
rec('T8 re-import keeps original created_at, bumps updated_at',
  docRow?.created_at === '2024-01-01T00:00:00.000Z' && docRow?.updated_at === '2026-06-15T10:14:56.000Z',
  `created_at=${docRow?.created_at} updated_at=${docRow?.updated_at}`);

// ── T9 — restoreTable FAIL-LOUD counts rows stamped import-time (Fix B) ──
const r9miss = await restoreTable(db, 'documents', [{ id: 't9-miss', path: 'agents/test/t9-miss.md', title: 't9', content: 'restore row with no created_at' }], { userId });
const r9have = await restoreTable(db, 'documents', [{ id: 't9-have', path: 'agents/test/t9-have.md', title: 't9', content: 'restore row with a created_at', created_at: '2025-05-05T05:05:05.000Z' }], { userId });
rec('T9 restoreTable counts inferredNow when created_at absent',
  r9miss.inferredNow === 1 && r9have.inferredNow === 0,
  `missing.inferredNow=${r9miss.inferredNow} have.inferredNow=${r9have.inferredNow}`);

// ── T10 — parser FAIL-LOUD accounting: a swallowed capture error is counted ──
{
  const z = new JSZip();
  z.file('conversations.json', JSON.stringify([{ uuid: 'cv2', name: 'C2', chat_messages: [
    { uuid: 'ok1', sender: 'human', text: 'fine', created_at: '2020-01-01T00:00:00Z' },
    { uuid: 'boom', sender: 'human', text: 'will throw', created_at: '2020-01-01T00:00:01Z' },
  ] }]));
  const zip = await JSZip.loadAsync(await z.generateAsync({ type: 'nodebuffer' }));
  const detected = await detectExportType(zip);
  const res = await processClaudeExport(zip, { conversations: detected.conversations,
    capture: async (m) => { if (m.id === 'claude-boom') throw new Error('boom'); return { deduped: false }; } });
  rec('T10 Claude parser reports failed count (not silent loss)',
    res.failed === 1 && res.imported === 1 && res.stats.failed === 1, `imported=${res.imported} failed=${res.failed}`);
}

const ok = ledger.every(Boolean);
console.log(`\nVERDICT: ${ok ? 'GO' : 'NO-GO'} — imported messages keep their original timestamps`);
raw.close();
await close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
console.log(`EXIT=${ok ? 0 : 1}`);
process.exit(ok ? 0 : 1);

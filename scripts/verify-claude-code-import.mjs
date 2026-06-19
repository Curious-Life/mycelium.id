// Verify — Claude Code transcript import (~/.claude/projects/**/*.jsonl):
//   CC1 user + assistant message lines → imported w/ source 'claude-code-import',
//       original timestamp preserved, grouped by sessionId
//   CC2 assistant content as block[] → text extracted
//   CC3 non-message lines (queue-operation, ai-title, attachment) → skipped (not failed)
//   CC4 re-run same entries → deduped on uuid (idempotent)
//   CC5 a capture error is COUNTED as failed (fail-loud)
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.
import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { boot } from '../src/index.js';
import { captureMessage } from '../src/ingest/capture.js';
import { processClaudeCodeExport } from '../src/ingest/import-parsers.js';

const DB = 'data/verify-cc.db';
const KCV = 'data/verify-cc-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
mkdirSync('data', { recursive: true });
{ const seed = new Database(DB); applyMigrations(seed); seed.close(); }

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex() });
const userId = 'verify-cc-user';
const raw = new Database(DB, { readonly: true });
const rowOf = (id) => raw.prepare('select created_at, conversation_id, source from messages where id = ?').get(id);

// A session transcript: metadata lines + a user (string content) + an assistant
// (block[] content) + a non-message line to ensure it's skipped.
const sess = [
	JSON.stringify({ type: 'queue-operation', operation: 'x', sessionId: 'S1', timestamp: '2026-06-02T08:46:00.000Z' }),
	JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'S1', cwd: '/repo', gitBranch: 'main', timestamp: '2026-06-02T08:46:07.406Z', message: { role: 'user', content: 'fix the bug in run-import' } }),
	JSON.stringify({ type: 'assistant', uuid: 'a1', sessionId: 'S1', timestamp: '2026-06-02T08:46:20.100Z', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', name: 'Edit', input: {} }] } }),
	JSON.stringify({ type: 'ai-title', sessionId: 'S1', aiTitle: 'Bug fix' }),
].join('\n') + '\n';
const entries = [{ relPath: 'proj/S1.jsonl', content: sess }];
const capture = (m) => captureMessage(db, { userId, ...m }, null);

const r1 = await processClaudeCodeExport(entries, { capture });
rec('CC1 user msg → source import-claude-code (ungated), ts preserved, sessionId',
	rowOf('claude-code-u1')?.source === 'import-claude-code' && rowOf('claude-code-u1')?.created_at === '2026-06-02T08:46:07.406Z' && rowOf('claude-code-u1')?.conversation_id === 'S1',
	JSON.stringify(rowOf('claude-code-u1')));
rec('CC2 assistant block[] content → text extracted', rowOf('claude-code-a1')?.created_at === '2026-06-02T08:46:20.100Z',
	`imported=${r1.imported}`);
rec('CC3 non-message lines skipped (2 msgs imported, 1 session)', r1.imported === 2 && r1.stats.sessions === 1,
	JSON.stringify(r1.stats));

const r2 = await processClaudeCodeExport(entries, { capture });
rec('CC4 re-run dedups on uuid (idempotent)', r2.imported === 0 && r2.skipped === 2, JSON.stringify(r2));

let threw = 0;
const r3 = await processClaudeCodeExport([{ content: JSON.stringify({ type: 'user', uuid: 'boom', sessionId: 'S2', timestamp: '2026-06-03T00:00:00.000Z', message: { role: 'user', content: 'x' } }) + '\n' }],
	{ capture: async () => { throw new Error('boom'); } });
rec('CC5 capture error counted as failed (fail-loud)', r3.failed === 1 && r3.imported === 0, JSON.stringify(r3));

// A noisy session: human + assistant-text + pure tool_use + tool_result + isMeta + <system-reminder>.
const noisy = [{ content: [
	JSON.stringify({ type: 'user', uuid: 'nh', sessionId: 'N1', timestamp: '2026-06-04T00:00:00.000Z', message: { role: 'user', content: 'do the thing' } }),
	JSON.stringify({ type: 'assistant', uuid: 'na', sessionId: 'N1', timestamp: '2026-06-04T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'doing it' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
	JSON.stringify({ type: 'assistant', uuid: 'nt', sessionId: 'N1', timestamp: '2026-06-04T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: {} }] } }),
	JSON.stringify({ type: 'user', uuid: 'ntr', sessionId: 'N1', timestamp: '2026-06-04T00:00:03.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
	JSON.stringify({ type: 'user', uuid: 'nm1', isMeta: true, sessionId: 'N1', timestamp: '2026-06-04T00:00:04.000Z', message: { role: 'user', content: 'caveat' } }),
	JSON.stringify({ type: 'user', uuid: 'nm2', sessionId: 'N1', timestamp: '2026-06-04T00:00:05.000Z', message: { role: 'user', content: '<system-reminder>noise</system-reminder>' } }),
].join('\n') + '\n' }];

const rc = await processClaudeCodeExport(noisy, { capture }, { mode: 'clean' });
rec('CC6 clean: keeps human+agent-text only, tool/meta counted in filtered',
	rc.imported === 2 && rc.filtered['tool-call'] === 1 && rc.filtered['tool-result'] === 1 && rc.filtered.meta === 2,
	JSON.stringify({ imported: rc.imported, filtered: rc.filtered }));

// metadata.raw lossless: the kept assistant turn retains its tool_use block.
const metaRow = (await db.rawQuery('SELECT metadata FROM messages WHERE id = ?', ['claude-code-na']))?.results?.[0];
let rawOk = false;
try { const m = JSON.parse(metaRow?.metadata || '{}'); rawOk = m?.raw?.uuid === 'na' && Array.isArray(m.raw.message.content) && m.raw.message.content.some((b) => b.type === 'tool_use'); } catch { /* */ }
rec('CC7 metadata.raw preserves the FULL original line (incl. tool_use blocks)', rawOk, `rawPresent=${!!metaRow}`);

const rf = await processClaudeCodeExport(noisy, { capture }, { mode: 'full' });
const toolRow = rowOf('claude-code-nt');
rec('CC8 full: imports tool/meta turns too (nothing dropped)',
	rf.imported === 4 && !!toolRow, JSON.stringify({ imported: rf.imported, skipped: rf.skipped }));

const ok = ledger.every(Boolean);
console.log(`\nVERDICT: ${ok ? 'GO' : 'NO-GO'} — Claude Code transcripts import with original timestamps, dedup, fail-loud`);
raw.close(); await close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
console.log(`EXIT=${ok ? 0 : 1}`);
process.exit(ok ? 0 : 1);

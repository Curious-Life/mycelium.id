// Verify — OpenClaw agent import (sessions/*.jsonl + workspace/*.md):
//   O1 user (string content) + assistant (block[] content) turns → imported,
//      source 'import-openclaw', timestamp preserved, conversation openclaw:<uuid>
//   O2 clean mode drops tool_use / tool_result turns → counted in filtered
//   O3 non-message lines (session header, model_change, custom) → ignored
//   O4 workspace/*.md → document under import/openclaw/workspace/ + a memory
//   O5 re-run → fully deduped (idempotent on openclaw-<id>)
//   O6 .trajectory.jsonl telemetry mirror is NOT imported (only canonical .jsonl)
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.
import crypto from 'node:crypto';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { boot } from '../src/index.js';
import { importOpenClaw } from '../src/ingest/openclaw-import.js';

const DB = 'data/verify-openclaw.db';
const KCV = 'data/verify-openclaw-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
mkdirSync('data', { recursive: true });
{ const seed = new Database(DB); applyMigrations(seed); seed.close(); }

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// ── Fixture: a sessions dir + a workspace dir (the real layout) ──
const fix = path.join(tmpdir(), `openclaw-fix-${process.pid}`);
try { rmSync(fix, { recursive: true }); } catch { /* */ }
const sessionsDir = path.join(fix, 'agents', 'main', 'sessions');
const workspaceDir = path.join(fix, 'workspace');
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(workspaceDir, { recursive: true });

const SID = 'aaaa-bbbb-cccc';
const sessionLines = [
  { type: 'session', version: 1, id: SID, timestamp: '2026-06-20T10:00:00.000Z', cwd: '/x' },         // header (ignored)
  { type: 'model_change', provider: 'ollama', modelId: 'llama', parentId: 'r0' },                      // ignored
  { type: 'message', id: 'm1', parentId: SID, message: { role: 'user', content: 'What should I focus on?', timestamp: '2026-06-20T10:00:01.000Z' } },
  { type: 'message', id: 'm2', parentId: 'm1', message: { role: 'assistant', content: [{ type: 'text', text: 'Focus on the import sweep.' }], timestamp: '2026-06-20T10:00:02.000Z' } },
  { type: 'message', id: 'm3', parentId: 'm2', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'search', input: {} }], timestamp: '2026-06-20T10:00:03.000Z' } }, // tool-call (noise)
  { type: 'message', id: 'm4', parentId: 'm3', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }], timestamp: '2026-06-20T10:00:04.000Z' } },               // tool-result (noise)
].map((o) => JSON.stringify(o)).join('\n') + '\n';
writeFileSync(path.join(sessionsDir, `${SID}.jsonl`), sessionLines);
// A telemetry mirror that must be ignored — its "messages" would double-count.
writeFileSync(path.join(sessionsDir, `${SID}.trajectory.jsonl`), JSON.stringify({ type: 'message', id: 'TRAJ', message: { role: 'user', content: 'should be ignored' } }) + '\n');
writeFileSync(path.join(workspaceDir, 'USER.md'), '# User\n## Context\nPrefers concise, candid answers.\n');
writeFileSync(path.join(workspaceDir, 'SOUL.md'), '# Soul\nSteady. Curious. Honest.\n');

const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex() });
const userId = 'verify-openclaw-user';
const raw = new Database(DB, { readonly: true });
const rowOf = (id) => raw.prepare('SELECT created_at, conversation_id, source FROM messages WHERE id = ?').get(id);
const exists = (id) => !!raw.prepare('SELECT 1 FROM messages WHERE id = ?').get(id);

const r1 = await importOpenClaw(db, { userId, sessionsDir, workspaceDir, mode: 'clean' });
rec('O1 user+assistant imported: source import-openclaw, ts preserved, conversation openclaw:<uuid>',
  rowOf('openclaw-m1')?.source === 'import-openclaw' && rowOf('openclaw-m1')?.created_at === '2026-06-20T10:00:01.000Z' && rowOf('openclaw-m1')?.conversation_id === `openclaw:${SID}` && rowOf('openclaw-m2')?.created_at === '2026-06-20T10:00:02.000Z',
  JSON.stringify(rowOf('openclaw-m1')));
rec('O2 clean drops tool turns (2 conv msgs; tool-call + tool-result filtered)',
  r1.imported === 2 && r1.filtered['tool-call'] === 1 && r1.filtered['tool-result'] === 1,
  JSON.stringify({ imported: r1.imported, filtered: r1.filtered, sessions: r1.sessions }));
rec('O3 non-message lines ignored (session/model_change not imported)', !exists('openclaw-r0'));
const wsDoc = (await db.rawQuery('SELECT path FROM documents WHERE path = ?', ['import/openclaw/workspace/USER.md']))?.results?.[0];
rec('O4 workspace md → document + memory', !!wsDoc && r1.docs.imported === 2 && exists('openclaw:workspace/USER.md'),
  JSON.stringify({ doc: wsDoc, docs: r1.docs }));
rec('O6 .trajectory.jsonl mirror NOT imported', !exists('openclaw-TRAJ'));

const r2 = await importOpenClaw(db, { userId, sessionsDir, workspaceDir, mode: 'clean' });
rec('O5 re-run fully deduped (idempotent)', r2.imported === 0 && r2.skipped === 2 && r2.docs.deduped === 2,
  JSON.stringify({ imported: r2.imported, skipped: r2.skipped, docs: r2.docs }));

const ok = ledger.every(Boolean);
console.log(`\nVERDICT: ${ok ? 'GO' : 'NO-GO'} — OpenClaw import: sessions (ungated, ts-preserving) + workspace memory, idempotent`);
raw.close(); await close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
try { rmSync(fix, { recursive: true }); } catch { /* */ }
console.log(`EXIT=${ok ? 0 : 1}`);
process.exit(ok ? 0 : 1);

// Verify — Hermes agent import (~/.hermes/state.db + SOUL.md):
//   H1 user + assistant turns → imported, source 'import-hermes' (ungated),
//      epoch-seconds timestamp → ISO preserved, conversation_id = hermes:<session>
//   H2 clean mode drops tool turns (role 'tool' / pure tool_calls) → counted in filtered
//   H3 active=0 (rewound) turns are NOT imported
//   H4 SOUL.md → a document under agents/hermes/SOUL.md (persona)
//   H5 re-run → fully deduped (idempotent on hermes-<id>)
//   H6 full mode imports tool turns too
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.
import crypto from 'node:crypto';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { boot } from '../src/index.js';
import { importHermes } from '../src/ingest/hermes-import.js';

const DB = 'data/verify-hermes.db';
const KCV = 'data/verify-hermes-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
mkdirSync('data', { recursive: true });
{ const seed = new Database(DB); applyMigrations(seed); seed.close(); }

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// ── Build a fixture Hermes state.db (the real schema's relevant columns) ──
const fix = path.join(tmpdir(), `hermes-fix-${process.pid}`);
try { rmSync(fix, { recursive: true }); } catch { /* */ }
mkdirSync(fix, { recursive: true });
const statePath = path.join(fix, 'state.db');
const soulPath = path.join(fix, 'SOUL.md');
writeFileSync(soulPath, '# Soul\nI am a steady, candid thinking partner.\n');
{
  const sdb = new Database(statePath);
  sdb.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, started_at REAL, system_prompt TEXT);
            CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL, active INTEGER DEFAULT 1);`);
  sdb.prepare('INSERT INTO sessions (id,title,started_at) VALUES (?,?,?)').run('S1', 'Planning', 1_718_000_000);
  const ins = sdb.prepare('INSERT INTO messages (id,session_id,role,content,tool_calls,tool_name,timestamp,active) VALUES (?,?,?,?,?,?,?,?)');
  ins.run(1, 'S1', 'user', 'Help me plan the week', null, null, 1_718_000_001.5, 1);
  ins.run(2, 'S1', 'assistant', 'Here is a plan.', null, null, 1_718_000_002, 1);
  ins.run(3, 'S1', 'assistant', '', JSON.stringify([{ name: 'search' }]), 'search', 1_718_000_003, 1); // pure tool call (noise)
  ins.run(4, 'S1', 'tool', 'search results blob', null, 'search', 1_718_000_004, 1);                    // tool result (noise)
  ins.run(5, 'S1', 'assistant', 'A retracted draft', null, null, 1_718_000_005, 0);                     // active=0 (rewound)
  sdb.close();
}

const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex() });
const userId = 'verify-hermes-user';
const raw = new Database(DB, { readonly: true });
const rowOf = (id) => raw.prepare('SELECT created_at, conversation_id, source FROM messages WHERE id = ?').get(id);
const exists = (id) => !!raw.prepare('SELECT 1 FROM messages WHERE id = ?').get(id);

const r1 = await importHermes(db, { userId, statePath, soulPath, mode: 'clean' });
const expIso = new Date(1_718_000_001.5 * 1000).toISOString();
rec('H1 user turn imported: source import-hermes, ts→ISO, conversation hermes:S1',
  rowOf('hermes-1')?.source === 'import-hermes' && rowOf('hermes-1')?.created_at === expIso && rowOf('hermes-1')?.conversation_id === 'hermes:S1',
  JSON.stringify(rowOf('hermes-1')));
rec('H2 clean drops tool turns (2 msgs imported; tool-call + tool-result filtered)',
  r1.imported === 2 && r1.filtered['tool-call'] === 1 && r1.filtered['tool-result'] === 1,
  JSON.stringify({ imported: r1.imported, filtered: r1.filtered }));
rec('H3 active=0 (rewound) turn NOT imported', !exists('hermes-5'));
const soulDoc = (await db.rawQuery('SELECT path FROM documents WHERE path = ?', ['import/hermes/SOUL.md']))?.results?.[0];
rec('H4 SOUL.md → document import/hermes/SOUL.md', !!soulDoc && r1.persona === 1, JSON.stringify(soulDoc));

const r2 = await importHermes(db, { userId, statePath, soulPath, mode: 'clean' });
rec('H5 re-run fully deduped (idempotent)', r2.imported === 0 && r2.skipped === 2, JSON.stringify({ imported: r2.imported, skipped: r2.skipped }));

const r3 = await importHermes(db, { userId, statePath, soulPath, mode: 'full' });
rec('H6 full mode imports tool turns too', exists('hermes-3') && exists('hermes-4'), JSON.stringify({ imported: r3.imported }));

const ok = ledger.every(Boolean);
console.log(`\nVERDICT: ${ok ? 'GO' : 'NO-GO'} — Hermes state.db import: ungated, ts-preserving, active-only, persona, idempotent`);
raw.close(); await close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
try { rmSync(fix, { recursive: true }); } catch { /* */ }
console.log(`EXIT=${ok ? 0 : 1}`);
process.exit(ok ? 0 : 1);

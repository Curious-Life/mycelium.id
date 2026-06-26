// Verify — auto-detect of local data sources (allowlist, presence/counts only):
//   D1 Claude Code transcripts under ~/.claude/projects → detected w/ count + dates
//   D2 Obsidian vault (from obsidian.json) → detected w/ .md count
//   D3 empty home → no false positives (returns [])
//   D4 readClaudeCodeEntries reads the .jsonl files back for import
//   D5 a detector NEVER reads file content during detection (no throw on binary)
//
// detectSources({home}) is pure (takes a home dir) — no boot needed.
// PASS/FAIL ledger + VERDICT + EXIT=<code>.
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { detectSources, readClaudeCodeEntries } from '../src/ingest/detect-sources.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const root = path.join(tmpdir(), `detect-${process.pid}`);
const home = path.join(root, 'home');
const empty = path.join(root, 'empty');
try { rmSync(root, { recursive: true }); } catch { /* */ }

// Fixture: a Claude Code projects dir + an Obsidian vault wired via obsidian.json.
const ccDir = path.join(home, '.claude', 'projects', 'proj');
mkdirSync(ccDir, { recursive: true });
writeFileSync(path.join(ccDir, 'S1.jsonl'), JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'S1', timestamp: '2026-06-02T08:46:07.406Z', message: { role: 'user', content: 'hi' } }) + '\n');
writeFileSync(path.join(ccDir, 'S2.jsonl'), JSON.stringify({ type: 'assistant', uuid: 'a1', sessionId: 'S2', timestamp: '2026-06-03T09:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] } }) + '\n');

const vault = path.join(home, 'Notes Vault');
mkdirSync(vault, { recursive: true });
writeFileSync(path.join(vault, 'a.md'), '# A');
writeFileSync(path.join(vault, 'b.md'), '# B');
writeFileSync(path.join(vault, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // binary — must not break the scan
const obsCfg = path.join(home, 'Library', 'Application Support', 'obsidian');
mkdirSync(obsCfg, { recursive: true });
writeFileSync(path.join(obsCfg, 'obsidian.json'), JSON.stringify({ vaults: { v1: { path: vault, open: true } } }));

// Hermes: ~/.hermes/state.db (sessions + messages) + SOUL.md.
const hermesDir = path.join(home, '.hermes');
mkdirSync(hermesDir, { recursive: true });
writeFileSync(path.join(hermesDir, 'SOUL.md'), '# Soul');
{
  const sdb = new Database(path.join(hermesDir, 'state.db'));
  sdb.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER DEFAULT 1)');
  const ins = sdb.prepare('INSERT INTO messages (id,session_id,role,content,timestamp,active) VALUES (?,?,?,?,?,?)');
  ins.run(1, 'S1', 'user', 'hi', 1_718_000_001, 1);
  ins.run(2, 'S1', 'assistant', 'hello', 1_718_000_002, 1);
  ins.run(3, 'S1', 'assistant', 'rewound', 1_718_000_003, 0); // active=0 — not counted
  sdb.close();
}

// OpenClaw: sessions/*.jsonl (+ a .trajectory mirror to ignore) + workspace/*.md.
const ocSessions = path.join(home, '.openclaw', 'agents', 'main', 'sessions');
const ocWorkspace = path.join(home, '.openclaw', 'workspace');
mkdirSync(ocSessions, { recursive: true });
mkdirSync(ocWorkspace, { recursive: true });
writeFileSync(path.join(ocSessions, 'abc.jsonl'), JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'hi' } }) + '\n');
writeFileSync(path.join(ocSessions, 'abc.trajectory.jsonl'), '{}\n'); // telemetry mirror — must NOT be counted as a session
writeFileSync(path.join(ocWorkspace, 'USER.md'), '# User');

// Loose local files: a note under ~/Documents and a photo under ~/Pictures.
mkdirSync(path.join(home, 'Documents'), { recursive: true });
mkdirSync(path.join(home, 'Pictures'), { recursive: true });
writeFileSync(path.join(home, 'Documents', 'plan.md'), '# Plan');
writeFileSync(path.join(home, 'Pictures', 'sunset.jpg'), Buffer.from([0xff, 0xd8, 0xff]));

mkdirSync(empty, { recursive: true });

const found = detectSources({ home });
const cc = found.find((s) => s.source === 'claude-code');
const obs = found.find((s) => s.source === 'obsidian');
const herm = found.find((s) => s.source === 'hermes');
const oc = found.find((s) => s.source === 'openclaw');
const lf = found.find((s) => s.source === 'local-files');

rec('D1 Claude Code detected (2 sessions, dateRange)', !!cc && cc.count === 2 && Array.isArray(cc.dateRange) && cc.importable === true, JSON.stringify(cc));
rec('D2 Obsidian vault detected (2 .md, vault path)', !!obs && obs.count === 2 && obs.vaults?.[0]?.path === vault, JSON.stringify(obs && { count: obs.count, name: obs.vaults?.[0]?.name }));
rec('D3 empty home → no false positives', detectSources({ home: empty }).length === 0);
const entries = readClaudeCodeEntries(path.join(home, '.claude', 'projects'));
rec('D4 readClaudeCodeEntries reads sessions back', entries.length === 2 && entries.every((e) => e.content.includes('"type"')), `entries=${entries.length}`);
rec('D5 binary file in vault did not break the scan', !!obs && obs.count === 2);
rec('D6 Hermes state.db detected (2 active messages, persona, dateRange)',
  !!herm && herm.count === 2 && herm.persona === true && Array.isArray(herm.dateRange) && herm.importable === true, JSON.stringify(herm));
rec('D7 OpenClaw detected (1 session — trajectory mirror excluded — + 1 note)',
  !!oc && oc.count === 1 && oc.notes === 1 && oc.importable === true, JSON.stringify(oc));
rec('D8 Local files swept by category (document + image counts)',
  !!lf && lf.count === 2 && lf.categories?.some((c) => c.key === 'document' && c.count === 1) && lf.categories?.some((c) => c.key === 'image' && c.count === 1),
  JSON.stringify(lf && { count: lf.count, cats: lf.categories?.map((c) => [c.key, c.count]) }));
rec('D9 empty home → still no false positives (all 5 detectors)', detectSources({ home: empty }).length === 0);

const ok = ledger.every(Boolean);
console.log(`\nVERDICT: ${ok ? 'GO' : 'NO-GO'} — local data-source detection (allowlist, presence/counts, no false positives)`);
try { rmSync(root, { recursive: true }); } catch { /* */ }
console.log(`EXIT=${ok ? 0 : 1}`);
process.exit(ok ? 0 : 1);

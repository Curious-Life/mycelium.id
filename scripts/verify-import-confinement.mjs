// Adversarial security test for IMPORT-PATH CONFINEMENT — attacks the on-disk
// path surface of src/portal-import.js the way a stolen owner Bearer or a
// malicious portal page would: POST an arbitrary server-local path and try to
// read files outside the import allowlist back into the vault.
//
// The allowlist (src/ingest/detect-sources.js: importAllowedRoots) is the
// Obsidian config vault dirs + ~/.claude/projects + MYCELIUM_IMPORT_ALLOWED_ROOTS
// grants. We grant a temp dir via that env so the positive cases are hermetic.
//
//   C1 obsidian arbitrary path (/etc) → 400 import_path_denied (not walked)
//   C2 obsidian granted vault dir → 200, note imported (legit flow still works)
//   C3 obsidian symlink-escape (symlink inside grant → outside) → 400 (realpath)
//   C4 claude-code arbitrary path (/etc) → 400 import_path_denied
//   C5 full-export arbitrary path (/etc) → 400 import_path_denied
//   C6 full-export GRANTED path passes confinement (fails later on manifest, NOT denied)
//   C7 walker symlink-skip: readClaudeCodeEntries does not follow a symlinked .jsonl
//   C8 detectSources obsidian count skips a symlinked .md (countFiles symlink-skip)
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import { rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';

// Fixtures: a granted root (allowed) + a secret root (forbidden) the attacker targets.
const ROOT = realpathSync(tmpdir());
const GRANT = path.join(ROOT, `import-confine-grant-${process.pid}`);
const SECRET = path.join(ROOT, `import-confine-secret-${process.pid}`);
for (const d of [GRANT, SECRET]) { try { rmSync(d, { recursive: true }); } catch {} mkdirSync(d, { recursive: true }); }

// A legit Obsidian vault inside the granted root.
const VAULT = path.join(GRANT, 'Notes Vault');
mkdirSync(VAULT, { recursive: true });
writeFileSync(path.join(VAULT, 'hello.md'), '# Hello\n\nworld');

// A secret outside the grant + a symlink inside the grant pointing AT it (escape).
writeFileSync(path.join(SECRET, 'secret.md'), '# TOP SECRET');
const ESCAPE = path.join(GRANT, 'escape-link');
symlinkSync(SECRET, ESCAPE);

// Grant the temp root to the allowlist BEFORE the server reads it.
process.env.MYCELIUM_IMPORT_ALLOWED_ROOTS = GRANT;
const { startRestServer } = await import('../src/server-rest.js');
const { detectSources, readClaudeCodeEntries } = await import('../src/ingest/detect-sources.js');

const DB = 'data/verify-import-confinement.db';
const KCV = 'data/verify-import-confinement-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
{ const raw = new Database(DB); applyMigrations(raw); raw.close(); }

const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
const M = (p) => `${srv.url}/api/v1/portal${p}`;
const post = (p, body) => fetch(M(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function main() {
  try {
    // ── C1 obsidian: arbitrary absolute path is denied (not walked) ──
    const c1 = await post('/import/obsidian', { folderPath: '/etc' });
    const c1b = await c1.json().catch(() => ({}));
    rec('C1 obsidian arbitrary path (/etc) → 400 import_path_denied',
      c1.status === 400 && /import_path_denied/.test(c1b.error || ''), `status=${c1.status} err=${c1b.error}`);

    // ── C2 obsidian: granted vault dir still imports (no legit-flow regression) ──
    const c2 = await post('/import/obsidian', { folderPath: VAULT });
    const c2b = await c2.json().catch(() => ({}));
    rec('C2 obsidian granted vault dir → 200, note imported',
      c2.status === 200 && c2b.ok === true && (c2b.documentsUpserted ?? 0) >= 1, `status=${c2.status} docs=${c2b.documentsUpserted}`);

    // ── C3 obsidian: a symlink inside the grant pointing OUTSIDE → realpath escape → denied ──
    const c3 = await post('/import/obsidian', { folderPath: ESCAPE });
    const c3b = await c3.json().catch(() => ({}));
    rec('C3 obsidian symlink-escape → 400 (realpath collapses the escape)',
      c3.status === 400 && /import_path_denied/.test(c3b.error || ''), `status=${c3.status} err=${c3b.error}`);

    // ── C4 claude-code: arbitrary path denied ──
    const c4 = await post('/import/claude-code', { folderPath: '/etc' });
    const c4b = await c4.json().catch(() => ({}));
    rec('C4 claude-code arbitrary path (/etc) → 400 import_path_denied',
      c4.status === 400 && /import_path_denied/.test(c4b.error || ''), `status=${c4.status} err=${c4b.error}`);

    // ── C5 full-export: arbitrary path denied ──
    const c5 = await post('/import/full-export', { dirPath: '/etc' });
    const c5b = await c5.json().catch(() => ({}));
    rec('C5 full-export arbitrary path (/etc) → 400 import_path_denied',
      c5.status === 400 && /import_path_denied/.test(c5b.error || ''), `status=${c5.status} err=${c5b.error}`);

    // ── C6 full-export: a GRANTED dir passes confinement (then fails on the
    //    missing manifest — proving the gate let it through, didn't deny it) ──
    const c6 = await post('/import/full-export', { dirPath: GRANT });
    const c6b = await c6.json().catch(() => ({}));
    rec('C6 full-export granted dir passes confinement (fails on manifest, NOT denied)',
      !/import_path_denied/.test(c6b.error || ''), `status=${c6.status} err=${c6b.error}`);
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
  }

  // ── C7 walker symlink-skip: readClaudeCodeEntries does not follow a symlinked .jsonl ──
  const ccDir = path.join(GRANT, 'cc');
  mkdirSync(ccDir, { recursive: true });
  writeFileSync(path.join(ccDir, 'real.jsonl'), '{"type":"user"}\n');
  writeFileSync(path.join(SECRET, 'leak.jsonl'), '{"type":"user","secret":true}\n');
  symlinkSync(path.join(SECRET, 'leak.jsonl'), path.join(ccDir, 'leak.jsonl'));
  const entries = readClaudeCodeEntries(ccDir);
  rec('C7 readClaudeCodeEntries skips a symlinked .jsonl (only the real file)',
    entries.length === 1 && entries[0].relPath === 'real.jsonl', `entries=${entries.map((e) => e.relPath).join(',')}`);

  // ── C8 detectSources/countFiles symlink-skip: a symlinked .md is not counted ──
  const home = path.join(GRANT, 'home');
  const symVault = path.join(home, 'vault');
  mkdirSync(symVault, { recursive: true });
  writeFileSync(path.join(symVault, 'one.md'), '# one');
  writeFileSync(path.join(SECRET, 'two.md'), '# two');
  symlinkSync(path.join(SECRET, 'two.md'), path.join(symVault, 'two.md'));
  const obsCfg = path.join(home, 'Library', 'Application Support', 'obsidian');
  mkdirSync(obsCfg, { recursive: true });
  writeFileSync(path.join(obsCfg, 'obsidian.json'), JSON.stringify({ vaults: { v1: { path: symVault, open: true } } }));
  const obs = detectSources({ home }).find((s) => s.source === 'obsidian');
  rec('C8 countFiles skips a symlinked .md (counts 1, not 2)', !!obs && obs.count === 1, `count=${obs?.count}`);

  const ok = ledger.every(Boolean);
  console.log(`\nVERDICT: ${ok ? 'GO — import paths confined to the allowlist; symlink escapes rejected; legit grant still imports' : 'NO-GO — see FAIL rows'}`);
  for (const d of [GRANT, SECRET]) { try { rmSync(d, { recursive: true }); } catch {} }
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  console.log(`EXIT=${ok ? 0 : 1}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('verify-import-confinement threw:', e); process.exit(1); });

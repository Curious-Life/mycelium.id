// tests/vault-safe-copy.test.js — safeVaultCopy() produces a CONSISTENT, same-key
// encrypted snapshot with no plaintext leak, and stays consistent under a live
// concurrent writer (the regression: fs.copyFileSync tears → "database disk image is
// malformed"). @see src/db/backup.js, docs/VAULT-CONCURRENCY-FIX-DESIGN-2026-07-01.md.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { safeVaultCopy } from '../src/db/backup.js';

const KEY = 'd'.repeat(64);
const MARK = 'PLAINTEXT_LEAK_CANARY';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safecopy-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

function open(p, ro = false) {
  const db = new Database(p, { readonly: ro });
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key="x'${KEY}'"`);
  db.pragma('temp_store = MEMORY');
  if (!ro) { db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000'); }
  return db;
}
function seed(p, rows) {
  const db = open(p);
  db.exec('CREATE TABLE msgs (id INTEGER PRIMARY KEY, body TEXT)');
  const ins = db.prepare('INSERT INTO msgs (body) VALUES (?)');
  db.transaction(() => { for (let i = 0; i < rows; i++) ins.run(MARK + i); })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}

describe('safeVaultCopy', () => {
  it('produces a same-key-encrypted, consistent copy with no plaintext leak', () => {
    const src = path.join(tmp, 'a.db'); seed(src, 200);
    const dest = path.join(tmp, 'a-snap.db');
    const s = open(src);
    safeVaultCopy(s, dest); // open() returns the raw better-sqlite3 handle (exposes .exec)
    s.close();

    // consistent + readable with the same key
    const d = open(dest, true);
    assert.equal(d.prepare('PRAGMA quick_check').all()[0].quick_check, 'ok');
    assert.equal(d.prepare('SELECT count(*) c FROM msgs').get().c, 200);
    d.close();

    // no plaintext leak: the canary must not appear in the raw bytes, and an UNKEYED
    // open must fail (proves it is encrypted, CLAUDE.md §1/§7)
    assert.equal(fs.readFileSync(dest).includes(Buffer.from(MARK)), false);
    assert.throws(() => { const u = new Database(dest, { readonly: true }); u.prepare('SELECT 1 FROM msgs').get(); });
  });

  it('overwrites a stale destination (VACUUM INTO requires an absent target)', () => {
    const src = path.join(tmp, 'b.db'); seed(src, 50);
    const dest = path.join(tmp, 'b-snap.db');
    fs.writeFileSync(dest, 'stale'); // pre-existing junk
    const s = open(src);
    assert.doesNotThrow(() => safeVaultCopy(s, dest));
    s.close();
    const d = open(dest, true);
    assert.equal(d.prepare('PRAGMA quick_check').all()[0].quick_check, 'ok');
    d.close();
  });

  it('stays consistent under a live concurrent writer (copyFileSync would tear)', () => {
    const src = path.join(tmp, 'c.db'); seed(src, 12000); // ~a few MB so a copy overlaps writes
    // child writer: hammer the same vault RW while we snapshot
    const writer = `
      import Database from 'better-sqlite3';
      const db = new Database(${JSON.stringify(src)});
      db.pragma("cipher='sqlcipher'"); db.pragma('key="x\\'${KEY}\\'"');
      db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000');
      const ins = db.prepare('INSERT INTO msgs (body) VALUES (?)');
      const tx = db.transaction((k)=>{ for(let i=0;i<200;i++) ins.run('${MARK}'+k+'_'+i); });
      const t0 = Date.now(); let k=0; while (Date.now()-t0 < 8000) { try { tx(k++); } catch {} }
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', writer], { stdio: 'ignore' });
    try {
      // give the writer a moment to start, then snapshot repeatedly during writes
      const start = Date.now();
      let iterations = 0;
      while (Date.now() - start < 3000) {
        const dest = path.join(tmp, `c-snap-${iterations}.db`);
        const s = open(src);
        safeVaultCopy(s, dest);
        s.close();
        const d = open(dest, true);
        const qc = d.prepare('PRAGMA quick_check').all()[0].quick_check;
        d.close();
        assert.equal(qc, 'ok', `snapshot ${iterations} must be consistent under a concurrent writer`);
        for (const sfx of ['', '-wal', '-shm']) { try { fs.rmSync(dest + sfx); } catch {} }
        iterations++;
      }
      assert.ok(iterations >= 2, 'expected at least 2 snapshots during the writer window');
    } finally {
      try { child.kill('SIGKILL'); } catch {}
    }
  });
});

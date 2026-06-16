// spike/at-rest-alias-check.mjs — confirm the aliased driver satisfies the two
// properties the opt-in at-rest design rests on. Throwaway; delete after run.
//   (A) keyed open is opaque at rest + round-trips + fail-closed on wrong/no key
//   (B) no-key open stays plaintext (so the ~104 raw-read verify gates keep working)
import Database from 'better-sqlite3';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveDbKey } from '../src/account/keystore.js';

const KEY = deriveDbKey('a'.repeat(64));
const dir = tmpdir();
const enc = join(dir, `at-rest-enc-${process.pid}.db`);
const plain = join(dir, `at-rest-plain-${process.pid}.db`);
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  [✓] ${n}`); } else { fail++; console.log(`  [✗] ${n}`); } };

try {
  // (A) keyed
  {
    const db = new Database(enc);
    db.pragma(`cipher='sqlcipher'`);
    db.pragma(`key="x'${KEY}'"`);
    db.exec(`CREATE TABLE t(id INTEGER PRIMARY KEY, secret TEXT)`);
    db.prepare(`INSERT INTO t(secret) VALUES (?)`).run('PLAINTEXT_MARKER_42');
    db.close();
  }
  const encBytes = readFileSync(enc);
  ok('A2 file is not a plaintext SQLite header', encBytes.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0');
  ok('A1 seeded marker absent from ciphertext', !encBytes.includes(Buffer.from('PLAINTEXT_MARKER_42')));
  {
    const db = new Database(enc);
    db.pragma(`cipher='sqlcipher'`); db.pragma(`key="x'${KEY}'"`);
    const row = db.prepare(`SELECT secret FROM t WHERE id=1`).get();
    ok('A4 round-trip decrypts identically', row?.secret === 'PLAINTEXT_MARKER_42');
    db.close();
  }
  { // wrong key
    let threw = false;
    try { const db = new Database(enc); db.pragma(`cipher='sqlcipher'`); db.pragma(`key="x'${'b'.repeat(64)}'"`); db.prepare(`SELECT * FROM t`).get(); db.close(); }
    catch { threw = true; }
    ok('A3 wrong key fails closed', threw);
  }
  { // no key on an encrypted file
    let threw = false;
    try { const db = new Database(enc); db.prepare(`SELECT * FROM t`).get(); db.close(); }
    catch { threw = true; }
    ok('A3 no key on encrypted file fails closed', threw);
  }
  // (B) plaintext path unchanged
  {
    const db = new Database(plain);
    db.exec(`CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)`);
    db.prepare(`INSERT INTO t(v) VALUES (?)`).run('VISIBLE');
    db.close();
  }
  const plainBytes = readFileSync(plain);
  ok('B no-key open is a normal plaintext SQLite file', plainBytes.subarray(0, 16).toString('latin1') === 'SQLite format 3\0');
  {
    const db = new Database(plain);
    ok('B plaintext round-trips', db.prepare(`SELECT v FROM t`).get()?.v === 'VISIBLE');
    db.close();
  }
} finally {
  for (const f of [enc, plain]) { try { rmSync(f); } catch {} }
}
console.log(`\nVERDICT: ${fail === 0 ? 'GO' : 'NO-GO'} (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);

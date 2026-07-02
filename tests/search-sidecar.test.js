// tests/search-sidecar.test.js — the search index lives in a SEPARATE, encrypted
// sidecar file, and a CORRUPT sidecar self-heals (file-level rm + rebuild) instead
// of becoming a fatal, un-DROPpable error. The reset NEVER touches the vault.
// @see src/search/sqlite/sidecar.js, docs/SEARCH-SIDECAR-DESIGN-2026-07-02.md.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openSidecar, sidecarPath, ensureSidecarHealthy } from '../src/search/sqlite/sidecar.js';

const KEY = 'a1'.repeat(32); // 64-char hex
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const VAULT = path.join(tmp, 'mycelium.db');

function seedSidecar(dbPath, n) {
  const { raw } = openSidecar({ dbPath, dbKeyHex: KEY });
  const f32 = (arr) => Buffer.from(Float32Array.from(arr).buffer);
  const v = new Array(768).fill(0).map((_, i) => Math.sin(i) / 27);
  const v256 = v.slice(0, 256);
  const tx = raw.transaction(() => {
    for (let i = 0; i < n; i++) {
      raw.prepare('INSERT INTO doc_meta(id,ts) VALUES(?,?)').run('m' + i, 1700000000 + i);
      raw.prepare('INSERT INTO fts_docs(id,content) VALUES(?,?)').run('m' + i, 'lorem ipsum doc ' + i);
      raw.prepare('INSERT INTO vec_docs_768(id,embedding) VALUES(?,?)').run('m' + i, f32(v));
      raw.prepare('INSERT INTO vec_docs_256(id,embedding) VALUES(?,?)').run('m' + i, f32(v256));
    }
    raw.prepare("INSERT INTO search_state(key,value) VALUES('corpus_built','1')").run();
  });
  tx();
  raw.pragma('wal_checkpoint(TRUNCATE)');
  raw.close();
}

describe('search sidecar', () => {
  it('sidecarPath maps mycelium.db → mycelium.search.db (same dir)', () => {
    assert.equal(sidecarPath('/a/b/mycelium.db'), '/a/b/mycelium.search.db');
    assert.equal(path.dirname(sidecarPath(VAULT)), tmp);
  });

  it('creates an ENCRYPTED sidecar (unkeyed + wrong-key opens fail — no plaintext leak)', () => {
    const { raw, path: sp, wasReset } = openSidecar({ dbPath: VAULT, dbKeyHex: KEY });
    assert.equal(wasReset, false);
    assert.ok(fs.existsSync(sp));
    // schema present
    const names = raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all().map((r) => r.name);
    assert.ok(names.includes('doc_meta') && names.includes('fts_docs') && names.includes('vec_docs_256'));
    raw.close();
    // unkeyed open of the encrypted file must fail
    assert.throws(() => { const d = new Database(sp, { fileMustExist: true }); d.prepare('SELECT 1 FROM doc_meta').get(); });
    // wrong key must fail
    assert.throws(() => { const d = new Database(sp, { fileMustExist: true }); d.pragma(`cipher='sqlcipher'`); d.pragma(`key="x'${'b2'.repeat(32)}'"`); d.prepare('SELECT 1 FROM doc_meta').get(); });
  });

  it('REGRESSION: a physically-corrupt sidecar self-heals (rm + rebuild), content untouched', () => {
    // a vault file that must never be deleted by the reset
    const vraw = new Database(VAULT);
    vraw.pragma(`cipher='sqlcipher'`); vraw.pragma(`key="x'${KEY}'"`);
    vraw.exec('CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, content TEXT)');
    vraw.prepare('INSERT OR REPLACE INTO messages(id,content) VALUES(?,?)').run('keep-1', 'precious content');
    vraw.close();
    const vaultSizeBefore = fs.statSync(VAULT).size;

    // build a populated sidecar, then scribble garbage densely across its back
    // ~65% (hits the fts5/vec0 shadow b-tree pages — proven in the audit experiment)
    const sp = sidecarPath(VAULT);
    seedSidecar(VAULT, 5000);
    const size = fs.statSync(sp).size;
    const fd = fs.openSync(sp, 'r+');
    const garbage = Buffer.alloc(64 * 1024, 0xDB);
    for (let off = Math.floor(size * 0.3); off < size - garbage.length; off += garbage.length) fs.writeSync(fd, garbage, 0, garbage.length, off);
    fs.fsyncSync(fd); fs.closeSync(fd);

    // sanity: it really is corrupt now
    assert.throws(() => { const d = new Database(sp, { fileMustExist: true }); d.pragma(`cipher='sqlcipher'`); d.pragma(`key="x'${KEY}'"`); for (const _ of d.prepare('SELECT * FROM fts_docs').iterate()) {} });

    // openSidecar must detect + reset (rm + fresh)
    const { raw, wasReset } = openSidecar({ dbPath: VAULT, dbKeyHex: KEY });
    assert.equal(wasReset, true, 'corrupt sidecar should have been reset');
    // fresh + empty + schema present + corpus_built cleared (→ rebuild next warm)
    assert.equal(raw.prepare('SELECT count(*) c FROM doc_meta').get().c, 0);
    assert.equal(raw.prepare("SELECT value FROM search_state WHERE key='corpus_built'").get(), undefined);
    assert.equal(raw.prepare('PRAGMA integrity_check(5)').all().map((r) => r.integrity_check).join(), 'ok');
    raw.close();

    // the VAULT is completely untouched by the reset
    assert.equal(fs.statSync(VAULT).size, vaultSizeBefore);
    const vr = new Database(VAULT, { fileMustExist: true });
    vr.pragma(`cipher='sqlcipher'`); vr.pragma(`key="x'${KEY}'"`);
    assert.equal(vr.prepare("SELECT content FROM messages WHERE id='keep-1'").get().content, 'precious content');
    vr.close();
  });

  it('ensureSidecarHealthy is best-effort and idempotent on a clean sidecar', () => {
    const r1 = ensureSidecarHealthy({ dbPath: VAULT, dbKeyHex: KEY });
    assert.equal(r1.wasReset, false);
    assert.equal(r1.error, undefined);
  });

  it('FAIL-CLOSED: refuses an UNKEYED sidecar next to an ENCRYPTED vault (no plaintext embeddings §7)', () => {
    // a real encrypted vault file (SQLCipher header → vaultIsEncrypted true)
    const encVault = path.join(tmp, 'enc.db');
    const v = new Database(encVault); v.pragma(`cipher='sqlcipher'`); v.pragma(`key="x'${KEY}'"`);
    v.exec('CREATE TABLE t(x)'); v.close();
    assert.throws(() => openSidecar({ dbPath: encVault, dbKeyHex: null }), /UNKEYED|sensitive/i);
    // keyed open of the same vault's sidecar is fine
    const { raw } = openSidecar({ dbPath: encVault, dbKeyHex: KEY });
    raw.close();
  });

  it('DEEP probe (ensureSidecarHealthy) resets a corrupt sidecar via quick_check', () => {
    const dv = path.join(tmp, 'deep.db');
    // encrypt the vault so the sidecar is keyed
    const v = new Database(dv); v.pragma(`cipher='sqlcipher'`); v.pragma(`key="x'${KEY}'"`); v.exec('CREATE TABLE t(x)'); v.close();
    seedSidecar(dv, 4000);
    const sp = sidecarPath(dv);
    const size = fs.statSync(sp).size;
    const fd = fs.openSync(sp, 'r+');
    const g = Buffer.alloc(64 * 1024, 0xDB);
    for (let off = Math.floor(size * 0.3); off < size - g.length; off += g.length) fs.writeSync(fd, g, 0, g.length, off);
    fs.fsyncSync(fd); fs.closeSync(fd);
    const r = ensureSidecarHealthy({ dbPath: dv, dbKeyHex: KEY });
    assert.equal(r.wasReset, true, 'deep quick_check should catch + reset the corruption');
    assert.equal(r.error, undefined);
  });
});

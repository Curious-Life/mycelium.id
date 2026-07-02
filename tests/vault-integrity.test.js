// tests/vault-integrity.test.js — the detached, throttled boot integrity check.
// Covers the standalone probe's exit codes (0 ok / 1 corrupt / 2 error) and the
// scheduler's throttle + marker behavior. @see src/db/integrity.js,
// src/db/vault-integrity-check.mjs, docs/VAULT-CONCURRENCY-FIX-DESIGN-2026-07-01.md.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { deriveDbKey } from '../src/account/keystore.js';
import { maybeScheduleIntegrityCheck, vaultCorruptMarkerPath } from '../src/db/integrity.js';

const SCRIPT = fileURLToPath(new URL('../src/db/vault-integrity-check.mjs', import.meta.url));
const USER_HEX = 'e'.repeat(64);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

function runScript(dbPath, { withKey = false } = {}) {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, MYCELIUM_DB: dbPath };
    if (withKey) env.USER_MASTER = USER_HEX;
    const c = spawn(process.execPath, [SCRIPT], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d.toString(); });
    c.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}
function seedKeyed(p) {
  const db = new Database(p);
  db.pragma(`cipher='sqlcipher'`); db.pragma(`key="x'${deriveDbKey(USER_HEX)}'"`);
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, b TEXT)');
  db.prepare('INSERT INTO t(b) VALUES(?)').run('hello'); db.close();
}
function seedCorruptPlaintext(p) {
  const db = new Database(p); db.pragma('journal_mode = DELETE');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, b TEXT)');
  const ins = db.prepare('INSERT INTO t(b) VALUES(?)');
  db.transaction(() => { for (let i = 0; i < 5000; i++) ins.run('row'.repeat(50)); })();
  db.close();
  const buf = fs.readFileSync(p); for (let i = 8192; i < 8592; i++) buf[i] = 0x99; fs.writeFileSync(p, buf);
}

describe('vault-integrity probe (script)', () => {
  it('exit 0 + ok:true on a clean keyed vault', async () => {
    const p = path.join(tmp, 'clean.db'); seedKeyed(p);
    const { code, out } = await runScript(p, { withKey: true });
    assert.equal(code, 0);
    assert.equal(JSON.parse(out).ok, true);
  });

  it('exit 1 on a corrupt-but-openable vault (b-tree damage)', async () => {
    const p = path.join(tmp, 'corrupt.db'); seedCorruptPlaintext(p);
    const { code, out } = await runScript(p, { withKey: false });
    assert.equal(code, 1);
    assert.equal(JSON.parse(out).ok, false);
  });

  it('exit 2 when the file is not a database', async () => {
    const p = path.join(tmp, 'garbage.db'); fs.writeFileSync(p, 'not a database at all');
    const { code } = await runScript(p, { withKey: false });
    assert.equal(code, 2);
  });
});

describe('integrity scheduler (throttle + marker)', () => {
  it('skips non-canonical vaults and when disabled', () => {
    const p = path.join(tmp, 's1.db'); fs.writeFileSync(p, 'x');
    assert.equal(maybeScheduleIntegrityCheck({ dbPath: p, isCanonical: false }).reason, 'not-canonical');
    process.env.MYCELIUM_SKIP_INTEGRITY_CHECK = '1';
    assert.equal(maybeScheduleIntegrityCheck({ dbPath: p, isCanonical: true }).reason, 'disabled');
    delete process.env.MYCELIUM_SKIP_INTEGRITY_CHECK;
  });

  it('throttles a second call within the window', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'thr-')); const p = path.join(dir, 'v.db'); seedKeyed(p);
    const first = maybeScheduleIntegrityCheck({ dbPath: p, userHex: USER_HEX, isCanonical: true });
    assert.equal(first.scheduled, true);
    const second = maybeScheduleIntegrityCheck({ dbPath: p, userHex: USER_HEX, isCanonical: true });
    assert.equal(second.scheduled, false);
    assert.equal(second.reason, 'throttled');
  });

  it('writes a .vault-corrupt marker when the detached check finds corruption', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'mark-')); const p = path.join(dir, 'v.db');
    seedCorruptPlaintext(p); // plaintext + corrupt → probe (no key) → exit 1
    const r = maybeScheduleIntegrityCheck({ dbPath: p, isCanonical: true }); // no userHex → plaintext probe
    assert.equal(r.scheduled, true);
    // poll for the marker (detached child); fail if it never appears
    const marker = vaultCorruptMarkerPath(p);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !fs.existsSync(marker)) { await new Promise((res) => setTimeout(res, 100)); }
    assert.equal(fs.existsSync(marker), true, 'expected a .vault-corrupt marker after a failed check');
    assert.equal(typeof JSON.parse(fs.readFileSync(marker, 'utf8')).at, 'number');
  });
});

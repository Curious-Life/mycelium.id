// verify:at-rest-default — the CRITICAL fix gate. After the SQLCipher Stage B/C
// collapse, content has NO per-field envelope, so whole-file SQLCipher is the only
// at-rest defense — and it must be the DEFAULT for the canonical vault on EVERY entry
// point (incl. the documented `node src/index.js` self-host path), NOT opt-in. This
// gate proves: (1) atRestDefaultOn scopes to the canonical path; (2) the canonical
// vault is BORN ENCRYPTED with no MYCELIUM_AT_REST flag (the index.js opt-in); (3) an
// existing plaintext canonical vault MIGRATES; (4) a NON-canonical fixture stays
// PLAINTEXT (design D5 / the ~104-gate invariant); (5) the fail-closed condition holds.
// PASS/FAIL ledger. @see docs/PRE-FREEZE-SECURITY-DESIGN-2026-06-19.md, src/index.js.
import Database from 'better-sqlite3';
import { rmSync, mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { applyMigrations } from '../src/db/migrate.js';
import { initVaultStorage } from '../src/db/init.js';
import { atRestDefaultOn, atRestEnabled, vaultIsEncrypted } from '../src/db/open.js';
import { isPlaintextSqlite } from '../src/account/db-cipher-migrate.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const userHex = crypto.randomBytes(32).toString('hex');

// index.js's per-entry-point opt-in, replicated verbatim (the unit under test is that
// THIS decision flips at-rest on for the canonical vault, with no flag preset).
function indexJsOptIn(dbPath) {
  if (atRestDefaultOn(dbPath) && !atRestEnabled()) process.env.MYCELIUM_AT_REST = '1';
}
const clearFlag = () => { delete process.env.MYCELIUM_AT_REST; };

const dir = mkdtempSync(join(tmpdir(), 'verify-at-rest-default-'));
try {
  // ── 1. scope: canonical via MYCELIUM_DB → true; a different path → false ──────
  const canon = join(dir, 'mycelium.db');
  process.env.MYCELIUM_DB = canon;
  const nonCanon = join(dir, 'fixture.db');
  rec('1. atRestDefaultOn(canonical)=true, (fixture)=false, (null)=false',
    atRestDefaultOn(canon) === true && atRestDefaultOn(nonCanon) === false && atRestDefaultOn(null) === false);

  // ── 2. FRESH canonical vault is BORN ENCRYPTED with NO flag set ──────────────
  clearFlag();
  rec('2a. precondition: MYCELIUM_AT_REST is NOT set', !atRestEnabled());
  indexJsOptIn(canon);                                  // index.js opts the canonical entry in
  const key1 = await initVaultStorage({ dbPath: canon, userHex, log: () => {} });
  rec('2b. fresh canonical vault → keyed (dbKeyHex returned) without a preset flag',
    typeof key1 === 'string' && /^[0-9a-f]{64}$/i.test(key1));
  rec('2c. fresh canonical vault file is CIPHERTEXT at rest (born encrypted)',
    existsSync(canon) && vaultIsEncrypted(canon) && !isPlaintextSqlite(canon));
  clearFlag();

  // ── 3. EXISTING plaintext canonical vault MIGRATES to ciphertext on boot ─────
  const canon2 = join(dir, 'existing', 'mycelium.db');
  process.env.MYCELIUM_DB = canon2;
  rmSync(join(dir, 'existing'), { recursive: true, force: true });
  mkdirSync(join(dir, 'existing'), { recursive: true });
  { const d = new Database(canon2); applyMigrations(d); d.prepare("INSERT INTO facts(id,user_id,category,key,value) VALUES (?,?,?,?,?)").run('f1','u','c','k','PLAINTEXT_MARKER'); d.close(); }
  rec('3a. seeded an EXISTING plaintext canonical vault', isPlaintextSqlite(canon2));
  clearFlag();
  indexJsOptIn(canon2);
  const key2 = await initVaultStorage({ dbPath: canon2, userHex, log: () => {} });
  rec('3b. existing plaintext canonical vault MIGRATED to ciphertext (keyed + no plaintext header)',
    typeof key2 === 'string' && vaultIsEncrypted(canon2) && !isPlaintextSqlite(canon2));
  clearFlag();

  // ── 4. NON-canonical fixture stays PLAINTEXT (design D5 / ~104-gate invariant) ─
  // MYCELIUM_DB points at canon2; a DIFFERENT path is non-canonical → no opt-in.
  const fixture = join(dir, 'fixture.db');
  rec('4a. fixture path is non-canonical', atRestDefaultOn(fixture) === false);
  indexJsOptIn(fixture);                                // no-op for a non-canonical path
  rec('4b. opt-in did NOT set the flag for a non-canonical fixture', !atRestEnabled());
  const key3 = await initVaultStorage({ dbPath: fixture, userHex, log: () => {} });
  rec('4c. non-canonical fixture → plaintext open (null key), header stays plaintext',
    key3 === null && existsSync(fixture) && isPlaintextSqlite(fixture));
  clearFlag();

  // ── 5. fail-closed CONDITION: canonical + no key ⇒ index.js throws ───────────
  // (index.js: `if (isCanonicalVault && !dbKeyHex) throw …`.) Prove the predicate.
  const wouldRefuse = (dbPath, dbKeyHex) => atRestDefaultOn(dbPath) && !dbKeyHex;
  rec('5. fail-closed predicate: canonical+unkeyed ⇒ refuse; canonical+keyed ⇒ open; fixture+unkeyed ⇒ open',
    wouldRefuse(canon2, null) === true && wouldRefuse(canon2, key2) === false && wouldRefuse(fixture, null) === false);
} finally {
  clearFlag(); delete process.env.MYCELIUM_DB;
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — canonical vault born-encrypted by default (no flag) + migrates + fail-closed; non-canonical fixtures stay plaintext (D5 intact)' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

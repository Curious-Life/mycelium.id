#!/usr/bin/env node
// verify-vault-fail-stop.mjs — the fail-STOP latch for structural vault damage.
//
// THE FAILURE IT PROVES BOUNDED (production, 2026-07-26, from the app's own log):
//   server-rest.log:212  [llm-usage] record failed: database disk image is malformed
//   server-rest.log:213  [llm-usage] record failed: database disk image is malformed
//   server-rest.log:214  [enrich] embedded 3840 message(s) in-process
// SQLite reported structural damage; an ordinary catch (src/db/llm-usage.js:70) swallowed
// it; the app wrote 3,840 more rows into the damaged file. One bad page became an
// unrecoverable vault.
//
// The load-bearing check is NOT "does the latch set a boolean" — it is "THE BLEED STOPS":
// after the trip, a caller whose catch block is byte-for-byte the llm-usage swallow
// cannot add a single row to a vault that would otherwise have accepted it.
//
// Fixtures are REAL SQLCipher vaults made malformed by page-splicing between two
// generations of ONE lineage (same salt ⇒ every page decrypts, the b-tree is a lie).
// Byte-patching cannot be used: SQLCipher HMACs each page, so shredding bytes yields
// SQLITE_NOTADB "file is not a database" — a WRONG-KEY signature, not the production
// one. Measured while building this gate. verify:wal-guard's randomBytes fixture has the
// same limitation. The canonical vault is never opened; the harness refuses if
// MYCELIUM_DB points at it.
//
// Each mutation below was APPLIED, the gate RUN, and the mutation RESTORED (2026-07-28):
//
// MUTATION-TESTED: removed assertVaultUsable() from src/adapter/d1.js query() → "halted
//   vault refuses a second write" AND "THE BLEED STOPS" RED
// MUTATION-TESTED: dropped the isCorruptionError test in noteQueryError so the latch
//   fires on any error → "SQLITE_BUSY / constraint errors do NOT halt the vault" REDs
// MUTATION-TESTED: sqlShape() returns the raw SQL (inlined-literal leak) → "forensics
//   carry no plaintext" REDs
// MUTATION-TESTED: forensics record the bound params → "forensics carry no plaintext" REDs
// MUTATION-TESTED: reverted the keys.js malformed branch, folding `malformed` back in
//   with the wrong-key patterns → "a corrupt vault is NOT reported as a wrong key" REDs
// MUTATION-TESTED: removed PRAGMA cell_size_check = ON → "cell_size_check and fullfsync
//   are set on the canonical open" REDs
// MUTATION-TESTED: reverted classifyBootError's vault_corrupt branch → "classifyBootError
//   reports vault_corrupt, not the generic boot_failed" REDs
//
// Added 2026-07-28 after an independent adversarial review found five real defects that
// the first version of this gate did not cover — each fix has its own mutation:
// MUTATION-TESTED: removed the raw-handle guards (db.prepare/exec/transaction) from
//   src/adapter/d1.js → "raw-handle writes are ALSO refused after the trip" REDs
// ⚠️ RECORD CORRECTED 2026-07-28. This previously read "made src/index.js stop reading
//   the .vault-corrupt marker at boot → REDs". That was true only as literally performed
//   (deleting the identifier TEXT) and FALSE as written: an adversarial review set
//   `const mark = readVaultCorruptMarker(dbPath)` → `const mark = null`, which stops boot
//   consulting the marker entirely, and the gate still reported 16 passed / 0 failed —
//   the identifier survives on the destructuring import, which is what the grep and the
//   iRead<iOpen ordering check were both indexing. The three greps are replaced by three
//   checks that RUN the real boot():
// MUTATION-TESTED: `const mark = readVaultCorruptMarker(dbPath)` → `const mark = null`
//   → ALL THREE of "marker + vault GONE", "marker + genuinely DAMAGED" and
//   "marker + REPAIRED" RED. This is the mutation the old grep survived.
// MUTATION-TESTED: made clearVaultCorruptMarker a no-op (the permanent-lockout bug) →
//   "a condemned vault self-heals when it proves clean" REDs
// MUTATION-TESTED: sqlShape() stops stripping string literals and free-scans for FROM/INTO
//   (reinstating the leak: "UPDATE settings SET v='imported from X'" → "UPDATE X") →
//   "forensics carry no plaintext" REDs
// ⚠️ RECORD CORRECTED 2026-07-28. The mid-session 503 check was FOUR greps over
//   server-rest.js, and an adversarial review neutered the predicate itself
//   (`isVaultDataPath = (p) => false && …`), ungating every data path while all four
//   matched — 16 passed, 0 failed with a halted vault serving normally. It is now a live
//   request against a BOOTED vault (an unbooted one is 503 either way, so it proves
//   nothing):
// MUTATION-TESTED: `isVaultDataPath = (p) => false`
//   → "a mid-session halt returns 503 vault_corrupt" REDs.
//   ⚠️ My first attempt at this mutation inserted `false &&` into the existing expression
//   and SURVIVED — `&&` binds tighter than `||`, so `(false && A) || B || C` still matched
//   /ingest/. The mutation was not what I thought I had written. Verify the mutation does
//   what you intend, not merely that the edit landed.
// ⚠️ RECORD CORRECTED 2026-07-28. The portal check was a SOURCE read of +page.svelte (an
//   index ordering plus strings inside the damaged block), and an adversarial review
//   defeated all of it with ONE character: `if (false && bootError === 'vault_corrupt')`.
//   Every index still resolved, every string was still in the file, and a damaged vault
//   fell through to the paste-your-recovery-key screen — the entire reported symptom —
//   at 16 passed, 0 failed. It now MOUNTS the real page and answers its status fetch.
// MUTATION-TESTED: `if (false && bootError === 'vault_corrupt')`
//   → "the portal routes a damaged vault AWAY from the recovery-key screen" REDs.
//   The check carries a CONTROL (a non-corruption bootError must still reach the
//   recovery-key screen), so "no key prompt" cannot pass by the damaged branch
//   swallowing everything.
//
// ⚠️ TWO of those five mutations SURVIVED on the first attempt — because the mutation had
// not actually applied (a perl/regex that silently matched nothing), not because the check
// was weak. A mutation you did not verify was applied proves nothing at all. Both were
// re-run with the edit confirmed on disk first, and only then RED.
//
// HONEST NOTE — this gate was green for the wrong reason once, and mutation testing is
// the only reason it is not still. The bleed check originally ran against the FULLY
// corrupt fixture, where SQLite refuses the writes on its own: mutation 1 removed the
// latch entirely and the check stayed [✓]. It now runs against an otherwise-HEALTHY
// vault with the latch tripped directly, which is also the truer model of production —
// there, `INSERT llm_usage` raised malformed while 3,840 embeddings still landed in
// other tables. That partial usability is exactly what the latch has to stop.
//
// Also measured and recorded, because it is a trap for the next person: splicing pages
// between two same-salt generations can produce a database that reads CLEANLY and
// returns the WRONG generation's data with no error at all. That silent case is what
// src/db/wal-guard.js exists to prevent, and no gate can catch it after the fact.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
// ── THE STRUCTURAL FIX FOR THE CLASS (2026-07-28, after six review rounds) ──────────
// Six adversarial rounds each found a defect in the marker decision, and EVERY ONE was an
// unhandled COMBINATION falling into a permissive branch — a condemned vault opened and
// written to, or a healthy one bricked. The individual branches were correct each time;
// what was never enumerated was the state space, so "did I miss a case?" stayed a
// judgement call and was wrong six times running.
//
// The decision is now a pure total function over two DECLARED axes (vault-halt.js
// MARKER_KINDS × VERDICT_KINDS), and the full cartesian product is tabled below. That
// converts the judgement into a coverage count:
//   · a new state on either axis fails the coverage check until it has a row;
//   · it fails again until it has a fixture that really classifies as that kind;
//   · and the switch's default throws until it has a case.
// Adding a state quietly — the mechanism behind all six rounds — is no longer possible.
//
// MUTATION-TESTED: a sixth kind added to VERDICT_KINDS without tabling it
//   → "the truth table COVERS every pair" AND "every DECLARED verdict kind has a reachable
//   fixture" both RED. This is the class-level guard, and it is the load-bearing one.
// MUTATION-TESTED: the `inconclusive` cell flipped from REFUSE to BOOT — i.e. round 2's
//   actual defect, reintroduced at the decision layer
//   → "every tabled combination decides exactly as the table says" AND the end-to-end
//   "marker + a vault that cannot be CHECKED" both RED. Two independent layers, one
//   tabular and one behavioural, catch the same regression.

// ROUND-6 REVIEW (2026-07-28). The FOURTH instance of the same class, and the worst one:
// the chain boot() → classifyBootError → status.bootError → the portal's damaged screen had
// BOTH ENDS SIMULATED AND THE JOIN ASSERTED NOWHERE. classifyBootError was only ever fed
// hand-built errors the product never throws on this path (messages containing "database
// disk image is malformed"), while the REAL error carries no SQLite signature and matches
// only via `err?.code === 'vault_corrupt'`; the portal harness built {bootError:'vault_corrupt'}
// itself. Deleting that one clause routed every condemned vault to the
// paste-your-recovery-key screen — THE ENTIRE REPORTED 2026-07-26 SYMPTOM — at 33 passed,
// 0 failed.
// MUTATION-TESTED: `isCorruptionError(err) || err?.code === 'vault_corrupt' || …`
//   → `isCorruptionError(err)` → "END TO END: a condemned vault reaches the portal as
//   bootError=vault_corrupt" REDs, while the old classifyBootError check stays GREEN.
//   That split is the evidence: the old check could not see it, the new one can.
//   ⚠️ My first attempt at this mutation was a regex that ate the following line and made
//   the file a SyntaxError — 3 checks RED for the wrong reason. Second time on this branch.
// MUTATION-TESTED: readVaultCorruptMarker returning the raw JSON.parse result
//   → "a marker body that PARSES to a falsy value still condemns" REDs. `null`, `0`,
//   `false` and `""` all parse to falsy, `if (mark)` skipped the whole gate, and 2.27 MB
//   went into a condemned vault — for four of five shapes, with "presence is the signal,
//   not parseability" written four lines above.

// ROUND-5 REVIEW (2026-07-28). Two HIGH, both inside round 4's fix, and the SAME class a
// third time — a fixture that does not exercise what the product does:
//  · src/db/integrity.js — the app's OWN scheduled condemnation path — wrote {at, detail}
//    with NO `db` field, so index.js's ownership test was vacuously true for every path in
//    the directory and round 4's fix did not apply to the primary writer. Measured before
//    the fix: 2.3 MB written into a condemned vault via a sibling boot.
//  · the mismatch branch RETURNED EARLY, discarding a verdict it had already computed, so
//    boot opened the file unchecked; and the test is a BASENAME comparison, so any alias
//    for the same inode defeated it — 2.3 MB written through a symlink.
// Fixed structurally: ONE marker writer (integrity.js writeVaultCorruptMarker, used by the
// latch too — a format two places construct will diverge again), and file-naming now gates
// CLEARING only, never REFUSING.
// MUTATION-TESTED: the mismatch branch back to an early return
//   → "a marker naming ANOTHER file still refuses a vault that is itself damaged" REDs.
// MUTATION-TESTED: `db` removed from the shared writer
//   → "a marker naming a DIFFERENT file is not cleared by booting this one" REDs.
//   ⚠️ The FIRST attempt at that mutation SURVIVED, because this gate's fixture built the
//   marker JSON itself — so the product could stop emitting `db` and the fixture went on
//   supplying it. A fixture that constructs the artefact under test is testing itself. The
//   fixtures now call the product's writer.

// ROUND-4 REVIEW (2026-07-28). Three more, and the shape is worth naming: every marker
// fixture here forced MYCELIUM_AT_REST='' while the real launch guard sets it to 1, so all
// four branches were gated ONLY in a configuration the shipped app never runs.
// MUTATION-TESTED: key the verify unconditionally (`resolveDbKeyHex` without the
//   vaultIsEncrypted test) + drop the plaintext retry → "AT-REST ON + a still-PLAINTEXT
//   vault" REDs. The defect: the marker gate runs BEFORE the plaintext→cipher migration, so
//   a still-plaintext vault was opened WITH a key, answered SQLITE_NOTADB (which is not a
//   corruption code), fell into "inconclusive ⇒ refuse" and bricked permanently — for
//   exactly the population this change set exists for, with the self-heal branch
//   unreachable in production.
// ⚠️ SINGLE-LAYER NOTE, measured: removing ONLY the caller-side fix
//   (`vaultIsEncrypted(dbPath) ? … : null` → unconditional `resolveDbKeyHex`) SURVIVES,
//   because verifyVaultIntegritySync's plaintext reopen catches it on its own. Removing
//   BOTH REDs. That is defence in depth working as intended rather than a gap — recorded
//   so nobody deletes the "redundant" second layer on the evidence that a mutation of the
//   first one survived.
// MUTATION-TESTED: `readVaultCorruptMarker` empty-body back to `null` → "an UNREADABLE or
//   empty marker" REDs. It had collapsed absent / empty / unreadable into null, so boot
//   skipped every branch and opened the condemned vault read/write. tripVaultHalt writes
//   the marker with a plain truncate-then-write, so a crash mid-write leaves the 0-byte
//   case exactly.
// MUTATION-TESTED: `marksThisFile` forced true → "a marker naming a DIFFERENT file" REDs.
//   The marker path is dirname(dbPath)/.vault-corrupt — directory-scoped — so booting any
//   other db in the same directory took the `absent` branch and un-condemned the real vault.


// ROUND-3 REVIEW (2026-07-28) — the round-2 fix was ENTIRELY UNGATED, and this gate said
// otherwise. The "cannot be checked" fixture was a garbage text file, which boot refuses
// ~40 lines EARLIER at the KCV stage (code: null) and never reaches the marker branch; the
// check declined to assert the code, which was the only discriminator. Re-introducing the
// exact round-2 fail-open left this gate at GO 21/0 — the branch's headline fix, silently
// revertible. Both are fixed: the fixture is now a two-phase boot (clean first, so a real
// kcv.json exists, then chmod 000 for an INCONCLUSIVE SQLITE_CANTOPEN), and the code is
// asserted.
// MUTATION-TESTED: verifyVaultIntegritySync's inconclusive return → `{ok:true,verified:true}`
//   → "marker + a vault that cannot be CHECKED" REDs. (Under the old fixture: GO 21/0.)
// MUTATION-TESTED: the empty-file guard removed → "marker + EMPTY vault" REDs. A 0-byte
//   SQLite file answers quick_check "ok" with a readable, empty sqlite_master, so a
//   TRUNCATED condemned vault read as REPAIRED: marker cleared, the owner told
//   "quick_check now passes (repaired or restored)", and 2.7 MB of fresh schema written
//   over it — measured with a 103 KB -wal holding 3,000 uncheckpointed rows still beside
//   it. That is this repo's own "cannot tell it-worked from nothing-ran" class, landing
//   where it costs the user their data.


import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, openSync, readSync, writeSync, closeSync, copyFileSync, writeFileSync, chmodSync, symlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

// ── refuse to run against the canonical vault ────────────────────────────────────
{
  const { dbPath } = await import('../src/paths.js');
  let canonical = null; try { canonical = resolve(dbPath()); } catch { /* none here */ }
  const target = process.env.MYCELIUM_DB ? resolve(process.env.MYCELIUM_DB) : null;
  if (canonical && target === canonical) {
    console.error('verify-vault-fail-stop: REFUSING to run against the canonical vault.');
    process.exit(2);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'myc-failstop-'));
const KEY = 'b'.repeat(64); // synthetic — never a real key
const USER_MASTER_HEX = 'c'.repeat(64); // synthetic USER_MASTER for the real-boot cases
const SYSTEM_HEX = 'd'.repeat(64);      // boot() resolves BOTH keys; passing only one falls back to env
const { createDb } = await import('../src/adapter/d1.js');
const halt = await import('../src/db/vault-halt.js');
const { isPlaintextSqlite } = await import('../src/account/db-cipher-migrate.js');

/** A real keyed SQLCipher vault with enough rows to span multiple b-tree pages. */
function makeVault(name, rows = 400, prefix = 'x', key = KEY) {
  const p = join(dir, name);
  const db = new Database(p);
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key="x'${key}'"`);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE llm_usage(id INTEGER PRIMARY KEY, payload TEXT)');
  const ins = db.prepare('INSERT INTO llm_usage(payload) VALUES (?)');
  const many = db.transaction(() => { for (let i = 0; i < rows; i++) ins.run(prefix.repeat(60) + i); });
  many();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  return p;
}

/**
 * Build a CHIMERA — the real production damage signature, reproduced deterministically.
 *
 * WHY NOT BYTE-PATCHING: SQLCipher HMACs every page, so shredding bytes makes the page
 * fail its MAC and SQLite reports SQLITE_NOTADB "file is not a database" — which is
 * indistinguishable from a wrong key and is NOT what the production vault did. Measured
 * both ways while building this gate: patching page 1 → NOTADB; patching data pages →
 * no error at all (page 1 still readable).
 *
 * The production vault said "database disk image is malformed", which means its pages
 * were CRYPTOGRAPHICALLY VALID and STRUCTURALLY WRONG — pages from a different
 * generation of the same-keyed vault, spliced in at their old offsets. That is exactly
 * what src/db/wal-guard.js:4-14 describes a stale-WAL replay doing.
 *
 * So we build it honestly: two generations under ONE key, then splice gen-1 pages into
 * gen-2 at the same page numbers. Both sets decrypt cleanly; the b-tree is a lie.
 * Verified to yield `SQLITE_CORRUPT :: database disk image is malformed` — byte-for-byte
 * the production error. This is the first reproducer of that signature in this repo
 * (scripts/vault-repair/repro-corruption.mjs is a REFUTATION harness; its scenarios all
 * come back CLEAN).
 */
function makeChimera(name, key = KEY) {
  const g1 = makeVault(`${name}.gen1`, 200, 'A', key);
  const target = makeVault(`${name}.gen2`, 3000, 'B', key);
  const PS = 4096;
  const fd1 = openSync(g1, 'r');
  const fdT = openSync(target, 'r+');
  const buf = Buffer.alloc(PS);
  let spliced = 0;
  for (const page of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const off = (page - 1) * PS;
    try {
      if (readSync(fd1, buf, 0, PS, off) === PS) { writeSync(fdT, buf, 0, PS, off); spliced++; }
    } catch { /* gen1 is smaller — fewer pages is fine */ }
  }
  closeSync(fd1); closeSync(fdT);
  assert.ok(spliced >= 3, `chimera fixture spliced only ${spliced} pages`);
  return target;
}

/**
 * A PLAINTEXT chimera. The boot-marker cases below run the REAL boot() with at-rest
 * off, so its key is null and quick_check must be able to run unkeyed — an encrypted
 * fixture would fail to OPEN (no verdict) rather than fail to VERIFY (damaged), which
 * are now deliberately different outcomes.
 */
function makePlainChimera(name) {
  const g1 = join(dir, `${name}.p1`);
  const target = join(dir, `${name}.p2`);
  for (const [p, rows, tag] of [[g1, 200, 'A'], [target, 3000, 'B']]) {
    const db = new Database(p);
    db.exec('CREATE TABLE llm_usage(id INTEGER PRIMARY KEY, payload TEXT)');
    const ins = db.prepare('INSERT INTO llm_usage(payload) VALUES (?)');
    const many = db.transaction(() => { for (let i = 0; i < rows; i++) ins.run(tag.repeat(60) + i); });
    many();
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }
  const PS = 4096;
  const fd1 = openSync(g1, 'r'); const fdT = openSync(target, 'r+');
  const buf = Buffer.alloc(PS);
  let spliced = 0;
  for (const page of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const off = (page - 1) * PS;
    try { if (readSync(fd1, buf, 0, PS, off) === PS) { writeSync(fdT, buf, 0, PS, off); spliced++; } } catch { /* */ }
  }
  closeSync(fd1); closeSync(fdT);
  assert.ok(spliced >= 3, `plain chimera spliced only ${spliced} pages`);
  return target;
}

/**
 * A SCHEMA chimera — page 1 itself is unreadable, which is the state the 2026-07-26
 * production vault was found in ("even reading sqlite_master throws malformed").
 *
 * Built from ONE lineage so the salt matches and page 1 decrypts cleanly: take a small
 * vault, grow a copy of it hugely, then splice the grown copy's page 1 back onto the
 * small file. The header now describes a database far larger than the file, so SQLite
 * reaches its own structural verdict on a page it decrypted perfectly. Key correct,
 * schema root malformed — no byte-patching, no MAC failure.
 */
function makeSchemaChimera(name, key = KEY) {
  const small = makeVault(`${name}.small`, 50, 'S', key);
  const big = join(dir, `${name}.big`);
  copyFileSync(small, big);
  {
    const db = new Database(big);
    db.pragma(`cipher='sqlcipher'`);
    db.pragma(`key="x'${key}'"`);
    const ins = db.prepare('INSERT INTO llm_usage(payload) VALUES (?)');
    db.transaction(() => { for (let i = 0; i < 8000; i++) ins.run('G'.repeat(200) + i); })();
    db.exec('CREATE TABLE t2(a TEXT); CREATE INDEX ix ON llm_usage(payload)');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }
  const target = join(dir, `${name}.chimera.db`);
  copyFileSync(small, target);
  const PS = 4096;
  const fdB = openSync(big, 'r');
  const fdT = openSync(target, 'r+');
  const buf = Buffer.alloc(PS);
  readSync(fdB, buf, 0, PS, 0);
  writeSync(fdT, buf, 0, PS, 0);
  closeSync(fdB); closeSync(fdT);
  return target;
}

const open = (p) => createDb({ dbPath: p, userKey: null, systemKey: null, dbKeyHex: KEY });

// ══ 1. a healthy vault does not trip the latch ══════════════════════════════════
await t('healthy vault: queries succeed and the latch stays clear', async () => {
  halt.__resetVaultHaltForTests();
  const a = open(makeVault('healthy.db'));
  const r = await a.d1Query('SELECT count(*) AS n FROM llm_usage');
  assert.equal(r.results[0].n, 400, 'expected 400 rows');
  await a.d1Query('INSERT INTO llm_usage(payload) VALUES (?)', ['fine']);
  assert.equal(halt.isVaultHalted(), false, 'healthy vault must not halt');
  a.close();
});

// ══ 2. structural damage trips the latch ════════════════════════════════════════
let corruptPath = null;
await t('corrupt vault: a query raises SQLITE_CORRUPT and latches the halt', async () => {
  halt.__resetVaultHaltForTests();
  corruptPath = makeChimera('corrupt');
  const a = open(corruptPath);
  let threw = null;
  try { await a.d1Query('SELECT count(*) AS n FROM llm_usage'); }
  catch (e) { threw = e; }
  if (!threw) { try { await a.d1Query('INSERT INTO llm_usage(payload) VALUES (?)', ['x']); } catch (e) { threw = e; } }
  assert.ok(threw, 'expected the corrupt vault to raise');
  assert.ok(halt.isVaultHalted(), `expected the latch to be set (got error: ${threw?.message})`);
  try { a.close(); } catch { /* a corrupt handle may refuse to close */ }
});

// ══ 3. THE LOAD-BEARING CHECK: the bleed actually stops ═════════════════════════
await t('halted vault refuses a second write BEFORE touching the file', async () => {
  assert.ok(halt.isVaultHalted(), 'precondition: latch set by check 2');
  const a = open(corruptPath);
  await assert.rejects(
    () => a.d1Query('INSERT INTO llm_usage(payload) VALUES (?)', ['must not land']),
    (e) => e.code === 'VAULT_HALTED',
    'a halted vault must refuse with VAULT_HALTED, not attempt the write',
  );
  try { a.close(); } catch { /* */ }
});

await t('THE BLEED STOPS: a swallowing caller cannot write to a vault that still would accept writes', async () => {
  // WHY A HEALTHY FILE, NOT THE CORRUPT ONE: on a fully-corrupt fixture SQLite refuses
  // the writes itself, so this check would pass even with the latch removed — green for
  // the wrong reason (CLAUDE.md M-001). Caught exactly that during mutation testing.
  //
  // The production shape was PARTIAL: `INSERT llm_usage` raised malformed while the
  // enrich pipeline went on to write 3,840 embeddings successfully into other tables.
  // So the property under test is precisely "a write that WOULD have landed does not":
  // trip the latch as if some other statement discovered the damage, then prove the
  // otherwise-healthy vault takes no further rows. Without the latch these writes
  // certainly land, so removing it MUST turn this red.
  halt.__resetVaultHaltForTests();
  const p = makeVault('bleed.db');
  const a = open(p);

  // Sanity: this exact write lands before the trip. Without it the check could pass
  // because the statement was broken, not because the latch worked.
  await a.d1Query('INSERT INTO llm_usage(payload) VALUES (?)', ['lands-before-trip']);
  const rows = () => {
    const raw = new Database(p, { readonly: true });
    raw.pragma(`cipher='sqlcipher'`); raw.pragma(`key="x'${KEY}'"`);
    const n = raw.prepare('SELECT count(*) AS n FROM llm_usage').get().n;
    raw.close();
    return n;
  };
  const before = rows();
  assert.equal(before, 401, 'precondition: the pre-trip write landed');

  halt.tripVaultHalt(
    Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }),
    { op: 'INSERT llm_usage', dbPath: p },
  );

  let swallowed = 0;
  // Byte-for-byte the production swallow (src/db/llm-usage.js:70): catch, log, continue.
  for (let i = 0; i < 50; i++) {
    try {
      await a.d1Query('INSERT INTO llm_usage(payload) VALUES (?)', ['x'.repeat(500)]);
    } catch (err) {
      swallowed++; // "Accounting must never break generation; surface to stderr only."
    }
  }
  assert.equal(swallowed, 50, 'every post-trip write must have been refused');
  assert.equal(rows(), before, `the vault gained ${rows() - before} rows after the halt — the bleed did not stop`);
  try { a.close(); } catch { /* */ }
});

// ══ 3b. the RAW HANDLE is not a hole in the latch (review finding 2) ════════════
await t('raw-handle writes (rawDb / db._sqlite) are ALSO refused after the trip', async () => {
  // device-sessions.js:136 and device-tokens.js:87 UPDATE via the raw handle on EVERY
  // authenticated request, and jobs.js backfill writes encrypted columns back — none of
  // them touch query(). Guarding only query() would have left the app writing to a
  // damaged vault on its busiest path.
  halt.__resetVaultHaltForTests();
  const p = makeVault('rawbleed.db');
  const a = open(p);
  const raw = a.db; // exactly what src/db/index.js hands out as rawDb / db._sqlite

  raw.prepare('INSERT INTO llm_usage(payload) VALUES (?)').run('lands-before-trip');
  const count = () => {
    const r = new Database(p, { readonly: true });
    r.pragma(`cipher='sqlcipher'`); r.pragma(`key="x'${KEY}'"`);
    const n = r.prepare('SELECT count(*) AS n FROM llm_usage').get().n; r.close(); return n;
  };
  const before = count();

  halt.tripVaultHalt(
    Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }),
    { op: 'INSERT llm_usage', dbPath: p },
  );

  assert.throws(() => raw.prepare('INSERT INTO llm_usage(payload) VALUES (?)').run('x'),
    (e) => e.code === 'VAULT_HALTED', 'raw prepare/run must refuse');
  assert.throws(() => raw.exec("INSERT INTO llm_usage(payload) VALUES ('y')"),
    (e) => e.code === 'VAULT_HALTED', 'raw exec must refuse');
  assert.throws(() => raw.transaction(() => {})(),
    (e) => e.code === 'VAULT_HALTED', 'raw transaction must refuse');
  assert.equal(count(), before, 'the raw handle wrote to a halted vault');

  // …but recovery-shaped reads must still work: closing cleanly and reading pragmas is
  // part of getting OUT of this state, so they are deliberately NOT guarded.
  assert.doesNotThrow(() => raw.pragma('journal_mode'), 'pragma must stay available while halted');
  assert.doesNotThrow(() => a.close(), 'close must stay available while halted');
});

// ══ 3c. the marker is READ — and is SUSPICION, never a permanent lockout ════════
await t('a condemned vault self-heals when it proves clean, and stays refused when it does not', async () => {
  // The first version threw unconditionally on the marker. NOTHING cleared it —
  // install-vault.mjs did not touch it and integrity.js:83 is scheduled ~40 lines AFTER
  // the throw — and `scripts/` is not even in the app bundle, so every recovery message
  // named a directory the user does not have. Repair your vault, app still refuses,
  // forever. Three independent reviews caught it; this check exists so it cannot return.
  halt.__resetVaultHaltForTests();
  const mdir = mkdtempSync(join(tmpdir(), 'myc-marker-'));
  const p = join(mdir, 'mycelium.db');
  {
    const db = new Database(p);
    db.pragma(`cipher='sqlcipher'`); db.pragma(`key="x'${KEY}'"`);
    db.exec('CREATE TABLE llm_usage(id INTEGER PRIMARY KEY, payload TEXT)');
    db.close();
  }
  assert.equal(halt.readVaultCorruptMarker(p), null, 'a healthy vault has no marker');

  halt.tripVaultHalt(
    Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }),
    { op: 'INSERT llm_usage', dbPath: p },
  );
  assert.ok(halt.readVaultCorruptMarker(p), 'the marker must be readable back');
  halt.__resetVaultHaltForTests(); // a FRESH process: latch clear, marker on disk

  // THE ANTI-LOCKOUT CONTRACT: this file is healthy, so the check passes and the flag goes.
  const good = halt.verifyVaultIntegritySync(p, KEY);
  assert.equal(good.ok, true, `a healthy vault must verify clean, got ${good.reason}`);
  assert.equal(halt.clearVaultCorruptMarker(p), true);
  assert.equal(halt.readVaultCorruptMarker(p), null, 'a proven-clean vault MUST clear its flag');

  // …and a genuinely damaged vault must still be refused.
  const bad = halt.verifyVaultIntegritySync(makeSchemaChimera('markerbad'), KEY);
  assert.equal(bad.ok, false, 'a damaged vault must not verify clean');

  rmSync(mdir, { recursive: true, force: true });
});

// BEHAVIOURAL, deliberately. The previous version of this check was three
// assert.match() greps over src/index.js, and an adversarial review defeated it in
// one line: `const mark = readVaultCorruptMarker(dbPath)` → `const mark = null`
// makes boot ignore the marker entirely, and the gate still reported 16 passed /
// 0 failed — the identifier survives on the destructuring import, which is what the
// grep and the iRead<iOpen ordering check were both indexing. So these now RUN the
// real boot() in a child and judge what it DID.
//
// The three cases are the whole contract, and case B is the one that shipped a brick
// (the third of its class in this change set): the marker is a SIBLING of the vault,
// so it outlives the file, and a user who deletes a condemned vault to start fresh
// must not be locked out of creating a new one.
{
  /** Boot the REAL src/index.js against dir/dbPath in a child; report what it did. */
  const runBootChild = async (dir, dbPath, label = 'boot', envOverrides = {}) => {
    const src = [
      `import { boot } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).pathname)};`,
      `const dbPath = process.argv[2];`,
      `boot({ dbPath, kcvPath: dbPath + '.kcv', userHex: ${JSON.stringify(USER_MASTER_HEX)}, systemHex: ${JSON.stringify(SYSTEM_HEX)}, embedder: null, initStorage: true })`,
      `  .then((b) => { console.log('OK:' + JSON.stringify({ threw: false })); return b?.close?.(); })`,
      `  .catch((e) => console.log('OK:' + JSON.stringify({ threw: true, code: e?.code || null, msg: String(e?.message || e).slice(0, 300) })))`,
      `  .finally(() => process.exit(0));`,
    ].join('\n');
    const childPath = join(dir, 'boot-child.mjs');
    writeFileSync(childPath, src);
    const r = spawnSync(process.execPath, [childPath, dbPath], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, MYCELIUM_AT_REST: '', MYCELIUM_KEY_SOURCE: 'env', MYCELIUM_DISABLE_EMBED: '1', ...envOverrides },
    });
    const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('OK:'));
    // POSITIVE PRECONDITION: the child must have reached our reporting line. Without
    // this, a child that dies of a syntax error reads as "did not throw vault_corrupt".
    assert.ok(line, `${label}: child never reported (stdout=${String(r.stdout).slice(-200)} stderr=${String(r.stderr).slice(-300)})`);
    return { ...JSON.parse(line.slice(3)), dir, dbPath };
  };

  const bootCase = async (label, prepare) => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-bootmark-'));
    const dbPath = join(dir, 'mycelium.db');
    prepare(dbPath, dir);
    return runBootChild(dir, dbPath, label);
  };

  await t('marker + vault GONE → boot clears the stale flag and makes a fresh vault (no brick)', async () => {
    const out = await bootCase('absent', (dbPath, dir) => {
      // marker present, vault deliberately NOT created — the "I deleted it to start over" case
      writeFileSync(join(dir, '.vault-corrupt'), JSON.stringify({ at: new Date(0).toISOString(), code: 'SQLITE_CORRUPT' }));
    });
    assert.equal(out.threw, false, 'a marker whose vault no longer exists must not refuse the boot');
    assert.ok(existsSync(out.dbPath), 'boot must have created the fresh vault');
    assert.ok(!existsSync(join(out.dir, '.vault-corrupt')), 'the stale marker must be cleared');
    rmSync(out.dir, { recursive: true, force: true });
  });

  await t('marker + genuinely DAMAGED vault → boot still refuses (the halt is real)', async () => {
    const out = await bootCase('damaged', (dbPath, dir) => {
      copyFileSync(makePlainChimera('bootmark'), dbPath);
      writeFileSync(join(dir, '.vault-corrupt'), JSON.stringify({ at: new Date(0).toISOString(), code: 'SQLITE_CORRUPT' }));
    });
    assert.equal(out.threw, true, 'a marker over a vault that still fails quick_check must refuse');
    assert.equal(out.code, 'vault_corrupt', 'and it must refuse with vault_corrupt, not a generic boot error');
    rmSync(out.dir, { recursive: true, force: true });
  });

  await t('marker + vault whose quick_check THROWS → boot still refuses (fail CLOSED)', async () => {
    // THE REGRESSION THIS EXISTS FOR. quick_check does not always return rows — on bad
    // enough damage (a shredded page 1, the shape the 2026-07-26 vault was found in) it
    // THROWS. The first fix for the lockout folded that into "could not look" and let
    // boot continue; an adversarial review then wrote 3,840 rows — the production number
    // — into a vault this box had already condemned, through the real boot(). The three
    // cases above were all blind to it: their damaged fixture returns rows, so it lands
    // in the other branch entirely.
    const out = await bootCase('threw', (dbPath, dir) => {
      const db = new Database(dbPath);
      db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
      const ins = db.prepare('INSERT INTO t(v) VALUES (?)');
      db.transaction(() => { for (let i = 0; i < 100; i++) ins.run('x'.repeat(200) + i); })();
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      const fd = openSync(dbPath, 'r+'); writeSync(fd, Buffer.alloc(200, 0xff), 0, 200, 24); closeSync(fd);
      writeFileSync(join(dir, '.vault-corrupt'), JSON.stringify({ at: new Date(0).toISOString(), code: 'SQLITE_CORRUPT' }));
    });
    assert.equal(out.threw, true, 'a condemned vault whose quick_check THROWS must not be opened');
    assert.equal(out.code, 'vault_corrupt', 'and it must refuse as vault_corrupt');
    rmSync(out.dir, { recursive: true, force: true });
  });

  await t('marker + a vault that cannot be CHECKED (not proven damaged) → boot refuses', async () => {
    // THE ROUND-2 FIX'S ONLY GATE, and the first version of it proved nothing: its fixture
    // was a garbage text file, which dies ~40 lines earlier in boot at the KCV stage
    // (code: null), never reaching the marker branch at all. Re-introducing the exact
    // round-2 fail-open then left this gate at GO 21/0 — the headline fix of this branch,
    // silently revertible. Round-3 review.
    //
    // So the fixture must be a vault boot ACCEPTS up to the marker branch, whose
    // quick_check then returns an INCONCLUSIVE error rather than a corruption one.
    // chmod 000 gives SQLITE_CANTOPEN, which isCorruptionError() does not match — exactly
    // the `verified:false` path. Two phases: boot once clean so a real kcv.json exists,
    // then damage-by-permission and boot again.
    const dir = mkdtempSync(join(tmpdir(), 'fs-inconclusive-'));
    const dbPath = join(dir, 'mycelium.db');
    const first = await runBootChild(dir, dbPath);
    assert.equal(first.threw, false, `precondition: the first boot must succeed (${first.code || ''} ${String(first.msg).slice(0, 160)})`);
    assert.ok(existsSync(dbPath + '.kcv'), 'precondition: a real kcv.json must exist so boot reaches the marker branch');

    writeFileSync(join(dir, '.vault-corrupt'), JSON.stringify({ at: new Date(0).toISOString(), code: 'SQLITE_CORRUPT' }));
    chmodSync(dbPath, 0o000);
    try {
      const out = await runBootChild(dir, dbPath);
      assert.equal(out.threw, true, 'a condemned vault we cannot re-check must be refused, not opened');
      // THE DISCRIMINATOR. Asserting only "it threw" is what let the old fixture pass on an
      // unrelated KCV failure — the code is the proof it came from the marker branch.
      assert.equal(out.code, 'vault_corrupt', `and the refusal must come from the marker branch (got ${out.code}: ${String(out.msg).slice(0, 160)})`);
    } finally {
      try { chmodSync(dbPath, 0o600); } catch { /* */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t('AT-REST ON + a still-PLAINTEXT vault + marker → self-heals, does not brick', async () => {
    // THE CONFIGURATION THE APP ACTUALLY SHIPS. Every other fixture here blanks
    // MYCELIUM_AT_REST, and the real launch guard sets it to 1 — so this branch was gated
    // only in a configuration the product never runs. The marker gate executes BEFORE the
    // plaintext→cipher migration, so resolveDbKeyHex returned a derived key for a file
    // that is still plaintext, the keyed open answered SQLITE_NOTADB, and "inconclusive ⇒
    // refuse" bricked it permanently — for exactly the population this change set is for
    // (the 2026-07-26 vault was plaintext when it was condemned), with the self-heal branch
    // unreachable in production. Round-4 review.
    const dir = mkdtempSync(join(tmpdir(), 'fs-atrest-'));
    const dbPath = join(dir, 'mycelium.db');
    const first = await runBootChild(dir, dbPath, 'atrest-phase1');
    assert.equal(first.threw, false, 'precondition: a healthy plaintext vault boots');
    assert.ok(isPlaintextSqlite(dbPath), 'precondition: the fixture must still be PLAINTEXT');

    writeFileSync(join(dir, '.vault-corrupt'), JSON.stringify({ at: new Date(0).toISOString(), code: 'SQLITE_CORRUPT', db: 'mycelium.db' }));
    const out = await runBootChild(dir, dbPath, 'atrest-phase2', { MYCELIUM_AT_REST: '1' });
    assert.equal(out.threw, false,
      `a HEALTHY plaintext vault must self-heal its marker under at-rest, not brick (${out.code}: ${String(out.msg).slice(0, 200)})`);
    assert.ok(!existsSync(join(dir, '.vault-corrupt')), 'and the disproved marker must be cleared');
    rmSync(dir, { recursive: true, force: true });
  });

  await t('an UNREADABLE or empty marker is treated as condemnation, not as health', async () => {
    // readVaultCorruptMarker collapsed absent / empty / unreadable into null, so boot
    // skipped every branch and opened a condemned vault read/write. tripVaultHalt writes
    // the marker with a plain truncate-then-write, so a crash mid-write leaves the 0-byte
    // case exactly. Round-4 review.
    const dir = mkdtempSync(join(tmpdir(), 'fs-badmarker-'));
    const dbPath = join(dir, 'mycelium.db');
    const first = await runBootChild(dir, dbPath, 'badmarker-phase1');
    assert.equal(first.threw, false, 'precondition: the first boot must succeed');
    // damage it for real, then leave a ZERO-BYTE marker beside it
    copyFileSync(makePlainChimera('badmarker'), dbPath);
    writeFileSync(join(dir, '.vault-corrupt'), '');
    const out = await runBootChild(dir, dbPath, 'badmarker-phase2');
    assert.equal(out.threw, true, 'an empty marker must still condemn — it is presence, not parseability');
    assert.equal(out.code, 'vault_corrupt', `and refuse from the marker branch (got ${out.code}: ${String(out.msg).slice(0, 160)})`);
    rmSync(dir, { recursive: true, force: true });
  });

  await t('a marker naming a DIFFERENT file is not cleared by booting this one', async () => {
    // The marker path is dirname(dbPath)/.vault-corrupt — directory-scoped. Booting any
    // other db path in the same directory took the `absent` branch and deleted the
    // condemnation of the REAL vault, un-condemning it for every later boot. Round-4.
    const dir = mkdtempSync(join(tmpdir(), 'fs-otherdb-'));
    const marker = join(dir, '.vault-corrupt');
    const { writeVaultCorruptMarker } = await import('../src/db/integrity.js');
    writeVaultCorruptMarker(join(dir, 'mycelium.db'), { code: 'SQLITE_CORRUPT', source: 'runtime-query' });
    const out = await runBootChild(dir, join(dir, 'other.db'), 'otherdb');
    assert.equal(out.threw, false, 'booting an unrelated db in the same directory should proceed');
    assert.ok(existsSync(marker), "and must NOT clear a marker that names a different vault");
    rmSync(dir, { recursive: true, force: true });
  });

  await t('marker + EMPTY vault → refuse; an empty file is not a repair', async () => {
    // quick_check answers "ok" on a 0-byte SQLite file and sqlite_master is readable and
    // empty, so a condemned vault that got TRUNCATED (an interrupted install-vault copy,
    // ENOSPC, a failed restore) used to read as REPAIRED: the marker was cleared, the
    // owner was told "quick_check now passes (repaired or restored)", and boot wrote
    // 2.7 MB of fresh schema over it — destroying the -wal remnants a repair tool needs.
    // Measured with a 103 KB -wal holding 3,000 uncheckpointed rows still beside it.
    // Two phases so a real kcv.json exists and boot reaches the marker branch.
    const dir = mkdtempSync(join(tmpdir(), 'fs-empty-'));
    const dbPath = join(dir, 'mycelium.db');
    const first = await runBootChild(dir, dbPath, 'empty-phase1');
    assert.equal(first.threw, false, 'precondition: the first boot must succeed');
    const wal = readFileSync(dbPath).length;
    assert.ok(wal > 0, 'precondition: phase 1 wrote a real vault');

    writeFileSync(dbPath, ''); // truncate to zero — the file still exists
    writeFileSync(join(dir, '.vault-corrupt'), JSON.stringify({ at: new Date(0).toISOString(), code: 'SQLITE_CORRUPT' }));
    const out = await runBootChild(dir, dbPath, 'empty-phase2');
    assert.equal(out.threw, true, 'an empty condemned vault must NOT be treated as repaired');
    assert.equal(out.code, 'vault_corrupt', `and must refuse from the marker branch (got ${out.code}: ${String(out.msg).slice(0, 160)})`);
    assert.ok(existsSync(join(dir, '.vault-corrupt')), 'the marker must NOT be cleared by an empty file');
    assert.equal(readFileSync(dbPath).length, 0, 'and boot must not have written a fresh schema over it');
    rmSync(dir, { recursive: true, force: true });
  });

  await t('marker + REPAIRED vault → boot clears the flag and continues', async () => {
    const out = await bootCase('repaired', (dbPath, dir) => {
      const good = new Database(dbPath);
      good.exec('CREATE TABLE t(v)'); good.close();
      writeFileSync(join(dir, '.vault-corrupt'), JSON.stringify({ at: new Date(0).toISOString(), code: 'SQLITE_CORRUPT' }));
    });
    assert.equal(out.threw, false, 'a vault that now passes quick_check must self-heal the flag');
    assert.ok(!existsSync(join(out.dir, '.vault-corrupt')), 'the disproved marker must be cleared');
    rmSync(out.dir, { recursive: true, force: true });
  });
  await t("a marker in the SCHEDULED CHECKER's own format still condemns this vault", async () => {
    // The gate's other fixtures all write tripVaultHalt's shape, which carries `db`. The
    // app's automated condemnation path — src/db/integrity.js, spawned on a throttle at
    // every boot — wrote {at, detail} with NO db field, so marksThisFile (`!mark.db || …`)
    // was vacuously true for every path in the directory and the directory-scoping fix did
    // not apply to the primary writer at all. Measured before the fix: 2.3 MB written into
    // a condemned vault. The fixture format was itself the blind spot. Round-5 review.
    const dir = mkdtempSync(join(tmpdir(), 'fs-schedfmt-'));
    const dbPath = join(dir, 'mycelium.db');
    const first = await runBootChild(dir, dbPath, 'schedfmt-p1');
    assert.equal(first.threw, false, 'precondition: the first boot must succeed');
    copyFileSync(makePlainChimera('schedfmt'), dbPath);
    const before = statSync(dbPath).size;
    // Built by the PRODUCT'S OWN WRITER, not by this fixture. Hardcoding the JSON here is
    // what let the previous version pass while integrity.js emitted a different shape:
    // removing the `db` field from the product left this check green, because the fixture
    // was writing the field itself. A fixture that constructs the artefact under test is
    // testing itself. Round-5 review, third instance of this class on this branch.
    const { writeVaultCorruptMarker } = await import('../src/db/integrity.js');
    writeVaultCorruptMarker(dbPath, { detail: 'quick_check failed', source: 'scheduled-integrity' });
    assert.ok(existsSync(join(dir, '.vault-corrupt')), 'precondition: the product writer must have written a marker');
    const out = await runBootChild(dir, dbPath, 'schedfmt-p2');
    assert.equal(out.threw, true, "the scheduled checker's marker must condemn just as the latch's does");
    assert.equal(out.code, 'vault_corrupt', `and from the marker branch (got ${out.code}: ${String(out.msg).slice(0, 160)})`);
    assert.equal(statSync(dbPath).size, before, 'and nothing may be written to the condemned file');
    rmSync(dir, { recursive: true, force: true });
  });

  await t('a marker naming ANOTHER file still refuses a vault that is itself damaged', async () => {
    // The mismatch branch used to return early, discarding a verdict it had ALREADY
    // computed, so boot opened the file with no check. marksThisFile is a BASENAME test, so
    // any alias for the same inode defeated it — measured 2.3 MB written into a condemned
    // vault through a symlink. Naming now gates CLEARING only, never REFUSING.
    const dir = mkdtempSync(join(tmpdir(), 'fs-alias-'));
    const real = join(dir, 'mycelium.db');
    const first = await runBootChild(dir, real, 'alias-p1');
    assert.equal(first.threw, false, 'precondition: the first boot must succeed');
    copyFileSync(makePlainChimera('alias'), real);
    const alias = join(dir, 'vault.db');
    symlinkSync(real, alias);
    const before = statSync(real).size;
    writeFileSync(join(dir, '.vault-corrupt'), JSON.stringify({ at: new Date(0).toISOString(), code: 'SQLITE_CORRUPT', db: 'mycelium.db' }));
    const out = await runBootChild(dir, alias, 'alias-p2');
    assert.equal(out.threw, true, 'a damaged vault reached by another name must still be refused');
    assert.equal(out.code, 'vault_corrupt', `and from the marker branch (got ${out.code}: ${String(out.msg).slice(0, 160)})`);
    assert.equal(statSync(real).size, before, 'and nothing may be written through the alias');
    assert.ok(existsSync(join(dir, '.vault-corrupt')), "and it must not clear another file's marker");
    rmSync(dir, { recursive: true, force: true });
  });

  // ══ THE MARKER TRUTH TABLE ═════════════════════════════════════════════════════════
  // Six review rounds each found a defect in this decision, and every one was an UNHANDLED
  // COMBINATION that fell into a permissive branch. The branches were individually right;
  // the state space was never enumerated. This is the fix for the CLASS: the decision is a
  // pure total function over two declared axes, and the full cartesian product is tabled
  // here. A new state on either axis fails this gate until it has a row.
  {
    const { decideMarkerAction, MARKER_KINDS, VERDICT_KINDS, markerKind, verdictKind } =
      await import('../src/db/vault-halt.js');

    // marker kind × verdict kind → [action, clearMarker]
    const TABLE = {
      'none/ok':                     ['BOOT', false],
      'none/absent':                 ['BOOT', false],
      'none/empty':                  ['BOOT', false],
      'none/damaged':                ['BOOT', false],
      'none/inconclusive':           ['BOOT', false],
      'owns-this-file/ok':           ['BOOT', true],   // proven healthy → clear ours
      'owns-this-file/absent':       ['BOOT', true],   // file gone → clear, boot fresh
      'owns-this-file/empty':        ['REFUSE', false], // truncated ≠ repaired
      'owns-this-file/damaged':      ['REFUSE', false],
      'owns-this-file/inconclusive': ['REFUSE', false], // could not disprove ⇒ do not write
      'names-other-file/ok':         ['BOOT', false],  // healthy, but not ours to clear
      'names-other-file/absent':     ['BOOT', false],
      'names-other-file/empty':      ['REFUSE', false], // the verdict is about THIS file
      'names-other-file/damaged':    ['REFUSE', false],
      'names-other-file/inconclusive': ['REFUSE', false],
    };

    // Fixtures that produce each verdict KIND, so the axis is not a fiction.
    const VERDICTS = {
      ok: { ok: true, verified: true, reason: 'ok' },
      absent: { ok: false, verified: true, absent: true, reason: 'gone' },
      empty: { ok: false, verified: true, empty: true, reason: 'empty' },
      damaged: { ok: false, verified: true, reason: 'quick_check: …' },
      inconclusive: { ok: false, verified: false, reason: 'could not verify (SQLITE_BUSY)' },
    };
    const MARKS = {
      none: null,
      'owns-this-file': { at: 'x', db: 'mycelium.db' },
      'names-other-file': { at: 'x', db: 'other.db' },
    };

    await t('the marker truth table COVERS every marker-kind × verdict-kind pair', async () => {
      const missing = [];
      for (const mk of MARKER_KINDS) {
        for (const vk of VERDICT_KINDS) {
          if (!(`${mk}/${vk}` in TABLE)) missing.push(`${mk}/${vk}`);
        }
      }
      assert.equal(missing.length, 0,
        `un-tabled combination(s): ${missing.join(', ')}. A new state on either axis must be `
        + 'given a row here — that is the whole point of this table.');
      // …and no stale rows either: a row for a kind that no longer exists is a decision
      // nobody is making any more, which is how a table rots into decoration.
      const stale = Object.keys(TABLE).filter((k) => {
        const [mk, vk] = k.split('/');
        return !MARKER_KINDS.includes(mk) || !VERDICT_KINDS.includes(vk);
      });
      assert.equal(stale.length, 0, `stale row(s) for kinds that no longer exist: ${stale.join(', ')}`);
      assert.equal(Object.keys(TABLE).length, MARKER_KINDS.length * VERDICT_KINDS.length,
        'the table must be exactly the cartesian product — no more, no less');
    });

    await t('every tabled combination decides exactly as the table says', async () => {
      const wrong = [];
      for (const mk of MARKER_KINDS) {
        for (const vk of VERDICT_KINDS) {
          const [wantAction, wantClear] = TABLE[`${mk}/${vk}`];
          const got = decideMarkerAction({ mark: MARKS[mk], verdict: VERDICTS[vk], dbFile: 'mycelium.db' });
          if (got.action !== wantAction || got.clearMarker !== wantClear) {
            wrong.push(`${mk}/${vk}: want ${wantAction}/clear=${wantClear}, got ${got.action}/clear=${got.clearMarker}`);
          }
        }
      }
      assert.equal(wrong.length, 0, `\n      ${wrong.join('\n      ')}`);
    });

    await t('the classifiers really produce each declared kind (the axes are not fiction)', async () => {
      // The table is only worth anything if the product actually emits these kinds. Verdict
      // kinds are proven against REAL on-disk fixtures through the REAL verify function;
      // marker kinds against markers written by the PRODUCT's own writer.
      const { writeVaultCorruptMarker } = await import('../src/db/integrity.js');
      const d = mkdtempSync(join(tmpdir(), 'fs-kinds-'));

      const gone = join(d, 'gone.db');
      assert.equal(verdictKind(halt.verifyVaultIntegritySync(gone, null)), 'absent', 'absent must be reachable');

      const empty = join(d, 'empty.db'); writeFileSync(empty, '');
      assert.equal(verdictKind(halt.verifyVaultIntegritySync(empty, null)), 'empty', 'empty must be reachable');

      const good = join(d, 'good.db');
      { const db = new Database(good); db.exec('CREATE TABLE t(v)'); db.close(); }
      assert.equal(verdictKind(halt.verifyVaultIntegritySync(good, null)), 'ok', 'ok must be reachable');

      const bad = join(d, 'bad.db'); copyFileSync(makePlainChimera('kinds'), bad);
      assert.equal(verdictKind(halt.verifyVaultIntegritySync(bad, null)), 'damaged', 'damaged must be reachable');

      // inconclusive: unreadable for a NON-corruption reason
      const locked = join(d, 'locked.db');
      { const db = new Database(locked); db.exec('CREATE TABLE t(v)'); db.close(); }
      chmodSync(locked, 0o000);
      const lk = verdictKind(halt.verifyVaultIntegritySync(locked, null));
      chmodSync(locked, 0o600);
      assert.equal(lk, 'inconclusive', 'inconclusive must be reachable');

      // marker kinds, via the product's writer
      const mdir = mkdtempSync(join(tmpdir(), 'fs-kinds-m-'));
      const mine = join(mdir, 'mycelium.db'); writeFileSync(mine, '');
      writeVaultCorruptMarker(mine, { code: 'SQLITE_CORRUPT', source: 'runtime-query' });
      const m = halt.readVaultCorruptMarker(mine);
      assert.equal(markerKind(m, 'mycelium.db'), 'owns-this-file', 'owns-this-file must be reachable');
      assert.equal(markerKind(m, 'other.db'), 'names-other-file', 'names-other-file must be reachable');
      assert.equal(markerKind(halt.readVaultCorruptMarker(join(d, 'no-marker.db')), 'x.db'), 'none', 'none must be reachable');

      // THE `!mark.db` FALLBACK. Both table fixtures carry `db`, so this path — legacy
      // markers from builds before the field existed, and the unreadable-marker sentinel —
      // was reachable only through the older behavioural checks. Round-7 review found that
      // flipping the fallback REDs those and never the table, so if they were ever removed
      // the table alone would not notice.
      for (const legacy of [{ at: 'x' }, { source: 'integrity-check' }, { source: 'unreadable-marker', unreadable: true }]) {
        assert.equal(markerKind(legacy, 'mycelium.db'), 'owns-this-file',
          `a marker with no db field must own this file (safe for REFUSING): ${JSON.stringify(legacy)}`);
      }

      rmSync(d, { recursive: true, force: true });
      rmSync(mdir, { recursive: true, force: true });
    });

    await t('every DECLARED verdict kind has a reachable fixture and is decided without throwing', async () => {
      // This is the check that makes adding a state expensive in the right way. Add a kind
      // to VERDICT_KINDS and three things fail until you finish the job: the coverage test
      // (no table row), this one (no fixture), and the switch's default (no case). The
      // failure mode behind all six review rounds was a new state quietly taking a
      // permissive path; it now cannot be added quietly at all.
      const noFixture = VERDICT_KINDS.filter((k) => !(k in VERDICTS));
      assert.equal(noFixture.length, 0,
        `verdict kind(s) with no fixture: ${noFixture.join(', ')} — a kind nobody can construct is a kind nobody has tested`);
      for (const vk of VERDICT_KINDS) {
        assert.equal(verdictKind(VERDICTS[vk]), vk, `the fixture for "${vk}" must actually classify as "${vk}"`);
        for (const mk of MARKER_KINDS) {
          assert.doesNotThrow(
            () => decideMarkerAction({ mark: MARKS[mk], verdict: VERDICTS[vk], dbFile: 'mycelium.db' }),
            `${mk}/${vk} must be decided, not thrown on`,
          );
        }
      }
      // HONEST LIMIT: the switch's `default:` throw is a backstop this gate cannot reach,
      // because verdictKind() is total by construction — it always returns one of the five.
      // It exists for the case where someone widens verdictKind and forgets the switch, and
      // the two assertions above are what actually catch that. Stated rather than implied.
    });
  }

  await t('END TO END: a condemned vault reaches the portal as bootError=vault_corrupt', async () => {
    // THE JOIN NOBODY ASSERTED. The chain is: boot() throws {code:'vault_corrupt'} →
    // classifyBootError → status.bootError → the setup page routes to mode='damaged'.
    // Both ENDS were tested and the JOIN was not: classifyBootError was only ever fed
    // HAND-BUILT errors the product never throws on this path (a message containing
    // "database disk image is malformed"), while the real error carries no SQLite
    // signature at all and classifies solely via the `err?.code === 'vault_corrupt'`
    // clause — which no check exercised. Deleting that one clause made every condemned
    // vault report boot_failed, which the portal routes to the paste-your-recovery-key
    // screen: THE ENTIRE REPORTED 2026-07-26 SYMPTOM, restored, at 33 passed / 0 failed.
    // The portal half was simulated too — the mount harness builds {bootError:'vault_corrupt'}
    // itself — so neither end could notice the middle going missing.
    // Fourth instance of "the fixture does not exercise what the product does". Round-6.
    const dir = mkdtempSync(join(tmpdir(), 'fs-e2e-'));
    const dbPath = join(dir, 'mycelium.db');
    const first = await runBootChild(dir, dbPath, 'e2e-p1');
    assert.equal(first.threw, false, 'precondition: the first boot must succeed');
    copyFileSync(makePlainChimera('e2e'), dbPath);
    // the PRODUCT's writer, not a hand-built marker
    const { writeVaultCorruptMarker } = await import('../src/db/integrity.js');
    writeVaultCorruptMarker(dbPath, { code: 'SQLITE_CORRUPT', source: 'runtime-query' });

    // The KCV and the keys must be the SAME ones phase 1 established, or boot fails for an
    // unrelated reason and reports boot_failed — which would look exactly like the defect.
    const saved = { s: process.env.MYCELIUM_KEY_SOURCE, u: process.env.USER_MASTER_KEY, y: process.env.SYSTEM_KEY, e: process.env.MYCELIUM_DISABLE_EMBED };
    process.env.MYCELIUM_KEY_SOURCE = 'env';
    process.env.USER_MASTER_KEY = USER_MASTER_HEX;
    process.env.SYSTEM_KEY = SYSTEM_HEX;
    process.env.MYCELIUM_DISABLE_EMBED = '1';
    const { startRestServer } = await import('../src/server-rest.js');
    const srv = await startRestServer({ port: 0, host: '127.0.0.1', dbPath, kcvPath: `${dbPath}.kcv` });
    try {
      const body = await (await fetch(`${srv.url}/api/v1/account/status`)).json();
      // POSITIVE PRECONDITION: the server must have tried and failed to open this vault.
      assert.ok(body.bootError, `precondition: boot must have failed (status=${JSON.stringify(body).slice(0, 200)})`);
      assert.equal(body.bootError, 'vault_corrupt',
        `a condemned vault must surface as vault_corrupt, not "${body.bootError}" — the portal routes anything else to the recovery-key screen`);
    } finally {
      try { await new Promise((r) => srv.server.close(r)); } catch { /* */ }
      try { srv.close?.(); } catch { /* */ }
      for (const [k, v] of [['MYCELIUM_KEY_SOURCE', saved.s], ['USER_MASTER_KEY', saved.u], ['SYSTEM_KEY', saved.y], ['MYCELIUM_DISABLE_EMBED', saved.e]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t('a marker body that PARSES to a falsy value still condemns', async () => {
    // readVaultCorruptMarker special-cased an empty body but returned JSON.parse() raw, so
    // `null`, `0`, `false` and `""` parsed to falsy values, `if (mark)` skipped the entire
    // gate, and boot opened the condemned vault — 2.27 MB written, measured, for four of
    // the five falsy shapes, with "presence is the signal, not parseability" written four
    // lines above. Round-6 review.
    for (const body of ['null', '0', 'false', '""']) {
      const dir = mkdtempSync(join(tmpdir(), 'fs-falsy-'));
      const dbPath = join(dir, 'mycelium.db');
      const first = await runBootChild(dir, dbPath, `falsy-p1-${body}`);
      assert.equal(first.threw, false, 'precondition: the first boot must succeed');
      copyFileSync(makePlainChimera(`falsy${body.replace(/\W/g, '')}`), dbPath);
      const before = statSync(dbPath).size;
      writeFileSync(join(dir, '.vault-corrupt'), body);
      const out = await runBootChild(dir, dbPath, `falsy-p2-${body}`);
      assert.equal(out.threw, true, `a marker body of ${body} must still condemn`);
      assert.equal(out.code, 'vault_corrupt', `and refuse from the marker branch for ${body} (got ${out.code})`);
      assert.equal(statSync(dbPath).size, before, `and write nothing into the condemned vault for ${body}`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── A HEALTHY VAULT WITH A STALE FOREIGN -wal MUST BOOT ───────────────────────────
  // The restore/rebuild/install-vault shape: a good vault swapped in while a -wal from the
  // PREVIOUS file generation is still beside it — this repo's documented #1 corruption
  // vector (wal-guard.js:4-14). SQLite reads the good file THROUGH that WAL and answers
  // SQLITE_NOTADB, so an integrity gate that runs before the WAL guard cannot verify it and
  // — correctly refusing to rewrite what it cannot read — CONDEMNS IT. Reproduced 3/3 by an
  // adversarial review on a vault whose pristine copy probes `quick_check ok, 671 pages`,
  // and every later boot then refused with "the condemnation could not be re-checked",
  // because the -wal was never quarantined so it never could be. A permanent brick, on the
  // exact recovery path the refusal message recommends.
  //
  // verify:wal-guard could not see it: it calls guardAgainstForeignWal() directly and greps
  // init.js for the string. It proves the guard works when called; it never proved boot
  // REACHES it. The recurring class once more — the fixture calls the function instead of
  // exercising the product's call site — so this row boots the real thing.
  await t('a HEALTHY vault + a stale FOREIGN -wal boots (the guard runs before any integrity opinion)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-foreignwal-'));
    const dbPath = join(dir, 'mycelium.db');
    const first = await runBootChild(dir, dbPath, 'foreignwal-p1', { MYCELIUM_AT_REST: '1' });
    assert.equal(first.threw, false, `precondition: the first boot must succeed (${first.code}: ${String(first.msg).slice(0, 160)})`);
    const healthy = statSync(dbPath).size;
    // A GENUINE previous-generation -wal, not synthetic bytes. The first version of this
    // fixture wrote a hand-made 64 KB buffer with WAL magic, and it SURVIVED the mutation
    // that un-hoists the guard — green for the wrong reason, in the row written to catch
    // exactly that. SQLite discards a WAL whose salt/checksums do not match instead of
    // reading through it, so nothing was ever contaminated.
    //
    // The real shape: boot a SECOND vault, take its hot (uncheckpointed) -wal, and leave
    // that beside this one. Now the sidecar is a valid WAL from a different file
    // generation — the restore/rebuild/install-vault case wal-guard.js exists for.
    // 1. Give THIS vault a hot, uncheckpointed -wal, then abandon it (the crash shape).
    const { deriveDbKey } = await import('../src/account/keystore.js');
    const key = deriveDbKey(USER_MASTER_HEX);
    const live = new Database(dbPath);
    live.pragma(`cipher='sqlcipher'`);
    live.pragma(`key="x'${key}'"`);
    live.pragma('journal_mode = WAL');
    live.pragma('wal_autocheckpoint = 0');
    live.exec('CREATE TABLE IF NOT EXISTS foreign_probe(id INTEGER PRIMARY KEY, v TEXT)');
    const ins = live.prepare('INSERT INTO foreign_probe (v) VALUES (?)');
    for (let i = 0; i < 400; i++) ins.run(`gen1-${i}`);
    assert.ok(existsSync(`${dbPath}-wal`) && statSync(`${dbPath}-wal`).size > 0,
      'precondition: generation 1 must leave a NON-EMPTY -wal, or the fixture tests nothing');
    const staleWal = readFileSync(`${dbPath}-wal`);
    try { live.close(); } catch { /* */ }

    // 2. SWAP A DIFFERENT HEALTHY VAULT IN — the restore / rebuild / install-vault move —
    //    and put generation 1's -wal back beside it. THIS is the documented vector: the
    //    file was replaced while a stale sidecar from the previous generation remained.
    const other = join(dir, 'other');
    mkdirSync(other, { recursive: true });
    const otherDb = join(other, 'mycelium.db');
    const o = await runBootChild(other, otherDb, 'foreignwal-donor', { MYCELIUM_AT_REST: '1' });
    assert.equal(o.threw, false, `precondition: the replacement vault must boot (${o.code}: ${String(o.msg).slice(0, 160)})`);
    copyFileSync(otherDb, dbPath);
    writeFileSync(`${dbPath}-wal`, staleWal);
    assert.ok(statSync(`${dbPath}-wal`).size > 0, 'precondition: the stale foreign -wal must be in place');
    const out = await runBootChild(dir, dbPath, 'foreignwal-p2', { MYCELIUM_AT_REST: '1' });
    assert.equal(out.threw, false,
      `a HEALTHY vault must boot despite a stale foreign -wal — condemning it is a permanent brick on the restore path (${out.code}: ${String(out.msg).slice(0, 240)})`);
    assert.ok(!existsSync(join(dir, '.vault-corrupt')),
      'and it must NOT be condemned: the marker outlives the boot and every later one refuses');
    assert.ok(statSync(dbPath).size >= healthy, 'and the vault must still be there');
    // …AND THE GUARD MUST HAVE QUARANTINED, NOT MERELY "NOT BRICKED".
    // Without these three, a guard that simply unlinkSync'd the -wal — or one that let
    // SQLite replay it into a chimera that still boots — keeps this row green. "Quarantine,
    // never delete" (wal-guard.js:22) was held only by verify:wal-guard's unit rows, which
    // call the guard directly; this row exists to close that product-vs-fixture split, so
    // it has to assert the outcome and not just the absence of disaster.
    const aside = readdirSync(dir).filter((f) => f.startsWith('mycelium.db-wal') && f !== 'mycelium.db-wal');
    assert.ok(aside.length > 0,
      `the foreign -wal must be QUARANTINED aside, not deleted and not replayed (dir: ${readdirSync(dir).join(', ')})`);
    assert.ok(!existsSync(`${dbPath}-wal`) || statSync(`${dbPath}-wal`).size === 0,
      'and it must no longer be beside the vault where SQLite would replay it');
    // The replacement vault must be intact and must NOT carry generation 1's rows — that
    // would mean the foreign frames were replayed into it, which is the corruption itself.
    const check = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      check.pragma(`cipher='sqlcipher'`);
      check.pragma(`key="x'${key}'"`);
      assert.equal(check.pragma('quick_check').map((r) => r.quick_check ?? r).join('|'), 'ok',
        'the swapped-in vault must still be structurally sound after the guard ran');
      const leaked = check.prepare("SELECT count(*) c FROM sqlite_master WHERE name='foreign_probe'").get().c;
      assert.equal(leaked, 0,
        "generation 1's table must NOT appear in the replacement vault — if it does, the foreign WAL was replayed and this is the chimera the guard exists to prevent");
    } finally { try { check.close(); } catch { /* */ } }
  });

  // MUTATION-TESTED 2026-07-29 (the row above):
  //   un-hoisting guardAgainstForeignWal back below the D-117 gate → RED (50/1)
  //   removing the unconditional recordVaultBinding                → RED (50/1)
  //   quarantine → delete (`renameSync(f,q)` → `unlinkSync(f)`)    → RED (50/1), on the
  //     `aside.length > 0` assertion specifically. That is the teeth for "quarantine,
  //     NEVER delete" (wal-guard.js:22) at the PRODUCT's call site; verify:wal-guard also
  //     REDs (11/1), but only through its own direct call to the guard.
  //
  // ⚠️ HONEST LIMIT OF THE OTHER THREE NEW ASSERTIONS. `!existsSync(-wal)`, `quick_check
  // ok` and `foreign_probe absent` have NO demonstrated failing mutation, and the claim
  // that they catch "a guard that let SQLite replay the WAL into a chimera that still
  // boots" is NOT producible here: against a raw-key SQLCipher vault, replayed gen-1 pages
  // fail their HMAC against gen-2's salt, so a replay always surfaces as SQLITE_NOTADB and
  // the PRE-EXISTING `threw === false` assertion catches it first. They are belt, not
  // teeth, and are kept as cheap insurance against a future plaintext or
  // different-cipher path — recorded as such rather than left to read as proven.
  // ⚠️ The FIRST version of this row was green under BOTH of those — a hand-made 64 KB
  // buffer with WAL magic, which SQLite discards on a salt mismatch instead of reading
  // through. Green for the wrong reason, in the row written to catch exactly that. The
  // fixture now takes a REAL generation-1 -wal and swaps a REAL second vault in.

  // ── THE PROBE MUST NOT DESTROY WHAT IT IS PROTECTING ──────────────────────────────
  // The `empty` verdict exists to stop a truncated vault being re-created over, because a
  // -wal beside it may hold the only recoverable pages — the incident it cites had 3,000
  // uncheckpointed rows in a 103 KB -wal. Measured 2026-07-29: opening that 0-byte vault
  // read-only DELETED the -wal (105,472 bytes before, absent after). The probe was
  // destroying the evidence. Both integrity readers now classify a 0-byte file by stat.
  await t('the 0-byte probe does NOT delete the -wal beside it (it is the only recoverable data)', async () => {
    const halt = await import('../src/db/vault-halt.js');
    for (const [label, probe] of [
      ['vaultLooksStructurallySane', (p) => halt.vaultLooksStructurallySane(p, null)],
      ['verifyVaultIntegritySync', (p) => halt.verifyVaultIntegritySync(p, null)],
    ]) {
      const d = mkdtempSync(join(tmpdir(), 'fs-walkeep-'));
      const p = join(d, 'mycelium.db');
      writeFileSync(p, '');
      writeFileSync(`${p}-wal`, Buffer.alloc(103 * 1024, 7));
      const sizeBefore = statSync(`${p}-wal`).size;
      const verdict = probe(p);
      assert.ok(existsSync(`${p}-wal`),
        `${label}: the -wal was DELETED by the probe — those pages are the only thing a repair tool could recover`);
      assert.equal(statSync(`${p}-wal`).size, sizeBefore, `${label}: the -wal was modified by the probe`);
      // …and it still has to give the right answer, or this row would pass by not looking.
      const empty = verdict.empty === true || verdict.sane === false;
      assert.ok(empty, `${label}: must still classify a 0-byte vault as empty (got ${JSON.stringify(verdict)})`);
      rmSync(d, { recursive: true, force: true });
    }
  });

  // ── THE SAME CONTRACT, IN THE CONFIGURATION THE APP ACTUALLY SHIPS ────────────────
  // Three of four adversarial review rounds found the same class: the fixture exercised a
  // configuration the product never runs. Round 3 — the fixture died before reaching the
  // branch. Round 4 — every marker fixture forced MYCELIUM_AT_REST='' while the real
  // launch guard (src/index.js) sets it to 1, so a permanent brick for every plaintext
  // vault was invisible. One blind spot, several faces. So the contract is now asserted
  // under BOTH configurations rather than the convenient one.
  for (const [label, env] of [['at-rest OFF', { MYCELIUM_AT_REST: '' }], ['at-rest ON', { MYCELIUM_AT_REST: '1' }]]) {
    await t(`[${label}] marker + vault GONE → clears the stale flag, boots fresh`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fs-matrix-gone-'));
      const dbPath = join(dir, 'mycelium.db');
      writeFileSync(join(dir, '.vault-corrupt'), JSON.stringify({ at: new Date(0).toISOString(), code: 'SQLITE_CORRUPT', db: 'mycelium.db' }));
      const out = await runBootChild(dir, dbPath, `matrix-gone-${label}`, env);
      assert.equal(out.threw, false, `must not refuse when the vault is gone (${out.code}: ${String(out.msg).slice(0, 160)})`);
      assert.ok(existsSync(dbPath), 'a fresh vault must be created');
      assert.ok(!existsSync(join(dir, '.vault-corrupt')), 'the stale marker must be cleared');
      rmSync(dir, { recursive: true, force: true });
    });

    await t(`[${label}] marker + HEALTHY vault → self-heals the flag`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fs-matrix-ok-'));
      const dbPath = join(dir, 'mycelium.db');
      const first = await runBootChild(dir, dbPath, `matrix-ok-p1-${label}`, env);
      assert.equal(first.threw, false, `precondition: a healthy vault boots (${first.code}: ${String(first.msg).slice(0, 160)})`);
      writeFileSync(join(dir, '.vault-corrupt'), JSON.stringify({ at: new Date(0).toISOString(), code: 'SQLITE_CORRUPT', db: 'mycelium.db' }));
      const out = await runBootChild(dir, dbPath, `matrix-ok-p2-${label}`, env);
      assert.equal(out.threw, false,
        `a HEALTHY vault must self-heal its marker, not brick (${out.code}: ${String(out.msg).slice(0, 200)})`);
      assert.ok(!existsSync(join(dir, '.vault-corrupt')), 'the disproved marker must be cleared');
      rmSync(dir, { recursive: true, force: true });
    });

    await t(`[${label}] marker + DAMAGED vault → still refuses`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fs-matrix-bad-'));
      const dbPath = join(dir, 'mycelium.db');
      const first = await runBootChild(dir, dbPath, `matrix-bad-p1-${label}`, env);
      assert.equal(first.threw, false, 'precondition: the first boot must succeed');
      copyFileSync(makePlainChimera(`matrix-bad-${label.replace(/\W/g, '')}`), dbPath);
      writeFileSync(join(dir, '.vault-corrupt'), JSON.stringify({ at: new Date(0).toISOString(), code: 'SQLITE_CORRUPT', db: 'mycelium.db' }));
      const out = await runBootChild(dir, dbPath, `matrix-bad-p2-${label}`, env);
      assert.equal(out.threw, true, 'a damaged condemned vault must be refused');
      assert.equal(out.code, 'vault_corrupt', `and from the marker branch (got ${out.code}: ${String(out.msg).slice(0, 160)})`);
      rmSync(dir, { recursive: true, force: true });
    });

    // ── D-117 — THE FIRST-ENCOUNTER CASE ──────────────────────────────────────────
    // MUTATION-TESTED 2026-07-29 (each mutation grep'd back off disk + `node --check`ed):
    //   removing the assertVaultSafeToRewrite call from initVaultStorage → all 4 D-117
    //     rows RED (41/4)
    //   `if (false && shallow.sane === false)`  (tier 1 blinded) → ONLY the 2 TRUNCATED
    //     rows RED (43/2)
    //   `if (false && isPlaintextSqlite(dbPath))` (tier 2 blinded) → ONLY the 2 DAMAGED
    //     rows RED (43/2)
    //   tier 2 scoped back to `atRestEnabled() && isPlaintext` (the scoping an adversarial
    //     review REFUTED by writing 2,273,280 bytes into a damaged encrypted vault)
    //                                          → both ENCRYPTED rows + 1 plaintext row RED (47/3)
    //   the 0-byte evidence check removed      → both 0-byte-fresh rows RED (48/2)
    //   the 0-byte probes open the file again  → the -wal row + both TRUNCATED rows RED (47/3)
    // The separation is the point: each tier has a row that fails when THAT tier is
    // blinded and no other. A single fixture covering both would have let either half be
    // deleted silently.
    // Everything above needs a marker to already exist, and the marker is only written
    // when THIS box saw the damage happen. A vault damaged while the app was CLOSED
    // arrives with none — which is how most corruption is actually met. Measured before
    // the fix: 147,456 → 2,891,776 bytes, no marker, no snapshot, and the portal then
    // told the owner "Nothing has been deleted or overwritten".
    await t(`[${label}] NO marker + DAMAGED vault → refuses and writes NOTHING (D-117)`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fs-firstenc-bad-'));
      const dbPath = join(dir, 'mycelium.db');
      const first = await runBootChild(dir, dbPath, `firstenc-p1-${label}`, env);
      assert.equal(first.threw, false, 'precondition: the first boot must succeed');
      copyFileSync(makePlainChimera(`firstenc-${label.replace(/\W/g, '')}`), dbPath);
      assert.ok(!existsSync(join(dir, '.vault-corrupt')), 'precondition: there must be NO marker — that is the whole case');
      const before = statSync(dbPath).size;
      const out = await runBootChild(dir, dbPath, `firstenc-p2-${label}`, env);
      assert.equal(out.threw, true,
        `a damaged vault with no marker must be refused, not rewritten (${out.code}: ${String(out.msg).slice(0, 200)})`);
      assert.equal(out.code, 'vault_corrupt', `and as vault_corrupt (got ${out.code})`);
      assert.equal(statSync(dbPath).size, before,
        `and NOTHING may be written into it — this is the byte count D-117 was filed for (was ${before}, now ${statSync(dbPath).size})`);
      assert.ok(existsSync(join(dir, '.vault-corrupt')),
        'and it must be condemned durably, so the next boot refuses through the marker branch with its UI');
      rmSync(dir, { recursive: true, force: true });
    });

    // ⚠️ THE ROW THAT WAS MISSING, AND THE REASON THE FIRST FIX SHIPPED THE DEFECT.
    //
    // Both D-117 rows above use makePlainChimera, so under the `at-rest ON` label the LABEL
    // says at-rest-ON while the FILE UNDER TEST IS PLAINTEXT. The product ships ciphertext.
    // An adversarial review pointed the gate's own encrypted chimera builder at this path
    // and boot wrote 2,273,280 bytes into a damaged vault — D-117's own number — on the
    // commit that closed D-117, with no vault_corrupt code and no marker.
    //
    // That is the class this gate's header names four times: the fixture did not exercise
    // what the product does. It is recorded here rather than quietly fixed, because the
    // mutation record for the plaintext rows was TRUE and still proved nothing about the
    // configuration users run.
    await t(`[${label}] NO marker + damaged ENCRYPTED vault → refuses and writes NOTHING (D-117)`, async () => {
      const { deriveDbKey } = await import('../src/account/keystore.js');
      const dir = mkdtempSync(join(tmpdir(), 'fs-firstenc-enc-'));
      const dbPath = join(dir, 'mycelium.db');
      // at-rest ON for the FIRST boot regardless of the label, so the vault under test is
      // genuinely ciphertext. An encrypted vault self-detects and opens keyed either way.
      const first = await runBootChild(dir, dbPath, `firstenc-enc-p1-${label}`, { MYCELIUM_AT_REST: '1' });
      assert.equal(first.threw, false, `precondition: the first boot must succeed (${first.code}: ${String(first.msg).slice(0, 160)})`);
      const magic = Buffer.alloc(16);
      const fd = openSync(dbPath, 'r'); readSync(fd, magic, 0, 16, 0); closeSync(fd);
      assert.notEqual(magic.toString('latin1'), 'SQLite format 3\0',
        'precondition: the vault under test must be CIPHERTEXT — a plaintext file here would make this row a duplicate of the one above, which is exactly how the hole survived');
      copyFileSync(makeChimera(`firstenc-enc-${label.replace(/\W/g, '')}`, deriveDbKey(USER_MASTER_HEX)), dbPath);
      assert.ok(!existsSync(join(dir, '.vault-corrupt')), 'precondition: there must be NO marker');
      const before = statSync(dbPath).size;
      const out = await runBootChild(dir, dbPath, `firstenc-enc-p2-${label}`, { MYCELIUM_AT_REST: '1' });
      assert.equal(out.threw, true,
        `a damaged ENCRYPTED vault with no marker must be refused (${out.code}: ${String(out.msg).slice(0, 200)})`);
      assert.equal(out.code, 'vault_corrupt',
        `and as vault_corrupt — a generic code routes the owner to the paste-your-recovery-key screen (got ${out.code}: ${String(out.msg).slice(0, 160)})`);
      assert.equal(statSync(dbPath).size, before,
        `and NOTHING may be written into it (was ${before}, now ${statSync(dbPath).size})`);
      assert.ok(existsSync(join(dir, '.vault-corrupt')), 'and it must be condemned durably');
      rmSync(dir, { recursive: true, force: true });
    });

    // D5 — AN EMPTY VAULT WITH NO HISTORY IS A FRESH START, NOT DAMAGE.
    // ensureVaultSchema creates the file and only then applies migrations, so a crash in
    // that window leaves a brand-new user with a 0-byte vault. The first draft of the
    // first-encounter gate condemned it permanently and told them to restore a snapshot
    // that cannot exist. Three of this repo's shipped bricks are that shape.
    await t(`[${label}] 0-byte vault with NO history → boots fresh, is NOT condemned`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fs-firstenc-virgin-'));
      const dbPath = join(dir, 'mycelium.db');
      writeFileSync(dbPath, '');   // the interrupted-first-launch shape: no -wal, no snapshots, no history
      const out = await runBootChild(dir, dbPath, `firstenc-virgin-${label}`, env);
      assert.equal(out.threw, false,
        `a 0-byte vault that never held data must initialise, not condemn (${out.code}: ${String(out.msg).slice(0, 200)})`);
      assert.ok(!existsSync(join(dir, '.vault-corrupt')),
        'and it must NOT leave a marker telling the owner to restore a snapshot that cannot exist');
      assert.ok(statSync(dbPath).size > 0, 'and the vault must actually have been initialised');
      rmSync(dir, { recursive: true, force: true });
    });

    // TIER 1 GETS ITS OWN ROW. The chimera above is caught by the deep quick_check, so on
    // its own it proves nothing about the cheap check that runs on EVERY boot. A truncated
    // vault is the tier-1 shape: an interrupted copy, ENOSPC, a half-finished restore. It
    // carries no SQLite magic, so the deep branch is skipped entirely and only tier 1 can
    // refuse it. Without this row, blanking tier 1 survives the whole gate.
    await t(`[${label}] NO marker + TRUNCATED vault → refuses (tier 1, no deep check runs)`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fs-firstenc-trunc-'));
      const dbPath = join(dir, 'mycelium.db');
      const first = await runBootChild(dir, dbPath, `firstenc-trunc-p1-${label}`, env);
      assert.equal(first.threw, false, 'precondition: the first boot must succeed');
      writeFileSync(dbPath, ''); // 0 bytes — passes vacuously through anything that only asks "does it open?"
      // …AND a non-empty -wal beside it. That is not decoration, it is the difference
      // between the two 0-byte states. vault-halt.js:277-284 records the real incident this
      // verdict was written for: "a 103 KB -wal holding 3,000 uncheckpointed rows still
      // beside it". Those pages are the only thing a repair tool could recover, and
      // re-creating the schema destroys them.
      //
      // A 0-byte vault with NO -wal, no snapshots and no binding has nothing left to
      // preserve — refusing there protects nothing and only blocks a new user from ever
      // starting (the row above). So the fixture must carry the evidence that makes this
      // case a truncation rather than a fresh start, or it is testing the other case.
      writeFileSync(`${dbPath}-wal`, Buffer.alloc(103 * 1024, 7));
      assert.equal(statSync(dbPath).size, 0, 'precondition: the fixture must actually be truncated');
      assert.ok(statSync(`${dbPath}-wal`).size > 0, 'precondition: the -wal that makes this recoverable must exist');
      const out = await runBootChild(dir, dbPath, `firstenc-trunc-p2-${label}`, env);
      assert.equal(out.threw, true,
        `a truncated vault must be refused, not re-created over (${out.code}: ${String(out.msg).slice(0, 200)})`);
      assert.equal(out.code, 'vault_corrupt', `and as vault_corrupt (got ${out.code})`);
      assert.equal(statSync(dbPath).size, 0,
        'and NOTHING may be written over it — a -wal beside it may be the only surviving copy');
      rmSync(dir, { recursive: true, force: true });
    });

    // The other half of the same gate, and the one that keeps it honest: the check must
    // not refuse a vault that is merely UNFAMILIAR. A false positive here condemns a
    // healthy vault on first sight, which would be strictly worse than the defect.
    await t(`[${label}] NO marker + HEALTHY vault → boots normally (no false condemnation)`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fs-firstenc-ok-'));
      const dbPath = join(dir, 'mycelium.db');
      const first = await runBootChild(dir, dbPath, `firstenc-ok-p1-${label}`, env);
      assert.equal(first.threw, false, 'precondition: the first boot must succeed');
      const out = await runBootChild(dir, dbPath, `firstenc-ok-p2-${label}`, env);
      assert.equal(out.threw, false,
        `a healthy vault with no marker must boot (${out.code}: ${String(out.msg).slice(0, 200)})`);
      assert.ok(!existsSync(join(dir, '.vault-corrupt')), 'and must NOT be condemned');
      rmSync(dir, { recursive: true, force: true });
    });
  }

}

await t('install-vault clears the marker (no dead-end recovery)', async () => {
  // Still source-level, and honestly labelled as such: install-vault.mjs is an
  // operator script that takes a vault path and swaps files, so driving it here would
  // mean building a full repair fixture for a claim about ONE call. The behavioural
  // half of this contract is covered above: a repaired vault self-heals its flag.
  const inst = readFileSync(new URL('./vault-repair/install-vault.mjs', import.meta.url), 'utf8');
  assert.match(inst, /clearVaultCorruptMarker/,
    'install-vault must clear the flag — otherwise a verified repair still refuses to boot');
});

// ══ 4. transient errors must NOT halt a healthy vault ═══════════════════════════
await t('SQLITE_BUSY / constraint errors do NOT halt the vault', async () => {
  halt.__resetVaultHaltForTests();
  const a = open(makeVault('transient.db'));
  await assert.rejects(() => a.d1Query('SELECT * FROM no_such_table'));
  await assert.rejects(() => a.d1Query('INSERT INTO llm_usage(id, payload) VALUES (1, ?)', ['dup']));
  const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  assert.equal(halt.noteQueryError(busy, { op: 'INSERT llm_usage' }), false, 'SQLITE_BUSY must not latch');
  assert.equal(halt.isVaultHalted(), false, 'transient errors must leave the vault usable');
  await a.d1Query('INSERT INTO llm_usage(payload) VALUES (?)', ['still works']);
  a.close();
});

// ══ 5. forensics — written, and content-free ════════════════════════════════════
await t('the trip writes a durability event, a ledger line and the .vault-corrupt marker', async () => {
  halt.__resetVaultHaltForTests();
  const p = makeChimera('forensics');
  process.env.MYCELIUM_DATA_DIR = dir;
  const a = open(p);
  try { await a.d1Query('SELECT count(*) FROM llm_usage'); } catch { /* expected */ }
  try { await a.d1Query('INSERT INTO llm_usage(payload) VALUES (?)', ['x']); } catch { /* expected */ }
  assert.ok(halt.isVaultHalted(), 'precondition: latch set');

  const marker = join(dir, '.vault-corrupt');
  assert.ok(existsSync(marker), '.vault-corrupt marker must exist');
  assert.match(readFileSync(marker, 'utf8'), /SQLITE_CORRUPT|malformed/i, 'marker must name the verdict');

  const ledger = join(dir, 'corruption-events.jsonl');
  assert.ok(existsSync(ledger), 'corruption-events.jsonl must exist');
  assert.match(readFileSync(ledger, 'utf8'), /runtime-query/, 'ledger must record the runtime source');

  const events = join(dir, 'durability-events.jsonl');
  assert.ok(existsSync(events), 'durability-events.jsonl must exist');
  assert.match(readFileSync(events, 'utf8'), /sqlite-corrupt/, 'durability log must record the corruption');
  try { a.close(); } catch { /* */ }
});

await t('forensics carry no plaintext — statement SHAPE only, never params', async () => {
  // The canary MUST be able to trip the failure mode. The first version used
  // 'PLAINTEXT-CANARY-9f3a' as a BOUND PARAM — structurally incapable of failing, because
  // the leak vector was a free scan of the statement TEXT for `from <word>` / `into <word>`
  // inside string literals. Green for the wrong reason (M-001); found by review, not by
  // this gate. The canary is now shaped like the leak.
  const SECRET = 'PLAINTEXT-CANARY-9f3a';
  halt.__resetVaultHaltForTests();
  const p = makeChimera('leak');
  const a = open(p);
  try { await a.d1Query('INSERT INTO llm_usage(payload) VALUES (?)', [SECRET]); } catch { /* expected */ }
  for (const f of ['.vault-corrupt', 'corruption-events.jsonl', 'durability-events.jsonl']) {
    const fp = join(dir, f);
    if (!existsSync(fp)) continue;
    const body = readFileSync(fp, 'utf8');
    assert.ok(!body.includes(SECRET), `${f} leaked a bound param value (CLAUDE.md §1)`);
  }
  // …and the shape it DOES record is the useful one — including the literal-embedded
  // forms that leaked verbatim before (measured on this branch, 2026-07-28):
  //   "UPDATE settings SET value='imported from gmail_backup_2019'" → "UPDATE gmail_backup_2019"
  //   "INSERT INTO notes (body) VALUES ('a letter from Margaret …')" → "INSERT Margaret"
  const shapes = [
    [`INSERT INTO llm_usage (id) VALUES ('${SECRET}')`, 'INSERT llm_usage'],
    ['SELECT * FROM documents WHERE body = ?', 'SELECT documents'],
    ['UPDATE territory_vitality SET v = ?', 'UPDATE territory_vitality'],
    ['DELETE FROM territory_vitality WHERE user_id = ?', 'DELETE territory_vitality'],
    ['INSERT OR REPLACE INTO documents (id) VALUES (?)', 'INSERT documents'],
    [`UPDATE settings SET value = 'imported from ${SECRET}'`, 'UPDATE settings'],
    [`INSERT INTO notes (body) VALUES ('a letter from ${SECRET} about therapy')`, 'INSERT notes'],
    [`UPDATE documents SET body='x' WHERE title='into ${SECRET}'`, 'UPDATE documents'],
    [`REPLACE INTO t VALUES ('from ${SECRET}')`, 'REPLACE t'],
    [`SELECT a FROM t WHERE x='from ${SECRET}'`, 'SELECT t'],
  ];
  for (const [sql, want] of shapes) {
    const got = halt.sqlShape(sql);
    assert.equal(got, want, `sqlShape(${JSON.stringify(sql)}) = ${JSON.stringify(got)}`);
    assert.ok(!got.includes(SECRET), `sqlShape leaked the literal: ${got}`);
  }
  try { a.close(); } catch { /* */ }
});

// ══ 6. the boot lie — corrupt is not a wrong key ════════════════════════════════
await t('classifyBootError CLASSIFIES corruption, key-mismatch and near-misses correctly', async () => {
  // Was a regex over the source text, which would have passed on
  // `if (false) return 'vault_corrupt';` — it never called the function (review finding 8).
  // Now the real function is extracted and EXECUTED against real error shapes.
  const src = readFileSync(new URL('../src/server-rest.js', import.meta.url), 'utf8');
  const m = /const classifyBootError = \(err\) => \{([\s\S]*?)\n  \};/.exec(src);
  assert.ok(m, 'classifyBootError not found — the gate must be repointed');
  const { isCorruptionError } = await import('../src/db/durability-log.js');
  // eslint-disable-next-line no-new-func
  const classify = new Function('isCorruptionError', `return (err) => {${m[1]}\n};`)(isCorruptionError);

  const mk = (msg, code) => { const e = new Error(msg); if (code) e.code = code; return e; };
  assert.equal(classify(mk('database disk image is malformed', 'SQLITE_CORRUPT')), 'vault_corrupt');
  assert.equal(classify(mk('database disk image is malformed')), 'vault_corrupt', 'message alone must classify');
  assert.equal(classify(mk('USER_MASTER KCV failed — wrong key. Vault stays locked.')), 'key_mismatch');
  // The near-miss that a loose /malformed/i got wrong: a real, non-vault error.
  assert.equal(classify(mk('openCekGrant: malformed grant')), 'boot_failed',
    'a malformed GRANT is not a malformed VAULT — must not point the owner at vault-repair');
});

await t('a corrupt vault is NOT reported as a wrong key (keys.js via unlock)', async () => {
  const { unlock } = await import('../src/crypto/keys.js');
  const { deriveDbKey } = await import('../src/account/keystore.js');
  // keys.js probes with the HKDF-DERIVED db-file key, not the raw master — key the
  // fixture the same way or the probe legitimately reports a wrong key.
  const p = makeSchemaChimera('kcv', deriveDbKey(KEY));
  // The D-080 path: kcv.json missing beside a real vault, so unlock() probes whether
  // the key opens it. keys.js used to fold `malformed` in with the wrong-key patterns,
  // so a CORRECT key against a corrupt vault came back false and the owner was told
  // "this key does not open mycelium.db" — the reported 2026-07-26 symptom exactly.
  // It must now surface the damage instead.
  let thrown = null;
  try {
    await unlock({ userHex: KEY, systemHex: 'c'.repeat(64), kcvPath: join(dir, 'kcv-absent.json'), dbPath: p });
  } catch (e) { thrown = e; }
  assert.ok(thrown, 'unlock must refuse against a corrupt vault');
  assert.equal(thrown.code, 'vault_corrupt', `expected code vault_corrupt, got ${thrown.code}: ${thrown.message}`);
  assert.match(thrown.message, /structurally damaged/i, 'the message must name damage, not a key problem');
  assert.doesNotMatch(thrown.message, /does not open/i, 'must NOT tell the owner their key is wrong');
  assert.ok(!existsSync(join(dir, 'kcv-absent.json')), 'no KCV may be minted beside a damaged vault (D-080)');
});

// ══ 6b. the user-visible surfaces (review findings 3 + 4) ═══════════════════════
await t('a mid-session halt returns 503 vault_corrupt, not an opaque 500', async () => {
  // bootError only ever covered a vault that FAILED TO OPEN. The case actually observed
  // on 2026-07-26 is the other one: opened fine, went malformed hours later.
  //
  // BEHAVIOURAL. This was four assert.match() greps over server-rest.js, and an
  // adversarial review defeated them by neutering the predicate itself —
  // `(p) => false && (p.startsWith('/api/') || …)` — which ungates every data path while
  // /isVaultHalted\(\)\s*&&\s*isVaultDataPath/, the reason:'vault_corrupt' slice, the
  // 'not a key problem' slice and the iHalt<iSub ordering ALL still matched. 16 passed,
  // 0 failed with a halted vault serving data normally.
  // The vault must actually be BOOTED, or every data path is already 503 ("not
  // initialized") and a 503 after the trip would prove nothing. Measured: with no vault,
  // /portal/ and /ingest/ are 503 both before and after — indistinguishable.
  const saved = { src: process.env.MYCELIUM_KEY_SOURCE, u: process.env.USER_MASTER_KEY, s: process.env.SYSTEM_KEY, e: process.env.MYCELIUM_DISABLE_EMBED };
  process.env.MYCELIUM_KEY_SOURCE = 'env';
  process.env.USER_MASTER_KEY = 'a'.repeat(64);
  process.env.SYSTEM_KEY = 'b'.repeat(64);
  process.env.MYCELIUM_DISABLE_EMBED = '1';
  const { startRestServer } = await import('../src/server-rest.js');
  const sdir = join(dir, 'rest503');
  const srv = await startRestServer({ port: 0, host: '127.0.0.1', dbPath: join(sdir, 'mycelium.db'), kcvPath: join(sdir, 'kcv.json') });
  try {
    halt.__resetVaultHaltForTests();
    // POSITIVE PRECONDITION: the path must be SERVED (404 from a live route) before the
    // trip, or "503 after" is indistinguishable from "503 the whole time".
    const before = await fetch(`${srv.url}/ingest/status`);
    assert.notEqual(before.status, 503,
      `precondition: the vault must be booted so a data path is live before the halt (got ${before.status})`);

    halt.tripVaultHalt(Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }), { op: 'INSERT llm_usage' });

    const after = await fetch(`${srv.url}/ingest/status`);
    assert.equal(after.status, 503, 'a halted vault must refuse data paths with 503, not serve them');
    const body = await after.json().catch(() => ({}));
    assert.equal(body.reason, 'vault_corrupt', `the mid-session 503 must classify as vault_corrupt (got ${JSON.stringify(body).slice(0, 160)})`);
    assert.match(JSON.stringify(body), /not a key problem/i, 'the message must say it is not a key problem');
  } finally {
    halt.__resetVaultHaltForTests();
    try { await new Promise((r) => srv.server.close(r)); } catch { /* */ }
    try { srv.close?.(); } catch { /* */ }
    for (const [k, v] of [['MYCELIUM_KEY_SOURCE', saved.src], ['USER_MASTER_KEY', saved.u], ['SYSTEM_KEY', saved.s], ['MYCELIUM_DISABLE_EMBED', saved.e]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// NOTE (measured 2026-07-28): /api/v1/account is mounted at server-rest.js:1042, ABOVE the
// halt gate at :1179, so account status/setup/restore stay reachable on a halted vault.
// That is correct and deliberate — it is the surface the portal uses to LEARN the vault is
// damaged and to act on it — but it means the gate covers /portal/, /ingest/ and the vault
// sub-app, not the account API. Written down because the obvious test target
// (/api/v1/account/status) silently proves nothing.

await t('the portal routes a damaged vault AWAY from the recovery-key screen', async () => {
  // THE reported symptom: `needsRecoveryKey || bootError` sent a malformed vault to the
  // paste-your-recovery-key screen — which no key can satisfy.
  //
  // BEHAVIOURAL. This was a source read of +page.svelte asserting an index ordering (the
  // vault_corrupt branch appears before the generic restore route) plus strings inside the
  // damaged block. An adversarial review defeated all of it with ONE character —
  // `if (false && bootError === 'vault_corrupt')` — every index still resolved, every
  // string was still in the file, and a damaged vault fell through to mode='restore'.
  // 16 passed, 0 failed while the entire reported symptom was restored. Ordering in a
  // source file is not routing, so the component is now mounted and its status fetch
  // answered. The harness lives at portal-app/test/mount-setup-damaged.mjs.
  const run = (scenario) => {
    const out = spawnSync(process.execPath, ['--conditions', 'browser', 'test/mount-setup-damaged.mjs', scenario], {
      cwd: new URL('../portal-app/', import.meta.url).pathname, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    const txt = String(out.stdout || '');
    const i = txt.indexOf('{');
    assert.ok(i >= 0, `mount harness produced no JSON (${scenario}): ${String(out.stderr).slice(-300)}`);
    return JSON.parse(txt.slice(i));
  };

  const corrupt = run('corrupt');
  // POSITIVE PRECONDITION: a harness that failed to mount must not read as "the screen is right".
  assert.ok(corrupt.mounted, `the setup page must mount: ${String(corrupt.error).slice(0, 300)}`);
  assert.match(corrupt.text, /not a key problem/i, 'a damaged vault must be told it is not a key problem');
  assert.match(corrupt.text, /has not been deleted|not been overwritten/i, 'the screen must reassure that data is intact');
  assert.match(corrupt.text, /vault-repair/, 'the screen must point at the actual recovery path');
  assert.doesNotMatch(corrupt.text, /Paste the 64-character recovery key/i,
    'the damaged screen must NOT be the paste-your-recovery-key screen — that is the reported symptom');

  // CONTROL: the same page, same needsRecoveryKey:true, a DIFFERENT bootError — must still
  // reach the recovery-key screen. Without this, "no key prompt" could simply mean the
  // damaged branch swallowed everything.
  const generic = run('generic');
  assert.ok(generic.mounted, `the control mount must succeed: ${String(generic.error).slice(0, 300)}`);
  assert.match(generic.text, /Paste the 64-character recovery key/i,
    'a NON-corruption boot error must still reach the recovery-key screen');
  assert.doesNotMatch(generic.text, /not a key problem/i,
    'the damaged copy must not leak onto the ordinary recovery path');
});

// ══ 7. durability pragmas are actually applied ══════════════════════════════════
await t('cell_size_check and fullfsync are set on the canonical open', async () => {
  halt.__resetVaultHaltForTests();
  const a = open(makeVault('pragmas.db'));
  assert.equal(Number(a.db.pragma('cell_size_check', { simple: true })), 1, 'cell_size_check must be ON');
  assert.equal(Number(a.db.pragma('fullfsync', { simple: true })), 1, 'fullfsync must be 1 (macOS platter flush)');
  a.close();
});

// ══ 8. the escape hatch works, and only when asked ══════════════════════════════
await t('MYCELIUM_IGNORE_VAULT_HALT=1 lets recovery tooling through', async () => {
  halt.__resetVaultHaltForTests();
  halt.tripVaultHalt(Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }), {});
  assert.equal(halt.isVaultHalted(), true, 'latch must be set');
  // Must prove a real QUERY gets through, not just that a boolean flips (review finding 8):
  // the check is named "lets recovery tooling through", so it has to demonstrate that.
  const p = makeVault('hatch.db');
  const a = open(p);
  await assert.rejects(() => a.d1Query('INSERT INTO llm_usage(payload) VALUES (?)', ['blocked']),
    (e) => e.code === 'VAULT_HALTED', 'precondition: halted vault refuses');

  process.env.MYCELIUM_IGNORE_VAULT_HALT = '1';
  assert.equal(halt.isVaultHalted(), false, 'the escape hatch must open the latch');
  assert.doesNotThrow(() => halt.assertVaultUsable(), 'assertVaultUsable must pass under the hatch');
  await a.d1Query('INSERT INTO llm_usage(payload) VALUES (?)', ['recovery tooling']);
  const r = await a.d1Query("SELECT count(*) AS n FROM llm_usage WHERE payload = 'recovery tooling'");
  assert.equal(r.results[0].n, 1, 'the recovery write must actually land');

  delete process.env.MYCELIUM_IGNORE_VAULT_HALT;
  assert.equal(halt.isVaultHalted(), true, '…and close again when unset');
  await assert.rejects(() => a.d1Query('INSERT INTO llm_usage(payload) VALUES (?)', ['blocked again']),
    (e) => e.code === 'VAULT_HALTED', 'unsetting the hatch must re-arm the latch');
  a.close();
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

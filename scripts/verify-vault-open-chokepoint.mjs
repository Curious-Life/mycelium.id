#!/usr/bin/env node
// verify-vault-open-chokepoint.mjs — a BUILD-TIME invariant on who may open the vault.
//
// THE PROBLEM IT SOLVES, and why it is not another guard:
// This vault accumulated six runtime guards, one per incident — torn copy, foreign lineage,
// foreign process, stale WAL, concurrent migration, disk space. Each was correct. None
// could see the others, and none could see a NEW opener that simply did `new Database(...)`
// and skipped all of them. When the fail-stop latch was added at the adapter chokepoint,
// FIVE existing openers bypassed it on day one — and nothing in the repo could say so.
//
// The failure mode is not "a guard is missing". It is "a guard exists and is routed
// around", silently, by the next person who needs a database handle. No runtime check can
// fix that, because the code that skips the check never runs it. So this is a gate over the
// SOURCE, and `maxWriteCapable` is a RATCHET: it may only shrink.
//
// The property being ratcheted is deliberately WRITE-CAPABILITY, not opener count. A
// read-only handle CANNOT write to a damaged vault — the exact thing the latch exists to
// prevent — so it is safe by construction and needs no guard. Moving an opener from
// write-capable to read-only is therefore a real reduction in risk, not bookkeeping, and it
// is usually possible: VACUUM INTO succeeds on a read-only connection (measured).
//
// MUTATION-TESTED: added a new unguarded `new Database(dbPath)` write opener to
//   src/db/health.js → "no vault opener exists outside the chokepoint + allowlist" REDs
// MUTATION-TESTED: raised maxWriteCapable above the allowlist length → "the ratchet has not
//   been loosened" REDs
// MUTATION-TESTED: removed the readonly flag from snapshot-worker's keyed() call so a
//   listed read-only opener became write-capable → "every readOnly opener really is opened
//   read-only" REDs
// MUTATION-TESTED: deleted an entry's `why` → "every allowlisted opener states why" REDs
// MUTATION-TESTED: removed assertVaultUsable() from query() ITSELF → "the chokepoint
//   enforces the fail-stop latch" REDs
//
// ⚠️ Two traps this gate's own mutation testing walked into, recorded so the next person
// does not repeat them:
//  · `guardRaw` defines `assertVaultUsable(); try {` immediately ABOVE query(), so a
//    replace-first mutation edits the RAW-HANDLE guard, not the query path. A mutation
//    aimed at the wrong site proves nothing; the anchor must include query()'s own
//    `// CONTRACT` comment.
//  · slicing query()'s body by brace over-reached and kept matching withTransaction's
//    assert, so the check stayed green with query()'s deleted. It is now pinned to
//    `autoEncryptParams`, which appears nowhere else.
//
// NOTE, and it is not a gap: with query()'s assert removed, verify:vault-fail-stop stays
// GREEN — because query() calls the WRAPPED db.prepare, which asserts too. That is
// defence-in-depth doing its job. The structural check here is what pins query()'s own
// guard; the behavioural proof lives there. Neither subsumes the other.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const REPO = fileURLToPath(new URL('..', import.meta.url));
// MUTATION-TESTED (2026-07-28), after an adversarial review showed the first version was
// green for the wrong reason. Applied, confirmed on disk, run, restored:
//   M. added `new Database(dbFile)` (write-capable, latch-bypassing) inside
//      src/db/init.js — a file ALREADY on the allowlist
//      → "the ratchet has not been loosened" REDs: 10 write-capable SITE(S) vs ceiling 9.
//      Under the old entry-counting ratchet this was completely invisible.
//
// ⚠️ The original record for this gate mutated src/db/health.js — an UNLISTED file — so it
// only ever proved the case that already worked. Two structural holes it could not see:
// exemptions were per-FILE (dropLegacyVaultIndex opened the vault write-capable and ran
// DROP TABLE from inside a file exempted for a different database), and the ceiling counted
// allowlist ENTRIES while one file can hold many opens (db-cipher-migrate.js has four).

const SRC = join(REPO, 'src');
const allow = JSON.parse(readFileSync(new URL('./vault-openers-allowlist.json', import.meta.url), 'utf8'));

// Files that open a DIFFERENT database entirely — never the vault. Narrow and explicit:
// a broad pattern here would silently swallow a real vault opener.
// PER-SITE, NOT PER-FILE. A whole-file exemption hides every OTHER opener in that file:
// sidecar.js was exempted for `mycelium.search.db`, and dropLegacyVaultIndex sat in the
// same file opening THE VAULT write-capable and running DROP TABLE on it (called with the
// vault's dbPath from src/db/init.js). A fifth write-capable, latch-bypassing vault opener,
// invisible while the ceiling claimed four. Adversarial review, 2026-07-28.
//
// Each entry names the identifiers this file may pass to `new Database(` WITHOUT it being
// a vault open. Anything else in these files is a stray and must be allowlisted like any
// other opener. Keep both the file list and the identifier lists narrow.
const NOT_THE_VAULT = {
  'src/search/sqlite/sidecar.js': ['path', 'sidecarPath', 'idxPath'], // mycelium.search.db — regenerable index
  'src/auth.js': ['dbPath'],            // auth.db — separate, plaintext, regenerable (verify:auth-db-heal)
  'src/remote/config.js': ['dbp', 'dbPath'],   // auth.db
  'src/ingest/hermes-import.js': ['statePath', 'src', 'srcPath'], // a foreign app's database, read-only
  'src/ingest/detect-sources.js': ['statePath', 'src', 'srcPath'], // ditto
  // `.vault-ownership` — a ZERO-ROW file that exists only to carry a kernel (fcntl) lock.
  // It is not the vault and holds no data at all, so there is nothing here for the
  // fail-stop latch to guard. Scoped to these three identifiers, not the whole file, so a
  // future `new Database(dbPath)` in vault-lease.js would still be caught. (Two identifiers,
  // not three — an earlier version of this comment miscounted its own list.)
  // `.vault-ownership` and `.vault-presence-*` — ZERO-ROW files that exist only to carry
  // kernel (fcntl) locks. Neither is the vault and neither holds any data, so there is
  // nothing here for the fail-stop latch to guard. Scoped to these four identifiers rather
  // than the whole file, so a future `new Database(dbPath)` in vault-lease.js is still
  // caught — which is why the presence opens use SPECIFIC names (`presencePath`,
  // `presenceFile`) instead of a generic `p`/`full` that would widen the hole.
  'src/db/vault-lease.js': ['lockPath', 'lock', 'presencePath', 'presenceFile'],
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    // .cjs too — a .cjs opener used to be invisible to this walk entirely.
    else if (/\.(m?js|cjs)$/.test(e)) out.push(p);
  }
  return out;
}

/** Every `new Database(` site in src/, as { file, line, readonly }. */
function findOpeners() {
  const hits = [];
  for (const abs of walk(SRC)) {
    const rel = relative(REPO, abs);
    const exemptArgs = NOT_THE_VAULT[rel] || null;
    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    lines.forEach((ln, i) => {
      const m = /new Database\s*\(\s*([A-Za-z_$][\w$.]*)?/.exec(ln);
      if (!m) return;
      // Exempt only the SITES that open this file's own non-vault database.
      if (exemptArgs && m[1] && exemptArgs.includes(m[1])) return;
      // `readonly: true` may sit on this line or the next (multi-line option objects).
      const near = `${ln}\n${lines[i + 1] || ''}`;
      const readonly = /readonly\s*:\s*true/.test(near);
      hits.push({ file: rel, line: i + 1, readonly, text: ln.trim() });
    });
  }
  return hits;
}

const openers = findOpeners();
const listed = new Set([allow.chokepoint, ...allow.readOnly.map((r) => r.site), ...allow.writeCapable.map((r) => r.site)]);

t('every vault opener is either THE chokepoint or explicitly allowlisted', () => {
  const stray = openers.filter((o) => !listed.has(o.file));
  assert.equal(stray.length, 0,
    `unlisted vault opener(s):\n${stray.map((s) => `        ${s.file}:${s.line}  ${s.text}`).join('\n')}\n`
    + '      Route it through src/adapter/d1.js, or add it to scripts/vault-openers-allowlist.json\n'
    + '      with a reason — and understand that a write-capable opener bypasses the fail-stop latch.');
});

t('the ratchet has not been loosened', () => {
  // COUNT SITES, NOT ENTRIES. One allowlisted FILE can hold many write-capable opens —
  // db-cipher-migrate.js has four — so an entry count let new unguarded openers appear
  // inside an already-listed file without moving the number. Adversarial review, 2026-07-28.
  const writeSites = openers.filter((o) => !o.readonly);
  assert.ok(writeSites.length <= allow.maxWriteCapable,
    `maxWriteCapable=${allow.maxWriteCapable} but ${writeSites.length} write-capable SITE(S) exist:\n`
    + writeSites.map((o) => `        ${o.file}:${o.line}  ${o.text}`).join('\n'));
  // The ceiling may only come DOWN. Raising it is how a ratchet quietly stops ratcheting.
  // The ceiling lives HERE, in the script, not in the JSON it checks — raising it requires
  // editing the gate itself, which a reviewer sees. Started at 7 (2026-07-28), now 4.
  // 4 → 9 is a CORRECTION, not a loosening: the old number counted allowlist ENTRIES while
  // whole files were exempt, so it was never the real figure. 9 is the measured count of
  // write-capable SITES with per-site exemptions in force. From here it may only shrink.
  assert.ok(allow.maxWriteCapable <= 9,
    `maxWriteCapable was raised to ${allow.maxWriteCapable}; this ceiling may only shrink (measured true baseline 9 on 2026-07-28, after per-site exemptions made every opener visible). `
    + 'Reduce an opener to read-only or route it through the chokepoint instead.');
});

t('every allowlisted opener states why, and how it could be reduced', () => {
  for (const r of [...allow.readOnly, ...allow.writeCapable]) {
    assert.ok(r.why && r.why.length > 12, `${r.site}: needs a real "why"`);
  }
  for (const r of allow.writeCapable) {
    assert.ok(r.reduceTo && r.reduceTo.length > 8,
      `${r.site}: a write-capable opener must record how it could stop being one ("reduceTo")`);
  }
});

t('every readOnly opener really is opened read-only', () => {
  for (const r of allow.readOnly) {
    const sites = openers.filter((o) => o.file === r.site);
    assert.ok(sites.length > 0, `${r.site}: listed as read-only but opens nothing — stale entry`);
    const writeCapable = sites.filter((o) => !o.readonly);
    assert.equal(writeCapable.length, 0,
      `${r.site} is listed READ-ONLY but opens write-capable at line(s) ${writeCapable.map((s) => s.line).join(', ')}. `
      + 'A write-capable handle can write to a damaged vault — which is the whole point of the latch.');
  }
});

t('the chokepoint itself enforces the fail-stop latch', () => {
  const src = readFileSync(join(REPO, allow.chokepoint), 'utf8');
  // SCOPED to the query() body. A file-wide match was green with the assert removed from
  // query() entirely, because the same call appears in withTransaction and the raw-handle
  // guards — a check named "the chokepoint enforces the latch" that passes when the
  // chokepoint does not. (Behavioural proof lives in verify:vault-fail-stop's bleed check;
  // this is the structural half, and it must actually point at the right function.)
  // Pinned to a marker UNIQUE to query() — autoEncryptParams appears nowhere else. Brace
  // slicing over-reached and kept matching assertVaultUsable() from withTransaction, so the
  // check stayed green with the assert deleted from query(). Verified by mutation, twice.
  assert.match(src, /assertVaultUsable\(\);\s*try \{[\s\S]{0,600}?autoEncryptParams/,
    'query() must call assertVaultUsable() BEFORE it touches the file');
  assert.match(src, /autoDecryptResults[\s\S]{0,400}?catch \(err\)[\s\S]{0,200}?noteQueryError\(/,
    'query() must classify errors on the way out');
  assert.match(src, /db\.prepare = /, 'the raw handle it exposes must be guarded');
  assert.match(src, /assertVaultUsable\(\);[\s\S]{0,200}return db\.transaction/, 'withTransaction must be guarded');
});

t('the allowlist has no stale entries (every listed file still opens a database)', () => {
  const files = new Set(openers.map((o) => o.file));
  const stale = [...listed].filter((f) => !files.has(f));
  assert.equal(stale.length, 0,
    `allowlist entries that no longer open anything (delete them, and lower maxWriteCapable): ${stale.join(', ')}`);
});

// Report SITES, which is what the ratchet enforces. Printing allowlist ENTRIES here said
// "5 write-capable" while nine write-capable opens existed — the summary a human reads
// must be the same number the assertion uses.
console.log(`\n  ${openers.length} vault-opening site(s) · ${openers.filter((o) => !o.readonly).length} write-capable across ${allow.writeCapable.length} file(s) (ceiling ${allow.maxWriteCapable})`);
console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

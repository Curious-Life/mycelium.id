// scripts/vault-repair/loss-guard.probe.mjs — prove rebuild-fresh.mjs's data-loss guard now
// (a) FIRES on synthetic loss and (b) stays SILENT on a clean rebuild.
//
//   node scripts/vault-repair/loss-guard.probe.mjs
//
// Copy-only tooling. Uses PLAIN in-memory better-sqlite3 (no SQLCipher / keychain / live vault):
// the guard is pure completeness/count logic, independent of encryption.
//
// The guard's real wire shape (mirrored here, NOT a simplified stand-in): robustCopy runs a
// FORWARD and a REVERSE `SELECT *` scan and records, for each, whether it reached EOF without
// throwing. `robustScanIncomplete(fwd, rev)` collapses those two booleans; `parityVerdict` then
// consumes `robustIncomplete` at the final count-parity gate. The clean-rebuild scenario below
// drives ACTUAL forward+reverse scans over a real in-memory table to produce those booleans, so
// we exercise the true scan mechanics — not a hand-set flag.
//
// Regressions guarded:
//   1. The old `failed` array was declared but never populated → stillMissing was always ≤ 0 →
//      the UNRECOVERABLE warning could NEVER fire. Now a both-scans-stopped table sets the flag.
//   2. The old gate's `dN < s` compared a number to 'ERR' → NaN → false → a robust-copied table
//      with unread rows SILENTLY passed. Now an 'ERR' src on an incompletely-read table fails.
import Database from 'better-sqlite3';
import { robustScanIncomplete, parityVerdict } from './loss-guard.mjs';

let pass = 0, fail = 0;
const check = (label, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); cond ? pass++ : fail++; };
const eq = (label, got, want) => check(`${label}${JSON.stringify(got) === JSON.stringify(want) ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`, JSON.stringify(got) === JSON.stringify(want));

// NOTE ON COVERAGE: this probe proves the DECISION plumbing is correct given trustworthy scan
// booleans. It cannot construct a silently-under-reading corrupt b-tree in memory, so it does
// NOT prove the load-bearing assumption "a clean-completing SELECT * read every row" (see
// loss-guard.mjs's honesty caveat — validate.mjs is the authority for that). `realScans` below
// MIRRORS robustCopy's scan closure rather than importing it (robustCopy is inline in
// rebuild-fresh.mjs); keep the two in sync when either changes.

// Run robustCopy's real scan closure over a healthy table and return whether each direction
// reached EOF. On a clean table both complete → incomplete=false → guard silent.
function realScans(n) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY, content TEXT)');
  const ins = db.prepare('INSERT INTO messages(rowid, id, content) VALUES (?,?,?)');
  db.transaction(() => { for (let r = 1; r <= n; r++) ins.run(r, 'a' + r, 'body-' + r); })();
  const seen = new Map();
  const scan = (desc) => {
    let complete = false;
    try {
      const sql = `SELECT rowid AS __rid, id, content FROM messages${desc ? ' ORDER BY rowid DESC' : ''}`;
      for (const r of db.prepare(sql).iterate()) { if (!seen.has(r.__rid)) seen.set(r.__rid, r); }
      complete = true;
    } catch { /* would throw on a damaged tree */ }
    return complete;
  };
  const fwd = scan(false), rev = scan(true);
  db.close();
  return { fwd, rev, readCount: seen.size };
}

console.log('=== robustScanIncomplete: clean table read by REAL forward+reverse scans (guard SILENT) ===');
{
  const { fwd, rev, readCount } = realScans(100);
  eq('forward scan completed', fwd, true);
  eq('reverse scan completed', rev, true);
  eq('all 100 rows read', readCount, 100);
  eq('incomplete == false (guard silent)', robustScanIncomplete(fwd, rev), false);
}

console.log('\n=== robustScanIncomplete: directional damage cases ===');
{
  // One direction reached EOF ⇒ the whole b-tree was walked ⇒ `seen` complete ⇒ NO loss.
  eq('forward completed, reverse stopped → not incomplete', robustScanIncomplete(true, false), false);
  eq('reverse completed, forward stopped → not incomplete', robustScanIncomplete(false, true), false);
  // BOTH directions stopped on damage ⇒ possible unread region ⇒ guard FIRES.
  eq('both scans stopped → incomplete (guard fires)', robustScanIncomplete(false, false), true);
}

console.log('\n=== parityVerdict: the src=ERR NaN blind spot ===');
{
  // 1) ERR src on a table robustCopy could NOT fully read → MUST flag (old code silently passed).
  const lossy = parityVerdict({ s: 'ERR', dN: 95, wasCopied: true, robustIncomplete: true });
  eq('ERR + incomplete robust read → mismatch', lossy.mismatch, true);
  check('ERR + incomplete → note says UNVERIFIABLE LOSS', /UNVERIFIABLE LOSS/.test(lossy.note || ''));

  // 2) ERR src on a table that WAS fully read → no possible loss → pass, but surfaced (not silent).
  const clean = parityVerdict({ s: 'ERR', dN: 95, wasCopied: true, robustIncomplete: false });
  eq('ERR + complete read → not a mismatch', clean.mismatch, false);
  check('ERR + complete read → surfaced, not silent', clean.note !== null && /unverifiable/.test(clean.note));

  // 3) ERR src on a table never copied → flag (can't have gap-filled it).
  eq('ERR + uncopied → mismatch', parityVerdict({ s: 'ERR', dN: 0, wasCopied: false, robustIncomplete: false }).mismatch, true);

  // Prove the historical NaN path is dead: number < 'ERR' would have been false → silent pass.
  check('sanity: JS `95 < "ERR"` is false (the old silent-pass bug)', (95 < 'ERR') === false);
}

console.log('\n=== parityVerdict: numeric cases still behave (unchanged from original gate) ===');
{
  eq('equal counts → no mismatch', parityVerdict({ s: 100, dN: 100, wasCopied: true, robustIncomplete: false }).mismatch, false);
  eq('dest short of src → mismatch', parityVerdict({ s: 100, dN: 90, wasCopied: true, robustIncomplete: false }).mismatch, true);
  eq('dest > src via legit gap-fill → no mismatch', parityVerdict({ s: 100, dN: 105, wasCopied: true, robustIncomplete: false }).mismatch, false);
  // A numeric src count catches a shortfall even if the robust read was flagged incomplete.
  eq('numeric shortfall + incomplete → mismatch', parityVerdict({ s: 100, dN: 90, wasCopied: true, robustIncomplete: true }).mismatch, true);
  // dest count(*) itself threw → destination broken → fail closed, whatever src reports.
  eq('dest=ERR (num src) → mismatch', parityVerdict({ s: 100, dN: 'ERR', wasCopied: true, robustIncomplete: false }).mismatch, true);
  eq('dest=ERR (ERR src, both) → mismatch (no silent both-ERR pass)', parityVerdict({ s: 'ERR', dN: 'ERR', wasCopied: true, robustIncomplete: false }).mismatch, true);
  // No false-abort on a fully-readable-but-index-flagged table: forced robust, both scans
  // complete (incomplete=false), counts agree → pass. (Guards against re-importing the phantom
  // hazard that an enumerate-and-diff guard would have tripped on such a table.)
  eq('forced-robust healthy table (counts agree) → no mismatch', parityVerdict({ s: 100, dN: 100, wasCopied: true, robustIncomplete: false }).mismatch, false);
}

console.log(`\n[loss-guard.probe] ${pass} passed, ${fail} failed`);
if (fail > 0) { console.error('PROBE FAILED — loss guard did not behave as specified'); process.exit(1); }
console.log('PROBE OK — decision plumbing correct: guard fires when both scans stop, silent on a clean read,');
console.log('           ERR no longer silently passes, broken dest fails closed. (Row-level completeness is validate.mjs.)');

// scripts/vault-repair/loss-guard.mjs — the two pure decisions behind rebuild-fresh.mjs's
// data-loss guard, factored out so an in-memory probe can exercise them WITHOUT the keychain,
// argv, live-vault quiescence, or SQLCipher setup that rebuild-fresh.mjs pulls in at import.
//
// Copy-only tooling. These functions read no state and touch no database.
//
// WHY completeness (not rowid enumeration): robustCopy salvages a corrupt table by scanning
// `SELECT * FROM t` FORWARD then REVERSE and unioning the rows it can read. It deliberately does
// NOT enumerate rowids and seek — on a shared-page-damaged tree a rowid/id enumeration can be
// satisfied from an INDEX that wanders into other trees and returns PHANTOM keys (live: 101,398
// "rows" for a 71,823-row table). So the guard must NOT re-derive an "expected" rowid set to diff
// against; that re-imports the exact hazard robustCopy avoids and would false-abort a healthy
// table. Instead it uses the one trustworthy signal the scan itself produces: did a full-table
// pass in EITHER direction reach EOF without hitting a bad page?

// robustScanIncomplete — did robustCopy fail to read the whole table in one clean pass?
//
//   fwdComplete : the forward  `SELECT *` scan iterated to EOF without throwing
//   revComplete : the reverse  `SELECT * ORDER BY rowid DESC` scan iterated to EOF without throwing
//
// A clean pass in EITHER direction traverses the table b-tree to EOF; an iterate that hits a
// corrupt page raises SQLITE_CORRUPT and throws, so reaching EOF without throwing means the
// traversal encountered no bad page. In the overwhelmingly common damage mode (a scan dies at
// the bad page) `seen` then holds every physically-present row and there is nothing more to
// recover. When BOTH directions stop early on page damage, an unread region can sit between
// them: rows we could not copy from src (recovered only if the snapshot happened to carry them).
// Returns true only in that both-failed case — the conservative, fail-closed direction, and one
// that a fully-readable-but-index-flagged table never trips (its forward scan completes).
//
// Residual (by design, not covered here): a structurally-damaged interior page whose child
// pointer is wrong-but-VALID can make a traversal follow it and silently miss a subtree without
// erroring — a "complete" scan that under-read. This in-line guard cannot see that; the id-level
// authority is validate.mjs (SHA of repaired-vs-snapshot, which reports MISSING ids). This guard
// is the fast in-line tripwire, not the last word — always run validate.mjs before swapping.
export function robustScanIncomplete(fwdComplete, revComplete) {
  return !(fwdComplete || revComplete);
}

// parityVerdict — the final-gate decision for ONE table. Returns { mismatch, note }.
//
//   s               : src count(*) — a number, or the string 'ERR' when the corrupt src can't be counted
//   dN              : dest count(*) — a number, or 'ERR'
//   wasCopied       : true when a copy path populated counts[t] (genericCopy OR robustCopy)
//   robustIncomplete: true when robustCopy could not read this table in one clean pass
//                     (robustScanIncomplete above); false/undefined otherwise, incl. every
//                     genericCopy'd table (genericCopy fully reads the table or throws → degrades)
//
// The historical blind spot this fixes: when the corrupt src cannot be counted, `s === 'ERR'`,
// and the old gate's `dN < s` evaluated `number < 'ERR'` → NaN → false, so a robust-copied table
// SILENTLY passed even when its scan-union had thrown mid-table. Here 'ERR' never rides a numeric
// comparison:
//   • a NUMERIC src count still catches a dest shortfall (`dN < s`) exactly as before;
//   • an 'ERR' src on a table whose salvage scan THREW is unverifiable loss → FAIL CLOSED;
//   • an 'ERR' src on a table whose salvage scan raised no error → pass, but say so (not a silent
//     green) — see the honesty caveat below.
//
// HONESTY CAVEAT (do not overstate): "no scan error" is WEAKER than "no loss." A clean-completing
// `SELECT *` proves the traversal hit no corrupt page, not that it visited every row (a bad-but-
// valid interior pointer can skip a subtree without erroring — robustScanIncomplete's residual).
// And `s` itself is `count(*)` over the SAME damaged b-tree, so even a numeric `s == dN` can agree
// on a wrong number. This gate is a fast in-line tripwire; the id-level authority is validate.mjs
// (SHA of repaired-vs-snapshot, which reports MISSING ids). Always run it before swapping.
export function parityVerdict({ s, dN, wasCopied, robustIncomplete }) {
  // Dest is a freshly built + VACUUMed db; `count(*)` on it must succeed. If it threw ('ERR'),
  // the destination is itself broken — fail closed regardless of src (also covers both-'ERR').
  if (dN === 'ERR') return { mismatch: true, note: `dest count(*) FAILED (dN=ERR) — destination unreadable  <-- BROKEN DEST` };
  if (String(s) === String(dN)) return { mismatch: false, note: null };
  const bothNum = typeof s === 'number' && typeof dN === 'number';
  const destShort = bothNum && dN < s;
  // Counts differ and either the table was never copied, or dest is genuinely short of a
  // readable src count → real mismatch.
  if (!wasCopied || destShort) return { mismatch: true, note: `src=${s} dest=${dN}  <-- MISMATCH` };
  // Src count is unreadable ('ERR'). Numeric parity is impossible; fall back to whether the
  // salvage scan threw.
  if (s === 'ERR') {
    if (robustIncomplete) {
      return { mismatch: true, note: `src=ERR (corrupt count) dest=${dN} and robustCopy's scan STOPPED on damage (both directions) — possible unrecovered rows  <-- UNVERIFIABLE LOSS` };
    }
    return { mismatch: false, note: `src=ERR (corrupt count) dest=${dN} — count parity unverifiable; salvage scan raised no error (NOT a completeness proof — run validate.mjs)` };
  }
  // dest > src via a legitimate snapshot gap-fill — expected, not a mismatch.
  return { mismatch: false, note: null };
}

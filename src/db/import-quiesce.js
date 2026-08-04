// src/db/import-quiesce.js — a process-wide latch that stills every background writer
// while a bulk import owns the vault (D-128).
//
// WHY. On 2026-07-30 a full-export import of 67k messages hit SQLITE_CORRUPT mid-way
// ("invalid page number …", vault HALTED, the import's writes never durably landed).
// The importer runs a mass write — including `PRAGMA foreign_keys = OFF` on the app's
// long-lived SHARED connection — while the enrich drainer keeps writing the same rows,
// the transcribe drain keeps writing attachments, and a DETACHED snapshot worker can
// `VACUUM INTO` the same file, coordinated by nothing but busy_timeout. D-108's halt
// latch correctly stopped the *amplification* (the app stopped writing into the damage);
// this module closes the *ingress*: while an import holds the latch, the writers that
// would interleave with it stand down.
//
// SHAPE. In-memory and process-local, deliberately: the importer, the drainer, the
// transcribe drain and the snapshot SPAWN DECISION all live in the one server process,
// so a module-level latch is sufficient and survives nothing it shouldn't (a crashed
// import releases by process death). Consumers poll `isImportQuiesced()` at the top of
// each cycle — the same re-check-each-cycle discipline the pause flags learned in the
// D-047 era (a latch read once at boot is no latch, drainer.js:328's lesson).
//
// NOT a lock: acquire never blocks and nests (two concurrent imports both hold it;
// the latch clears when the LAST releases). Release is idempotent. Content-free.

let _holders = 0;
let _label = null;

/**
 * Take the quiesce latch for the duration of a bulk import.
 * @param {string} label content-free description for logs ("full-export-import")
 * @returns {() => void} release — idempotent, call in `finally`
 */
export function acquireImportQuiesce(label = 'import') {
  _holders++;
  _label = label;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    _holders = Math.max(0, _holders - 1);
    if (_holders === 0) _label = null;
  };
}

/** True while any bulk import holds the latch — background writers must stand down. */
export function isImportQuiesced() { return _holders > 0; }

/** Content-free status for logs/readiness. */
export function importQuiesceStatus() { return _holders > 0 ? { quiesced: true, label: _label, holders: _holders } : { quiesced: false }; }

export default { acquireImportQuiesce, isImportQuiesced, importQuiesceStatus };

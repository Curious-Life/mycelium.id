// src/db/migration-ledger.js — a durable record of WHICH migrations shaped this vault.
//
// WHY (proven, 2026-07-15): the live production vault carries `attachments.transcribe_attempts`
// — a column created by exactly one file on this machine, `mycelium.id/migrations/
// 0041_attachment_transcribe_attempts.sql`, in the CANONICAL repo. This repo has no such
// migration; its 0041 is `0041_categories_provenance.sql`. The two lineages FORKED at the
// same number, and a Claude session configured with MYCELIUM_DATA_DIR=<live vault> booted
// the canonical codebase against it, applying that lineage's DDL. The vault's schema is a
// Frankenstein of two lineages — and nothing recorded it, because `applyMigrations` kept no
// ledger: it re-asserted every migration on every boot and inferred "already applied" from
// the schema itself. A vault that cannot say what shaped it cannot be trusted or diagnosed.
//
// WHAT THIS GIVES:
//   1. A ledger (file + sha256 + when) — the audit trail that did not exist.
//   2. Skip-if-applied — boots stop re-asserting 54 files against a 2 GB vault
//      (measured on the real vault: 458ms → 3ms).
//   3. Loud, recorded WARNINGS on divergence (see inspectLineage — reporting, NOT gating).
//
// SCOPE — read this before trusting it (independent review, 2026-07-15):
//  * The ledger does NOT catch the incident that motivated it. The canonical repo runs the
//    OLD ledger-less applyMigrations: it applies DDL and records NOTHING. This build then
//    boots, sees only its own entries — all present — and passes. Ledger divergence only
//    appears between two LEDGER-AWARE builds, i.e. this repo's own branches.
//  * Therefore this is an AUDIT TRAIL + a speedup, not a defence. The defence against a
//    foreign build is: (a) don't point another codebase at this vault (~/.claude.json — the
//    proven cause), and (b) src/db/writer-lock.js.
//  * schemaDrift() in migrate.js is the check that CAN see a ledger-less foreign build —
//    it compares the vault's ACTUAL columns against what this build's migrations produce
//    (that is how `attachments.transcribe_attempts` is visible). Also warn-only: an extra
//    column is ambiguous (a foreign lineage vs. one of your own feature branches).

import { createHash } from 'node:crypto';

export const LEDGER_TABLE = 'schema_migrations';

/** Create the ledger table if absent. Safe on every boot. */
export function ensureLedger(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
    filename   TEXT PRIMARY KEY,
    sha256     TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * @returns {Map<string,string>} filename → sha256 of what was applied
 * Fails CLOSED (CLAUDE.md §3): after ensureLedger() the table exists, so a read error is a
 * REAL problem (corrupt page, hijacked table) — exactly when we must refuse, not silently
 * return "empty" and re-apply everything as if this were a fresh vault.
 */
export function readLedger(db) {
  try {
    return new Map(db.prepare(`SELECT filename, sha256 FROM ${LEDGER_TABLE}`).all().map((r) => [r.filename, r.sha256]));
  } catch (e) {
    if (/no such table/i.test(e.message)) return new Map(); // pre-ensureLedger / read-only probe
    throw new Error(`migration ledger unreadable (${e.message}) — refusing to treat this vault as un-migrated`);
  }
}

export function recordApplied(db, filename, hash) {
  db.prepare(`INSERT OR REPLACE INTO ${LEDGER_TABLE} (filename, sha256, applied_at) VALUES (?, ?, ?)`)
    .run(filename, hash, new Date().toISOString());
}

/**
 * Report lineage divergence. **Never throws by default — this REPORTS, it does not gate.**
 *
 * WHY NOT FAIL CLOSED (independent review 2026-07-15 — both were REAL brick risks):
 *  - Dev.app and production SHARE ONE VAULT (see init.js: "dev + production share one
 *    vault"). A feature branch carrying one extra migration (e.g. 0050_*) records it; the
 *    next boot of a build without that file would REFUSE → boot fails. That skew is routine
 *    and was previously harmless.
 *  - 8 of 54 migration files were edited AFTER landing (comments/typos) and the hash covers
 *    comments → one future comment fix would refuse boot on every existing vault.
 *  - An env-only hatch is UNREACHABLE anyway: main.rs spawns the app with a FIXED env list,
 *    so a Finder/launchd app can never receive it, and a boot throw surfaces as a WHITE
 *    SCREEN — the careful error text never reaches the user.
 * A guard that bricks the one machine where a brick is unrecoverable is worse than the drift
 * it prevents. So: warn loudly, record it, keep booting. Opt IN to gating with
 * MYCELIUM_STRICT_LINEAGE=1 (CI / controlled box) — never in the shipped app.
 *
 * @param {Map<string,string>} ledger  filename → sha, as recorded in the vault
 * @param {Map<string,string>} present filename → sha, as shipped by THIS build
 * @returns {{foreign: string[], changed: string[]}}
 */
export function inspectLineage(ledger, present) {
  if (ledger.size === 0) return { foreign: [], changed: [] }; // un-ledgered → bootstrap
  return {
    foreign: [...ledger.keys()].filter((f) => !present.has(f)).sort(),
    changed: [...ledger.entries()].filter(([f, sha]) => present.has(f) && present.get(f) !== sha).map(([f]) => f).sort(),
  };
}

/** Opt-in gate for CI / a controlled box. NEVER enabled in the shipped app. */
export function assertLineageStrict({ foreign, changed }) {
  if (process.env.MYCELIUM_STRICT_LINEAGE !== '1') return;
  if (foreign.length) throw new Error(`lineage: vault records migration(s) this build lacks: ${foreign.join(', ')}`);
  if (changed.length) throw new Error(`lineage: migration content changed after apply: ${changed.join(', ')}`);
}

export default { ensureLedger, readLedger, recordApplied, inspectLineage, assertLineageStrict, sha256, LEDGER_TABLE };

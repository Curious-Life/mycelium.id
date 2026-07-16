-- 0050 — one-shot backfill: legacy ai_providers.status='pending' rows → 'active'.
--
-- WHY: resolve.js mapRowToConfig refuses status='pending' — that is what makes an
-- IMPORTED provider row unresolvable until the user deliberately arms it (setActive).
-- "No vault holds a 'pending' row" is true of every CODE path (db/providers.js create()
-- hardcodes 'active'; the /providers/:id/test probe writes 'active'/'error' and now
-- refuses to promote 'pending') but NOT of the schema DEFAULT at 0001_init.sql:130,
-- which applies to any INSERT omitting the column. Pre-2026-07-16 restoreTable did
-- exactly that when a manifest row carried no `status`, so a vault that imported a
-- hand-built or third-party bundle can hold 'pending' rows that have been resolving for
-- months. Without this they would silently stop working — no error, nothing in the UI to
-- explain it. They predate the control and were already live; disabling them is a
-- regression, not a security win.
--
-- WHY IT MUST BE ONE-SHOT (do not "simplify" the WHERE away — and if you do, the gate
-- will now catch you: verify:provider-import P14 forces the real self-heal path):
-- applyMigrations SELF-HEALS (src/db/migrate.js:55-66) — if any expected table is
-- missing it IGNORES the ledger and re-applies EVERY migration. A bare
-- `UPDATE … WHERE status='pending'` would therefore re-run at some arbitrary future
-- boot, AFTER an import has landed a pending row, and ARM it — silently killing the
-- control this migration exists to support. Scoping by created_at is no fix either:
-- restoreTable preserves the BUNDLE's created_at, so an attacker picks it.
--
-- WHY THE LEDGER, NOT A MARKER TABLE: the obvious guard is a marker table this migration
-- creates and checks. That FAILS OPEN, circularly — missingExpectedTables() regex-scans
-- migrations for CREATE TABLE (migrate.js:101-108), so the marker is itself an "expected
-- table", and its ABSENCE is precisely what triggers the self-heal that re-runs this file
-- against an empty marker ⇒ every pending row armed. It would store its "already done"
-- bit in the very namespace self-heal exists to reconstruct. (This codebase drops live
-- vault tables today — sidecar.js:130 drops five — so that is not hypothetical.)
--
-- `schema_migrations` is the right anchor: recordApplied() runs AFTER applyOne()
-- (migrate.js:71-73), so on the FIRST apply this row does not exist yet and the UPDATE
-- runs; on every re-apply — including self-heal, which ignores the ledger for its SKIP
-- decision but never CLEARS it — the row exists and the UPDATE matches nothing.
UPDATE ai_providers SET status = 'active'
 WHERE status = 'pending'
   AND NOT EXISTS (
     SELECT 1 FROM schema_migrations WHERE filename = '0050_provider_status_backfill.sql'
   );

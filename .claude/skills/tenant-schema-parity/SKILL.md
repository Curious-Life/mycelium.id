---
name: tenant-schema-parity
description: >-
  Use proactively whenever a new D1 migration is added, a customer fleet
  deploy is about to ship, a new tenant is provisioned, or a runtime
  "no such column / no such table / SQLITE_ERROR" surfaces in agent or
  worker logs. Mycelium's D1 fleet (operator `mycelium-db` plus per-tenant
  `mycelium-tenant-<handle>`) drifts silently when migrations get
  applied to some D1s but not others — there is no automated runner yet
  (FLEET-MIGRATIONS-PLAN.md F2 is unbuilt). This skill enforces the
  manual discipline: inventory tenant-scope migrations, compare each D1
  against the operator schema, identify drift, apply missing migrations
  idempotently, verify post-state, and audit-log per host. Required
  before any code change ships that depends on a column/table existing
  on every D1. Refuses "looks fine, deploy" without a parity check.
---

# Tenant Schema Parity Protocol

Mycelium's D1 fleet is sharded: one operator DB (`mycelium-db`) plus one DB per customer (`mycelium-tenant-<handle>`). Migrations are run by hand today — there's no `schema_migrations` tracking table populated and no post-deploy F2 runner (planned in [FLEET-MIGRATIONS-PLAN.md](../../../docs/FLEET-MIGRATIONS-PLAN.md), unbuilt). The historical pattern is: a migration lands on the operator DB, ships in code that queries the new column, customer fleet runs that code, and **fails silently for hours** until someone notices `D1_ERROR: no such column: X`.

This skill is the manual gate that prevents that class of incident. It does not replace F2 — it bridges to it.

## When this skill applies

**YES — invoke before:**
- Adding a new migration with `@scope: tenant`, `@scope: both`, or `@scope: all`.
- A `update-customers.sh` deploy that ships code referencing recently-added columns/tables.
- Provisioning a new customer VPS (the new tenant DB starts at the schema state of `provision-customer.sh` — verify it ends up at parity).
- Investigating any runtime SQL error of shape `no such column`, `no such table`, `SQLITE_ERROR: duplicate column`, `D1_ERROR` — these are drift symptoms.
- Reviewing a migration whose `@scope` annotation looks suspicious (e.g., one that ALTERs a table also present in tenant DBs but is annotated `operator`).
- Merging a long-lived feature branch that introduced any migration.

**NO — skip when:**
- The change is purely operator-scope (e.g., `fleet_attest_keys`, `provisioning_jobs`) and demonstrably untouched by tenant code paths.
- A migration is `@scope: skip` (auto-generated dumps, legacy Postgres-only).
- Documentation-only change.

## Step 1 — Inventory the migrations relevant to this change

Determine the scope of investigation. For a single new migration: just that file + any earlier migrations on the same table that the new one assumes are applied. For a customer fleet deploy: all `@scope: tenant|both|all` migrations from the last known-good fleet sync forward. For a runtime error: the migration(s) that introduce the missing column/table.

```bash
# All tenant-affecting migrations (scope = tenant | both | all):
grep -lE "^-- @scope: (tenant|both|all)" migrations/*.sql | sort -V

# What does a specific migration touch?
grep -E "^(CREATE TABLE|ALTER TABLE|CREATE INDEX|DROP)" migrations/<file>.sql

# What columns does a migration add / rename?
grep -E "ADD COLUMN|RENAME COLUMN" migrations/<file>.sql
```

Watch for:
- Migrations sharing a number prefix (e.g., `125_spaces.sql` and `125_temporal_saliency.sql`) — the F2 runner will need a stable order; today, alphabetical-after-prefix is the de-facto rule but verify nothing depends on a specific order.
- Migrations whose `@scope:` annotation is **inconsistent with what they ALTER**. The canonical surprise: `125_spaces.sql` is annotated `@scope: operator` but adds `users.type` and `users.created_by` columns; the `users` table also lives in every tenant DB and code queries `users.type` against tenant DBs. Re-classifying these is its own follow-up; for the immediate parity check, treat the migration as effectively `both` if its ALTERs touch a tenant-present table.

**Output of Step 1:** a numbered list of in-scope migrations + the set of (table, columns_added/altered, indexes_created) tuples they introduce.

## Step 2 — Snapshot every D1's current schema for the affected tables

For each table the in-scope migrations touch, dump the column list from every D1 in the fleet. Use wrangler with the operator DB's wrangler.toml:

```bash
cd packages/worker

# Operator (admin) DB:
npx wrangler d1 execute mycelium-db --remote \
  --command "SELECT name FROM pragma_table_info('<table>') ORDER BY cid" \
  | grep '"name":' | sed 's/.*"name": "\(.*\)".*/\1/' | sort > /tmp/admin_<table>.txt

# Each tenant — list with: SELECT handle FROM provisioning_jobs WHERE status='ready'
for handle in 0mm puh nati; do
  npx wrangler d1 execute mycelium-tenant-$handle --remote \
    --command "SELECT name FROM pragma_table_info('<table>') ORDER BY cid" \
    | grep '"name":' | sed 's/.*"name": "\(.*\)".*/\1/' | sort > /tmp/${handle}_<table>.txt
done

# Diff each tenant against admin:
for handle in 0mm puh nati; do
  echo "=== $handle vs admin ==="
  diff /tmp/admin_<table>.txt /tmp/${handle}_<table>.txt
done
```

Also enumerate **tables**, not just columns, when an in-scope migration creates a new table:

```bash
npx wrangler d1 execute <db> --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

**Output of Step 2:** per-tenant diff against the operator schema for every affected table — one of:
- ✓ identical — that tenant is at parity for this table
- ⨯ missing N columns — list them
- ⨯ has wrong-name columns (rename gap, e.g., tenant has `vitality` but operator has `coherence`) — list before/after
- ⨯ missing table entirely

## Step 3 — Classify the drift type

For each gap from Step 2, identify which of the following caused it:

- **(N) Migration never applied** — tenant DB is missing all columns/tables the migration introduces. Apply the migration verbatim.
- **(P) Migration partially applied** — tenant DB has SOME columns from a migration but not others (typical when an earlier `wrangler d1 execute` failed mid-multi-statement). Re-running will hit `duplicate column` errors on the parts already there. Apply the missing pieces individually.
- **(R) Pre-rename state** — tenant DB has the old column names (e.g., `vitality` instead of `coherence`). The rename migration (e.g., `146_rename_to_vitality.sql`) hasn't been applied. Apply only that rename migration.
- **(W) Wrong scope annotation** — operator DB has the column but the migration is annotated `@scope: operator` so tenants never received it. Fix in two parts: (a) immediately apply the relevant ALTER to each tenant DB by hand; (b) follow up by correcting the migration's `@scope:` annotation to `both` and updating `scripts/fleet-migrations-classification.json`.
- **(O) Out of scope for this skill** — operator-only table that genuinely doesn't belong on tenants (e.g., `fleet_registry`, `provisioning_jobs`, `handle_reservations`). Verify this is intentional; the gap is correct.

The output is a per-host classification table:

```
Tenant: 0mm
| Migration | Affected | Drift type | Resolution                                  |
|-----------|----------|------------|---------------------------------------------|
| 125_spaces.sql | users.type, users.created_by | (W) | Wrong scope. Apply ALTERs manually + reclassify migration |
| 127_territory_frequency.sql | territory_profiles.current_frequency, .current_state | (N) | Apply verbatim |
| 146_rename_to_vitality.sql | territory_profiles.{vitality→coherence, current_*→...} | (R) | Apply rename verbatim |
```

## Step 4 — Apply with idempotency-aware error handling

Apply each migration to each affected tenant via wrangler. SQLite's `ALTER TABLE ADD COLUMN` is **not idempotent** — re-running a migration whose first statement already succeeded will error on subsequent statements. Strategy:

```bash
# For each (tenant, migration) pair:
npx wrangler d1 execute mycelium-tenant-<handle> --remote --file=migrations/<migration>.sql 2>&1 \
  | tee /tmp/apply_<handle>_<migration>.log

# Acceptable errors that mean "already applied at the column/index level":
#   - "duplicate column name: <X>: SQLITE_ERROR"
#   - "table <X> already exists: SQLITE_ERROR"
#   - "index <X> already exists: SQLITE_ERROR"
# Treat these as soft-fail and continue.

# Hard fails to STOP for:
#   - "no such table" referenced by an INSERT/UPDATE/DELETE in the migration body
#   - constraint violations on data backfill
#   - any error outside the soft-fail list
```

For drift type (P) — partial application — DO NOT re-run the whole migration. Instead, apply ONLY the missing slice:

```bash
# Example: 0mm has 11 of 13 columns from a migration. Apply only the 2 missing ALTERs:
npx wrangler d1 execute mycelium-tenant-0mm --remote \
  --command "ALTER TABLE users ADD COLUMN welcome_shown_at TEXT; ALTER TABLE users ADD COLUMN onboarding_dismissed_at TEXT;"
```

For drift type (W) — wrong scope — apply the relevant ALTERs verbatim to tenant, then file a follow-up to fix the migration's annotation. Do not silently change the annotation in this PR; that change deserves its own commit so future fleet-migration runs (when F2 lands) inherit the right scope.

## Step 5 — Verify post-apply schema parity

Re-run Step 2's diff. Every tenant should now be **identical to admin** for every in-scope table. If any diff remains, return to Step 3 and classify what's left.

```bash
for handle in 0mm puh nati; do
  npx wrangler d1 execute mycelium-tenant-$handle --remote \
    --command "SELECT name FROM pragma_table_info('<table>')" \
    | grep '"name":' | sed 's/.*"name": "\(.*\)".*/\1/' | sort > /tmp/${handle}_after.txt
  diff /tmp/admin_<table>.txt /tmp/${handle}_after.txt && echo "  ✓ $handle at parity"
done
```

For tables that were freshly created on a tenant: also verify indexes (the index DDL in the migration may have been part of a multi-statement that errored mid-way):

```bash
npx wrangler d1 execute mycelium-tenant-<handle> --remote \
  --command "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='<table>'"
```

## Step 6 — Smoke-test the surface that surfaces drift errors

For every `(tenant, table)` pair where drift was fixed, exercise the code path that queries it. The simplest validation: restart the tenant's `personal-agent` and watch fresh log lines for ~60 seconds:

```bash
ssh <handle> "pm2 restart personal-agent && sleep 30 && pm2 logs personal-agent --lines 100 --nostream 2>&1 | grep -E 'no such column|no such table|SQLITE_ERROR|D1_ERROR' | head -5"
# Expect: zero matches
```

If the affected code path is only triggered by user action (e.g., a slash command, a portal page load), trigger it explicitly and watch logs. **Do not declare parity until a real query against the affected table has succeeded post-apply.**

## Step 7 — Audit log + handoff trail

The output of this skill MUST be a paste-able ledger. Drift incidents lose context fast (days later, "wait, why did 0mm have current_frequency but no current_state?" is a question with a fading answer). The ledger goes into the deploy notes / handoff doc / commit message — wherever future-you will find it.

Format:

```
=== Tenant Schema Parity Ledger — <date> ===
Trigger: <new migration | fleet deploy | runtime error | new tenant>
In-scope tables: <list>
In-scope migrations: <list>

Per-tenant pre-state:
  0mm: missing 12 columns on territory_profiles (drift type N)
       missing 4 columns on users (drift type W — 125_spaces.sql @scope: operator but ALTERs tenant table)
  puh: at parity
  nati: missing 4 columns on territory_profiles (drift type R — pre-vocab rename)

Applied:
  0mm: 17 tenant migrations (125-156) → 17 OK, 9 soft-fails (duplicate column, expected)
  0mm: 4 manual ALTERs on users for type/created_by/welcome_shown_at/onboarding_dismissed_at
  0mm: 146_rename_to_vitality.sql
  nati: 146_rename_to_vitality.sql

Per-tenant post-state:
  0mm: ✓ at parity for territory_profiles + users
  puh: ✓ unchanged, at parity
  nati: ✓ at parity

Smoke:
  0mm: pm2 restart → zero `no such column` errors in 100 fresh log lines
  puh: pm2 restart → zero
  nati: pm2 restart → zero

Followups filed:
  - 125_spaces.sql @scope annotation should be `both` not `operator`
  - Continue investigating 0mm's missing tenant tables (3 tables still gap-vs-admin) — separate skill run
```

## Anti-patterns to refuse

- **"It works on admin, ship it."** Admin is the OPERATOR DB. Customer DBs are different beasts. Tenant parity is the only signal.
- **Applying migrations without `pragma_table_info` diff first.** SQLite ALTERs are not idempotent; running a migration on a tenant that already has half of it produces a confusing partial-apply state.
- **Trusting `@scope:` annotations blindly.** The annotation is a hint, not a guarantee. If the migration's body ALTERs a tenant-present table, it's effectively `both` regardless of the header.
- **Ignoring `duplicate column` errors as cosmetic.** They ARE acceptable, but only after you've verified the column is the right type/default. A `duplicate column` on a column with the wrong default is silent corruption.
- **Skipping the smoke test because "schema diff was clean."** The runtime path may stitch columns from multiple tables; a parity check on one table doesn't prove the JOIN works.
- **Applying migrations from a dirty working tree.** The local `migrations/` directory must reflect committed state — otherwise you might apply a migration that's still in WIP. Either commit first or `git stash` then apply.
- **Treating drift as "operator forgot."** Drift is a structural failure mode; the fix is F2 (auto-runner), not blame. Every drift incident this skill handles is data for the F2 spec.
- **Updating `@scope:` annotations as part of the fix.** That's a separate commit (annotate-migrations.js manifest change). Conflating them obscures the audit trail.
- **Skipping the post-apply parity verification.** "I ran the migration, exit code 0, done" — and then index DDL was in a separate statement that failed. Always re-run the diff.

## Mycelium-specific reminders

- Tenant DBs live behind Worker bindings: `DB_TENANT_<user_id>` per [packages/worker/wrangler.toml](../../../packages/worker/wrangler.toml). The `mycelium-tenant-<handle>` D1 names are what wrangler accepts; the Worker uses the binding name with the user_id suffix.
- Customer hosts in the fleet today: `0mm`, `puh`, `nati` (per `~/.config/mycelium-ssh/customers.yml`). The list lives at `provisioning_jobs WHERE status='ready'` in the operator DB — query that for the canonical list rather than hardcoding handles.
- The `@scope:` annotation source of truth is `scripts/fleet-migrations-classification.json`. `scripts/annotate-migrations.js` reads it and writes the headers. To change a migration's scope durably, update the JSON and re-run the script (idempotent).
- The four valid `@scope:` values are `operator`, `tenant`, `both`, `all`, and `skip`. `both` and `all` mean the same thing (apply everywhere) — `all` is older usage and may be normalized to `both` later.
- F2 runner is the planned automated solution. Read [docs/FLEET-MIGRATIONS-PLAN.md](../../../docs/FLEET-MIGRATIONS-PLAN.md) for the full design. This skill bridges to F2 — once F2 ships and populates `schema_migrations` on every D1, Steps 1-5 collapse into "F2 ran, here's its drift report." Step 6 (smoke) and Step 7 (ledger) still apply.
- The `provisioning-daemon` PM2 process invokes `provision-customer.sh` per new tenant. New tenant DBs inherit whatever schema state `provision-customer.sh` initializes — verify a freshly-provisioned tenant ends up at parity with admin (this skill, run on new-tenant-creation).
- Some "operator-only" tables genuinely belong only on operator: `provisioning_jobs`, `handle_reservations`, `fleet_registry`, `fleet_attest_keys`, `fleet_health_reports`, `federation_keys`, `federation_log`, `deployment_log`, `crypto_payments`. Tenants legitimately don't have these. Keep an explicit allowlist in the audit ledger so they're not flagged as drift.
- Cross-DB JOINs are not supported by D1. If code does `JOIN users u` against a tenant DB but expects rows from the operator DB (e.g., spaces have type='space' on operator), there's an architectural assumption to verify — possibly a real bug, not a drift.

## Output expectations

When this skill fires, the user should see:
1. The Step 1 inventory (in-scope migrations + tables/columns they touch).
2. The Step 2 per-tenant diff snapshot (the "before" state).
3. The Step 3 classification table (drift type per row).
4. The Step 4 apply log (which migrations applied to which tenants, with soft/hard error annotations).
5. The Step 5 post-apply diff (the "after" state — should show full parity).
6. The Step 6 smoke-test result (fresh log lines, no SQL errors).
7. The Step 7 audit ledger ready to paste into a deploy note or handoff.

If parity is not achieved at Step 5, return to Step 3 and reclassify what's left. **Do not declare done until every tenant's diff is clean and the smoke test passes.**

The skill is meant to be invoked by Claude (or the operator) as the gate before any deploy that depends on schema parity. It is the prepared response to "drift will happen until F2 ships."
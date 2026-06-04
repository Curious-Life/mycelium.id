# Design — Connectors Tier 2 (health UI · daily budget · dedicated table · multi-account)

**Date:** 2026-06-04
**Source:** `docs/BENCHMARK-data-connections-2026-06-04.md` Tier 2 adopt-list (#5–#8).
**Base:** `origin/main` `e76eb00` (after #64 AI-interface + #78 remote-access + #80 Tier 1).
**Status:** SWEEP-FIRST DESIGN — verified, awaiting approval. **No code written yet.**

> Method: 4 parallel read-only sweeps (providers-precedent+crypto/migration · connector internals+multi-account seams · OAuth multi-account · budget+health UI), then I pressure-tested the spine (encryption wiring, db wiring, schema, latest migration) against source myself. Citations are `file:line` in the worktree.

---

## 1. What the sweep changed vs the initial framing (assumptions corrected)

The benchmark framed Tier 2 as "dedicated `connectors` table → multi-account, daily budget, health UI." The sweep refined this materially:

| # | Assumption (initial) | Verdict | Reality (file:line) |
|---|---|---|---|
| A1 | A `providers` table is the precedent to mirror | **NUANCED** | Table is **`ai_providers`**, secret col is **`credentials`** (JSON envelope), and it **pre-exists in `migrations/0001_init.sql:119`** — #64 added only the namespace+router+verify+`ENCRYPTED_FIELDS` entry. A new `connectors` table needs a **new migration (0008)**. |
| A2 | Encrypt the table with SYSTEM_KEY (like secrets) | **REFUTED** | `ai_providers` uses **USER_MASTER_KEY** — `SYSTEM_KEY_TABLES = {secrets}` only (`crypto-local.js:1332`). User-owned connector data ⇒ USER key. (Tokens stay in `secrets`/SYSTEM key — see A6.) |
| A3 | Look up rows via select-all+filter (like secrets/folders) | **REFUTED** | `ai_providers` keeps **plaintext queryable columns** (`provider`, `user_id`, `status`, integer PK) and does normal `WHERE` (`db/providers.js:28,73,95,106`). Only `secrets`/`folders` select-all+filter — because *their key is encrypted*. ⇒ connectors must keep a **plaintext stable id**. |
| A4 | `connections` table can hold connectors | **REFUTED** | `connections` is the **social graph** (federation/WebFinger, `db/connections.js:1-13`). Name is taken ⇒ use **`connectors`**. |
| A5 | Reuse the `oauth_states` table for multi-account pending-auth | **REFUTED** | `oauth_states` is **not wired into the local db** (no `db.oauthStates` in `db/index.js`), is **plaintext D1**, and `validate()` returns `{user_id, redirect_url}` (no `pkce_verifier`/connection slot). Reusing it would **regress the "PKCE verifier stays encrypted" invariant**. ⇒ keep pending-auth in the **encrypted secrets** namespace. |
| A6 | The connectors table holds the OAuth tokens | **NUANCED → SPLIT** | Tokens already live encrypted in `secrets` (SYSTEM key). Keep **tokens + transient `oauthState`/`pkceVerifier` in `secrets`** (re-keyed per connection); move only **operational STATE** to the new table. Bonus: fixes the per-cycle `secrets.list` O(all-secrets) decrypt-in-JS cost (`store.js:39-46` → `secrets.js:30-41`). |
| A7 | Daily budget can reuse #64's egress counter | **REFUTED** | #64's `egress-audit.js` is an append-only audit + an **in-memory 5-min** window — not a persisted per-entity daily counter (`egress-audit.js:24,36-51`). Daily budget is **net-new** (small). |
| A8 | Richer health UI needs new backend | **REFUTED (good news)** | `status()` **already emits** `lastOkAt/lastErrorAt/idleStreak/lastRun/recentRuns/itemsCreated/Updated/Deduped` (my Tier-1 change, `scheduler.js:43-58`); `ImportView` renders only a subset (`ImportView.svelte:59-62,386-407`). Health UI is **frontend-only**. |
| A9 | Multi-account is a field-rename | **REFUTED (it's the hard part)** | `connectionId == adapterId` is fused across ~12 sites; `status()` is **adapter-shaped** (one card per provider) and must **invert** to connection-shaped; the **OAuth callback can't tell which account from `:id` alone**. This is a model inversion + OAuth rethink + frontend rework. |

## 2. Forced pivots (the three that shape the build)

1. **OAuth callback must resolve by `state`, not `:id`.** Today `connect()` stores one `{oauthState, pkceVerifier}` in the single `connector:<id>:state` secret and `handleCallback()` matches against it (`scheduler.js:81,95-96`); the redirect URI is provider-fixed (`providers.js:59`). Two Gmail accounts collide. **Pivot:** mint a `connectionId` + nonce at connect; store an **encrypted** pending-auth record `connector:pending:<state>` → `{provider, connectionId, accountLabel, pkceVerifier, expiresAt}`; the callback resolves the target connection from `state` (the redirect URI stays provider-fixed, so no re-registration with Google/Linear). This *also* fixes the existing concurrent-connect clobber.
2. **`status()` inverts from adapter-shaped to connection-shaped.** Iterate *connections* (per user, from the table) and join the adapter by `provider` for `label`/`oauth`. The list endpoint + ImportView render N cards per provider + an "add account" action (no "create connection" route exists today — `connect` is create-by-side-effect).
3. **State store moves to a table; tokens stay encrypted.** STATE → `connectors` table (plaintext queryable columns + encrypted PII); TOKENS + pending-auth stay in `secrets`, re-keyed by `connectionId`.

## 3. The `connectors` table (mirrors the `ai_providers` pattern)

`migrations/0008_connectors.sql` — `CREATE TABLE IF NOT EXISTS connectors (...)`:

| Column | Plaintext? | Notes |
|---|---|---|
| `id` TEXT PK | plaintext | the **connectionId** (stable, generated). Lookup key — never encrypted. |
| `user_id` TEXT | plaintext | tenant filter/JOIN |
| `provider` TEXT | plaintext | enum (`gmail`/`linear`/…); adapter lookup key |
| `account_label` TEXT | **ENCRYPTED** | e.g. the account email — PII |
| `status` TEXT | plaintext | enum (disconnected/connecting/connected/syncing/error) |
| `cursor` TEXT | plaintext | incremental watermark (low sensitivity; keep queryable) |
| `connected_at`/`last_sync_at`/`last_ok_at`/`last_error_at` TEXT | plaintext | timestamps |
| `last_error` TEXT | **ENCRYPTED** | may contain provider detail |
| `idle_streak` INTEGER | plaintext | idle-backoff input |
| `items_last_sync`/`items_created`/`items_updated`/`items_deduped` INTEGER | plaintext | counts |
| `budget_date` TEXT, `items_today` INTEGER | plaintext | the daily budget counter (Phase 2a/2b) |
| `recent_runs` TEXT (JSON) | **ENCRYPTED** | last-10 run log (may carry error strings) |
| `created_at`/`updated_at` TEXT | plaintext | |

- **`ENCRYPTED_FIELDS.connectors = ['account_label', 'last_error', 'recent_runs']`**; **USER_MASTER_KEY** (omit from `SYSTEM_KEY_TABLES`).
- **No `scope` column** ⇒ NOT added to `SCOPE_AWARE_TABLES` (mirrors `ai_providers`). *(Caveat from the sweep: the scope-aware contract test does not exist in this checkout — keeping that set correct is manual; we simply don't touch it.)*
- `db/connectors.js` namespace mirrors `db/providers.js` (plaintext-key `WHERE`, never returns encrypted cols in `list()`); wired in `db/index.js`.
- TOKENS remain `secrets`: `connector:<connectionId>:tokens`; pending-auth `connector:pending:<state>`.

## 4. Phased plan (ship value early, de-risk the inversion last)

**Phase 2a — Health UI + daily budget (LOW risk; ~frontend + tiny backend).** No schema, no multi-account.
- Health UI: widen `ConnectorStatus` (`ImportView.svelte:59-62`) + render `lastOkAt` (Active/Stale freshness), `lastError`→"Needs reconnect" CTA, `idleStreak` (paused-no-new hint), `recentRuns` (history), cumulative `itemsCreated/Updated/Deduped`.
- Daily budget: `{budgetDate, itemsToday}` in the existing `:state` JSON; rollover+increment+cap in `runSync` next to `MAX_ITEMS_PER_SYNC`; surface remaining in the UI.
- Verify: extend `verify-connectors`/`verify:connector-upsert` with health-field + budget-rollover assertions (health payload is currently untested).
- **Verify GO + :8796 preview + PR.**

**Phase 2b — Dedicated `connectors` table, single-account (MEDIUM risk).** Foundation; `connectionId = provider` (1:1) to stay drop-in.
- Migration 0008 + `ENCRYPTED_FIELDS` + `db/connectors.js` + wiring; move STATE off `:state` secret → table (tokens stay in secrets); one-time backfill of any existing `connector:<id>:state` → row; scheduler iterates table rows.
- Verify: `verify-connectors-store` (at-rest: `account_label`/`last_error` encrypted, plaintext id/provider queryable; CRUD; backfill; perf). **Verify GO + preview + PR.**

> **Phase 2b — SHIPPED 2026-06-04.** Migration `0008_connectors.sql` + `ENCRYPTED_FIELDS.connectors=['account_label','last_error','recent_runs']` (USER key) + `src/db/connectors.js` (wired in `db/index.js`) + `src/connectors/store.js` re-pointed (state→table; tokens + transient `oauthState`/`pkceVerifier`→`secrets`) + boot backfill of legacy `connector:<id>:state` + `scripts/verify-connectors-store.mjs` (S1–S7, GO). `scheduler.js` UNCHANGED — the store's public API (`getState/setState/patchState/listIds/remove`) is byte-identical; `getState` merges the transient OAuth fields back from the `:oauth` secret, `setState` splits them out. Regression guards `verify:connectors`/`verify:connector-upsert`/`verify:adapters` all GO.
> **Two encryption-layer gotchas that shaped the code (verified in `crypto-local.js`):** (1) the auto-encrypt INSERT parser encrypts only the `VALUES` group, **NOT** a `DO UPDATE SET` clause — so `db.connectors.put` does an explicit `SELECT → INSERT|UPDATE` (the `ai_providers` pattern), never `ON CONFLICT DO UPDATE`, or the PII params would write as plaintext. (2) `extractFirstValuesGroup`'s non-greedy `VALUES\s*\((.+?)\)` truncates at the first `)`, so a `datetime('now')` literal in INSERT VALUES corrupts param alignment — `created_at`/`updated_at` use column DEFAULTs and are omitted from INSERT; UPDATE sets `updated_at = datetime('now')` in SET (the UPDATE parser splits paren-aware → safe).
> **Deviation from §3 column list:** no separate `last_run` column — `lastRun` is derived as `recentRuns[0]` in `getState` (they are always set together in the runner, so this is behavior-preserving and avoids a redundant encrypted column). `provider` is resolved from the adapter registry at write time (fallback to id).

**Phase 2c — Multi-account (HIGH risk; own design doc).** The inversion.
- Pending-auth-by-nonce OAuth (pivot 1); `connectionId` decoupled from provider; `status()` connection-shaped (pivot 2); routes `:connectionId` + "connect another account"; tokens `connector:<connectionId>:tokens`; ImportView N-cards-per-provider.
- Verify: two concurrent Gmail connects don't collide; per-account tokens/state isolated; callback resolves by state. **Verify GO + preview + PR.**

## 5. Unchanged invariants
On-device token custody; **tokens stay AES-256-GCM in `secrets` (SYSTEM key), fail-closed**; localhost trust model; the single `captureMessage` ingestion choke-point; the Tier-1 content-aware upsert. No OAuth **broker** (rejected in the benchmark — would move tokens off-device).

## 6. Open decisions (for approval)
1. **Scope/order:** 2a only now? 2a+2b? or all the way to 2c? (Recommend **2a now** — highest value-per-risk, mostly frontend — then 2b, then 2c as a separate reviewed PR.)
2. **Is multi-account actually wanted** for this single-user vault, or is the table+health+budget (2a/2b) enough? (Multi-account is the heavy/risky part; worth confirming the product need before 2c.)

# HANDOFF — Connectors work (benchmark → Tier 1 → Tier 2a → **ready for 2b**)

**Date:** 2026-06-04. **Audience:** a fresh session resuming at **Phase 2b** (dedicated `connectors` table).
Self-contained: read this + the three design docs and you can build 2b without re-deriving anything.

---

## 0. TL;DR — where we are
- Benchmarked our data-connection design vs **openhuman** + **odysseus** → prioritized adopt-list (Tier 1 / Tier 2).
- **Tier 1 shipped & merged** (content-aware upsert + connector observability + idle-backoff + Obsidian path-stable ids + legacy convergence).
- **Tier 2a shipped, PR open** (per-connection daily budget + health UI).
- **Tier 2 fully designed** (2a/2b/2c) with a verified assumption table. **Next: build 2b** (the `connectors` table, single-account).

## 1. Repo / branch / worktree state
- `origin/main` = **`e76eb00`** (includes: #64 AI-interface layer w/ `ai_providers`/providers; #78 remote-access; #80 Tier 1; #76 benchmark doc).
- **Open PR:** **#81** `feat(connectors): health UI + per-connection daily budget (Tier 2a)` on branch **`feat/connectors-tier2`**. Awaiting user decision (merge / review / hold) — see §7.
- **Worktree for this work:** `/Users/altus/mycelium-tier2` on branch `feat/connectors-tier2` (off `e76eb00`).
  - `node_modules` and `portal-app/node_modules` are **symlinks** → `/Users/altus/mycelium.id/{,portal-app/}node_modules` (deps verified identical). **Never `git add` them.** If main advances with new deps, re-check parity before trusting the symlinks.
- **Live app checkout** `~/mycelium.id` is on **stale main `b90fa2a`** — `git pull` there to run the merged app. Don't disturb its working tree (worktrees are created from it but don't touch it).
- Latest migration = **`0007_messages_content_hash.sql`** → **next is `0008`**.

## 2. Shipped ledger (all via GitHub PRs; no direct main push)
| PR | What | State |
|---|---|---|
| #76 | `docs/BENCHMARK-data-connections-2026-06-04.md` | **merged** |
| #80 | Tier 1: content-aware upsert (edits propagate) + `last_error`/`last_ok`/audit-log + idle-backoff + Obsidian path-stable id + legacy convergence; Linear stable id; metadata-preserving update; unconditional single-flight | **merged** (`b092765`) |
| #81 | Tier 2a: daily budget + health UI | **OPEN** (`ca36b88`) |

## 3. Design docs (read these)
- `docs/BENCHMARK-data-connections-2026-06-04.md` — the dimension matrix vs openhuman/odysseus + adopt-list + the "webhooks need a hosted relay → local-first uses adaptive polling" reframe.
- `docs/DESIGN-connector-content-upsert-2026-06-04.md` — Tier 1 design + §8 security-review fixes.
- **`docs/DESIGN-connectors-tier2-2026-06-04.md`** — **THE 2b SPEC.** §1 verified-assumption table, §2 pivots, §3 the `connectors` table schema+encryption, §4 phased plan. **Build 2b from §3+§4.**

## 4. Current connector architecture (post Tier 1 + 2a)
Files under `src/connectors/`:
- **`registry.js`** — process-global Map of adapters keyed by `adapter.id`. `registerAdapter/getAdapter/listAdapters/_resetRegistry`.
- **`index.js`** — `registerBuiltinAdapters()` (gmail+linear always; mock if `MYCELIUM_CONNECTORS_MOCK=1`); re-exports runner/scheduler/registry/store + `connectorDueAt`, `dailyItemLimit`.
- **`store.js`** — per-connector persistence in the **encrypted `secrets`** table: `connector:<id>:tokens` + `connector:<id>:state` (both JSON). `getTokens/setTokens/getState/setState/patchState/remove/listIds` (listIds = regex over `secrets.list({prefix:'connector:'})`).
- **`scheduler.js`** — `createConnectorRunner({db,userId,enqueueEnrichment})` → `status/connect/handleCallback/disconnect/runSync` + `running` Set (single-flight, UNCONDITIONAL). `startConnectorScheduler` (setInterval 5min, idle-backoff via `connectorDueAt`). `runSync` does: budget rollover/gate → token refresh → `adapter.pull({cursor})` → `captureMessage` per item (content-aware upsert) → patch state (cursor, lastOk/Err, items*, idleStreak, recentRuns, **budgetDate/itemsToday**).
- **`oauth.js`** — `createPkce`(S256) / `createState` / `buildAuthUrl` / `exchangeCode` / `refreshAccessToken` / `isExpired`.
- **`providers.js`** — `resolveProviderConfig(id,ctx)`: creds from env `MYCELIUM_<P>_CLIENT_ID/_SECRET` or encrypted secret `connector:<id>:client_id/_secret`; **redirectUri is provider-fixed** `…/connectors/<id>/callback`.
- **`adapters/{gmail,linear,mock}.js`** — `normalize()` pure + `pull(ctx,{cursor})`. **gmail id `gmail:<msgId>`, linear id `linear:<issueId>`** (both stable — edits upsert). content is stable (no volatile fields) — required by the **adapter content-stability contract** (re-enrich amplification guard).
- **`src/portal-connectors.js`** — routes mounted at `/api/v1/portal`, **relative strings** (`/connectors`, `/connectors/:id/{connect,callback,disconnect,sync}`). `:id` == adapter id today.
- **`src/server-rest.js` `completeBoot`** — `registerBuiltinAdapters()` → `createConnectorRunner({userId: bootUserId})` (always) → `startConnectorScheduler` only when `!injectedKeys`.
- Ingestion: every pulled item → `captureMessage` (`src/ingest/capture.js`) → the **single choke-point** to the mindscape. Tier-1 dedup = **content_hash** (plaintext col, migration 0007) → new/insert, same/no-op, changed/UPDATE+re-enrich (reset `nlp_processed=0`, null `embedding_768`, drop `clustering_points`). Forgotten rows never resurrect.
- Health fields already emitted by `status()` (Tier 1+2a): `lastOkAt,lastErrorAt,idleStreak,lastRun,recentRuns,itemsCreated/Updated/Deduped,budgetDate,itemsToday,dailyItemLimit`. ImportView renders them (2a).

## 5. Verified facts for 2b (from the sweep — `file:line` in the design doc §1)
- **Precedent = `ai_providers`** (table pre-exists `migrations/0001_init.sql:119`; #64 added only the namespace/router/verify). Secret col `credentials` is encrypted via `ENCRYPTED_FIELDS.ai_providers=['credentials']` (`crypto-local.js:214`), **USER_MASTER_KEY** (`SYSTEM_KEY_TABLES={secrets}` only, `crypto-local.js:1332`). Plaintext queryable cols (`provider/user_id/status` + integer PK) → normal `WHERE`, NO select-all+filter. Mirror this.
- **Template files to copy:** `src/db/providers.js` (namespace), `src/portal-providers.js` (router; `publicRow()` whitelist omits secret; `list()` doesn't SELECT it), `scripts/verify-providers.mjs` + `scripts/verify-providers-leak.mjs` (the leak script scans `DB` + **`-wal`** + `-shm` for a sentinel — copy this technique).
- **Encryption-on-UPDATE is safe** if the SET clause is parseable: `parseWriteSQL` UPDATE branch (`crypto-local.js:1248-1302`) uses `/s` dotall, counts `?` per assignment; encrypted cols encrypt, plaintext cols (incl. the stable id) don't; WHERE params come after SET and never encrypt. Order params SET-first.
- **`oauth_states` is NOT reusable** (unwired in `db/index.js`, plaintext D1, wrong shape) — irrelevant to 2b (only matters for 2c).
- **`connections` = social graph** — use the name **`connectors`**.
- **No scope column** → do NOT touch `SCOPE_AWARE_TABLES`. (Caveat: its contract test doesn't exist in this checkout — manual discipline; we add no scope col, so nothing to do.)
- `migrate.js` (`src/db/migrate.js:29-51`): `CREATE TABLE IF NOT EXISTS` idempotent; `ALTER ADD COLUMN` guarded. Auto-discovers `migrations/*.sql` lexically.

## 6. Phase 2b — BUILD PLAN (single-account; `connectionId == provider == adapter id`, drop-in)
Goal: move connector **STATE** off the `connector:<id>:state` secret blob into a real **`connectors`** table (queryable + faster — `listIds` today is O(all-secrets) decrypt). **Tokens + oauthState/pkceVerifier STAY in `secrets`.** No behavior change, no multi-account (that's 2c).

1. **`migrations/0008_connectors.sql`** — `CREATE TABLE IF NOT EXISTS connectors (...)` per design §3. Columns: `id TEXT PK` (=connectionId; for 2b = adapter id), `user_id TEXT`, `provider TEXT`, `account_label TEXT` (ENCRYPTED), `status TEXT`, `cursor TEXT`, `connected_at/last_sync_at/last_ok_at/last_error_at TEXT`, `last_error TEXT` (ENCRYPTED), `idle_streak INTEGER`, `items_last_sync/items_created/items_updated/items_deduped INTEGER`, `budget_date TEXT`, `items_today INTEGER`, `recent_runs TEXT` (ENCRYPTED JSON), `created_at/updated_at TEXT`.
2. **`crypto-local.js`**: add `connectors: ['account_label','last_error','recent_runs']` to `ENCRYPTED_FIELDS`. Leave `SYSTEM_KEY_TABLES` + `SCOPE_AWARE_TABLES` untouched (USER key, no scope).
3. **`src/db/connectors.js`** (mirror `src/db/providers.js`): `createConnectorsNamespace({d1Query})` → `list(userId)` (omit nothing sensitive in list? it's single-user — but mirror providers: don't return `recent_runs`/`last_error`/`account_label` in a `list()` that's ever exposed; the runner uses `get()`), `get(userId,id)`, `upsert(userId, row)` (INSERT … ON CONFLICT(id) DO UPDATE), `patch(userId,id,fields)` (dynamic SET — keep SET parseable for the encryptor), `remove(userId,id)`, `listIds(userId)`. Wire in `src/db/index.js` (mirror `providers:` line ~70).
4. **`src/connectors/store.js`**: keep `getTokens/setTokens` (secrets). Re-point `getState/setState/patchState/listIds/remove(state part)` to `db.connectors` (table) instead of the `:state` secret. Map the JSON keys → columns (status, cursor, lastSyncAt→last_sync_at, idleStreak→idle_streak, recentRuns→recent_runs JSON, budgetDate/itemsToday, etc.). Keep the runner's `store.getState()/patchState()` API identical so `scheduler.js` is largely unchanged. **oauthState/pkceVerifier** currently live in `:state` — for 2b keep them in a small encrypted secret (`connector:<id>:pending` or keep a slim `:state` secret just for those two transient fields) so they stay encrypted; do NOT put them in the table (2c formalizes pending-auth-by-nonce).
5. **One-time backfill**: on boot (or lazily in the runner), for each legacy `connector:<id>:state` secret with no table row → `db.connectors.upsert` the row, then delete the secret. Keep it idempotent.
6. **`scheduler.js`**: `status()` still iterates `listAdapters()` and reads `store.getState(a.id)` (now table-backed) — minimal change. `listIds()` (scheduler cycle) now reads table rows. `connectorDueAt`/idle-backoff/budget operate on the row fields (already mirror the JSON keys).
7. **`account_label`**: for 2b set it to the connected account identifier when available (Gmail: optionally fetch the email; Linear: the workspace) else null — it's the PII display field. Low priority; null is acceptable for 2b.
8. **Verify**: new `scripts/verify-connectors-store.mjs` — at-rest (scan DB+`-wal`): `account_label`/`last_error`/`recent_runs` NOT plaintext, `id`/`provider`/`status`/`cursor` queryable plaintext; CRUD via the namespace; backfill from a seeded legacy `:state` secret; the runner works end-to-end table-backed (connect→sync→status→disconnect). Wire into the `verify` chain in `package.json` (after `verify:connectors`). **`verify:connectors` + `verify:connector-upsert` are the regression guard** (they exercise the runner heavily) — they MUST stay GO.

## 7. Open decisions
- **PR #81 (Tier 2a):** user to decide merge / quick security-review / hold. 2b should **stack on 2a** — create a new branch off `feat/connectors-tier2` (e.g. `feat/connectors-table`) → stacked PR; retarget to `main` after #81 merges. (Gotcha: don't `--delete-branch` a branch that is the base of another open PR — it auto-closes the dependent. Retarget dependents to `main` first.)
- **Is multi-account (2c) actually wanted** for a single-user vault? Confirm before building 2c — it's the high-risk inversion (OAuth callback resolves by `state` via encrypted pending-auth; connection-shaped `status()`; ImportView "add account").

## 8. Procedure / gotchas (carry forward)
- **Per phase:** design (done) → implement → **full `npm run verify` GO** (capture real exit: `npm run verify > log 2>&1; echo $?` — **NO `| tail`**, it masks the exit) → **isolated `:8796` preview** (random injected keys, `portalMode:'auto'` serves `portal-app/build`; NEVER the Keychain; mock via `MYCELIUM_CONNECTORS_MOCK=1`) → **GitHub PR** (no direct main push).
- Current verify chain = **58 checks**. New verify scripts must be added to `package.json` `"verify"` AND defined.
- **Merge:** poll `gh pr view N --json mergeable,mergeStateStatus` — merge only on `MERGEABLE` (+ wait for the **`verify` GitHub Action** to go green; `UNSTABLE` = CI pending). If `DIRTY`, **rebase onto current main** and union-resolve the recurring **`package.json` verify-chain** conflict (keep both sides' verify steps; insert the new one). Force-push `--force-with-lease`, re-run full verify, re-watch CI.
- **Frontend:** `portal-app/build` is **untracked** (deploy artifact). `npm run portal:build` to build (validates Svelte). Edits to `.svelte`: match exact **tabs** (use `sed -n 'a,bp' file | cat -tev` to reveal `^I`); prefer **mid-line anchors** (no leading whitespace) for Edit. **Chrome MCP was NOT connected** in the build env → live browser screenshots of the workspace `/import` route weren't capturable; rely on build-compile + the `:8796` `/connectors` endpoint returning the bound fields.
- **Encryption invariants (non-negotiable):** tokens AES-256-GCM in `secrets` (SYSTEM key), connector table PII via USER key, **fail-closed** (missing key → REFUSE), on-device custody, localhost trust model. No OAuth **broker** (rejected in the benchmark).
- Reference repos still cloned at `/tmp/openhuman` (`87a91ae`) and `/tmp/odysseus` (`68eeb78`) for follow-up reads.

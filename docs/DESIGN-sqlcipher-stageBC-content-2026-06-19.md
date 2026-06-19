# Stage B/C — collapse content field-encryption into SQLCipher — Sweep-First Design

**Date:** 2026-06-19 (v3 — re-swept against `origin/main` `285a8fc`, post-Stage-A)
**Branch / worktree:** `feat/sqlcipher-stageBC-content` · `mycelium-id-worktrees/sqlcipher-stageBC`
**Audience:** the session implementing Stage B/C.
**Depends on (all MERGED + live):** Stage 0 mandatory at-rest (#299); Stage A vectors + bridge BLOB transport (#302/#303/#311/#322); backfill engine composite-PK fix (#325).
**Companions:** [`DESIGN-sqlcipher-backfill-engine-2026-06-19.md`](DESIGN-sqlcipher-backfill-engine-2026-06-19.md), [`DESIGN-sqlcipher-vectors-768-anchor-2026-06-19.md`](DESIGN-sqlcipher-vectors-768-anchor-2026-06-19.md), [`SESSION-HANDOFF-2026-06-19-sqlcipher-collapse.md`](SESSION-HANDOFF-2026-06-19-sqlcipher-collapse.md).

---

## TL;DR

**This is the stage that fixes the loading pain at its source.** The Library's multi-second open, Mindscape's JS-sorted topology, and the decrypt-on-every-read tax all come from **content columns being per-field AES-GCM envelopes** that can't be SQL-queried. Stage B stops encrypting them and backfills to plaintext-inside-SQLCipher; Stage C restores real SQL (indexes, `WHERE`, `ORDER BY`, `JOIN`) and retires the machinery.

**The foundational fact (re-verified firsthand):** the read path decrypts on **value shape** (`isEncrypted()`, `crypto-local.js:733-753`), not on `ENCRYPTED_FIELDS` membership (`:1822`). So the migration is **lazy + non-destructive**: shrink the map / drop the Python `_enc()` → new writes go plaintext → **old envelope rows keep decrypting on read** → backfill at leisure. No flag-day.

**What changed since v2 (the four v3 pivots):**
- **The backfill is already built.** Stage A shipped `src/account/backfill.js` (content codec, tested), the `POST /mycelium/backfill` endpoint, the `BACKFILL_TARGETS` allowlist, and `startBackfillJob` (backup → 0-envelope assert → single-flight → kill-switch → purge). **Adding a content column is a one-line allowlist entry** — the v2 "write a new `backfill-content-plaintext.mjs` (~220 LOC)" is DELETED.
- **The stop-write is per-WRITER, and JS writes none of the metrics tables.** Every `cognitive_metrics_*` / `fisher_*` / `frequency_snapshots` / `cognitive_events` row is written **only by Python** (`pipeline/compute-*.py`). Their JS `ENCRYPTED_FIELDS` entries are dead-on-write; the real stop-write is dropping the Python caller-encrypt.
- **`verify:leak` is reframed, not deleted.** It currently boots a *plaintext* DB and asserts field-encryption hides content. Post-collapse it must boot a *keyed* vault and assert whole-file SQLCipher hides content (the real production guarantee). Security floor unchanged.
- **`ENCRYPTED_FIELDS` is now 64 tables; vectors are excluded from auto-decrypt** (`NEVER_AUTO_DECRYPT_COLUMNS`, Stage A). Final target is still `{secrets}`.

**Confidentiality is unchanged** — everything stays inside the mandatory whole-file SQLCipher (Stage 0). We remove the redundant inner envelope, not the at-rest encryption.

---

## Revision history

- **v1 (handoff §"Stage B/C"):** shrink ENCRYPTED_FIELDS → {secrets}; stop ~12 Python writers; write a backfill script; restore SQL (topology/territory-docs/claims/people); `people.name` needs a hash or plaintext backfill.
- **v2 (pre-Stage-A sweep):** pivots 1-4 — `people.name` plaintext + `ON CONFLICT` (no hash); JS-vs-Python split; hot-path first; no current SQL touches an encrypted content column.
- **v3 (this doc — re-swept post-Stage-A against `285a8fc`):**
  - **Pivot A — backfill is infrastructure, not a script.** Reuse `backfillColumn`/`BACKFILL_TARGETS`/`startBackfillJob`/`POST /mycelium/backfill`. A content column = `{ table, column, codec: { kind: 'content' } }` in the allowlist (`src/portal-mindscape.js:13`). The content codec is already test-covered (`scripts/verify-backfill.mjs:49-55`). **−220 LOC vs v2.**
  - **Pivot B — stop-write routing is per-writer.** `grep` proved JS issues **no** `INSERT INTO cognitive_metrics_*/fisher_*/frequency_snapshots/cognitive_events` — those are Python-only (`compute-frequency.py:324`, `compute-criticality.py:160`, etc.). Removing them from the JS map is harmless cleanup; the stop-write is dropping the Python `_enc()`/`stage_crypto.enc`. **JS-map shrink stops only the JS-written tables** (documents/messages/facts/entities/people/realms/theme_cards/territory_profiles narrative + centroids). `territory_profiles` is dual-written (JS adapter for narrative + Python `batch_encrypted` centroids, which itself routes back through the JS adapter's `autoEncryptParams`) — so the JS-map removal covers both its JS path *and* its bridge-centroid path; only its Python *describe/dynamics* caller-encrypts (if any) need a Python edit. Decide per-column at build via the writer grep.
  - **Pivot C — `verify:leak` reframed to a keyed vault.** `verify-leak.mjs:19-20` boots `new Database(DB)` + `boot({ dbPath, ... })` with **no at-rest key** — its sanity check (`:96`, plaintext id IS in raw bytes) proves the file is plaintext. Its premise ("field encryption is the only thing hiding plaintext") is exactly what Stage 0 obsoleted. Reframe: boot keyed (mirror `verify-at-rest.mjs` A7), keep the token-scan, assert tokens **absent from the ciphertext file**; invert the integrity check to "token readable through the keyed connection." Keep the fail-closed parser checks + guardian scrubbers + DB-COL guard, narrowed to `secrets`.
  - **Pivot D — counts refreshed.** `ENCRYPTED_FIELDS` = **64 tables** (`crypto-local.js:209`); `NEVER_AUTO_DECRYPT_COLUMNS` = `{embedding_768, nomic_embedding, anchor_vector}` (`:1801`, Stage A); `SYSTEM_KEY_TABLES = {secrets}` (`:1664`). All line numbers in the verification table re-read.

---

## The ordering law (the #1 landmine — unchanged)

Per column, **always** in this order, **never** collapsed:
1. **Stop-write** — for a JS-written column, remove its table from `ENCRYPTED_FIELDS`; for a Python-written column, drop the `_enc()`/`stage_crypto.enc` in that writer's upsert. New rows land plaintext; old rows still decrypt (mixed, read-safe via `isEncrypted`).
2. **Backfill** — add the column to `BACKFILL_TARGETS`, run the in-app job → decrypt every remaining envelope → plaintext-inside-cipher. The job asserts **0 envelopes remain** (`countRemainingEnvelopes`) before purging its backup.
3. **Restore SQL** (the Stage-C query) + retire/invert that column's gate.

Querying a half-migrated column (step 3 before step 2 completes) silently mis-sorts/drops the still-envelope rows. The per-column "0 envelopes" assert is the gate that authorizes step 3.

---

## Threat model

Identical to Stage 0/A: confidentiality = mandatory whole-file SQLCipher. Content plaintext lives only *inside* the encrypted file; on disk it is ciphertext. We remove the inner per-field envelope (a zero-trust-operator / multi-tenant pattern with no local benefit). **`secrets` stays field-encrypted under SYSTEM_KEY** (`SYSTEM_KEY_TABLES={'secrets'}`, `crypto-local.js:1664`). Egress still flows through the existing chokepoints; the scope guardians become no-ops for content (kept only for `secrets` tagging). `people.name` plaintext-in-cipher is consistent with all other content and never leaves the boundary except via the explicit signed-sharing path.

**The leak gate is the canary.** Because `verify:leak` (reframed) and `verify:at-rest`/`verify:secrets` all scan the raw file bytes for plaintext, any regression that wrote a content column *outside* the SQLCipher file, or left `secrets` unencrypted, fails the build. We never lose the at-rest guarantee; we only stop paying for a second, redundant inner layer on content.

---

## Sweep findings (consolidated, file:line — re-read firsthand against `285a8fc`)

**Read is value-shape-driven (the make-or-break):** `autoDecryptResults` (`crypto-local.js:1814-1839`) iterates row values; line 1821 hard-skips `NEVER_AUTO_DECRYPT_COLUMNS` by name (vectors), then `:1822` `if (typeof value === 'string' && isEncrypted(value)) decrypt(...)`. `isEncrypted` (`:733-753`) detects an envelope from the value alone (base64 of `{"v,s,iv,ct,dk}`; fast-reject on the `ey` prefix), independent of any table map. ⇒ **shrink is read-safe; raw vector BLOBs are never misread** (skipped by name + binary bytes ≠ `ey…` JSON).

**Write is ENCRYPTED_FIELDS-driven:** `autoEncryptParams` (`crypto-local.js:1664-1780`) parses the write SQL, encrypts only the table's mapped columns, passes everything else through plaintext. Write chokepoint `src/adapter/d1.js:70`. ⇒ **remove a table → new JS writes plaintext, automatically.**

**Who writes what (the routing — grep-verified):** JS issues **zero** inserts/updates into `cognitive_metrics_*`, `fisher_*`, `frequency_snapshots`, `cognitive_events` (grep of `src/`). Python writers: `compute-frequency.py:324` (`frequency_snapshots`), `compute-criticality.py:160` (`cognitive_events`) + the `cognitive_metrics_{behavioral,coherence,criticality,anchor,harmonic}` / `fisher_{trajectory,milestones}` upserts in `compute-{behavioral,coherence,criticality,anchor,fisher}.py` + `compute_information_harmonics.py` + `compute-cross-scale-coupling.py`. Encrypt helpers: `crypto_local.encrypt_str/encrypt_bytes` (`pipeline/crypto_local.py:258-311`), wrapper `stage_crypto.enc` (`stage_crypto.py:39-58`). Python dual-read already in place: `stage_crypto.dec` (`:61-68`) passes plaintext through, decrypts envelopes — the content analog of Stage A's `decode_stored_vector` (`crypto_local.py:354-376`).

**Hot-path columns (backfill first):** Library list `src/db/documents.js:152` SELECTs encrypted `title, summary, metadata`, orders by plaintext `updated_at`. Mindscape `src/db/mindscape.js:53-102` reads encrypted narrative on `theme_cards`/`territory_profiles`/`realms`. Topology `src/db/topology.js` JS-coerces+sorts encrypted `territory_cofire.cofire_*` (`loadCofire` ~:83-94), `territory_neighbors.distance` (`loadNeighbors` ~:121-126), profile metrics, via `numOr0`/`coerceCols` (`:41,69-70`); `getAuditFindings` (`:407-426`) carries the explicit "message_count is ENCRYPTED → cannot be a SQL ORDER BY key" comment. Streams `src/db/streams.js:64-87` reads **only plaintext** — already fine.

**Decrypt-then-JS-sort restore targets (Stage C):**
- `topology.js`: getCoFiring/getOrphans/getBridges/getGaps/getCluster/walkGraph/getOrphanGaps/getAuditFindings — replace JS sort/filter/aggregate with SQL; delete `numOr0`/`coerceCols`/`coerceAuditNums`.
- `territory-docs.js`: getAllWithDynamics (`:69-98`, JS sort by `energy`), getDailyActivations (`:207-294`, JS filter+sort), getNeedingDescription (`:44-66` — `description_version` encrypted ⇒ `!= ?` only catches NULL; **plaintext fixes a correctness bug**, not just speed).
- `claims.js`: listActive (`:101-110`, comment "confidence_logodds is encrypted (can't ORDER BY it in SQL)"); `num()` helper (`:34`); consumers (`tools/claims.js`, `tools/mindscape.js`, `tools/context.js`) re-sort in JS today.
- `people.js`: `loadNameIndex` + JS upsert dedup (`:26-48`) because `name` is non-deterministic ciphertext → no `ON CONFLICT`. No hash column exists.

**No SQL on encrypted content columns:** grep of `src/db/` found WHERE/ORDER BY/JOIN only on plaintext keys (user_id, path, dates, ids). ⇒ Pivot 4 holds — no live query breaks mid-backfill; the only risk is Stage C *introducing* SQL before backfill completes (managed by the ordering law).

**Keep-as-plaintext (do NOT touch):** `documents.content_hash`, `harness_runs.prompt_hash`, `cognitive_anchor_vectors.seed_content_hash` — plaintext dedup keys.

**Gates (the inventory):** Encryption-specific gates that **invert** post-collapse: `verify:leak` (reframe to keyed — Pivot C), and the `isEnvelope()` side-assertions inside `verify-{complexity:26,frequency:28,criticality:29,coherence:31,behavioral:28,vitality:27}.mjs` + any `verify-*-encryption.mjs`. Gates that stay **GREEN + UNCHANGED** (the security floor): `verify:secrets`, `verify:at-rest{,-boot,-migration,-purge}`. New Stage-A gates already green: `verify:backfill`, `verify:backfill-nomic`, `verify:bridge-blob`. The umbrella chain is `package.json:149` (at-rest gates first, then content gates).

**Scale:** ~2 GB / ~69k-doc vault; backfill = decrypt+rewrite every envelope → the in-app job already batches, paginates (keyset), suspends WAL autocheckpoint, yields with `setImmediate` (the proven search-build recipe).

---

## Design

### Stage B — stop-write + backfill

**B1. Shrink JS `ENCRYPTED_FIELDS`** (per the implementation order, table-group by table-group; final state `{secrets}`; `crypto-local.js:209`). Each removal makes new JS writes to that table plaintext via `autoEncryptParams` pass-through. `secrets` + `SYSTEM_KEY_TABLES` untouched. This stops the **JS-written** tables (documents/messages/facts/entities/people/realms/theme_cards/territory_profiles + the bridge-centroid path that routes through the adapter).

**B2. Drop the Python caller-encrypt in lockstep** for the **Python-written** tables — remove the `_enc()`/`stage_crypto.enc` wrapper in each writer's upsert (`compute-{frequency,criticality,coherence,behavioral,anchor,fisher}.py`, `compute_information_harmonics.py`, `compute-cross-scale-coupling.py`). Python **decrypt-on-read stays** (`stage_crypto.dec`) for the mixed window. (Removing these tables from the JS map too is optional tidiness — it does not affect the write path since JS never writes them.)

**B3. Backfill via the existing engine** — for each fully-stopped column, add a one-line entry to `BACKFILL_TARGETS` (`src/portal-mindscape.js:13`) with `codec: { kind: 'content' }`, then trigger `POST /api/v1/portal/mycelium/backfill` with `{ confirm: true, targets: [...] }`. `startBackfillJob` (`src/jobs.js:278`) takes the pre-campaign ciphertext backup, runs `backfillColumn` per column, asserts **0 envelopes remain**, and purges the backup only on a clean run. **No new script.** Order = hot-first (see Implementation order).

### Stage C — restore SQL + simplify

**C1. Restore queries** (per fully-backfilled column, gated by its 0-envelope assert):
- `topology.js`: `WHERE cofire_* > ?` / `ORDER BY cofire_* DESC LIMIT ?` / `SUM(cofire_*) … GROUP BY` / `ORDER BY message_count DESC`; delete `numOr0`/`coerceCols`/`coerceAuditNums`.
- `territory-docs.js`: `ORDER BY energy DESC`, `WHERE energy > ? ORDER BY energy DESC LIMIT 10`, reliable `WHERE description_version != ?` (correctness fix).
- `claims.js`: `ORDER BY confidence_logodds DESC`; consumers drop their JS re-sort.
- `people.js`: plaintext `name` + `UNIQUE(user_id, name)` + `ON CONFLICT(user_id, name) DO UPDATE`; delete `loadNameIndex`/JS dedup. Add the unique index in a migration **after** `name` is backfilled + de-duped.

**C2. Reframe/invert gates** (per stage): reframe `verify:leak` to a keyed vault (Pivot C); invert the `isEnvelope()` side-assertions to plaintext-present + file-still-ciphertext; keep `verify:secrets` + at-rest gates green at every step.

**C3. Neutralize scope guardians** (`scopeGuardian`/`scopeEncryptGuardian`/`SCOPE_AWARE_TABLES`) — no-op for content; keep the `secrets` tagging path. Full deletion is a later cleanup.

### Module shape & LOC budget (v3 — backfill cost removed)
| Change | File(s) | ~LOC |
|---|---|---|
| Shrink `ENCRYPTED_FIELDS` → `{secrets}` (staged) | `src/crypto/crypto-local.js` | ~−380 / +5 |
| Drop Python `_enc()` (Python-written tables) | `pipeline/*.py` | ~40 (deletions) |
| Backfill: allowlist entries only (engine reused) | `src/portal-mindscape.js` | ~+15 |
| Stage-C SQL restores | `src/db/{topology,territory-docs,claims,people}.js` | ~−250 (net delete) |
| `people` unique-index migration | `migrations/00NN_people_name_unique.sql` | ~10 |
| Gate reframe (`verify:leak` keyed) + invert side-asserts (~7) | `scripts/verify-*.mjs` | ~150 |
| **Total** | | **~−400 net (mostly deletion)** |

### Edge cases
- **Mixed column mid-backfill:** read-safe (`isEncrypted` / `stage_crypto.dec` / `decode_stored_vector`); never run the Stage-C SQL until the 0-envelope assert passes.
- **Reader expects a number but gets an envelope during the window:** existing `num()`/`coerce*`/`dec*` helpers tolerate both — keep them until C1 lands, then delete.
- **`people.name` collision pre-unique-index:** de-dupe in the backfill (merge or suffix) before adding `UNIQUE`; the migration runs after the merge.
- **Python writer re-encrypts after a missed `_enc()`:** that column silently stays mixed → the per-column 0-envelope assert catches it before C1.
- **`territory_profiles` dual writers:** stop the JS map (covers narrative + bridge centroids) AND grep for any Python caller-encrypt on its describe/dynamics columns; stop both before its backfill.
- **Backfill interrupted:** idempotent (skip-if-plaintext) + resumable; the pre-campaign backup is the floor; re-POST returns `already_running`/resumes.
- **Synchronous backup blocks the HTTP response** on a 2 GB vault (known Stage-A rough edge): `curl --max-time` may time out while the job runs fine — poll the job status / check for the `.pre-backfill` file rather than retrying blindly.

### Test strategy
- **Per-column backfill:** covered by the existing `verify:backfill` content-codec assertions (round-trip, idempotence, 0-envelope gate, file-still-ciphertext). Extend `BACKFILL_TARGETS` and the live job proves each real column.
- **`verify:leak` reframed:** boot keyed; assert content tokens absent from the ciphertext file + readable through the keyed connection + `secrets` still field-encrypted. This becomes a *stronger* gate (proves the production property, not a test-only one).
- **Stage-C golden-diff:** each restored query returns **identical results** to the old JS-sort on a clone of the real vault (the decision metric).
- **Regression:** `verify:secrets`, `verify:at-rest{,-boot,-migration,-purge}`, the inverted side-gates, `verify:mindscape`/`topology-audit`/`claims`/`vitality`/`fisher`/`harmonics`, `verify:people`/`context`. Full `npm run verify` green per stage.
- **Live:** Library open, Mindscape render, a re-cluster, a metrics run — on a real-vault clone — before touching the live vault; measure Library cold-open + vault size (post-`VACUUM`) before/after.

### Implementation order (each independently shippable)
1. **Hot-path content (the felt win):** B1-shrink `documents` + mindscape-narrative tables → backfill those columns (allowlist) → C1-restore the Library list + mindscape readers. Ship + **measure the Library cold-open drop**.
2. **Topology metrics:** B1-shrink (JS) `territory_cofire/neighbors/vitality/profiles` → backfill → C1-restore topology.js SQL + delete `coerceCols`/`numOr0`.
3. **claims + people:** backfill → restore `claims.js` ORDER BY + `people.js` ON CONFLICT (+ unique-index migration).
4. **Bulk content:** `messages` (largest) + the long tail (facts/entities/wealth/health/tasks/chronicles/…) → backfill.
5. **Python-only metrics:** B2-drop the `_enc()` sites → backfill `cognitive_metrics_*`/`fisher_*`/`frequency_snapshots`/`cognitive_events`.
6. **Retire gates + neutralize scope guardians;** shrink `ENCRYPTED_FIELDS` to final `{secrets}`; reframe `verify:leak`; full `verify` green; `VACUUM` to reclaim envelope overhead.

### Decision criteria → done
The collapse is complete when: `ENCRYPTED_FIELDS == {secrets}`; **0 envelopes** in every non-secrets content column (queryable assertion); the Stage-C SQL returns golden-identical results; the **Library cold-open is sub-second and Mindscape/topology render without JS-sort stalls** (the felt goal); full `verify` green with `secrets` + at-rest gates intact; vault size (post-`VACUUM`) reflects the reclaimed envelope overhead.

---

## Risks + mitigations
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Stage-C SQL on a not-fully-backfilled column → silent mis-sort/drop | Med | Data-integrity (wrong results) | The ordering law + per-column **0-envelope assert** gates each restore; golden-diff on a clone |
| Python writer keeps encrypting after a missed `_enc()` (wrong-side / missed edit) | Med | Column stuck mixed forever | Per-table writer grep (Pivot B); 0-envelope assert catches it |
| `verify:leak` reframe weakens the at-rest guarantee | Low | Security | Keep `verify:at-rest`/`verify:secrets` UNCHANGED as the floor; reframed leak is additive (keyed-vault token scan) |
| Backfill corrupts the 2 GB vault | Low | Critical | Reused engine: reversible + batched + resumable + idempotent + pre-campaign backup + 0-envelope assert; copy-test first |
| `people.name` duplicate plaintext blocks `UNIQUE` | Med | Migration fails | De-dupe in backfill before the unique-index migration |
| A missed reader still expects an envelope | Low | Stage breaks | `num/coerce/dec` helpers dual-tolerate through the window; regression gates |

## Open questions
**Resolved this sweep:** read is `isEncrypted`-driven (shrink read-safe); the backfill is already built (allowlist add, not a new script); stop-write is per-writer and JS writes none of the metrics tables; `verify:leak` reframes to a keyed vault (not deleted); `people.name` → plaintext + ON CONFLICT (no hash); no live SQL on encrypted content columns.
**Deferred:** whether to *delete* the Layer-2 machinery or leave it dormant for `secrets` (recommend dormant — `ENCRYPTED_FIELDS={secrets}` + guardians as no-ops; full deletion later); `territory_profiles` centroid columns (`centroid_256/3d`) — fold into this stage's `territory_profiles` shrink or keep as JSON-in-cipher (decide at step 2); `description_version` semantics post-plaintext (becomes a normal version compare).

---

## Verification table
| # | Load-bearing assumption | Verified at (read firsthand) |
|---|---|---|
| 1 | Read decrypts on `isEncrypted(value)`, NOT `ENCRYPTED_FIELDS` membership → shrink is read-safe | `src/crypto/crypto-local.js:1822`, `733-753` |
| 2 | Vectors hard-skipped by name before the value check → raw BLOBs never misread | `crypto-local.js:1801` (`NEVER_AUTO_DECRYPT_COLUMNS`), `:1821` |
| 3 | Write encrypts only ENCRYPTED_FIELDS columns; removal → plaintext write | `crypto-local.js:1664-1780`; `src/adapter/d1.js:70` |
| 4 | `ENCRYPTED_FIELDS` = 64 tables; `SYSTEM_KEY_TABLES={'secrets'}` | `crypto-local.js:209` (counted), `:1664` |
| 5 | JS writes NONE of the metrics/fisher/frequency/event tables (Python-only) | `grep src/` (0 inserts); `pipeline/compute-frequency.py:324`, `compute-criticality.py:160` |
| 6 | Python dual-read already tolerates plaintext + envelope (mixed-window safe) | `pipeline/stage_crypto.py:61-68`; `crypto_local.py:354-376` |
| 7 | Library list SELECTs encrypted title/summary/metadata, orders by plaintext | `src/db/documents.js:152,157` |
| 8 | Topology/territory-docs/claims/people decrypt-then-JS-sort (SQL-restore targets) | `topology.js:41,69-70,407-426`; `territory-docs.js:44-66,69-98,207-294`; `claims.js:34,101-110`; `people.js:26-48` |
| 9 | No live SQL WHERE/ORDER BY/JOIN on an encrypted content column | grep `src/db/` (only plaintext keys filtered/ordered) |
| 10 | Backfill engine + endpoint + job exist; content codec tested; add = 1-line allowlist | `src/account/backfill.js:50,78`; `portal-mindscape.js:13,388`; `jobs.js:278,317-319`; `scripts/verify-backfill.mjs:49-55` |
| 11 | `verify:leak` boots a PLAINTEXT db (premise = field-encryption) → must reframe to keyed | `scripts/verify-leak.mjs:19-20,90-96` |
| 12 | At-rest A7 already blesses "plaintext column inside ciphertext file" (reframe template) | `scripts/verify-at-rest.mjs:88-89` + A7 |
| 13 | Side-gates assert `isEnvelope()` → invert post-collapse | `verify-complexity.mjs:26`; `verify-frequency.mjs:28`; `verify-criticality.mjs:29`; `verify-vitality.mjs:27` |
| 14 | Plaintext dedup keys to keep | `documents.js` content_hash; `harness.js` prompt_hash |

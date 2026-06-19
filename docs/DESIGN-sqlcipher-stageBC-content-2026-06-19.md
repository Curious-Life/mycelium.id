# Stage B/C — collapse content field-encryption into SQLCipher — Sweep-First Design

**Date:** 2026-06-19
**Branch / worktree:** `feat/sqlcipher-stageBC-content` · `mycelium-id-worktrees/sqlcipher-stageBC` (off `origin/main` `72233a2`)
**Audience:** the session implementing Stage B/C. **Depends on:** Stage 0 (#299) merged + live-smoked; Stage A (vectors) shipped + measured.
**Companions:** [`SQLCIPHER-COLLAPSE-HANDOFF-2026-06-19.md`](SQLCIPHER-COLLAPSE-HANDOFF-2026-06-19.md), [`DESIGN-sqlcipher-stage0-mandatory-2026-06-19.md`](DESIGN-sqlcipher-stage0-mandatory-2026-06-19.md), [`DESIGN-sqlcipher-stageA-vectors-2026-06-19.md`](DESIGN-sqlcipher-stageA-vectors-2026-06-19.md), [`PORTAL-LOAD-PERF-DESIGN-2026-06-19.md`](PORTAL-LOAD-PERF-DESIGN-2026-06-19.md).

---

## TL;DR

**This is the stage that fixes the loading pain at its source.** The Library's 14.7s, Mindscape's JS-sorted topology, and the decrypt-on-every-read tax all come from **content columns being per-field AES-GCM envelopes** that can't be SQL-queried. Stage B stops encrypting them and backfills to plaintext-inside-SQLCipher; Stage C restores real SQL (indexes, `WHERE`, `ORDER BY`, `JOIN`) and retires the machinery.

**The foundational fact (verified firsthand):** the read path decrypts on **value shape** (`isEncrypted()`), not on `ENCRYPTED_FIELDS` membership (`crypto-local.js:1804-1805`). So the migration is **lazy + non-destructive**: shrink the map → new writes go plaintext → **old envelope rows keep decrypting on read** → backfill at leisure. No flag-day.

**Scope:** shrink `ENCRYPTED_FIELDS` from **62 tables / ~392 columns** to **`{secrets}`** only; stop the **48 Python caller-encrypt sites** (9 files) in lockstep; backfill content columns (hot-path first); restore the **decrypt-then-JS-sort** sites (topology.js, territory-docs.js, claims.js, people.js) to SQL. `secrets` stays Layer-2; vectors are Stage A; centroids fold in here (Stage B).

**Confidentiality is unchanged** — everything stays inside the mandatory whole-file SQLCipher (Stage 0). We remove the redundant inner envelope, not the at-rest encryption.

---

## Revision history

- **v1 (handoff §"Stage B/C"):** shrink ENCRYPTED_FIELDS → {secrets}; stop 12 Python writers; backfill; restore SQL (topology/territory-docs/claims/people); `people.name` needs a hash or plaintext backfill.
- **v2 (this doc, post-sweep) — pivots:**
  - **Pivot 1 — `people.name` becomes plain plaintext + `ON CONFLICT(user_id, name)`, no hash.** A sweep agent recommended a deterministic `name_hash` to "keep PII out of plaintext at rest" — that's the *old multi-tenant* threat model. Under SQLCipher-only, plaintext-inside-the-cipher is the *whole design*; `name` joins the general backfill exactly like `documents.content`. Drop `loadNameIndex()`; restore the SQL upsert. Simpler, and consistent.
  - **Pivot 2 — the shrink locus is split JS vs Python.** Verified: `cognitive_metrics_{window,trajectory,per_territory}`, `cognitive_events`, `frequency_snapshots` are in **JS ENCRYPTED_FIELDS** (remove there); `cognitive_metrics_{anchor,behavioral,coherence,criticality,harmonic}`, `fisher_trajectory`, `fisher_milestones` are **Python-only caller-encrypt** (edit the Python `_enc()` in the writer). Stopping a column on the wrong side leaves it mixed forever — the lockstep checklist must route each column correctly.
  - **Pivot 3 — hot-path first.** The felt loading win is a *subset*: `documents.{title,summary,metadata}` (Library), `theme_cards/territory_profiles/realms` narrative + `territory_cofire/neighbors/vitality` metrics (Mindscape/topology). Backfill + restore these FIRST; the Python-only metrics tables (cold, off the open path) come last.
  - **Pivot 4 — no current SQL touches an encrypted content column.** Verified: every encrypted content column is `SELECT`-ed then sorted/filtered in JS *because* it can't be queried; there is no live `WHERE`/`ORDER BY`/`JOIN` on one. So no existing query silently breaks mid-backfill — the only risk is Stage C *introducing* SQL before that column is fully backfilled (managed by the ordering rule).

---

## The ordering law (the #1 landmine)

Per column, **always** in this order, **never** collapsed:
1. **Stop-write** (remove from JS `ENCRYPTED_FIELDS` *or* drop the Python `_enc()`) → new rows plaintext, old rows still decrypt (mixed, read-safe via `isEncrypted`).
2. **Backfill** → decrypt every remaining envelope in that column → plaintext-inside-cipher. Assert **0 envelopes remain**.
3. **Restore SQL** (the Stage-C query) + retire that column's gate.

Querying a half-migrated column (step 3 before step 2 completes) silently mis-sorts/drops the still-envelope rows. The backfill's per-column "0 envelopes" assertion is the gate that authorizes step 3.

---

## Threat model

Identical to Stage 0/A: confidentiality = mandatory whole-file SQLCipher. Content plaintext lives only *inside* the encrypted file; on disk it is ciphertext. We remove the inner per-field envelope (a zero-trust-operator/multi-tenant pattern with no local benefit). **`secrets` stays field-encrypted under SYSTEM_KEY** (`SYSTEM_KEY_TABLES={'secrets'}`, `crypto-local.js:1647`). Egress still flows through the existing chokepoints; the scope guardians become no-ops for content (kept only for `secrets` tagging). `people.name` plaintext-in-cipher is consistent with all other content and never leaves the boundary except via the explicit signed-sharing path.

---

## Sweep findings (consolidated, file:line — read firsthand)

**Read is value-shape-driven (the make-or-break):** `autoDecryptResults` (`crypto-local.js:1797-1822`) iterates row values; `if (typeof value === 'string' && isEncrypted(value)) decrypt(...)` (1804-1805); `isEncrypted` (716-736) detects an envelope from the value alone (base64 of `{"v,s,iv,ct,dk}`), independent of any table map. ⇒ **shrink is read-safe.**

**Write is ENCRYPTED_FIELDS-driven:** `autoEncryptParams` (`crypto-local.js:1664-1767`) parses the write SQL (`parseWriteSQL`), looks up the table's columns in `ENCRYPTED_FIELDS`, encrypts only those params; a column not in the map passes through plaintext. Write chokepoint `src/adapter/d1.js:63-80` (mutates params, returns rewritten SQL); read chokepoint `d1.js:77-79` (`autoDecryptResults` on all rows). ⇒ **remove a table → new writes plaintext, automatically.**

**JS/Python split (verified):** JS `ENCRYPTED_FIELDS` = 62 tables. Python-only caller-encrypt (NOT in JS map): `cognitive_metrics_{anchor,behavioral,coherence,criticality,harmonic}`, `fisher_trajectory`, `fisher_milestones`. Python encrypts via `stage_crypto.enc()`/`crypto_local.encrypt_str` (`pipeline/crypto_local.py:307`, `stage_crypto.py:39`), **hardcoded per column** in each writer's upsert (no shared list) — `compute-{anchors,fisher,coherence,criticality,behavioral,frequency}.py`, `compute_information_harmonics.py`, `compute-cross-scale-coupling.py`, ~48 `_enc()` sites. Bridge-encrypt (via JS adapter): `cluster.py` `batch_encrypted` for `territory_profiles` centroids.

**Hot-path columns (backfill first):** Library list `src/db/documents.js:140` SELECTs encrypted `title, summary, metadata`. Mindscape `src/db/mindscape.js:51-112` reads encrypted narrative on `theme_cards`/`territory_profiles`/`realms` (name, essence, story_*, agent_*). Topology `src/db/topology.js` JS-sorts encrypted `territory_cofire.cofire_*`, `territory_neighbors.distance`, `territory_profiles.{message_count,current_vitality,energy}`. Streams `src/db/streams.js:64-86` reads **only plaintext** — already fine.

**Decrypt-then-JS-sort restore targets (Stage C):**
- `topology.js`: getCoFiring (148 `.sort` by strength), getOrphans (165,178), getBridges (200,213 SUM+sort), getGaps (229,239), getCluster (258,264), walkGraph (286,297), getOrphanGaps (346,367), getAuditFindings (410-425 — *explicit comment*: "message_count is ENCRYPTED → cannot be a SQL ORDER BY key; sort in SQL by severity then tie-break in JS"). `coerceCols`/`numOr0` become unnecessary.
- `territory-docs.js`: getAllWithDynamics (97 `.sort` by energy), getDailyActivations (280-284 filter+sort by energy), getNeedingDescription (45-48 — `description_version` encrypted ⇒ `!= ?` only catches NULL; **plaintext fixes a correctness bug**, not just speed).
- `claims.js`: listActive (107-108 — *comment*: "confidence_logodds is encrypted (can't ORDER BY it in SQL)"); `num()` helper; consumers `tools/claims.js`, `tools/mindscape.js`, `tools/context.js` re-sort in JS today.
- `people.js`: `loadNameIndex` + JS `upsert` dedup (3-8, 25-82) because `name` is non-deterministic ciphertext → no `ON CONFLICT`. No hash column exists today.

**No SQL on encrypted content columns:** grep found WHERE/ORDER BY/JOIN only on plaintext keys (user_id, path, dates, ids); encrypted columns are SELECT-only. ⇒ Pivot 4.

**Keep-as-plaintext (do NOT touch):** `documents.content_hash` (`documents.js:279`), `harness_runs.prompt_hash` (`harness.js:138,159`), `cognitive_anchor_vectors.seed_content_hash` — plaintext dedup keys.

**Gates asserting envelopes (rewrite/retire):** `verify-{health,topology,territory-scalars,fisher,harmonics,pipeline-cli}-encryption` + envelope-asserting parts of `verify-{complexity,frequency,criticality,coherence,behavioral,vitality,topology-audit}`. Each asserts "raw read does NOT contain the plaintext marker" (e.g. `verify-topology-encryption.mjs` TE1: `!rawCofire.includes('0.8')`). Post-collapse these **invert**: assert plaintext-in-column + file-still-ciphertext. **Keep green:** `verify:secrets`, `verify:at-rest{,-boot,-migration,-purge}`; **re-frame** `verify:leak`.

**Scale:** ~2 GB / ~69k-doc vault; backfill = decrypt+rewrite every envelope → treat like the search-build (batch, paginate, suspend autocheckpoint, yield).

---

## Design

### Stage B — stop-write + backfill

**B1. Shrink JS `ENCRYPTED_FIELDS` → `{secrets}`** (one map edit; `crypto-local.js:209`). Removes ~61 tables; new JS writes to those columns become plaintext via `autoEncryptParams` pass-through. `secrets` + `SYSTEM_KEY_TABLES` untouched.

**B2. Stop the Python caller-encrypt in lockstep** — per the split: the 7 Python-only metrics/fisher tables → remove the `_enc()` wrapper in each writer's upsert (`compute-*.py`, ~48 sites); the JS-mapped metrics tables (window/trajectory/per_territory/events/frequency) are covered by B1 (JS stops) but if Python *also* writes them, drop those `_enc()` too. **Decrypt-on-read stays** (`stage_crypto.dec_*`) for the mixed window.

**B3. Backfill** — `scripts/backfill-content-plaintext.mjs`: per column, in batches, `SELECT` rows where the value `isEncrypted`, `decrypt` → `UPDATE` plaintext, yield between batches, resumable, idempotent (skip already-plaintext). **Reversible:** back up the vault first (the migration's `.pre-cipher` pattern; note Stage-0 purge only runs on canonical boot, so the backfill keeps its own backup). **Order = hot-first:** (1) `documents.{title,summary,metadata}`; (2) mindscape narrative (`theme_cards`/`territory_profiles`/`realms`) + topology metrics (`territory_cofire`/`territory_neighbors`/`territory_vitality`); (3) `messages` content (largest); (4) people/facts/entities/wealth/health/tasks/etc.; (5) the Python-only metrics tables. Per column, assert **0 envelopes remain** before authorizing its Stage-C restore.

### Stage C — restore SQL + simplify

**C1. Restore queries** (per fully-backfilled column):
- `topology.js`: replace JS sort/filter/aggregate with `WHERE cofire_* > ?` / `ORDER BY cofire_* DESC LIMIT ?` / `SUM(cofire_*) … GROUP BY` / `ORDER BY message_count DESC` (drop the severity-then-JS tiebreak); `coerceCols`/`numOr0` deleted.
- `territory-docs.js`: `ORDER BY energy DESC`, `WHERE energy > ? ORDER BY energy DESC LIMIT 10`, reliable `WHERE description_version != ?` (correctness fix).
- `claims.js`: `ORDER BY confidence_logodds DESC` where wanted; consumers drop their JS re-sort.
- `people.js`: **plaintext `name` + `UNIQUE(user_id, name)` + `ON CONFLICT(user_id, name) DO UPDATE`**; delete `loadNameIndex`/JS dedup (Pivot 1). Add the unique index in a migration after `name` is backfilled.

**C2. Retire/rewrite gates** (per stage): invert the ~10 envelope-assert gates to assert plaintext-in-column + ciphertext-file; re-frame `verify:leak`; keep `verify:secrets` + at-rest gates green.

**C3. Neutralize scope guardians** (`scopeGuardian`/`scopeEncryptGuardian`/`SCOPE_AWARE_TABLES`, 9 refs) — no-op for content (single-user); keep the `secrets` tagging path. Delete in a later cleanup.

### Module shape & LOC budget
| Change | File(s) | ~LOC |
|---|---|---|
| Shrink `ENCRYPTED_FIELDS` → `{secrets}` | `src/crypto/crypto-local.js` | ~−380 / +5 |
| Stop Python `_enc()` (9 writers, ~48 sites) | `pipeline/*.py` | ~80 |
| Backfill tool (batched, reversible, resumable, per-column 0-envelope assert) | `scripts/backfill-content-plaintext.mjs` | ~220 |
| Stage-C SQL restores | `src/db/{topology,territory-docs,claims,people}.js` | ~−250 (net delete) |
| `people` unique-index migration | `migrations/00NN_people_name_unique.sql` | ~10 |
| Gate rewrites (~10) + `verify:leak` re-frame | `scripts/verify-*.mjs` | ~200 |
| **Total** | | **~700 (much of it deletion)** |

### Edge cases
- **Mixed column mid-backfill:** read-safe (`isEncrypted`); never run the Stage-C SQL until the 0-envelope assert passes.
- **A reader expects a number but gets an envelope (or vice-versa) during the window:** the existing `num()`/`coerce`/`dec_*` helpers already tolerate both (envelope→decrypt→number; plaintext→number) — keep them until C1 lands, then delete.
- **`people.name` collision during backfill** (two rows, same plaintext name, pre-unique-index): de-dupe in the backfill (merge or suffix) before adding `UNIQUE`; the migration must run *after* the merge.
- **Python writer re-encrypts after B1 (missed `_enc()`):** that column silently stays mixed → the per-column 0-envelope assert catches it before C1.
- **Re-cluster / pipeline run mid-migration:** writers now emit plaintext; readers dual-tolerate; safe.
- **Backfill interrupted:** resumable (idempotent skip-if-plaintext); the backup is the floor.

### Test strategy
- **Per-column backfill gate:** new `verify:content-plaintext` (parameterizable) — write plaintext, assert raw-read shows plaintext + file still ciphertext (no SQLite magic header) + adapter still decrypts a legacy envelope in the same column (mixed-state).
- **Stage-C golden-diff:** each restored query returns **identical results** to the old JS-sort on a clone of the real vault (the decision metric).
- **Regression:** `verify:secrets`, `verify:at-rest{,-purge}`, `verify:leak` (re-framed), `verify:mindscape`, `verify:topology-audit`, `verify:claims`, `verify:vitality`, `verify:fisher`, `verify:harmonics-encryption`→rewrite, `verify:health-encryption`→rewrite, `verify:people`/`verify:context`. Full `npm run verify` green per stage.
- **Live:** Library open, Mindscape render, a re-cluster, a metrics run — all on a real-vault clone — before touching the live vault; measure Library cold-open + vault size before/after.

### Implementation order (each independently shippable)
1. **Hot-path content (the felt win):** B1-shrink for `documents` + mindscape-narrative tables → backfill those columns → C1-restore the Library list + mindscape readers. Ship + **measure the Library cold-open drop**.
2. **Topology metrics:** stop-write (JS) → backfill `territory_cofire/neighbors/vitality/profiles` → C1-restore topology.js SQL + delete `coerceCols`.
3. **claims + people:** backfill → restore `claims.js` ORDER BY + `people.js` ON CONFLICT (+ unique-index migration).
4. **Bulk content:** `messages` + the long tail (facts/entities/wealth/health/tasks/chronicles/…) → backfill.
5. **Python-only metrics:** stop the `_enc()` sites → backfill `cognitive_metrics_*`/`fisher_*`.
6. **Retire gates + neutralize scope guardians;** shrink `ENCRYPTED_FIELDS` to its final `{secrets}`; full `verify` green.

### Decision criteria → done
The collapse is complete when: `ENCRYPTED_FIELDS == {secrets}`; **0 envelopes** in every non-secrets content column (queryable assertion); the Stage-C SQL returns golden-identical results; the **Library cold-open is sub-second and Mindscape/topology render without JS-sort stalls** (the felt goal); full `verify` green with `secrets` + at-rest gates intact; vault size reflects the reclaimed envelope overhead.

---

## Risks + mitigations
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Stage-C SQL on a not-fully-backfilled column → silent mis-sort/drop | Med | Data-integrity (wrong results) | The ordering law + per-column **0-envelope assert** gates each restore; golden-diff on a clone |
| Python writer keeps encrypting after JS shrink (wrong-side edit) | Med | Column stuck mixed forever | The JS/Python split checklist (Pivot 2); 0-envelope assert catches it |
| Backfill corrupts the 2 GB vault | Med | Critical | Reversible + batched + resumable + idempotent; copy-test first; keep backup |
| `people.name` duplicate plaintext blocks `UNIQUE` | Med | Migration fails | De-dupe in backfill before the unique-index migration |
| A missed reader still expects an envelope | Low | Stage breaks | `num/coerce/dec_*` helpers dual-tolerate through the window; regression gates |
| Gate churn hides a real leak | Low | Security | Re-frame (don't delete) `verify:leak`; keep `verify:secrets` + at-rest green at every step |

## Open questions
**Resolved:** read is `isEncrypted`-driven (shrink read-safe); JS-vs-Python split is real and per-table; `people.name` → plaintext + ON CONFLICT (no hash); no live SQL on encrypted content columns.
**Deferred:** whether to *delete* the Layer-2 machinery or leave it dormant for `secrets` (recommend dormant — `ENCRYPTED_FIELDS={secrets}` + guardians as no-ops; full deletion is a later cleanup); `description_version` semantics post-plaintext (becomes a normal version compare); centroid raw-bytes vs plaintext-JSON (fold into Stage A vectors or here — decide at step 2).

---

## Verification table
| # | Load-bearing assumption | Verified at (read firsthand) |
|---|---|---|
| 1 | Read decrypts on `isEncrypted(value)`, NOT `ENCRYPTED_FIELDS` membership → shrink is read-safe | `src/crypto/crypto-local.js:1804-1805`, `716-736` |
| 2 | Write encrypts only ENCRYPTED_FIELDS columns; removal → plaintext write | `src/crypto/crypto-local.js:1664-1767`; `src/adapter/d1.js:63-80` |
| 3 | `ENCRYPTED_FIELDS` = 62 tables/~392 cols; `SYSTEM_KEY_TABLES={'secrets'}` | `crypto-local.js` (counted), `:1647` |
| 4 | JS-vs-Python split (metrics/fisher tables not all in JS map) | `crypto-local.js` ENCRYPTED_FIELDS probe (window/trajectory/per_territory/events/frequency = JS; anchor/behavioral/coherence/criticality/harmonic/fisher_* = Python-only) |
| 5 | Library list SELECTs encrypted title/summary/metadata (the 14.7s) | `src/db/documents.js:140` |
| 6 | Topology/territory-docs/claims/people decrypt-then-JS-sort (the SQL-restore targets) | `src/db/topology.js:148,165,200,213,410-425`; `territory-docs.js:45-48,97,280-284`; `claims.js:107-108`; `people.js:3-8,25-82` |
| 7 | No live SQL WHERE/ORDER BY/JOIN on an encrypted content column | grep `src/db/` (only plaintext keys filtered/ordered) |
| 8 | `people.name` is non-deterministic ciphertext; no hash column exists | `src/db/people.js:3-8`; `migrations/0001_init.sql` (no name_hash) |
| 9 | Plaintext dedup keys to keep | `documents.js:279`; `harness.js:138,159` |
| 10 | Envelope-assert gates invert post-collapse | `scripts/verify-topology-encryption.mjs` TE1; `verify-health-encryption.mjs`; `verify-fisher-encryption.mjs` |

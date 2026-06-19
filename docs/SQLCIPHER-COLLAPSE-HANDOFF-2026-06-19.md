# Collapse field-encryption → SQLCipher-only — Handoff

**Date:** 2026-06-19
**Audience:** the next Claude Code instance executing this migration.
**Status:** DECIDED + inventoried; NOT started. Execute stage-by-stage, sweep-first, full `verify` green per stage.
**Companions:** [`docs/DESIGN-decrypt-perf-2026-06-19.md`](DESIGN-decrypt-perf-2026-06-19.md) (the decrypt-cache that shipped as the bridge), [`docs/AT-REST-BLINDNESS-DESIGN-2026-06-11.md`](AT-REST-BLINDNESS-DESIGN-2026-06-11.md) (the SQLCipher layer), memories `at-rest-blindness`, `embedding-storage-layout-candidate`, `deployment-local-primary`.

---

## TL;DR

**Decision:** Mycelium is a **local single-user** vault — **no multi-tenant, ever**. The application-layer per-field AES-256-GCM encryption ("layer 2") is a **cloud / zero-trust-storage pattern** that protects against threats this product doesn't have (untrusted DB operator, tenant isolation), at real cost (decrypt-on-every-read, no SQL queryability, base64-on-base64 vectors, event-loop stalls, a whole second crypto codebase in Python). The correct primitive for a local vault is **transparent whole-file encryption** — which we already have (SQLCipher, `deriveDbKey`).

**Plan:** Collapse to **SQLCipher-only**. Keep field-encryption ONLY for `secrets` (SYSTEM_KEY). Make SQLCipher **mandatory** (no plaintext-at-rest fallback). Then content reads are just transparent page-decrypt (cached), encrypted columns become **SQL-queryable again** (deleting piles of decrypt-then-JS-sort code), and vectors store as raw bytes (no bloat). **More secure** (less code = fewer footguns; effort redirected to key lifecycle + leak/egress) **and** far more performant.

**Bridge already shipped:** PR #289 (decrypt-once cache + `isEncrypted` prefix-guard) removes the acute "decrypt all the time" pain TODAY and keeps helping for old (still-encrypted) rows during the transition. Confirm its merge status before starting.

**This is a real, multi-day, staged project** — but the data migration is **lazy and non-destructive** (mixed encrypted/plaintext vaults read correctly), so it de-risks into stages with backfills between.

---

## Why (threat model — the load-bearing rationale)

For a local single-user vault the realistic threats are: **device/disk theft, backup/sync exposure, key compromise, and plaintext leakage through the app's own surfaces (logs/errors/egress).** Whole-file SQLCipher fully covers at-rest (1, 2). The real security lives in (3) **key lifecycle** and (4) **zero-leak discipline** — NOT in whether a field is encrypted twice. Once unlocked, plaintext is in process RAM either way; an attacker who can read it already has the key, so layer 2's "narrow window" is largely theater locally.

What does NOT apply locally and is the *entire* reason layer 2 exists: multi-tenant isolation, "the DB/host operator must not see plaintext", per-scope cryptographic separation between agents. **None of these are real for a single-user local product.** So layer 2 is cost without benefit here — and complexity is itself a security liability.

**Keep `secrets` field-encrypted** (SYSTEM_KEY, API tokens/OAuth) — it's cheap and the one place a separate-key story is plausible. Everything else → SQLCipher.

---

## The CRITICAL ordering constraint (read this twice)

`isEncrypted()` ([crypto-local.js:716](../src/crypto/crypto-local.js)) is **value-shape-driven** — it detects an envelope per-value, so a column can be **MIXED** (some rows envelope, some plaintext) and reads still work (`autoDecryptResults` passes plaintext through, decrypts envelopes). This is what makes the migration lazy/non-destructive.

**BUT:** you **cannot** `WHERE`/`ORDER BY`/`JOIN` on a column until it is **FULLY backfilled to plaintext** — a query over a half-migrated column silently misses/mis-sorts the still-envelope rows. So each column flips in **three ordered steps**, never collapsed:

1. **Stop writing ciphertext** (shrink `ENCRYPTED_FIELDS` / stop the Python writer) → new rows plaintext, old rows still envelopes (mixed, reads fine).
2. **Backfill** — decrypt every remaining envelope in that column → plaintext (inside the SQLCipher file). Heavy, must be safe/resumable/reversible.
3. **THEN restore SQL** queryability (the §B2 targets) + retire that column's encryption gate.

Skipping step 2 before step 3 = silent data loss in queries. This is the #1 landmine.

---

## Staged plan

### Stage 0 — make SQLCipher MANDATORY (precondition)
Today at-rest is **opt-in with a plaintext fallback** ([open.js:43-44](../src/db/open.js) returns `null` → plaintext open when the file is plaintext AND `MYCELIUM_AT_REST` is off; gate in [db/init.js:79](../src/db/init.js)). The packaged app already sets `MYCELIUM_AT_REST` so it self-migrates + self-detects forever (#233). **Remove the plaintext-at-rest fallback** so the real vault is ALWAYS keyed (never `return null` for the real vault; keep plaintext only for the bare-`new Database` test fixtures). Without this, dropping field-encryption on a non-at-rest vault = plaintext on disk. Verify `verify:at-rest`, `verify:at-rest-boot`, `verify:at-rest-migration` stay green — these become the PRIMARY at-rest guarantee.

### Stage A — vectors (the contained first win; do this first)
Smallest cut, biggest standalone payoff (kills the ~2.43× base64-on-base64 bloat + the per-vector search-build decrypt). Columns: `messages/documents/territory_profiles/realms/semantic_themes.embedding_768`, `clustering_points.nomic_embedding`, `cognitive_anchor_vectors.anchor_vector`, `territory_profiles.centroid_256/centroid_3d`.
- Stop `encryptVector` (JS [decode.js](../src/search/ann/decode.js)) + `encrypt_vector` (Python [crypto_local.py:327](../pipeline/crypto_local.py)); store raw Float32 bytes (or sqlite-vec BLOB) directly inside the SQLCipher file.
- Remove the three names from `NEVER_AUTO_DECRYPT_COLUMNS` ([crypto-local.js:1710](../src/crypto/crypto-local.js)); `decryptVector`/`encryptVector` collapse to `decodeVectorBytes`/`encodeVector` (no crypto). Python `decrypt_vector` likewise.
- Backfill existing vector envelopes → raw bytes.
- Retire/rewrite `verify:nomic-embedding-encryption`, `verify:centroid-encryption`.
- NB: the on-disk search backend ([search/backend/sqlite.js:97-100](../src/search/backend/sqlite.js)) ALREADY stores raw sqlite-vec BLOBs inside the file — this is the proven pattern to follow.

### Stage B — content write-side (shrink the surface)
Shrink `ENCRYPTED_FIELDS` ([crypto-local.js:209](../src/crypto/crypto-local.js)) to the KEEP set (`secrets` + `SYSTEM_KEY_TABLES`). New JS writes become plaintext automatically (`autoEncryptParams` passes them through). **In lockstep**, stop the 12 Python caller-encrypt writers (Appendix C) — else those columns stay mixed forever. Then **backfill** content columns (Appendix B1) → plaintext. Reads keep working throughout (mixed-safe). The decrypt-cache (#289) softens old-row reads during this window.

### Stage C — restore SQL queryability + simplify
Once a column is fully backfilled, move its decrypt-then-JS-sort logic back into SQL (Appendix B2 — topology.js, territory-docs.js, claims.js, people.js). Retire/triage the encryption-assert gates (Appendix D). Neutralize the scope guardians (`scopeGuardian`/`scopeEncryptGuardian`, [crypto-local.js:86/134](../src/crypto/crypto-local.js)) + `SCOPE_AWARE_TABLES` — single-user, no longer load-bearing once content is plaintext (decide: no-op vs remove; keep for `secrets` if it still tags).

### KEEP (do NOT touch)
`secrets` field-encryption (SYSTEM_KEY); `SYSTEM_KEY_TABLES`; `deriveDbKey`/SQLCipher (made mandatory); `documents.content_hash` / `harness_runs.prompt_hash` / `seed_content_hash` (plaintext dedup keys — fine under whole-file cipher); the decrypt-cache (#289).

---

## Security invariants that MUST hold throughout

1. **The vault file is ALWAYS ciphertext at rest** — Stage 0 makes SQLCipher mandatory; never regress to a plaintext-on-disk vault.
2. **The DB-file key never touches disk/logs/env-dumps** — unchanged (`deriveDbKey`, memory-only).
3. **`secrets` stays field-encrypted** under SYSTEM_KEY — never fold it into the collapse.
4. **No plaintext leaves the encrypted boundary** — §1 discipline (logs/errors/egress). The `verify:leak` gate's value is now "no plaintext OUTSIDE the SQLCipher file" — re-frame it, don't delete it.
5. **Backfill is reversible** — back up the vault (the at-rest migration's `.pre-cipher-<ts>` pattern) before each backfill; batch + yield (per the search-build perf lessons); resumable + idempotent.
6. **Full `verify` green per stage** (no partial-suite merges — see memory `no-hotfixes-production-ready`).

This collapse is NOT a security downgrade for the local model — it's a *focus* of the security budget onto what matters: finish the **key lifecycle** hardening (Keychain/Secure Enclave + Touch ID unlock + zero-on-lock + idle re-lock — already designed, see `touch-id-secure-enclave-unlock`), and close the **open leak/egress holes** (the SSRF/BYOK HIGH + recovery-key, per `prepublish-security-audit`). Those are the real local-vault security wins; flag them alongside.

---

## Gotchas

- **Mixed-column ⇒ no SQL queries until backfilled** (the ordering constraint above). The #1 way to silently break things.
- **Python writers must stop encrypting in lockstep** with the JS `ENCRYPTED_FIELDS` shrink, or columns stay mixed (Appendix C). Several Python-written tables (`cognitive_metrics_*`, `fisher_*`) are caller-encrypt-only and are NOT in the JS `ENCRYPTED_FIELDS` — you change the Python writer, not the JS table.
- **~15 `verify:*-encryption` gates assert envelopes at rest** and will FAIL per flipped column (Appendix D) — update/retire them in the same stage, but KEEP `verify:secrets` + the 3 `at-rest` gates green.
- **`people.name` has no plaintext dedup key** — restoring `ON CONFLICT(name)` needs a full plaintext backfill of `name` (or a deterministic name-hash column). The one §B2 target without an existing plaintext key.
- **Duplicate `pipeline/*.py` copies** exist under `build-staging/`, `mycelium-worktrees/*/`, `reference/`, and the packaged-app Resources — canonical is `pipeline/*.py`.
- **Sandbox redacts auth/crypto tokens in `grep`** (`token`/`oauth`→`n`) and empties large files — use `awk`/`sed`/`Read` or `dangerouslyDisableSandbox`.
- **Backfill cost on the real ~2GB/69k vault is heavy** (decrypt+rewrite every encrypted field) — this is the most expensive + risky step; treat like the search-build (batch, paginate, suspend autocheckpoint, yield).

---

## Verification plan (per stage)

- **Stage 0:** `verify:at-rest`, `verify:at-rest-boot`, `verify:at-rest-migration` GO; a fresh + an existing vault both open keyed; no plaintext-fallback for the real vault.
- **Stage A:** new `verify:vectors-raw` (vector round-trips as raw bytes inside the cipher file; the file is still ciphertext at rest); `verify:search` GO; retire nomic/centroid encryption gates; benchmark the search-build before/after.
- **Stage B:** per column — write plaintext, backfill, assert 0 remaining envelopes in that column; `verify:leak` re-framed (file bytes are cipher); the decrypt path still returns correct values for mixed rows mid-migration.
- **Stage C:** the restored SQL queries return identical results to the old JS-sort (golden-output diff on a copy of the real vault); retire the column's encryption gate; full `verify` green.
- **Throughout:** `verify:secrets` + `providers-leak` STAY green (secrets untouched).

---

## Open decisions for the operator

1. **Scope guardians** — no-op them or delete? (Single-user; not load-bearing post-collapse, except `secrets` tagging.) Recommend: keep as a thin no-op initially, delete in a later cleanup.
2. **Backfill: eager or lazy?** Lazy (decrypt-on-read + opportunistic-on-rewrite, no forced pass) is safest but the perf win is gradual; eager backfill reclaims it now but is the heavy/risky step. Recommend: eager per-column backfill, gated behind a verified copy-test on the real vault.
3. **Order:** Stage A (vectors) alone is a clean, low-risk, high-value PR — ship it first and measure before committing to B/C. Recommend: yes.
4. **Adjacent security work** to fund with the saved complexity budget: finish Touch ID/Secure-Enclave unlock + close the SSRF/BYOK HIGH. Recommend: prioritize alongside.

---

## Pickup protocol

1. Read this handoff cold, then [`docs/DESIGN-decrypt-perf-2026-06-19.md`](DESIGN-decrypt-perf-2026-06-19.md) + `docs/AT-REST-BLINDNESS-DESIGN-2026-06-11.md`.
2. Confirm PR #289 (decrypt-cache) merge status — it's the transition bridge.
3. Run `/sweep-first-design` on Stage A; it's the contained first cut. Build it in a worktree (main tree is contested — `git worktree list` first), full `verify` green, PR.
4. Before ANY backfill: back up a copy of the real vault; copy-test the backfill on it; prove reversibility.
5. Honor the ordering constraint (stop-write → backfill → restore-SQL) per column. Never SQL-query a mixed column.
6. Keep `secrets` + the at-rest gates green at every step.

---

## Appendices (the worklist — file:line inventory, branch `main` 2026-06-19)

### Appendix A — KEEP bucket
`secrets`: `key`, `value`, `description` ([crypto-local.js:437](../src/crypto/crypto-local.js)). `SYSTEM_KEY_TABLES = {'secrets'}` (line 1573). Also in `SCOPE_AWARE_TABLES` (line 694).

### Appendix B1 — content tables to drop (STAGE B), table → columns
`ai_providers`(credentials) · `channel_access`(allowed_senders_json) · `connectors`(account_label,last_error,recent_runs) · `messages`(content,thinking,tags,entities,entity_summary,suggested_new_tag,relations,metadata,nlp_error) · `scheduled_tasks`(prompt) · `conversation_summaries`(summary) · `peer_messages`(content) · `sharing_contexts`(summary) · `inbound_shares`(name) · `documents`(content,summary,title,tags,entities,relations,metadata,entity_summary,source_path) · `facts`(value) · `entities`(name,aliases,summary) · `attachments`(transcript,file_name,description,metadata) · `clustering_points`(content) · `agent_events`(payload) · `agent_tasks`(context,result,description,summary,error) · `agent_customizations`(system_prompt,settings,tools_config) · `people`(name,aliases,description,metadata,email,phone,company,position,linkedin_url,notes,avatar_url) · `wealth_*`(7 tables — notes/amounts/labels) · `health_daily`(18 metrics) · `activity_sessions`(window_title,url,app_bundle,app_name) · `internal_model_items`(content,metadata) · `person_claims`/`person_claim_snapshots`(claim_type,content,confidence_logodds,decay_class,support,…) · `reflections`(content,trigger,metadata) · `tasks`(title,description,notes,metadata) · `folders` · `note_links` · `territory_profiles`(all narrative + energy/coherence/velocity/current_vitality/point_delta; centroids→Stage A) · `realms` · `entity_snapshots`(payload) · `semantic_themes` · `user_identities` · `provisioning_jobs` · `time_chronicles` · `current_arc_chronicles` · `contact_chronicles` · `territory_pass_notes` · `theme_cards` · `space_rooms` · `space_knowledge` · `share_links`(invited_email) · `cognitive_metrics_window`(82 scalars) · `cognitive_metrics_trajectory` · `cognitive_metrics_per_territory` · `cognitive_events` · `territory_cofire` · `territory_neighbors` · `topology_metrics` · `territory_vitality` · `complexity_snapshots` · `frequency_snapshots` · `topology_audit_snapshots` · `topology_audit_findings`. (Full column lists: `ENCRYPTED_FIELDS`, [crypto-local.js:209-658](../src/crypto/crypto-local.js).)

### Appendix B2 — restore-queryability targets (STAGE C; move JS-sort → SQL)
- **`src/db/topology.js`** (header 18-30): `getCoFiring`(142,148-149), `getOrphans`(165,178-179), `getBridges`(203,213-214), `getGaps`(229,236-240), `getCluster`(258,264-265), `walkGraph`(286,297,313-314), `getOrphanGaps`(346,367-368), `getAuditFindings`(408-426), `getBridgesWithHealth`(449-466); `coerceCols`/`coerceAuditNums`(58-70,388,404) become unnecessary.
- **`src/db/territory-docs.js`**: `getNeedingDescription`(44-58), `getAllWithDynamics`(85,97), `getDailyActivations`(279-284).
- **`src/db/claims.js`**: `listActive`(101-109), `num()`(34,49,185-188); consumers `src/tools/claims.js:68-69`, `src/tools/mindscape.js:59`.
- **`src/db/people.js`**: name dedup (26-36,42-48) → `ON CONFLICT(name)` once `name` plaintext (see gotcha).
- **NOT targets:** `messages.js:786,809` (vector sim), `mindscape.js`/`documents.js` (plaintext keys), `claims/*` LLM token algos, `secrets.js` (KEEP).

### Appendix C — Python writers to stop (STAGE A/B, in lockstep)
Module: `pipeline/crypto_local.py` (`encrypt_str`:307, `encrypt_vector`:327, `decrypt_vector`:221); helper `pipeline/stage_crypto.py:enc`:39; bridge `pipeline/local_db.py:batch_encrypted`:96.
- `cluster.py`(:526/:536 nomic_embedding — Stage A; :1487/1501/1538/1576/1781 send plaintext via bridge → stop once ENCRYPTED_FIELDS shrinks, route to plain `d1_batch`).
- `compute-anchors.py`(:160 anchor_vector — Stage A; :232 cognitive_metrics_anchor scalars).
- `compute-fisher.py`(:418-446 fisher_trajectory/milestones).
- `compute-frequency.py`(:321-338 frequency_snapshots).
- `compute_information_harmonics.py`(:487-518 cognitive_metrics_harmonic, 46 cols).
- `compute-cross-scale-coupling.py`(:343-356 cognitive_metrics_harmonic UPDATE).
- `compute-behavioral.py`(:149-156), `compute-coherence.py`(:113-121), `compute-criticality.py`(:169-188 + cognitive_events).

### Appendix D — encryption-assert gates to update/retire (per stage)
`verify:health-encryption`, `verify:centroid-encryption`(A), `verify:topology-encryption`, `verify:territory-scalars-encryption`, `verify:nomic-embedding-encryption`(A), `verify:fisher-encryption`, `verify:harmonics-encryption`, `verify:pipeline-cli-encryption`, `verify:providers-leak`, and the envelope-asserting parts of `verify:fisher/frequency/complexity/topology-audit/criticality/coherence/behavioral/anchors/cross-scale-coupling/mindscape-scalars/claims`. **`verify:leak`** → re-frame to "no plaintext outside the SQLCipher file". **KEEP green:** `verify:secrets`, `verify:at-rest{,-boot,-migration}`.

### Appendix E — precondition + mixed-state + derived columns
- At-rest opt-in/fallback to remove: [open.js:43-44](../src/db/open.js), [db/init.js:79](../src/db/init.js); boot wiring [index.js:119-122](../src/index.js) → `initVaultStorage` ([db/init.js:105](../src/db/init.js)); migration [db-cipher-migrate.js](../src/account/db-cipher-migrate.js); key `deriveDbKey` ([keystore.js:70](../src/account/keystore.js), HKDF `mycelium:db-cipher:v1`).
- Mixed-state OK: `isEncrypted` ([crypto-local.js:716](../src/crypto/crypto-local.js)), `autoDecryptResults`(1723), `decryptFields`(1428) — all per-value.
- Plaintext-derived (keep): `documents.content_hash` ([documents.js:279](../src/db/documents.js)), `harness_runs.prompt_hash` ([harness.js:138](../src/db/harness.js)), `cognitive_anchor_vectors.seed_content_hash`.

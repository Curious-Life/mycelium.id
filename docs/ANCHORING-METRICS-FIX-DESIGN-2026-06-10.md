# Anchoring-metrics fix — design (measurement-layer audit follow-up)

**Date:** 2026-06-10 · **Status:** locked, implementing · **Scope:** bug A of the measurement-layer audit (this session). Bugs B/C (dead tables, realms hygiene) are being handled in a separate spawned session — sweep findings for them are handed off in §Handoff below.

## Revision history

- **v1 (audit sketch):** "anchoring compares ciphertext — decrypt the two envelopes."
- **v2 (this doc, post-sweep):** the sweep found anchoring is *triply* dead: (1) ciphertext compares (coherence, engagement), (2) `last_active` has **no writer anywhere** — all 20 live territories are NULL — so the 30-day recency rule never fires either, (3) `is_anchored` is reset to 0 every run and only re-marked by these dead rules, so the flag can never become 1. Fix grew from "decrypt two fields" to "decrypt two fields + write last_active". Also cleared a suspect: `compute-criticality.py` correctly decrypts via `stage_crypto.dec_float` (compute-criticality.py:88) — the all-zero criticality rows are honest low-confidence data, not this bug class.

## Sweep findings (consolidated, load-bearing)

- Encryption boundary: Python writes go through `d1_batch_encrypted` → `pipeline/local-write-bridge.js` → `db.rawQuery` → `autoEncryptParams` keyed by the `ENCRYPTED_FIELDS` map (src/crypto/crypto-local.js:342-366 lists `territory_profiles: energy, coherence, velocity, …`; :419-422 lists `territory_vitality: …, engagement_depth_normalized, …`). Python **reads** via `local_db.query()` (pipeline/local_db.py:43-51) which returns raw ciphertext — no auto-decrypt exists on the Python read path, by design.
- The repo's canonical Python decrypt-read pattern is `compute-fisher.py:155` `_dec_float` (decrypt_bytes → float → None on failure); `compute-criticality.py` uses the same via `stage_crypto.dec_float`.
- `compute-vitality.js` reads through the JS adapter and is NOT affected (it sees plaintext).
- Anchor consumers: `anchored_ids` lowers the Jaccard threshold 0.3 → 0.15 (cluster.py:1154-1162) and enables a centroid-similarity backup (cluster.py:1209-1228); portal surfaces `isAnchored` read-only (src/portal-mindscape.js:131).
- The 0.6/0.7 thresholds are undocumented anywhere (docs gap, noted in code comment now).
- Timestamps on `territory_profiles` are plaintext by schema convention (`created_at`, `updated_at`, `last_described_at`, `last_active` — migrations/0001_init.sql:1376-1410); `last_active` recency is already derivable from plaintext `clustering_points.created_at`, so writing it leaks no new metadata class.

## The fix (2 deltas in `pipeline/cluster.py`, ~25 LOC)

1. **`_dec_num(value)` helper** (mirrors compute-fisher `_dec_float`): try `crypto_local.decrypt_bytes(value, _get_master_key())` → float; on envelope-decode failure fall back to `float(value)` for legacy plaintext rows; else `None`. Used in the anchor loop for `coherence` and `eng`. A `None` skips the rule (fail-closed — never anchor on unreadable data).
2. **Write `last_active`** after assignments land, one correlated-subquery UPDATE (plaintext timestamp, consistent with schema class):
   `UPDATE territory_profiles SET last_active = (SELECT MAX(cp.created_at) FROM clustering_points cp WHERE cp.territory_id = territory_profiles.territory_id AND cp.user_id = territory_profiles.user_id) WHERE user_id = ? AND dissolved_at IS NULL` — guarded by `not args.dry_run`. The anchor query reads the PREVIOUS run's `last_active` (correct semantics: anchoring protects based on prior-cycle state).

## Threat model

No new surface. Decryption happens in the same process that already holds USER_MASTER and already decrypts embeddings (fetch path); decrypted scalars live only in memory and are never printed (only the anchored COUNT is logged). `last_active` is a plaintext timestamp in an existing plaintext-timestamp column class whose information content is already derivable from plaintext point rows. Fail-closed: any decrypt failure → rule skipped, never a permissive default.

## Edge cases — explicit decisions

- Legacy plaintext numeric rows (pre-SEC-3): `_dec_num` falls back to direct float — rule still works.
- Foreign/corrupt envelope: `None` → rule skipped, no crash, no anchor.
- `--dry-run`: both the `is_anchored` writes (already gated, cluster.py:2037) and the new `last_active` UPDATE are skipped.
- `--fresh-start`: anchor computation skipped entirely (existing branch) — unchanged.
- First run after this fix: `last_active` still NULL during the anchor read (written later in the same run) → recency rule fires from the SECOND run onward. Accepted: matches prior-cycle semantics.

## Test strategy

1. **E2E on a vault copy (writes to copy only):** run `cluster.py` twice back-to-back. Run 1: expect `last_active` populated for all live territories (SQL check), `Anchored: 0` still possible. Run 2: expect `Anchored: N ≥ 1` (recency rule must fire — every territory was active this month) and metric-rule eligibility (live values: coherence 0.55–0.99, eng 0.09–1.0 → at least one territory >0.6/>0.7).
2. **No-crash + fail-closed:** anchor loop with an unreadable envelope (manually corrupt one row on the copy) → run completes, that territory not anchored.
3. **Hermetic gate:** `verify:generate` GO (job protocol untouched).

## Decision criteria

`SELECT SUM(is_anchored) FROM territory_profiles WHERE dissolved_at IS NULL` > 0 after two consecutive live runs; zero `anchoring query failed` lines; `verify:generate` GO.

## Risks

| Risk | L | I | Mitigation |
|---|---|---|---|
| Anchoring now fires broadly (every active territory) → Jaccard threshold 0.15 for most | M | L | That is the documented intent (TERRITORY-CONTINUITY: protect living territories); revisit thresholds if dissolution rate drops too low |
| decrypt per-row cost | L | L | ≤ a few hundred rows, µs each |
| last_active UPDATE on large vaults | L | L | single SQL statement, indexed columns |

## Verification table

| Assumption | Verified at |
|---|---|
| Anchor rules compare ciphertext (coherence, eng) | pipeline/cluster.py:1925-1935 (read) |
| `coherence`/`engagement_depth_normalized` in ENCRYPTED_FIELDS | src/crypto/crypto-local.js:342-366, 419-422 (read via sweep + spot-check) |
| Python read path returns raw ciphertext | pipeline/local_db.py:43-51 (read) |
| `_dec_float` reuse pattern exists | pipeline/compute-fisher.py:155 (read) |
| `last_active` has no writer; all live rows NULL | repo-wide grep + live DB query 2026-06-10 (20/20 NULL) |
| `is_anchored` reset-then-mark each run, gated on dry_run | pipeline/cluster.py:2037-2044 (read) |
| compute-criticality decrypts correctly (not this bug) | pipeline/compute-criticality.py:85-100 (read) |
| compute-vitality reads through JS adapter (decrypted) | pipeline/compute-vitality.js:73-82 (sweep, comment quoted) |
| Timestamps are plaintext schema class | migrations/0001_init.sql territory_profiles block (sweep) |
| anchored_ids consumer semantics (0.15 threshold + centroid backup) | pipeline/cluster.py:1154-1162, 1209-1228 (sweep, spot-read) |

## Handoff — findings for the bugs-B/C session (dead tables + realms)

- `cognitive_metrics_per_territory` + `topology_metrics`: **NOT safe to drop** — `src/ingest/vault-import.js:242-243` imports into both from canonical export ZIPs (`m.cognitiveMetrics?.perTerritory` / `?.topology`); dropping breaks canonical import (restoreTable → tableMissing). They are import-continuity targets, not vestiges. Keep; document.
- `realms` stale rows DO leak: `src/search/index.js:132-134` lists realms with no message_count filter (stale rows appear in search); `src/portal-compat.js` writes `user_profiles.realm_count` counting ALL realm rows (shows 23, truth is 2). `portal-mindscape.js` is safe (iterates live realmCounts only).
- `realms` has no dissolution mechanism (events are logged to cluster_events but the row lingers; cluster.py:1254-1260). Recommended: `dissolved_at` column mirroring territory_profiles + prune/exclude in the two leaking readers.
- `realms.territory_count/message_count` are never written by anyone; portal shadows them with live counts (portal-mindscape.js:160). Either write them in cluster.py's realm pass or stop selecting them.

## Open questions deferred

- 0.6/0.7 threshold calibration (undocumented origin) — revisit once anchoring has run live for some weeks.
- Whether `phase='anchor'` from compute-vitality should feed `is_anchored` (currently label-only) — product decision.

# Measurement Layer — Full Encryption Design — 2026-06-04

> **Directive (operator):** *"all the data should be stored encrypted and have
> decryption everywhere when needed… decrypt everything when used and authenticated."*
>
> **Scope:** encrypt every **sensitive** column in the measurement/topology
> surface; decrypt at point-of-use; keep decryption gated on authentication.
> Companion to the buildout plan (v1.5). Sweep-first per repo discipline.

---

## 1. The hard constraint (non-negotiable)

AES-GCM here is **non-deterministic** (random IV per write). So a column that is
**joined, range-filtered, grouped, or dedup-keyed in SQL cannot be encrypted** —
the ciphertext differs every write, breaking the relational operation. Therefore:

**The relational skeleton stays PLAINTEXT** (it is structure, not content):
- Primary keys + foreign/join keys: `id`, `user_id`, `territory_id`, `neighbor_id`,
  `territory_a/b`, `realm_id`, `semantic_theme_id`, `theme_id`, `atom_id`, `snapshot_id`.
- Time-range keys: `date`, `window_start`, `window_end`, `created_at`, `updated_at`,
  `detected_at`, `run_at`, `last_cofire_at`, `dissolved_at`, `first_active`, `last_active`.
- Era/partition: `era_id`, `clustering_run_id`, `cluster_version`.
- Low-cardinality WHERE enums + flags: `event_type`, `severity`, `level`, `source`,
  `scope`, `language`, `granularity`, `window_type`, `connection_type`, `is_catchall`,
  `is_anchored`, `is_liminal`, `growth_state`.
- Dedup: `content_hash`.

**Everything else that is sensitive (content, derived metrics, embeddings) is ENCRYPTED.**
"Encrypt everything" = everything sensitive; the skeleton is not sensitive (it's row
plumbing) and must stay plaintext for the vault to function.

## 2. Auth-gated decryption — already the model (preserve)

Decryption requires the in-memory keys that exist **only after unlock/authentication**
(`src/crypto/keys.js` `unlock()` + KCV; keys never persisted post-lock). The adapter's
`decrypt`/guardians **fail closed**: no key → refuse; scope-guardians enforce
`AGENT_SCOPES`. There is **no decrypt path without the authenticated keys**. The
type-agnostic encrypt fix (v1.5) + auto-decrypt-on-read already give "encrypt at rest,
decrypt at point-of-use, only when authenticated." This design extends *coverage*, not
the auth model. **Invariant to preserve:** every new decrypt goes through the adapter /
`crypto_local` (never a raw read of a sensitive column).

## 3. Column classification (the sweep result)

Legend: 🔒 = encrypt · 🔑 = plaintext-structural (must stay) · ✅ = already encrypted.

| Table | 🔒 Encrypt (sensitive) | 🔑 Plaintext-structural |
|---|---|---|
| `territory_profiles` | ✅ name/essence/story_*/archetype/top_entities/agent_*/chronicle/activity_timeline; **NEW:** `centroid_256`, `centroid_3d`, `energy`, `coherence`, `velocity`, `current_vitality`, `point_delta`, `message_count`, `atom_count`, `explored_*` | id, user_id, territory_id, realm_id, semantic_theme_id, is_catchall, is_anchored, dissolved_at, first/last_active, updated_at, current_phase*, growth_state |
| `territory_cofire` | **NEW:** `cofire_immediate`, `cofire_session`, `cofire_daily`, `cofire_weekly` | id, user_id, territory_a, territory_b, last_cofire_at, last_computed |
| `territory_neighbors` | **NEW:** `distance`, `shared_entities`, `overlap_start/end` | id, user_id, territory_id, neighbor_id, connection_type, created_at |
| `territory_vitality` | **NEW:** all metric cols (entropy_diversification, connection_growth_rate, reach, cofire_partner_diversity, engagement_depth_normalized, vitality) | id, user_id, territory_id, phase*, computed_at |
| `topology_audit_snapshots/findings` | **NEW:** m2_*, degree_gini, mean/max_degree, counts, coherence, bridge_quality, explanation | ids, user_id, snapshot_id, severity, finding_type, run_at |
| `clustering_points` | ✅ content; **NEW:** `nomic_embedding` (256D — see §5 finding), `landscape_x/y/z` | id, user_id, source_type, source_id, *_id keys, cluster_version |
| `realms` / `semantic_themes` | ✅ name/description/essence/story_*; **NEW:** centroids, activity_timeline numerics | ids, user_id, keys |
| `cognitive_metrics_*` | ✅ (Python-encrypted) | keys/time/granularity/language |
| `cognitive_events` | ✅ magnitude/detail/headline (v1.5) | keys/enums/time |
| `health_daily` / `wealth_*` | ✅ (v1.5 type-agnostic fix) | id, user_id, date |
| `fisher_trajectory/_milestones` | ✅ (per ENCRYPTED_FIELDS; Python-written by K1) | keys/time/window_type/level |

\* `current_phase` / vitality `phase` / `growth_state` are derived **labels** (enums) used
in sorts/filters — kept plaintext as structural classification (low sensitivity, high
query value). Revisit if the operator wants them encrypted too (→ JS-side handling).

## 4. The topology-engine rework (the load-bearing change)

Encrypting `cofire_*` + territory scalars (`message_count`, `current_vitality`, …) breaks
the SQL in `src/db/topology.js`, which filters/orders by them (`WHERE cofire_weekly > ?`,
`ORDER BY message_count`, `HAVING SUM(strength) …`). **Rework pattern:** each query keeps
its JOINs/GROUPs on the plaintext keys, SELECTs the (now-encrypted) scalars, and moves the
**threshold/sort/aggregate into JS** after the adapter decrypts them. For ~150–300
territories this is trivially fast. Methods to rework: `getCoFiring`, `getOrphans`,
`getBridges`, `getBridgesWithHealth`, `getGaps`, `getCluster`, `walkGraph` (already JS-ish),
`getOrphanGaps` (already JS). Plus `compute-cofire.js`'s significance filter (reads its own
in-memory values — fine) and the portal-mindscape readers (`/cofire`, territory lists).

**Writers:** JS writers (compute-cofire.js, compute-territory-neighbors.js, future
vitality/audit) get encryption **for free** — the v1.5 type-agnostic adapter encrypts the
numbers on INSERT. Python writers (`cluster.py` centroids/energy/coherence/velocity) must
route through `d1_batch_encrypted` (the Node bridge) instead of `d1_batch`, and any
`cluster.py` **read** of a now-encrypted column must `crypto_local.decrypt`. (Sweep: cluster.py
writes centroid_256@1342 / centroid_3d@1304 via the plain batch today; `d1_batch_encrypted`
already exists and is used for activity_timeline@1259 — same pattern.)

## 5. Findings surfaced by the sweep (pre-existing plaintext-at-rest)

1. **`territory_profiles.centroid_256` / `centroid_3d` — PLAINTEXT.** 256-D semantic
   fingerprints (README §7: embeddings are sensitive). Not SQL-queried → encrypt cleanly.
2. **`clustering_points.nomic_embedding` — PLAINTEXT raw bytes.** In
   `NEVER_AUTO_DECRYPT_COLUMNS` as "raw bytes, not envelopes" → it's an unencrypted 256-D
   embedding. Needs the typed-vector encrypt path (like `embedding_768`, which *is* an
   envelope). Higher-effort (binary path) but a real embedding leak.
3. **`territory_cofire` / `territory_vitality` / `topology_audit_*` numerics — PLAINTEXT**
   (cofire is live; the others land with T1). Co-activation + vitality reveal cognitive structure.
4. (Fixed v1.5) health/wealth numerics + cognitive_events.magnitude.

## 6. Phased plan + verification gates

- **SEC-1 — Centroids.** Add `centroid_256`/`centroid_3d` to ENCRYPTED_FIELDS
  (territory_profiles, realms, semantic_themes); route cluster.py centroid writes through
  `d1_batch_encrypted`; confirm cluster.py has no plaintext centroid *read* (grep: write-only).
  Verify: centroids ciphertext at rest; `getOrphanGaps` + `compute-territory-neighbors`
  still GO (adapter decrypts → JSON.parse). *Bounded, no query rework.*
- **SEC-2 — Cofire + neighbor strengths + topology rework.** Add `cofire_*` + `distance`
  to ENCRYPTED_FIELDS; rework `db/topology.js` to JS-side filter/sort; update portal-mindscape
  cofire readers. Verify: `verify:mindscape` + `verify:territory-neighbors` + new
  `verify:topology-encryption` (strengths ciphertext; getCoFiring/getOrphans/getBridges/getGaps
  return correct ordered results from decrypted values).
- **SEC-3 — Territory scalars.** Encrypt `energy`/`coherence`/`velocity`/`current_vitality`/
  `message_count` etc.; rework the `message_count`/vitality sorts+filters to JS. Verify
  topology + portal still GO.
- **SEC-4 — nomic_embedding (binary path). ✅ DONE.** Encrypt `clustering_points.nomic_embedding`
  via the wrapped-DEK vector envelope, mirroring the `embedding_768` **caller-encrypt** pattern
  (NOT in ENCRYPTED_FIELDS; stays in `NEVER_AUTO_DECRYPT_COLUMNS` — the typed Python consumer
  decrypts, never the adapter). Built a **reusable Python crypto write path** in
  `pipeline/crypto_local.py` (`encrypt_bytes`/`encrypt_str`/`encrypt_vector`, plus `decrypt_vector`
  + `decrypt_safe`) that is **byte-compatible with the JS `encryptVector`** envelope (v1/v2/v3
  key families; AES-256-GCM + AES-KW + HKDF-SHA256 all matched). Wiring: JS writer
  `sync-clustering-points.js` → `encryptVector` envelope TEXT (was raw `X'<hex>'` BLOB);
  `cluster.py` read → `_decode_nomic_embedding` (envelope **or** legacy-raw fallback so a
  re-cluster across the migration boundary keeps pre-existing points); `cluster.py`
  `_write_embeddings_to_d1` (derive + ONNX paths) → `crypto_local.encrypt_vector`. No schema
  migration needed — SQLite dynamic typing stores the base64 envelope as TEXT in the BLOB-affinity
  column. Verify: `verify:nomic-embedding-encryption` (NE1–NE5: at-rest is envelope not float
  bytes; JS round-trip; **cluster.py decoder reads JS envelope**; **JS reads Python envelope**;
  legacy raw fallback — plus NE6/NE7 for the cache, below) + `python3 crypto_local.py` standalone
  self-test (10 round-trips).
  **Residual — ✅ RESOLVED.** `pipeline/cache/nomic_embeddings.npy` + `nomic_point_ids.json`
  were a local **plaintext** performance cache. Now encrypted-on-write / decrypted-on-read via
  the same reusable `crypto_local` envelope (`encrypt_bytes`/`encrypt_str` + `decrypt_bytes`/
  `decrypt_str`, `_NOMIC_SCOPE='personal'`): `_save_cache` serializes the matrix with `np.save`
  into memory and wraps the raw `.npy` buffer before it touches disk; `_load_cache` decrypts, and
  on any decrypt/parse failure (legacy plaintext or a stale/wrong-key envelope) **deletes** both
  files so no plaintext lingers, then rebuilds from the encrypted column. Kept the cache (rather
  than dropping it) because the column is now encrypted ⇒ the per-run DB read is *more* expensive,
  so the cache's value rose. `pipeline/cache/` added to `.gitignore`. Gate extended: NE6 (cache at
  rest is envelope TEXT, not raw float bytes, + decrypt round-trip via the real `_save_cache`/
  `_load_cache`) + NE7 (legacy plaintext cache rejected-and-deleted on load).
- **SEC-5 — landscape coords + audit/vitality (lands with T1).** Encrypt as those stages build.

Each phase: capture real exit (`> log 2>&1; echo $?`, never `| tail`); `verify:leak` GO;
full encryption-touching regression GO.

## 7. Changelog
- **2026-06-04** — Design created after the v1.5 type-agnostic-encryption fix. Constraint
  (structural skeleton plaintext) + auth-gating confirmed. Phased SEC-1…SEC-5.
- **2026-06-04 (K1b)** — **Fisher tables encrypted at rest (lands with the K1 keystone).**
  `fisher_trajectory` sensitive columns (`activation_vector`, `top_contributors`, `fisher_velocity`,
  `fisher_velocity_z`, `fisher_displacement`, `fisher_trajectory_length`, `exploration_ratio`,
  `R_recent`, `activation_entropy`) and `fisher_milestones` (`detail`, `headline`, `velocity_z`,
  `displacement`) now encrypted. **Approach = caller-encrypt** (like SEC-4 nomic, NOT the bridge):
  the Python writer `compute-fisher.py` encrypts via `crypto_local.encrypt_str` (reusing the
  byte-compatible component), the JS adapter AUTO-DECRYPTS on read (these columns are NOT in
  NEVER_AUTO_DECRYPT), and Python reads (era-skip / milestone anti-flap) decrypt explicitly via
  `crypto_local.decrypt_safe`. Chosen over the Node `d1_batch_encrypted` bridge because Fisher
  writes thousands of rows/run — a subprocess-per-batch bridge would be far slower, and
  caller-encrypt reuses the proven SEC-4 path. So fisher columns are deliberately NOT added to
  `ENCRYPTED_FIELDS` (no JS write of them exists to auto-encrypt; the tables are Python-write-only,
  JS-read-only + the plaintext `dismissed_at` UPDATE). Structural columns stay plaintext
  (level/window_type/window_start/window_end/phase/phase_recent/rule_type/phase_from/to/
  message_count/active_territory_count/low_confidence/scope) — `src/db/fisher.js` filters/sorts only
  on those, so encryption is transparent (added `coerceNums` for the decrypted numeric strings;
  fisher-tools.js already `Number()`-coerced defensively). **GOTCHA fixed:** numpy 2.x
  `repr(np.float64(x))` == `'np.float64(x)'` (not `'x'`) — the encrypter coerces `float(value)`
  first or the stored value is poisoned. Verify: `verify:fisher-encryption` (ciphertext at rest +
  structural plaintext + adapter decrypt/coerce + milestone detail) + `verify:fisher` F6 proves the
  decrypted recompute is bit-identical.
- **2026-06-04 (later)** — **SEC-4 SHIPPED.** `clustering_points.nomic_embedding` now encrypted
  at rest via the wrapped-DEK vector envelope. Built a reusable, byte-compatible Python crypto
  write path in `pipeline/crypto_local.py` (encrypt_bytes/str/vector + decrypt_vector/safe + a
  `__main__` self-test) and wired the JS sync writer, cluster.py reader (with legacy fallback),
  and cluster.py writer. New gate `verify:nomic-embedding-encryption` (cross-language parity,
  exercises the real production decoder/writer). Full `npm run verify` = **48 GO / 0 NO-GO,
  exit 0**. The **encryption sweep is now complete** for the measurement layer's live columns
  (SEC-5 = landscape coords + audit/vitality, lands with the T1 stages that create them).
- **2026-06-04 (later still)** — **SEC-4 residual CLOSED.** The local `pipeline/cache/*.npy`
  performance cache is now encrypted at rest (encrypt-on-write / decrypt-on-read via `crypto_local`,
  legacy plaintext rejected-and-deleted on load); `pipeline/cache/` gitignored; the pre-existing
  plaintext cache on disk was removed. `verify:nomic-embedding-encryption` grew NE6/NE7. Full
  `npm run verify` = **48 GO / 0 NO-GO, exit 0**. No plaintext embedding bytes touch disk anywhere.

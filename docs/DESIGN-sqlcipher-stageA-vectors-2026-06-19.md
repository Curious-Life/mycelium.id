# Stage A — vectors as raw bytes inside SQLCipher — Sweep-First Design

**Date:** 2026-06-19
**Branch / worktree:** `feat/sqlcipher-stageA-vectors` · `mycelium-id-worktrees/sqlcipher-stageA` (off `origin/main` `a6e409b`)
**Audience:** the session implementing Stage A. **Depends on:** Stage 0 (PR #299) merged + live-smoked first.
**Companions:** [`SQLCIPHER-COLLAPSE-HANDOFF-2026-06-19.md`](SQLCIPHER-COLLAPSE-HANDOFF-2026-06-19.md), [`DESIGN-sqlcipher-stage0-mandatory-2026-06-19.md`](DESIGN-sqlcipher-stage0-mandatory-2026-06-19.md), [`EMBEDDING-STORAGE-LAYOUT-HANDOFF-2026-06-18.md`](EMBEDDING-STORAGE-LAYOUT-HANDOFF-2026-06-18.md). Memory: `embedding-storage-layout-candidate`.

---

## TL;DR

**Goal:** store embedding vectors as **raw little-endian Float32 bytes inside the SQLCipher file** instead of the per-field wrapped-DEK envelope. Kills the measured **2.43× base64-on-base64 bloat** (~306 MB on the 69k-message vault) and the per-vector AES-GCM decrypt on every search-build / clustering / harmonics pass. At-rest confidentiality is unchanged — SQLCipher already encrypts the whole file (Stage 0 made that mandatory).

**Scope (sweep-corrected):** the three **NEVER_AUTO_DECRYPT vector columns** that use the `encryptVector` codec — `embedding_768` (messages/documents/territory_profiles/realms/semantic_themes/persona_claims), `clustering_points.nomic_embedding`, `cognitive_anchor_vectors.anchor_vector`. **`centroid_256`/`centroid_3d` are OUT** — they're encrypted *JSON* via the standard auto-encrypt path, not the vector codec, so they belong to Stage B.

**The shortcut the sweep found:** `clustering_points.nomic_embedding` is already a **BLOB** column whose Python reader (`cluster.py:_decode_nomic_embedding`) **already dual-reads raw-bytes OR envelope** (it went raw→envelope at "SEC-4"; Stage A reverses it). So nomic is the trivial first sub-cut — flip the writer back to raw; the reader needs no change.

**The migration is lazy/non-destructive:** SQLite type affinity is advisory — a raw `Buffer` stores fine in the existing `TEXT` columns (better-sqlite3 binds it as a BLOB), so **no schema migration is required**. The codec dual-reads (Buffer → raw decode; string → legacy envelope decrypt), so a half-migrated column reads correctly during the backfill.

---

## Revision history

- **v1 (handoff §"Stage A"):** "store raw Float32 bytes; drop encryptVector/encrypt_vector; remove the 3 names from NEVER_AUTO_DECRYPT; backfill; retire nomic/centroid gates." Lumped centroids in; implied a single codec swap.
- **v2 (this doc, post-sweep) — three pivots + one shortcut:**
  - **Pivot 1 — centroids are NOT in scope.** `centroid_256`/`centroid_3d` are `TEXT` storing **JSON arrays**, encrypted via the *auto-encrypt* path (in `ENCRYPTED_FIELDS`, decrypted by the adapter; `verify-centroid-encryption` CE2 proves the adapter round-trip) — they never touch `encryptVector`. Converting them is a Stage-B content-codec change, not a vector-codec change. **Defer to Stage B.** (`migrations/0001_init.sql:1069` "JSON array … stored as JSON".)
  - **Pivot 2 — no schema migration needed.** `embedding_768`/`anchor_vector` are `TEXT`; raw `Buffer` writes store as BLOB regardless of affinity, and reads return a Buffer. So we keep the columns and make the codec shape-aware. (Optional affinity-cleanup migration deferred.) This is what makes the migration lazy/mixed-safe.
  - **Pivot 3 — `NEVER_AUTO_DECRYPT` stays.** The columns must STILL be skipped by `autoDecryptResults` (raw bytes are not envelopes; auto-decrypt would mis-handle them). v1's "remove the 3 names from NEVER_AUTO_DECRYPT" is wrong — they stay; only the *typed codec* changes from decrypt-envelope to decode-bytes.
  - **Shortcut — nomic is already dual-read.** `cluster.py:_decode_nomic_embedding` already handles raw-bytes + envelope. Ship nomic first as the contained proof; the reader is untouched.

---

## Threat model

Unchanged from Stage 0: at-rest confidentiality is provided by **whole-file SQLCipher** (now mandatory). Raw Float32 bytes live *inside* the encrypted file — on disk they are ciphertext, indistinguishable from any other page. What we remove is the **redundant inner** AES-GCM envelope (a multi-tenant/zero-trust-operator pattern with no benefit on a local single-user vault — see Stage 0 threat model). **Embedding-inversion sensitivity (CLAUDE.md §7) is preserved:** the vectors never leave the SQLCipher boundary; error messages still carry only dims/byte-counts (`decode.js:22-23`), egress still goes through the existing chokepoints. No new attack surface.

---

## Sweep findings (consolidated, file:line — read firsthand)

**JS codec — `src/search/ann/decode.js`:** `encodeVector` (32-38): Float32 → `Buffer` → **base64 string**. `decodeVectorBytes` (41-55): base64 → Float32 (LE, `readFloatLE`). `encryptVector` (88-94): `encrypt(encodeVector(vec), …)` → wrapped-DEK envelope. `decryptVector` (65-85): `decrypt()` → base64 → `decodeVectorBytes`. So the full carrier is **Float32 → base64 → envelope-JSON → base64** = 2.43×.

**Proven raw-BLOB pattern — `src/search/backend/sqlite.js`:** `f32buf = (a)=>Buffer.from(a.buffer,a.byteOffset,a.byteLength)` (53); `INSERT INTO vec_docs_768(id,embedding) VALUES(?,?)` with `f32buf(norm)` (98-100,189-190); reads via `vec_distance_cosine` on the raw BLOB. **Raw Float32 BLOB inside the cipher — never base64, never enveloped.** This is the target codec, already in production for the derived sqlite-vec index.

**NEVER_AUTO_DECRYPT — `src/crypto/crypto-local.js:1784-1795`:** `embedding_768`, `nomic_embedding`, `anchor_vector` are hard-skipped in `autoDecryptResults` (`continue` at ~1804); the typed consumer decrypts. **Stays** (raw bytes also must skip auto-decrypt).

**Column types — `migrations/0001_init.sql`:** `embedding_768 TEXT` (messages:950, documents:651, territory_profiles:1408, semantic_themes:1142, realms:1075-area; persona_claims `0011:28`); `nomic_embedding BLOB` (274); `centroid_256 TEXT` "JSON array" (1069,1136,1402); `anchor_vector TEXT` (`0010_embedding_anchors.sql:44`).

**Python codec — `pipeline/crypto_local.py`:** `_vector_to_f32_bytes` (314-325): numpy `astype("<f4").tobytes()` (LE). `encrypt_vector` (327-338): `base64(f32 bytes)` → `encrypt_str` → envelope. `decrypt_vector` (221-240): envelope → `decrypt_bytes` → b64decode → `np.frombuffer(<f4)`. **Single canonical file** (no live duplicates of `crypto_local.py`). LE-f32 contract is identical to JS.

**The existing dual-read (the template) — `pipeline/cluster.py:_decode_nomic_embedding`:** *"new rows store an ENCRYPTED wrapped-DEK envelope … Legacy rows stored a raw float32 BLOB … Both are handled so a re-cluster across the migration boundary doesn't drop points."* Exactly the mixed-state read Stage A generalizes.

**Writers:** JS — `src/enrich/service.js:124` (embedding_768), `src/ingest/{vault-import.js:425,full-export-import.js:156}` (re-encrypt on import), `pipeline/sync-clustering-points.js:139` (nomic). Python — `cluster.py:526-537` (nomic via bridge), `compute-anchors.py:160` (anchor_vector via `/query`). All write the **pre-encrypted envelope as an opaque value** through the JS bridge (`pipeline/local_db.py:96-128` → `vault-bridge.js`/`local-write-bridge.js`, `db.rawQuery`); the bridge does NOT re-encrypt these columns.

**Readers (blast radius):** JS — `src/search/d1-loader.js:194-195` (builds the sqlite-vec index), `pipeline/sync-clustering-points.js:57-81`, `src/db/claims.js:125-127`. Python — `cluster.py:241-273,621-687`, `compute-anchors.py:172-181`, `compute_information_harmonics.py:389-446`, `compute-coherence.py`, `compute-frequency.py`. Every one decodes via `decryptVector`/`decrypt_vector` today → each must become shape-aware.

**Gates:** `verify-nomic-embedding-encryption.mjs` NE1 (72-74) asserts the at-rest value **IS a base64-JSON envelope, NOT raw bytes** — this inverts under Stage A → rewrite to assert **raw bytes + file-still-ciphertext**. NE5 (107-117) already tests the **raw-BLOB legacy fallback** — that assertion becomes the *primary* path. `verify-centroid-encryption.mjs` — **untouched** (centroids deferred).

**Bloat (measured, `EMBEDDING-STORAGE-LAYOUT-HANDOFF`):** raw 3072 B → stored 7472 B = **2.43×**; ~306 MB waste on embedding_768 across the 69k-message vault; the search-build cold scan was 312.9s (SQLCipher page-decrypt dominated → fewer bytes ≈ proportionally faster).

---

## Design

### The codec (JS — `src/search/ann/decode.js`)
Add a raw encoder + a shape-aware decoder; keep the legacy envelope helpers for the mixed-read window.
```
encodeVectorRaw(vec: Float32Array): Buffer          // f32 LE bytes, NO base64, NO envelope
decodeStoredVector(value: Buffer|string, dim, masterKey?, scopes?): Promise<Float32Array>
  // Buffer  → raw: validate byteLength === dim*4, readFloatLE  (sync work, async signature for uniformity)
  // string  → legacy: decryptVector(value, masterKey, scopes, dim)   (the existing path)
```
Writers switch `encryptVector(vec,…)` → bind `encodeVectorRaw(vec)` (a Buffer) as the column param. Readers switch `decryptVector(col,…)` → `decodeStoredVector(col, dim, masterKey)`.

### The codec (Python — `pipeline/crypto_local.py`)
```
encode_vector_raw(vec) -> bytes            # _vector_to_f32_bytes(vec)  (already LE f32; drop base64+envelope)
decode_stored_vector(value, dim) ->        # bytes/memoryview → np.frombuffer(<f4); str → decrypt_vector (legacy)
```
`cluster.py:_decode_nomic_embedding` **already does this** — generalize the same branch into `crypto_local` and reuse for `anchor_vector` + `embedding_768` readers.

### Storage
Raw `Buffer`/`bytes` bound to the existing columns (SQLite stores as BLOB; `nomic_embedding` already BLOB). No schema migration. `NEVER_AUTO_DECRYPT_COLUMNS` unchanged. The derived **sqlite-vec backend is untouched** (still raw BLOB; `d1-loader` now feeds it from raw source bytes instead of decrypted envelopes — one less decrypt).

### Backfill (per column, reversible)
Decrypt each remaining envelope → re-store as raw `Buffer`. Reads dual-handle throughout, so backfill is **opportunistic-on-rewrite by default + an eager per-column pass gated behind a copy-test**. Back up the vault first (`.pre-cipher`-style) — but note Stage 0's purge runs only on the canonical boot; the backfill tool keeps its own backup. Batched + yield (search-build lessons). Idempotent (skip rows already raw via length+shape check).

### Gates
- **Rewrite** `verify:nomic-embedding-encryption` → **`verify:vectors-raw`**: for each of the 3 columns — write raw, read back identical (±1e-5), assert the stored value is **raw bytes of length dim*4** (not a base64 envelope), assert the vault **file is still ciphertext** (no SQLite magic header), and assert the dual-read still decodes a legacy envelope (mixed-state safety). Cross-language: a Python-written raw vector reads in JS and vice-versa.
- **Keep** `verify:centroid-encryption` green unchanged (centroids deferred).
- Re-frame `verify:leak`'s vector portion to "raw vector bytes live only inside the cipher file."

### Module shape & LOC budget
| Change | File | ~LOC |
|---|---|---|
| `encodeVectorRaw` + `decodeStoredVector` (keep legacy helpers) | `src/search/ann/decode.js` | ~45 |
| Reader/writer switch (enrich, d1-loader, sync-clustering-points, claims, ingest×2) | `src/**` | ~40 |
| `encode_vector_raw` + `decode_stored_vector`; rewire cluster.py / compute-anchors.py / harmonics / coherence / frequency | `pipeline/*.py` | ~70 |
| Backfill tool (per-column, batched, reversible) | `scripts/backfill-vectors-raw.mjs` | ~120 |
| Gate rewrite `verify-vectors-raw.mjs` (+ package.json) | `scripts/` | ~120 |
| **Total** | | **~395** |

### Edge cases
- **Mixed column mid-backfill:** dual-read handles it; never run a SQL query that *interprets* the bytes (we don't — these columns are only read into typed consumers, never `WHERE`/`ORDER BY`'d, unlike Stage B/C content).
- **Wrong byte length (corruption / dim mismatch):** `decodeStoredVector` throws a `DecryptError` with dims/byte-counts only (no contents) — same posture as today.
- **Python reads a JS-written raw Buffer (and vice-versa):** identical LE-f32 layout (verified both sides) → byte-compatible; the gate proves it with a shared test vector.
- **`d1-loader` feeding sqlite-vec:** now passes raw bytes straight through (Float32 → already a Buffer) — strictly less work.
- **persona_claims.embedding_768:** in scope (TEXT, same codec) — include it in the backfill column list.

### Test strategy
- `verify:vectors-raw` (new) — the assertions above, all 3 columns, both languages, mixed-state.
- Regression: `verify:cluster-embed`, `verify:anchors`, `verify:embedding-novelty`, `verify:search`, `verify:harmonics-encryption`, `verify:centroid-encryption`, `verify:at-rest{,-purge}`, `verify:leak`.
- **Copy-test the backfill** on a clone of the real vault: byte-identical vectors before/after (decrypt-old vs decode-new), **search-build time + vault size measured before/after** (the decision metric).

### Implementation order (each independently shippable)
1. **Codec + nomic_embedding** (smallest; reader already dual-reads). Flip `cluster.py`/`sync-clustering-points` writers to raw; backfill `clustering_points`. Measure. Smoke: `verify:vectors-raw` (nomic) + `verify:cluster-embed`.
2. **embedding_768** (the bloat win): codec dual-read in all readers + writers (`enrich/service.js`, `d1-loader`, ingest, harmonics/coherence/frequency); backfill the 6 tables. Measure search-build + vault size.
3. **anchor_vector**: writer (`compute-anchors.py`) + reader; backfill `cognitive_anchor_vectors`.
4. Retire/rewrite gates; full `verify` green → PR → rebuild → live-smoke.

### Decision criteria → Stage B
Proceed when: vault size drops ~the predicted ~300 MB; search-build cold time drops measurably; `verify:vectors-raw` + full `verify` green; live re-cluster + search on the real vault return identical results to pre-Stage-A.

---

## Risks + mitigations
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A reader missed → reads raw bytes as a string envelope → throws | Med | Pipeline stage breaks | Shape-aware `decodeStoredVector` everywhere; the reader audit table (sweep) is the checklist; regression gates per stage |
| JS/Python byte mismatch | Low | Corrupt vectors | Identical LE-f32 verified both sides; gate proves cross-language round-trip with a shared vector before backfill |
| Backfill corrupts the real vault | Med | Critical | Reversible + batched + copy-test first; idempotent shape-check; keep a backup |
| sqlite-vec index drift after format change | Low | Stale search | `d1-loader` change is pass-through; rebuild the index post-backfill; `verify:search` |
| Centroids assumed in scope (v1) → broke the auto-encrypt path | — | Avoided | Pivot 1: centroids deferred to Stage B |

## Open questions
**Resolved:** centroids use auto-encrypt JSON (not the vector codec) → Stage B; no schema migration (affinity); NEVER_AUTO_DECRYPT stays; nomic already dual-reads.
**Deferred:** optional `TEXT→BLOB` affinity cleanup migration (cosmetic; after backfill); centroid raw-bytes (Stage B); whether to drop `encryptVector`/`encrypt_vector` entirely or keep for export interop (decide at step 4 — likely keep for `full-export-import` portability).

---

## Verification table
| # | Load-bearing assumption | Verified at (read firsthand) |
|---|---|---|
| 1 | JS codec is Float32→base64→envelope→base64 (the 2.43× chain) | `src/search/ann/decode.js:32-38,88-94` |
| 2 | Raw-BLOB pattern already in prod (the target codec) | `src/search/backend/sqlite.js:53,98-100,189-190` |
| 3 | The 3 vector columns are NEVER_AUTO_DECRYPT (must stay) | `src/crypto/crypto-local.js:1784-1795` |
| 4 | `embedding_768`/`anchor_vector` are TEXT; `nomic_embedding` is BLOB | `migrations/0001_init.sql:651,950,1142,1408,274`; `0010_embedding_anchors.sql:44`; `0011:28` |
| 5 | `centroid_256/3d` are TEXT JSON via auto-encrypt (NOT the vector codec) → out of scope | `migrations/0001_init.sql:1069,1136,1402` |
| 6 | `nomic_embedding` reader already dual-reads raw+envelope (the template) | `pipeline/cluster.py:_decode_nomic_embedding` |
| 7 | Python codec is LE-f32 + base64 + envelope, single canonical file | `pipeline/crypto_local.py:314-338,221-240` |
| 8 | Writers send pre-encrypted value through the JS bridge (no re-encrypt) | `pipeline/local_db.py:96-128`; `cluster.py:526-537`; `compute-anchors.py:160` |
| 9 | nomic-encryption gate asserts envelope-not-raw (inverts under Stage A) + has a raw-legacy assertion | `scripts/verify-nomic-embedding-encryption.mjs:72-74,107-117` |
| 10 | Measured 2.43× bloat / ~306 MB | `docs/EMBEDDING-STORAGE-LAYOUT-HANDOFF-2026-06-18.md` |

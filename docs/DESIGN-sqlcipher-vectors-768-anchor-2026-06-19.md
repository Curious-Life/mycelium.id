# DESIGN — `embedding_768` (6 tables) + `anchor_vector` → raw LE-f32, via a bidirectional bridge BLOB transport

**Date:** 2026-06-19
**Branch:** `feat/sqlcipher-vectors-768-anchor` (off `origin/main` `5c8239d`)
**Skill:** `/sweep-first-design` — 5 concurrent Explore sweeps + firsthand reads of the centerpiece
**Predecessors:** [backfill-job/nomic design](DESIGN-sqlcipher-backfill-job-nomic-2026-06-19.md) · [backfill-engine](DESIGN-sqlcipher-backfill-engine-2026-06-19.md) · [Stage A vectors](DESIGN-sqlcipher-stageA-vectors-2026-06-19.md) · [execution plan](SQLCIPHER-COLLAPSE-EXECUTION-PLAN-2026-06-19.md)
**Audience:** the implementer + the next instance. Memory index: `sqlcipher-collapse-decision`.

---

## What this delivers (the rest of "Stage A vectors")

Migrate the remaining vector columns off per-field encrypted base64 envelopes → **raw little-endian Float32 BLOB bytes** inside whole-file SQLCipher:
- `embedding_768` (dim 768) in **6 tables**: `messages`, `documents`, `territory_profiles`, `realms`, `semantic_themes`, `person_claims`.
- `cognitive_anchor_vectors.anchor_vector` (dim 768).

The enabling capability — and the **centerpiece** — is a **bidirectional BLOB transport** for the Python↔Node vault bridge, because Python reads (and, for anchors, writes) these columns through it and the bridge currently **refuses binary both ways**.

Split into two PRs:
- **PR 1 (code, this design):** bridge BLOB transport (both directions) + flip all readers to dual-read + flip all writers to raw + gate rewrites + allowlist. After PR 1: new writes are raw, every reader is dual-mode, the pipeline is raw-BLOB-safe. **No live data migrated yet** (old envelopes still read fine via dual-read).
- **PR 2 (execution):** run the backfill campaign for the 7 columns on the live vault + a measure-only smoke that proves the Python readers consume raw vectors through the bridge.

---

## Revision history

- **v1 (runbook sketch):** "flip the `embedding_768`/`anchor_vector` writers + add a bridge blob-param protocol for the Python writers."
- **v2 (this doc — after sweeps + firsthand bridge read):** Two load-bearing corrections:
  - **PIVOT 1 — the bridge must be BIDIRECTIONAL.** `vault-bridge.js:41-56` (`rawRun`) **throws** the moment any result cell is a `Buffer` ("BLOB column in result set is not supported over the bridge — no base64 transport"), and binds params via a raw spread with no Buffer path. The runbook only foresaw the *inbound* (write) gap. But `embedding_768` has **no Python writer** — its writers are all JS in-process (`Buffer` binds natively). What it has is **Python *readers* over the bridge** (`compute_information_harmonics.decrypt_vectors`, used by coherence/cross-scale/novelty; `cluster.py`). So the *read* direction is the gating gap. `anchor_vector` needs **both** (Python reads AND writes via the bridge).
  - **PIVOT 2 — this fixes a latent break I already shipped.** `nomic_embedding` is already raw BLOB (PR #311). The next time Generate runs `cluster.py`'s `SELECT nomic_embedding … ` over the bridge, `rawRun` throws. And the moment `embedding_768` migrates, **measure-only breaks** too — its metric stages (harmonics/coherence/cross-scale/novelty, run-clustering.sh Steps 4-16, which DO run in measure-only) read `embedding_768` through the bridge. So the bridge fix is **mandatory and co-required** with the embedding_768 migration, and it retroactively makes nomic safe for Generate.

---

## Sweep findings (consolidated; ★ = verified firsthand)

### The bridge (centerpiece) ★
- `pipeline/vault-bridge.js` — long-running loopback server; `getDb` opens the keyed cipher once; `rawDb = adapter.db` (raw handle). Auth `isTrustedLoopback` (loopback peer, no proxy headers); keys from env, never on the wire ([vault-bridge.js:30-92](../pipeline/vault-bridge.js)). **(Updated 2026-06-19, PR #345: auth is now TWO layers — loopback AND a per-boot `X-Bridge-Token`, fail-closed. See [DESIGN-vault-bridge-auth-2026-06-19.md](DESIGN-vault-bridge-auth-2026-06-19.md).)**
- `rawRun` ([vault-bridge.js:41-56](../pipeline/vault-bridge.js)): SELECT → `stmt.all(...params)`; **iterates every cell and throws on `Buffer.isBuffer(v)`** (lines 45-51). Non-reader → `stmt.run(...params)`.
- Routes `/query` (97-99), `/batch` (101-108), `/batch_encrypted` → `db.rawQuery` adapter encrypt path (110-114). Body via `JSON.parse` (70-74).
- `MYCELIUM_DB_BRIDGE_URL` set + bridge spawned/health-waited/killed in `run-clustering.sh` (≈:94,:107). The Python client is `pipeline/local_db.py`: `query`→`_post('/query',{sql,params})`, `batch`→`_post('/batch',{statements})`, `_post` does `json.dumps` ([local_db.py:38-90](../pipeline/local_db.py)).

### `embedding_768` writers/readers ★ (writers verified)
- WRITERS (all **JS in-process** — `Buffer` binds natively, NO bridge needed):
  - `messages`: `src/enrich/service.js:124` — `encryptVector(...)` → `messages.updateEnrichment(id,uid,{embedding768: envelope})`.
  - `documents`/`territory_profiles`/`realms`/`semantic_themes`: `src/ingest/full-export-import.js:149-173` `vectorPass(...)` — `encryptVector` → `db.rawQuery(UPDATE … embedding_768=?)`.
  - `person_claims`: `src/db/claims.js:76,86,94` — binds caller-supplied `c.embedding768 ?? null` (reserved/retrieval; usually NULL today — `src/claims/discovery.js:15`).
  - `src/ingest/vault-import.js:91-94` — sets `embedding_768 = null` (re-embed). No envelope written.
- READERS:
  - **JS**: `src/search/d1-loader.js:194` — `decryptVector(row.embedding_768, masterKey, null, EMBED_DIM)`. `src/db/claims.js:127` — returns raw to caller.
  - **Python via bridge**: `compute_information_harmonics.py` `decrypt_vectors` (≈:418-432) — `SELECT embedding_768 FROM messages` then `decrypt_vector`; **imported by** `compute-embedding-novelty.py`, `compute-coherence.py`, `compute-cross-scale-coupling.py`. `cluster.py` reads embedding_768 too.
- `embedding_768` ∈ `NEVER_AUTO_DECRYPT_COLUMNS` (`crypto-local.js:1792`); NOT in ENCRYPTED_FIELDS — adapter passes it through verbatim both ways. EMBED_DIM=768 (`src/embed/client.js:16`).

### `anchor_vector` ★ (writer/reader verified)
- `cognitive_anchor_vectors.anchor_vector TEXT NOT NULL`, dim 768 (`migrations/0010_embedding_anchors.sql:35-49`).
- WRITER **Python via bridge**: `pipeline/compute-anchors.py:160` — `crypto_local.encrypt_vector(mean_vec,'personal',mk)` → `querier(ANCHOR_UPSERT_SQL,[…,env])`.
- READER **Python via bridge**: `compute-anchors.py:178-179` — `decrypt_vector(env, mk, dim=ANCHOR_DIM)`. Consumed for cosine-proximity metrics.
- ∈ `NEVER_AUTO_DECRYPT_COLUMNS` (`crypto-local.js:1797`). No JS reader/writer. Sibling `cognitive_metrics_anchor` holds **scalars** (out of scope).

### Codec / adapter / backfill / gates
- Codec present: JS `encodeVectorRaw`/`decodeStoredVector` ([decode.js:108-142](../src/search/ann/decode.js)); Python `encode_vector_raw`/`decode_stored_vector` ([crypto_local.py:348-376](../pipeline/crypto_local.py), dual-reads bytes vs envelope).
- Adapter `NEVER_AUTO_DECRYPT` skip on read ([crypto-local.js:1804-1829](../src/crypto/crypto-local.js)); raw `Buffer` flows through write untouched (not in ENCRYPTED_FIELDS).
- Backfill engine handles dim 768: `decryptVector(v,mk,null,dim)`→raw `Buffer` ([backfill.js:50-100](../src/account/backfill.js)); `countRemainingEnvelopes` `LIKE 'ey%'` matches only TEXT envelopes ([backfill.js:30-33](../src/account/backfill.js)).
- No vec0/FTS/index/generated-column references these columns (TEXT→BLOB invisible to the query layer).
- Gates asserting envelope-ness (MUST rewrite to raw): `verify:nomic-embedding-encryption` (NE1-NE4,NE6-NE7), `verify:anchors` A2 (`scripts/verify-anchors.mjs:110`), `verify:enrich` N2-N3, `verify:claims` C2a. Gates already raw/dual-safe (no change): `vectors-raw`, `backfill`, `backfill-nomic`, `search-rehydrate`, `search`, `embed`, `claims-discovery`. Out of scope (scalar metric envelopes): coherence/novelty/metrics_anchor.

---

## The bridge BLOB transport — protocol design

**Convention:** a binary value is carried over JSON as a tagged object `{"__b64__": "<base64>"}`. The tag is intercepted at exactly one point per direction; everything else is untouched.

**Outbound (results) — `vault-bridge.js`:** in `rawRun`, replace the throw with an encode: when a result cell is a `Buffer`, emit `{ __b64__: v.toString('base64') }`. (Bounded: only the vector columns are BLOB; a normal TEXT/INT/REAL cell is unaffected.)

**Inbound (params) — `vault-bridge.js`:** before binding (`/query` and `/batch`), map each param: a plain object whose ONLY key is `__b64__` (string) → `Buffer.from(p.__b64__,'base64')`; everything else passes through. Use a strict shape check (`Object.getPrototypeOf(p)===Object.prototype && keys===['__b64__'] && typeof===string`) so a real string/number/array param can never be mistaken for a blob tag.

**Python client — `local_db.py`:** symmetric helpers.
- params (`query`/`batch`): walk params, `bytes`/`bytearray`/`memoryview` → `{"__b64__": base64.b64encode(bytes(p)).decode('ascii')}` before `json.dumps`.
- results (`_post` rows): walk each returned row's values, a dict `{"__b64__": s}` → `base64.b64decode(s)` (`bytes`) before handing rows to the caller.

After this, a Python reader gets `bytes` for a raw column (and the legacy base64-envelope string for an un-migrated row), so `decode_stored_vector(value, mk, dim)` resolves both. A Python writer passes `encode_vector_raw(vec)` (`bytes`) and it lands as a BLOB.

**Why a tag (not "base64 everything"):** the bridge already round-trips TEXT envelopes as plain strings; tagging keeps those untouched and makes binary explicit + self-describing on both ends. The tag string `__b64__` cannot collide with vault data: column values are strings/numbers/bytes, never a JSON object with that exact single key.

---

## Module shapes (PR 1)

| File | Change | LOC |
|---|---|---|
| `pipeline/vault-bridge.js` | `rawRun`: Buffer cell → `{__b64__}` (was throw). New `decodeParams()` applied in `/query` + `/batch` bind. | ~20 |
| `pipeline/local_db.py` | `_encode_params()` (bytes→tag) on `query`/`batch` send; `_decode_rows()` (tag→bytes) on `_post` results. | ~22 |
| `pipeline/compute_information_harmonics.py` | `decrypt_vectors`: `decrypt_vector` → `decode_stored_vector` (dual-read). | ~4 |
| `pipeline/compute-anchors.py` | reader `decrypt_vector`→`decode_stored_vector`; writer `encrypt_vector`→`encode_vector_raw`. | ~4 |
| `pipeline/cluster.py` | embedding_768 reader(s) → `decode_stored_vector`; (nomic reader already dual-reads). | ~6 |
| `src/search/d1-loader.js` | `decryptVector(row.embedding_768,…)` → `decodeStoredVector(row.embedding_768, EMBED_DIM, masterKey, null)`. | ~3 |
| `src/enrich/service.js` | `encryptVector(…)` → `encodeVectorRaw(Float32Array.from(vec))` (Buffer → BLOB). | ~3 |
| `src/ingest/full-export-import.js` | `vectorPass`: `encryptVector` → `encodeVectorRaw`; bind Buffer. | ~4 |
| `src/db/claims.js` | reader: where a caller cosine-matches `embedding768`, route through `decodeStoredVector` (writer stays caller-supplied; add to backfill). | ~2 |
| `src/portal-mindscape.js` | extend `BACKFILL_TARGETS` with the 6 `embedding_768` cols + `anchor_vector` (dim 768). | ~9 |
| `scripts/verify-bridge-blob.mjs` (NEW) | gate: bridge `{__b64__}` round-trip (param→BLOB stored, BLOB result→tag) on a keyed SQLCipher DB + Python-shape parity. | new |
| `scripts/verify-nomic-embedding-encryption.mjs` | rewrite → assert raw + `decodeStoredVector` round-trip (rename concept; keep chain name). | rewrite |
| `scripts/verify-anchors.mjs` | A2 → assert raw Buffer + round-trip. | ~6 |
| `scripts/verify-enrich.mjs` | N2-N3 → assert raw Buffer + `decodeStoredVector`. | ~8 |
| `scripts/verify-claims.mjs` | C2a → embedding_768 dual-safe (raw OR null), not envelope. | ~4 |

**Ordering law within PR 1:** land readers (dual-read) + the bridge transport **before/with** writers (raw). Since `decodeStoredVector`/`decode_stored_vector` read BOTH shapes, order is safe — but the writer flip must NOT precede the reader flip in a deploy. One PR = atomic, so fine. Live data stays envelopes until PR 2's backfill; everything reads via dual-read meanwhile.

---

## Threat model / security (the bridge is a chokepoint — CLAUDE.md §1,§13)
- **No trust-boundary change** *(for this BLOB-transport change; the bridge auth was independently hardened later — PR #345 added a per-boot `X-Bridge-Token` second layer on top of loopback, see [DESIGN-vault-bridge-auth-2026-06-19.md](DESIGN-vault-bridge-auth-2026-06-19.md))*. The transport still: binds to loopback, rejects proxied requests (`isTrustedLoopback`), keys-from-env-never-on-wire, never exposed (§13). Base64 is an *encoding*, not encryption — but the bytes it now carries are **already-decrypted vector plaintext**, which the bridge has *always* carried for TEXT envelopes (it serves decrypted rows by design). So no new exposure class; same paranoia (never log vector bytes; errors are message-only).
- **Tag-collision / injection:** strict single-key plain-object check on params; a user string/number can't be a `{__b64__}` object. Results only tag actual `Buffer` cells.
- **Fail-closed preserved:** a malformed `__b64__` (bad base64) → `Buffer.from` yields garbage bytes, caught downstream as a decode failure (skipped + counted), never a silent wrong value; the per-row backfill fail-closed + 0-envelope assert still gate correctness.
- **Zero-plaintext-leak:** the new code never logs param/result values.

## Edge cases — explicit decisions
| Case | Decision |
|---|---|
| Un-migrated envelope row read after PR 1 | `decode_stored_vector`/`decodeStoredVector` dual-read it (string envelope path). Safe. |
| `person_claims.embedding_768` is NULL (reserved) | Backfill converts 0 (NULL skipped); writer binds NULL; reader dual-safe. Include in targets for completeness. |
| measure-only reads embedding_768 (raw) via bridge before PR 2 backfill | Mix of raw+envelope; bridge delivers bytes for raw, string for envelope; reader dual-reads both. Safe. |
| A real TEXT/number param shaped like a blob tag | Impossible: strict single-`__b64__`-key plain-object check; scalars/strings/arrays pass through. |
| full-export import of an OLD bundle (decrypted vectors) | Now writes raw (encodeVectorRaw) — correct; no envelope reintroduced. |
| Generate re-enabled later (cluster.py nomic WRITER still envelope) | Out of scope here (separate deferred item); but cluster.py nomic *reader* + the bridge now handle raw, and this PR can also flip the cluster.py nomic writer via the new bridge blob-param (decide at impl — small add). |

## Test strategy
- **NEW `verify:bridge-blob`** — start a `vault-bridge` on a keyed throwaway SQLCipher DB: write a raw vector via a `{__b64__}` param (`/batch`), read it back via `/query` and assert the result row carries `{__b64__}` decoding to the exact bytes; assert a normal string/number param is unaffected; assert the Python `local_db` encode/decode shape parity (skips gracefully without `pipeline/.venv`).
- **Rewrite** `verify:nomic-embedding-encryption`, `verify:anchors` (A2), `verify:enrich` (N2-N3), `verify:claims` (C2a) → assert raw Buffer + `decodeStoredVector` round-trip; keep a legacy-envelope dual-read assertion.
- **Regression (must stay green):** `vectors-raw`, `backfill`, `backfill-nomic`, `search`, `search-rehydrate`, `embed`, `cluster-embed`, `anchors`, `enrich`, `claims`, `harmonics-encryption`, `coherence`, `cross-scale-coupling`, `embedding-novelty`, `at-rest{,-purge}`, `secrets`, `leak`. Full `verify` in CI (Python gates need `.venv` → CI).
- **PR 2 live:** backfill the 7 columns → 0 envelopes each; then a **measure-only run** (`POST /portal/mycelium/measure`) that exercises harmonics/coherence/novelty reading raw `embedding_768` through the bridge — the real proof the bidirectional transport works end-to-end on the live vault.

## Implementation order (PR 1 — each independently checkable)
1. **Bridge transport** (`vault-bridge.js` + `local_db.py`) + `verify:bridge-blob`. Smoke: gate GO.
2. **Readers dual-read** (JS `d1-loader.js`; Python `compute_information_harmonics`, `compute-anchors`, `cluster.py`). Now reads handle both shapes.
3. **Writers raw** (`enrich/service.js`, `full-export-import.js`, `compute-anchors.py`; claims as needed).
4. **Gate rewrites** + `BACKFILL_TARGETS` extension.
5. Full local JS gates green; push → CI green (Python gates).

## PR 2 — backfill campaign (live, after PR 1 merged + app rebuilt)
Per column, via `POST /api/v1/portal/mycelium/backfill {targets:[…],confirm:true}` (loopback, auto-backup, 0-envelope assert): `messages.embedding_768` (largest — the real size win) → `documents`/`territory_profiles`/`realms`/`semantic_themes`/`person_claims`.embedding_768 → `cognitive_anchor_vectors.anchor_vector`. Then `POST /portal/mycelium/measure` → confirm metrics recompute (Python readers consume raw via the bridge) + measure vault size delta (expect a meaningful drop — 768-dim base64 envelopes were the bulk of the embedding bloat).

## Risks + mitigations
| Risk | L | I | Mitigation |
|---|---|---|---|
| Bridge change breaks the pipeline read path | Med | High | `verify:bridge-blob` + measure-only smoke (PR 2) before trusting; dual-read keeps envelopes working |
| A Python reader missed → throws on raw BLOB | Med | High | Exhaustive reader inventory (sweep B/C); `decrypt_vectors` is the shared chokepoint for 4 stages |
| Tag collision / param mis-bind | Low | High | strict single-key plain-object check; gate asserts a normal param is unaffected |
| Backfill corrupts a 768-vector | Low | High | engine golden-diff proven (verify:backfill); per-row fail-closed; auto ciphertext backup, kept on failure |
| `package.json` verify-chain rebase conflict | High | Low | known resolver recipe; merge promptly |

## Open questions resolved during sweep
- **Bridge is bidirectional**, not inbound-only (firsthand). `embedding_768` has **no Python writer** — the gap is the *read* path.
- **Latent nomic-read break** for Generate is fixed by this same bridge change.
- **measure-only would break** on raw embedding_768 without the bridge fix → co-required.
- No indexes/vec0 on these columns → TEXT→BLOB is invisible to SQL.

## Open questions deferred
- `cluster.py` nomic **writer** flip (now feasible via the new bridge blob-param) — fold in here or keep as the Generate-reenable item.
- Stage B/C content columns (the loading-speed root fix) — next.

---

## Verification table
| Assumption | Verified at (firsthand ★ / sweep) |
|---|---|
| Bridge throws on BLOB results; binds params via raw spread | ★ `pipeline/vault-bridge.js:41-56,97-108` |
| Bridge auth = loopback + per-boot `X-Bridge-Token` (PR #345), keys from env | ★ `pipeline/vault-bridge.js` |
| Python client shapes (query/batch/_post, json.dumps) | ★ `pipeline/local_db.py:38-90` |
| `embedding_768` writers are all JS in-process | ★ `src/enrich/service.js:124` · `src/ingest/full-export-import.js:149-173` · `src/db/claims.js:76-94` |
| JS reader uses envelope-only decryptVector | ★ `src/search/d1-loader.js:194` |
| Python readers via bridge (shared `decrypt_vectors`) | ★ `pipeline/compute_information_harmonics.py:415-432` (+ coherence/novelty/cross-scale importers) |
| anchor_vector writer+reader are Python via bridge | ★ `pipeline/compute-anchors.py:160,178-179` |
| Both columns ∈ NEVER_AUTO_DECRYPT, not ENCRYPTED_FIELDS | `src/crypto/crypto-local.js:1792,1797` (+ skip 1804-1829) |
| Codecs exist (JS+Py), dim 768 | `src/search/ann/decode.js:108-142` · `pipeline/crypto_local.py:348-376` · `src/embed/client.js:16` |
| Backfill engine handles dim 768; `LIKE 'ey%'` envelope count | `src/account/backfill.js:30-33,50-100` |
| No vec0/FTS/index on these columns | sweep E (grep migrations + src/search) |
| Gates asserting envelope-ness to rewrite | `scripts/verify-anchors.mjs:110` · verify-nomic-embedding-encryption (NE1-7) · verify-enrich (N2-3) · verify-claims (C2a) |
| measure-only runs the embedding_768 metric readers | `pipeline/run-clustering.sh` Steps 4-16 (measure-only path) |

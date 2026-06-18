# Handoff — Embedding storage layout (the "2.43× base64 bloat" candidate)

**Status:** DESIGN CANDIDATE — *not built*. Parked deliberately after a sweep showed it is
the highest-risk / lowest-marginal-value of the three at-rest perf improvements. Pick this
up as its own **full sweep-first-design + copy-rehearsed migration** project. Do **not** run
any format/migration change against the live vault without rehearsing on a copy first.

Author: at-rest perf session, 2026-06-18. Sibling work that DID ship this session lives on
branch `fix/at-rest-migration-lock` (PR #256): batched bulk build (`e6043cc`), cooperative
paginated read + WAL-autocheckpoint suspend (`7c95244`), parallel-decrypt spike (`0431210`).
See [[at-rest-search-build-perf]] memory.

---

## TL;DR

Each `embedding_768` is stored at **2.43× its raw size** — a **7,472-byte** envelope for a
**3,072-byte** (768×f32) vector — and the inflation is **almost entirely base64, not
encryption**. Across the ~69,447-message vault that is **~306 MB of pure base64 waste**, and
it is the bulk of what makes the one-time index build's decrypt-read heavy (the 312.9s scan).

The clean fix is a **binary envelope format** (keep full Layer-B crypto, kill the base64) —
**NOT** "drop the envelope" (that trades §7 security for ~nothing, since encryption is only
~70 bytes of the bloat). BUT the envelope is a **cross-language codec contract** (JS
`crypto-local.js` ↔ Python `crypto_local.py`) used across the measurement pipeline, so the
change is a security-critical, cross-language, multi-table **migration of the most sensitive
data in the vault**. Deferred because the bloat's main cost (build time) is already mitigated
by the cooperative build + the proven 5.2× parallel decrypt; the residual cost is ~306 MB of
disk (minor) + proportionally heavier reads.

---

## The measured finding (hard evidence)

- Storage chain (`src/search/ann/decode.js`): `Float32Array(3072B) → base64(4096B) →
  encrypt() → base64(JSON({v,s,iv,ct,tag,...}))`. Base64 **on top of** base64.
- Measured envelope length: **7,472 chars** for a 3,072-byte vector = **2.43×**. The
  encryption proper (IV+tag+wrapped-DEK+scope) is only **~70 bytes**; the rest is base64.
  Reproduce:
  ```js
  // run from the worktree
  import { encryptVector } from './src/search/ann/decode.js';
  import { webcrypto } from 'node:crypto';
  const vec = new Float32Array(768); for (let i=0;i<768;i++) vec[i]=Math.random()*2-1;
  const mk = await webcrypto.subtle.importKey('raw', Buffer.alloc(32,7), 'HKDF', false, ['deriveBits','deriveKey']);
  const env = await encryptVector(vec, 'personal', mk);
  console.log(env.length, (env.length/vec.byteLength).toFixed(2)+'x'); // 7472 2.43x
  ```
- Why it matters for perf: the process `sample` of the live build showed the dominant cost is
  **`DecryptPageSQLCipherCipher` + `sqlcipher_hmac`** — i.e. SQLCipher *page* decrypt of the
  bytes, NOT the envelope decrypt (only ~31 of ~1500 hot samples were WebCrypto). So 2.43×
  more embedding bytes ≈ 2.43× more SQLCipher pages to decrypt for the embedding portion of
  the scan. Shrinking the bytes shrinks the build's dominant cost.

## The constraint that makes it hard: cross-language envelope contract

The wrapped-DEK envelope is implemented **twice** and must stay byte-compatible:
- JS: `src/crypto/crypto-local.js` (`encrypt`/`decrypt`), wrapped by `src/search/ann/decode.js`
  (`encryptVector`/`decryptVector`, base64 carrier).
- Python: `pipeline/crypto_local.py` (`encrypt_vector`, `decrypt_vectors`, `encrypt_bytes`,
  `encrypt_str`, `fetch_envelopes_chunked`).

Python readers/writers of these envelopes (all must move in lockstep with any format change):
- `pipeline/compute-coherence.py:151-152` — decrypts embedding_768 envelopes.
- `pipeline/compute-anchors.py:160,282-283` — decrypts embedding_768 AND **writes** new ones
  (`crypto_local.encrypt_vector(mean_vec, 'personal', mk)`, "byte-compatible with embedding_768").
- `pipeline/cluster.py:177-228` — encrypted embedding cache (`encrypt_bytes`/`encrypt_str`,
  `_NOMIC_SCOPE`); centroids; clustering_points.nomic_embedding.
- `pipeline/compute-frequency.py:80-275` — content + centroid_256 envelopes.
- fisher (`compute-fisher`, per [[measurement-layer-audit]] `_dec_float`).

JS readers/writers of `embedding_768` (also in scope):
- `src/search/d1-loader.js:194-195` — decrypts per row for the index build.
- `src/db/claims.js:64-127` — person_claims.embedding_768 (cosine match), NEVER_AUTO_DECRYPT.
- `src/ingest/full-export-import.js:156,165` — re-encrypts on import (`encryptVector(vec,'personal',mk)`).
- `src/ingest/vault-import.js:36` — `encryptVector`.
- `src/crypto/crypto-local.js:1711` — `embedding_768` is in NEVER_AUTO_DECRYPT (caller-managed).
- Other tables with `embedding_768`: documents, territory_profiles, realms, semantic_themes,
  person_claims (full-export-import.js:165-169) — same format, same migration.

## Security context (so we don't weaken §7)

- Embeddings are **never federated** — active tripwire `src/federation/lexicon.js:12`
  (`VECTOR_KEY_RE = /(embedding|vector|centroid|matryoshka|\bvec\b)/i`) + `handlers.js:246`
  refuse to serialize any vector field (CLAUDE.md §7: embeddings are semantic fingerprints;
  inversion attacks are real). So Layer-B's *selective-sharing* purpose does not apply here.
- BUT: that is an argument for keeping them well-encrypted, not for dropping a layer. The
  recommended design **keeps Layer-B crypto** and only changes the *encoding* (base64→binary).
  Dropping the envelope entirely would rely solely on whole-file SQLCipher (keyed by
  `deriveDbKey(USER_MASTER)`); since both layers chain to the SAME master key, the real-world
  defense-in-depth gain of Layer-B is marginal for the local single-user threat — but the
  size win of "drop the envelope" over "binary envelope" is also marginal (~70 bytes), so
  there is **no reason to drop it**. Keep the crypto.

## Recommended design (when picked up)

1. **Binary envelope** (preferred): define a packed binary envelope `magic ‖ ver ‖ scope_len ‖
   scope ‖ iv(12) ‖ wrapped_dek ‖ tag(16) ‖ ciphertext`, encrypt the **raw 3072 vector bytes**
   (no inner base64), store the column as **BLOB** (not TEXT). Keeps Layer-B AES-GCM + AES-KW
   scope wrap. Expected ~3,142 B/row (≈2.4× smaller). Implement in BOTH `crypto-local.js` and
   `crypto_local.py`, with a shared test vector proving byte-compatibility (JS-encrypt →
   Python-decrypt and vice versa) BEFORE any data moves.
2. **Versioned envelope + dual-read**: bump the envelope `v` field; readers accept v1 (legacy
   base64) AND v2 (binary). Writers emit v2. Migration re-encodes v1→v2 lazily or in a batched
   job. This avoids a flag-day and lets the migration be resumable/abortable.
3. **Alternative / complement — separate 1:1 `message_embeddings` table**: moves vectors out of
   the `messages` row so content/FTS scans don't drag them and the vec-index pass + FTS pass
   can run as independent (parallelizable) reads. Lower risk (no format change, no Python
   change) but does NOT shrink bytes — pairs well with the parallel-decrypt loader (#2).

## Migration plan (must rehearse on a COPY first — never live-first)

1. Copy the live encrypted vault → scratch copy (keyed). 2. Run the v1→v2 re-encode over
`messages.embedding_768` + documents/profiles/themes/person_claims + clustering caches +
centroids + anchors. 3. Parity-check: count, dim, and a sample of vectors decrypt identically
pre/post. 4. Confirm Python pipeline (cluster/coherence/anchors/fisher/frequency) reads v2 on
the copy. 5. Gate (`verify:embedding-format` — round-trip JS↔Python byte-compat + v1/v2
dual-read + size assertion). 6. Only then offer the live migration (app-triggered, like the
measure-only job per [[measure-only-and-key-blocker]] — pipeline scripts can't open the live
vault standalone; the working key is in the running app's session memory).

## Why deferred (decision record)

- Build-TIME cost of the bloat is already addressed: cooperative one-time build (shipped) +
  proven 5.2× parallel worker-thread decrypt (`scripts/spike-parallel-decrypt.mjs`, spike
  `0431210`; build target = #2 in the reorder).
- Residual cost = ~306 MB disk (minor; 6 GB just reclaimed by deleting plaintext backups) +
  proportionally heavier reads of embedding_768 (clustering/claims/export).
- Versus: a cross-language, security-critical, live-vault migration of §7 data. Risk ≫ value
  right now. Revisit if (a) vault size pressure returns, or (b) the measurement pipeline is
  re-enabled and embedding reads become hot again.

## Pickup protocol

1. `/sweep-first-design` — re-verify the caller inventory above against live code (file:line);
   the Python pipeline may have moved.
2. Write `docs/DESIGN-embedding-storage-layout-<date>.md` (binary envelope spec + JS↔Python
   byte-compat test vector + dual-read versioning + migration).
3. `/pre-deletion-caller-audit` for the TEXT→BLOB column change + the v1 format retirement.
4. Build behind a versioned envelope (dual-read), gate, rehearse on a copy, then app-triggered
   live migration.

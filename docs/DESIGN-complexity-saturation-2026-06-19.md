# LZ Complexity Saturation — SOTA Fix Design

**Date:** 2026-06-19
**Status:** LOCKED (sweep-first, 3 Explore sweeps + self-verified reads + live data)
**Scope:** Fix the LZ-complexity metric saturating at 1.00 for short sequences (21% of territories on the live vault). Three coupled fixes — char-vs-symbol bug, surrogate normalization, min-length gate — plus the UI honesty surface. **Deferred (named):** `embedding_novelty_ratio` as the Tier-1 cross-check (spec §4.19 — does not exist in code).

---

## 0. Headline

`/complexity` showed **40 of 192 territories (21%) pinned at exactly 1.00**, all with short activity sequences (mean 5.2 active days vs 16 for the rest). Two compounding causes, both in the shared `lzComplexity` primitive:

1. **Char-vs-symbol bug** — LZ runs over a comma-joined *character string*, so `n` = char count and `raw_complexity` counts char-phrases (explains the impossible `raw=4` for a `sequence_length=2` territory). A bug, fixed regardless.
2. **Asymptotic normalization at small n** — `normalized = c / (n/log₂a)` is the LZ76 *asymptotic optimum*; its finite-size convergence is O(log log n / log n), so the bias is large even at n=1000 and **catastrophic at n=5**. There is no clean analytic finite-n correction — the field doesn't patch the normalizer, it **changes the method** to a surrogate/shuffle null (the LZc lineage: Schartner 2015 → Casali PCI).

The fix mirrors patterns already validated in this codebase (the Fisher `null_model_z` and PLV `phase_locking_value_debiased` surrogate nulls), so it extends a proven pattern rather than inventing one.

---

## 1. Revision history

- **v1 (user sketch):** "surrogate-normalize LZ + min-length gate + char fix, with embedding_novelty as the Tier-1 cross-check (already in the stack)."
- **v2 (after Sweep C + self-read of spec §4.18/4.19 lines 503-515, 255-256):** **PIVOT — `embedding_novelty_ratio` does NOT exist in code.** It's a spec STUB (§4.19, Tier-1, "NN distance fraction"), never built — no column, no stage, no storage (grep clean across migrations + pipeline). So the "cross-check is already in the spec, you already have it" premise is half-right: the *spec intent* exists, the *code* does not. Pairing LZ with embedding-novelty requires a **net-new stage**. → scoped OUT of this fix; named as a deferred follow-up. Also surfaced: spec §4.18 already says LZ should be "True textbook LZ76 … **NOT the JS approximation**" — i.e. the current heuristic is a known-wrong impl — and tiers LZ76 as **Tier-2**, embedding-novelty as **Tier-1** (embedding-novelty is the spec's preferred primary).
- **v2 (after Sweep B + self-read of `harmonics.py:420-431`):** the PLV-debiased template returns `(obs−null_mean)/(1−null_mean)` clamped [0,1] — but PLV is bounded at 1; LZ is not. For LZ the correct surrogate form is the **ratio-to-null** `c_obs / mean(c_shuffled)` (the standard LZc normalization), naturally in [0,1]. Confirmed surrogate-alone does NOT un-saturate all-distinct short sequences (shuffling [3,5]→[5,3] is equally complex) → **the min-length gate is load-bearing, not optional.**
- **v2 (after Sweep A + self-read of `compute-complexity.js:54-65`):** territory sequence = **distinct active days** quantized 0-5; the `pts.length < 5` guard is on *point* count, not *day* count, so short sequences pass through. Territory LZ is degenerate **by construction** — most territories are touched on few days. (Realm/global use territory-transition sequences = message count → long, well-behaved.)

---

## 2. Sweep findings (consolidated, file:line)

### The primitive + callers (Sweep A)
- `lzComplexity` (`src/metrics/primitives.js:134-167`): `s = sequence.map(String).join(',') + ','; n = s.length` — LZ parses the **char string**, so commas/digits are symbols and `n` is char count. `maxComplexity = n / Math.log2(alphabetSize)`; `normalized = Math.min(1, complexity/maxComplexity)`.
- Callers: **complexity-only** — `compute-complexity.js:67` (territory), `:92` (realm), `:111` (global). No other production caller (also `scripts/verify-primitives.mjs`). → safe to change the signature.
- Territory sequence (`compute-complexity.js:56-65`): `dayCounts` → `days` (distinct dates) → quantized 0-5. `sequence.length = distinct active days`. Guard `pts.length < 5` is point-count, not day-count.
- Realm (`:90-91`): `pts.map(p => p.territory_id)`, guard ≥10 points. Global (`:106-107`): all territory ids, guard ≥10. These are long (message-scale).
- Schema `complexity_snapshots` (`migrations/0001_init.sql:524-539`): **no `low_confidence`, `notes`, `cvp_status`, or baseline column.** Encrypted: `lz_complexity, raw_complexity, sequence_length, alphabet_size, point_count, level_name` (`crypto-local.js:611-615`). UPSERT key `(user_id, level, level_id, window_end)`.
- `/complexity` (`portal-measurement.js:332-360`) returns the rows; UI `CuriousLifeView.svelte` renders `lz_complexity` bars with **no honesty indicator** — the 1.00s the user sees.

### The surrogate pattern to mirror (Sweep B)
- Fisher `null_model_z` (`fisher.py:205-247`): deterministic `rng = np.random.default_rng(seed)`, seed = `sha256(user|level|window_type|window_start)` (`compute-fisher.py:172-182`), 200 resamples, `z = (obs − null_mean)/null_std`, clamp on degenerate null.
- PLV `phase_locking_value_debiased` (`harmonics.py:374-431`): circular-shift surrogate, returns `{obs, null_mean, null_std, z, debiased}` with `debiased = clamp((obs−null_mean)/(1−null_mean), 0, 1)`.
- **No shared surrogate helper** — both inline. Deterministic seeding throughout. → I'll add an inline seeded shuffle in the JS primitive (a small `mulberry32` PRNG, since JS has no numpy).

### embedding-novelty (Sweep C) — the pivot
- `embedding_novelty_ratio` is **spec-only** (§4.19 STUB, Tier-1). Not in any migration, not computed, not stored. Cosine primitives (`primitives.js:51 cosineSim`, `compute-anchors.py` anchor cosine) + `messages.embedding_768` exist, so it's *buildable* as a new stage — but it's **net-new code**, out of scope here.

---

## 3. The fix (scoped)

### 3.1 `src/metrics/primitives.js` — rewrite `lzComplexity` (~60 LOC)
Replace the char-string heuristic with **textbook LZ76 over the symbol array** + **surrogate normalization**:

```js
// Deterministic PRNG (no numpy in JS) — seedable, for reproducible surrogate nulls.
function mulberry32(seed) { /* 5-line PRNG */ }

// Textbook Lempel-Ziv 1976 production complexity over a SYMBOL ARRAY (element
// equality, not characters) → integer c(n). O(n) amortized. NO comma/char conflation.
function lz76(symbols) { /* Kaspar–Schuster production count */ }

/**
 * @param {Array} sequence  — symbols (numbers/strings), each one token
 * @param {{ surrogates?: number, seed?: number, minReliable?: number }} [opts]
 * @returns {{ complexity, normalized, nullMean, nullStd, lowConfidence,
 *             sequenceLength, alphabetSize }}
 */
export function lzComplexity(sequence, { surrogates = 99, seed = 1, minReliable = 20 } = {}) {
  const n = sequence.length;
  const alphabetSize = new Set(sequence).size;
  if (n < 2 || alphabetSize < 2)
    return { complexity: n ? 1 : 0, normalized: 0, nullMean: null, nullStd: null,
             lowConfidence: 1, sequenceLength: n, alphabetSize };

  const cObs = lz76(sequence);                     // raw, over symbols → cObs ≤ n
  // Surrogate null: shuffle the SAME multiset; LZ of the shuffles ≈ the max
  // complexity achievable at this n+alphabet → cObs/mean(null) ∈ [0,1]:
  //   ~1 = no structure beyond chance (novel);  <1 = more compressible (repetitive).
  const rng = mulberry32(seed >>> 0);
  const nulls = [];
  for (let i = 0; i < surrogates; i++) nulls.push(lz76(shuffle(sequence, rng)));
  const nullMean = mean(nulls), nullStd = std(nulls);
  const normalized = nullMean > 0 ? Math.min(1, cObs / nullMean) : 0;
  // Gate: too short to discriminate, OR a degenerate null (no surrogate variance →
  // every ordering equally complex → the metric can't tell structure from chance).
  const lowConfidence = (n < minReliable || nullStd < 1e-9) ? 1 : 0;
  return { complexity: cObs, normalized: Math.round(normalized * 1000) / 1000,
           nullMean, nullStd, lowConfidence, sequenceLength: n, alphabetSize };
}
```

### 3.2 `pipeline/compute-complexity.js` — seed + write confidence (~15 LOC)
- Pass a deterministic seed per entity+window: `seed = djb2(`${userId}|${level}|${level_id}|${windowEnd}`)` (a tiny string-hash → 32-bit int; mirrors the Fisher sha256-seed intent without a crypto import in the hot loop).
- Carry `lowConfidence` through the result and into the INSERT.

### 3.3 `migrations/0027_complexity_confidence.sql` (~3 LOC)
`ALTER TABLE complexity_snapshots ADD COLUMN low_confidence INTEGER DEFAULT 0;` (idempotent guard via applyMigrations). Plaintext (a flag, not sensitive). Add to the UPSERT column list.

### 3.4 `src/portal-measurement.js` `/complexity` (~3 LOC)
SELECT + return `low_confidence`.

### 3.5 `portal-app/src/lib/views/CuriousLifeView.svelte` (~12 LOC)
Filter or grey territories with `low_confidence === 1` in "Complexity by territory" (and the global ring) — so the misleading saturated 1.00s stop being shown as confident values. Copy: a small "needs more activity to measure" note for gated ones.

**Total LOC: ~95** (primitives 60, stage 15, migration 3, endpoint 3, UI 12 + ~40 test).

---

## 4. Edge cases — explicit decisions

- **All-distinct short sequence (e.g. [3,5]).** Surrogate ratio ≈ 1 (shuffles equally complex) AND `nullStd ≈ 0` → `lowConfidence=1`. Stored but flagged; UI hides. Honest: "indistinguishable from random at this length."
- **Determinism.** Seeded `mulberry32` per (user|level|level_id|window) → bit-identical across runs (required for the verify gate + stable UI). No global RNG state touched.
- **Performance.** Textbook LZ76 is O(n) amortized (vs the old O(n²) `includes`). Surrogate cost = `surrogates × O(n)`. Territories: 192 × 99 × short-n → <1s. Global/realm: one global + ~22 realms × 99 × O(n) even at n=10k → a few M ops, sub-second. The stage was 0.13s; expect <1-2s. `surrogates` env-tunable (`COMPLEXITY_SURROGATES`) for a kill-switch.
- **`minReliable=20`.** Empirically the surrogate variance collapses below ~20 symbols here. Env-tunable. Realm/global rarely gate (long sequences); most *territories* will gate — which is correct (the construct is degenerate per-territory).
- **Backward value shift.** Existing `lz_complexity` values change meaning (asymptotic → surrogate-ratio). That's the point; the next measure run overwrites all rows (UPSERT). No migration of old values needed.
- **Char fix invariant.** `raw_complexity ≤ sequence_length` now holds (LZ over symbols, not chars). The verify gate asserts this.

---

## 5. Threat model / security

- All metric columns stay SEC-3 encrypted; `low_confidence` is a plaintext flag (like other structural columns) — not sensitive, needed for SQL/UI filtering. No ciphertext in a predicate.
- No new egress, endpoint, table, or IPC. The surrogate runs in-process in the existing stage. No plaintext logged (counts + the flag only).
- The PRNG is non-cryptographic (correctly — it's a statistical surrogate, not a secret). Seed is content-free (ids + window date).

---

## 6. Test strategy

| Test (file) | Asserts |
|---|---|
| `verify:primitives` (EXTEND) | (a) `raw ≤ sequenceLength` (char-fix invariant); (b) determinism — same seed → identical `normalized`/`nullMean`; (c) a REPETITIVE sequence (e.g. [1,1,1,1,…]) → `normalized` well below 1 (structure detected); (d) a short all-distinct sequence → `lowConfidence=1`; (e) a long random sequence → `lowConfidence=0` and `normalized` near 1 but NOT saturating a structured long sequence. |
| `verify:complexity` (EXTEND) | (f) stage writes `low_confidence`; (g) on a seeded vault with a short-sequence territory, that row has `low_confidence=1`; a long-sequence realm has `0`; (h) no territory has `raw_complexity > sequence_length`. |
| `verify:metrics-rest` (EXTEND) | `/complexity` returns `low_confidence` in each row. |
| `npm run verify` | full chain green before merge. |

---

## 7. Implementation order

1. **Primitive rewrite + `verify:primitives`** (LZ76 + surrogate + gate, behavior-neutral until callers pass opts). Smoke: `verify:primitives` GO.
2. **Stage seed + low_confidence write + migration 0027 + `verify:complexity`.** Smoke: GO; forced short-territory → low_confidence=1.
3. **`/complexity` + `verify:metrics-rest`.** Smoke: GO.
4. **UI grey/hide low_confidence.** Smoke: portal build + svelte-check.
5. **Full `npm run verify` + live measure run** — confirm the 1.00 cluster is now gated (greyed), long-sequence values are real, `raw ≤ seqlen` everywhere.
6. **PR + merge.**

---

## 8. Decision criteria / done

- No territory row has `raw_complexity > sequence_length` (char fix).
- Short-sequence territories carry `low_confidence=1` and are greyed/hidden in the UI (the 1.00 cluster stops reading as confident).
- A repetitive sequence scores well below 1; a structured long sequence is not falsely saturated (surrogate discriminates).
- `verify:primitives` + `verify:complexity` + full `npm run verify` GREEN; CI green; live re-run confirms.

---

## 9. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Surrogate cost blows up the stage | Low | Med | O(n) LZ76 + bounded `surrogates` (env kill-switch); measured <2s |
| `minReliable=20` mis-tuned (gates too much/little) | Med | Low | env-tunable; verify gate pins behavior at the boundary; the per-territory construct is genuinely weak (gating is honest) |
| Old `lz_complexity` values change meaning silently | High | Low | intended; UPSERT overwrites on next run; UI note explains "needs more activity" |
| Migration 0027 collides with a concurrent session | Med | Low | renumber at merge (did this for 0023→0024); ADD COLUMN idempotent |
| Non-deterministic PRNG breaks the gate | Low | Med | seeded mulberry32; determinism asserted in `verify:primitives` |

---

## 10. Open questions

**Resolved during sweep:**
- *Is embedding_novelty already in the stack?* No — spec-only (§4.19). Scoped out.
- *Does surrogate normalization alone fix saturation?* No — all-distinct short sequences stay ~1; the min-length gate is required.
- *Is the per-territory construct sound?* Marginal — territory sequences are short by construction; LZ lives in the degenerate regime per-territory. Surrogate+gate make it *honest*, but see deferred.

**Deferred (named, out of scope):**
1. **Spec §4.18 construct mismatch** — the spec's LZ76 is on per-window *plaintext* (text compressibility); the current impl is on activity-level/territory-id sequences (pattern compressibility). Different constructs. Reconcile in a future pass.

---

## 12. Embedding-novelty Tier-1 primary (IN SCOPE — user elected the full build)

The spec's Tier-1 cross-check (§4.19) does not exist in code; we build it now as the **primary** per-territory novelty signal (LZ becomes the Tier-2 cross-check). It degrades gracefully at low n — NN cosine distance is defined for n≥2 — exactly where LZ is degenerate.

### 12.1 Operationalization
Per territory: **intra-territory nearest-neighbor cosine-distance dispersion**.
- Decrypt each territory message's 768D embedding; for each embedding compute `1 − max cosine` to its nearest OTHER message in the same territory; `embedding_novelty = mean(NN distance)`.
- High = the territory's content is spread out (exploratory/novel); low = clustered (repetitive/routine). The embedding analog of LZ compressibility, robust at low n.
- `low_confidence = 1` when the territory has `< MIN_NOVELTY` (default 4) embedded messages.
- This is the §4.18-4.20 *compression-novelty* family's embedding member (NN-distance, §4.19); a temporal current-vs-prior-window variant is a future refinement (noted).

### 12.2 Architecture — new Python stage (envelopes are NEVER_AUTO_DECRYPT)
`pipeline/compute-embedding-novelty.py` — runs AFTER complexity (Step 10) in run-clustering.sh, reuses the harmonics decrypt path, and **UPDATEs the rows compute-complexity just wrote** (no window-coordination coupling):
- Reuse `from compute_information_harmonics import fetch_envelopes_chunked, decrypt_vectors` (768D, numpy). Master key via `crypto_local` (the cluster/fisher path).
- Query `clustering_points` for `(territory_id, source_id, created_at)` in-window; group message ids by territory.
- Per territory: fetch+decrypt embeddings → L2-normalize → cosine matrix → mean NN distance → `embedding_novelty`, `low_conf`.
- `stage_crypto.enc` the value (SEC sensitive, like the harmonic scalars); UPDATE `complexity_snapshots SET embedding_novelty = ?, embedding_novelty_low_conf = ? WHERE user_id=? AND level='territory' AND level_id=? AND window_end=(latest)`. Realm/global: optional (mean of member-territory novelty) — territory is the surfaced one.
- `stage_result.run_main('embedding-novelty', main)` (fail-loud + health recording; the bounded-writer/health patterns from this session).

### 12.3 Schema (migration 0027, extended)
`ALTER TABLE complexity_snapshots ADD COLUMN low_confidence INTEGER DEFAULT 0;` (LZ gate)
`ALTER TABLE complexity_snapshots ADD COLUMN embedding_novelty REAL;`  (encrypted via ENCRYPTED_FIELDS.complexity_snapshots)
`ALTER TABLE complexity_snapshots ADD COLUMN embedding_novelty_low_conf INTEGER DEFAULT 0;`
Add `embedding_novelty` to `ENCRYPTED_FIELDS.complexity_snapshots` (crypto-local.js).

### 12.4 Surface
`/complexity` returns `low_confidence`, `embedding_novelty`, `embedding_novelty_low_conf`. The UI "Complexity by territory" shows **embedding-novelty as the primary bar** (the Tier-1 signal), LZ as a secondary/cross-check, both greyed when their respective low-confidence flag is set.

### 12.5 Stage register + run order
- `run-clustering.sh`: add `node`/`python` step after complexity (Step 10) — call it Step 10b or renumber; keep measure-only-inclusive.
- `measurement-health` FAMILY_STAGE / freshness: register `embedding-novelty` stage so the health card tracks it.
- `verify:embedding-novelty` (new gate): seeded vault with a tight cluster (low novelty) + a spread cluster (high novelty) + a 1-message territory (low_confidence); assert the ordering + the flag + that the value is encrypted at rest.

### 12.6 LOC (embedding-novelty)
New stage ~120, migration +6, crypto-local +1, endpoint +3, UI +15, run-clustering +6, measurement-health +2, gate ~80. **~230 LOC** on top of the ~95 LZ-fix LOC.

### 12.7 Verification table (embedding-novelty additions)
| Assumption | Verified at |
|---|---|
| `messages.embedding_768` is envelope-encrypted (NEVER_AUTO_DECRYPT → Python decrypt path) | `src/crypto/crypto-local.js:345,1711` (read) |
| `fetch_envelopes_chunked` + `decrypt_vectors` reusable, 768D float32 | `compute_information_harmonics.py:404-445` (read) |
| message→territory link via clustering_points (territory_id, source_id, created_at) | `compute-complexity.js:46-49` (read) |
| anchors/harmonics establish the decrypt-embeddings-in-a-stage precedent + stage_crypto.enc | `compute-anchors.py:179,209` (sweep) |
| complexity_snapshots UPSERT key (user,level,level_id,window_end) — UPDATE-by-key works | `compute-complexity.js:173-188` (read) |

---

## 11. Verification table

| Assumption | Verified at |
|---|---|
| `lzComplexity` runs LZ over the comma-joined char string; `n` = char length | `src/metrics/primitives.js:139-140` (read) |
| Normalization is the asymptotic `n/log₂(alphabet)`, clamped to 1 | `src/metrics/primitives.js:159-160` (read) |
| `lzComplexity` is complexity-only (3 callers, no external) | `compute-complexity.js:67,92,111` (sweep) + grep |
| Territory sequence = distinct active days; guard is point-count not day-count | `pipeline/compute-complexity.js:54-65` (read) |
| `complexity_snapshots` has NO low_confidence/notes/cvp/baseline | `migrations/0001_init.sql:524-539` (read — grep clean) |
| Fisher/PLV provide a deterministic surrogate-null pattern to mirror | `pipeline/fisher.py:205-247`, `pipeline/harmonics.py:420-431` (sweep + read of PLV return) |
| PLV-debiased returns clamped [0,1] via `(obs−null)/(1−null)` (template, but PLV-bounded) | `pipeline/harmonics.py:422-431` (read) |
| `embedding_novelty_ratio` does NOT exist in code (spec STUB only) | `docs/COGNITIVE-MEASUREMENT-SPEC-2026-06-04.md:511-515` (read) + grep clean (sweep C) |
| Spec tiers LZ76 = Tier-2, embedding-novelty = Tier-1; paired as compression-novelty | spec lines 255-256, 503-515, 728 (read) |
| `/complexity` + CuriousLifeView render lz_complexity with no honesty flag | `src/portal-measurement.js:332-360`, `CuriousLifeView.svelte` (sweep) |
| `messages.embedding_768` + cosine primitives exist (for the deferred embedding-novelty) | `src/metrics/primitives.js:51`; `compute_information_harmonics.py` decrypt-vector path (sweep) |

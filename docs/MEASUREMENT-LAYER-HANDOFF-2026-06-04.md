# Measurement Layer — Session Handoff — 2026-06-04

## ⭐ FINALIZATION (2026-06-04, latest) — the whole buildout plan is DONE

**STATUS: buildout COMPLETE. PR OPEN, awaiting review/merge → https://github.com/Curious-Life/mycelium.id/pull/90**
Branch `feat/measurement-foundation-encryption-fisher` — **6 commits**, pushed to `origin`, off clean
`main` (`b90fa2a`, untouched). **Full `npm run verify` = 63 GO / 0 NO-GO, exit 0.** Every task F1–F5, G,
SEC + SEC-1..4, K1(+K1b), T1, S1, H1, C1, E1, X1 is COMPLETE. Each landed as: subagent build → my review
→ adversarial security-review subagent (all SHIP / SHIP-WITH-NITS, nits fixed) → full verify → commit.

Commits (oldest→newest):
1. `6b36e7d` foundation (F1–F5) + gaps + encryption sweep (SEC-1..4 + K1b) + Fisher keystone (K1)
2. `b96468b` T1 topology-graph stages (vitality/audit/complexity/frequency) + the cofire/neighbors CLI
   encryption production-bug fix (getDb-hex → boot()) + verify:pipeline-cli-encryption guard
3. `514a9f4` S1 surface-to-human REST bridge (src/portal-measurement.js, loopback fail-closed auth) +
   recovered the operator research spec → docs/COGNITIVE-MEASUREMENT-SPEC-2026-06-04.md (952 lines)
4. `cdd3043` compute-only families: H1 (§4.24/§4.34), C1 (criticality), coherence, behavioral-temporal
5. `958b653` E1 embedding-anchor (Tier-1, **CVP-pending**) + X1 CVP harness + presentation-contract
   validator + closed the legacy-harmonics plaintext-at-rest gap
6. `55459a6` final handoff doc

**The Fisher "movement" pillar is no longer hollow.** All 4 measurement pillars + the 13-family battery
are computed, encrypted at rest, surfaced to the human (except CVP-gated Tier-1 anchor metrics), and
each behind a `verify:*` gate.

**OPERATOR-GATED RESIDUALS (by design, not unfinished work):**
- **CVP calibration** — the embedding-anchor Tier-1 metrics (E1) are computed but stored
  `cvp_status='pending'` and NOT surfaced, because the spec (§2.3) mandates a Construct Validity
  Protocol pass on YOUR human-labeled held-out data before shipping. Nothing is faked.
- **Host-verified residual** — a real Generate run on a populated vault confirms the Python-bridge
  end-to-end (centroids/dynamics/cofire/fisher/anchors); production anchor embedding needs the Nomic
  embed-service (:8091) running. All verify gates use random keys + stub embedder (no keychain/network).

---

## ▶ NEXT-SESSION PICKUP PROTOCOL (do this, in order)

**0. Orient (2 min).**
```bash
cd ~/mycelium.id && git fetch origin
git checkout feat/measurement-foundation-encryption-fisher   # the work branch
git log --oneline main..HEAD          # the 6 commits above
gh pr view 90                          # PR status / review state
npm run verify > /tmp/v.log 2>&1; echo $?   # expect 0 (NEVER pipe to | tail — masks npm's exit)
```
Read this doc's FINALIZATION block (above) + `docs/MEASUREMENT-LAYER-BUILDOUT-PLAN-2026-06-04.md`
changelog (bottom, newest first: v2.2 → v1.0) for the full per-task story.

**1. Land the PR (#90).** It's reviewed (per-batch adversarial security reviews, all SHIP) + green.
Address any human review comments, then merge. After merge, the live checkout `~/mycelium.id` may be on
stale `main` — `git checkout main && git pull` to run the merged app. (Per memory: the live stack runs
from `~/mycelium.id`; PRs are GitHub PRs via `gh`.)

**2. Host-verify on a real vault (the one thing CI can't do).** With a populated vault + keys unlocked +
the Nomic embed-service on :8091, click **Generate** (or run `pipeline/run-clustering.sh` with
USER_MASTER/SYSTEM_KEY/MYCELIUM_DB set). It now runs **16 steps** (1 sync … 7 fisher … 8–11 topology …
12–15 cognitive families … 16 anchors). Confirm: no stage errors; `fisher_trajectory`/`territory_cofire`/
`territory_neighbors`/`cognitive_metrics_*`/`cognitive_anchor_vectors` populate; the portal Vitality/
trajectory pages render real numbers via the S1 bridge (`/api/v1/portal/...`). This closes the
"verified-by-pattern" residual into "verified-on-host".

**3. CVP-calibrate the embedding-anchor metrics (when you have labels).** This is the ONLY thing blocking
the E1 Tier-1 metrics from surfacing. The harness is built + tested (`src/metrics/cvp.js`,
`verify:cvp`). Steps: (a) gather operator human-labeled examples per construct (insight / reflective-
depth / affect / inner-state) — see seed phrases in `pipeline/anchors/definitions.py`; (b) run
`runCVP(values, labels)` (discriminant / incremental / confound-neutralization per spec §2.3); (c) on
pass, set the family's `cvp_status='pass'` (in `src/metrics/contracts.js` + the stored rows) — the
presentation-contract validator (`assertNotSurfacedUnlessValidated`) then lets them through the human
surface. Until then they correctly stay `pending` + `low_confidence=1`, never served as validated.

**4. Optional follow-ups (not blocking):** behavioral-temporal uses UTC hours (per-user TZ deferred);
`ml_transition_detector` (criticality) + `entity_grid_coherence` are honest NULL stubs awaiting a trained
model / NER; the §4.24 cross-scale "bands" are flagged `experimental` (text-band validity unproven) — all
documented in the buildout plan v2.1/v2.2. Baseline calibration (90-day, the `low_confidence`-off rule)
is Phase 6 and also needs accumulated real data.

## MOST-FRAGILE KNOWLEDGE (read before touching the measurement code)
1. **`npm run verify` real exit** — always `> log 2>&1; echo $?`; `| tail` masks npm's exit code (this
   bug bit a prior session). ~20 measurement gates are in the chain now (63 GO total).
2. **Encryption by writer language.** JS pipeline stages encrypt via `ENCRYPTED_FIELDS` (adapter
   auto-encrypt) **and MUST open the vault with `boot()`, NOT `getDb({userKey:hex})`** — getDb-with-hex
   can't make a CryptoKey, so encrypted writes throw "not of type CryptoKey" and get swallowed (this was
   the real cofire/neighbors prod bug; `verify:pipeline-cli-encryption` guards it). Python stages
   caller-encrypt via `pipeline/stage_crypto.py` `enc()` / `crypto_local.encrypt_*`.
3. **Decrypted values read back as STRINGS** → coerce with `Number()` (JS: `coerceNums` in fisher.js /
   topology.js) or `float()` (Python: `stage_crypto.dec_float`). **numpy 2.x `repr(np.float64(x))` ==
   `'np.float64(x)'`** (not `'x'`) → `enc()` coerces `repr(float(x))` first or the value is poisoned.
4. **Never SQL-filter/sort/aggregate an encrypted column** (AES-GCM non-deterministic) — do it in JS over
   decrypted values, joining only on the plaintext structural skeleton (keys/time/enums/counts).
5. **Caller-encrypt columns auto-decrypt on JS read** without being in `ENCRYPTED_FIELDS` (they just
   look encrypted) — that's how fisher/criticality/coherence/behavioral/anchor metrics round-trip. The
   exception is raw typed-vector columns (`embedding_768`, `nomic_embedding`, `anchor_vector`) which are
   in `NEVER_AUTO_DECRYPT_COLUMNS` and decrypted only by their typed consumer.
6. **CVP gate is load-bearing honesty** — `assertNotSurfacedUnlessValidated` refuses any Tier-1 metric
   lacking a contract OR `cvp_status==='pass'`; `runCVP` returns `'pending'`, never a fabricated `'pass'`,
   when labels are absent. Don't "temporarily" surface anchor metrics by bypassing it.
7. **Canonical source = `~/Documents/GitHub/mycelium`** (READ-ONLY); **spec = `docs/COGNITIVE-MEASUREMENT-
   SPEC-2026-06-04.md`** (the operator's research synthesis, recovered verbatim — source of truth for the
   families). The as-built map is `docs/MEASUREMENT-LAYER-STATE-2026-06-04.md`; the per-task log is the
   BUILDOUT-PLAN changelog; encryption design is `docs/MEASUREMENT-ENCRYPTION-DESIGN-2026-06-04.md`.
8. **Don't commit the pre-existing untracked noise** — `.claude/launch.json`,
   `assets/mycelium-icon-square.svg`, `src-tauri/{Cargo.lock,icons/**}` — none of it is this work.

---

## TL;DR
Reviewed the codebase + measurement system, **marked the honest state**, then with the
operator built the **foundation** for bringing the measurement layer out, fixed the
**"gaps" feature**, and ran a near-complete **"encrypt everything sensitive" sweep**.
Everything below is **verified GO** via the `npm run verify` chain (new gates wired in).

**Status: COMMITTED to a branch (not merged, not pushed).** Branch
`feat/measurement-foundation-encryption-fisher` (single commit at HEAD, 42 files; run
`git log --oneline -1` for the hash) off `main` (`b90fa2a`, which stays clean). Foundation F1–F5 + gaps + encryption sweep SEC-1..4 + Fisher
keystone K1 (a+b). Security-reviewed (adversarial subagent → SHIP-WITH-NITS; the one actionable
nit — era_skip column-name SQLi hardening — applied before commit). The pre-existing untracked
noise (`.claude/launch.json`, `assets/mycelium-icon-square.svg`, `src-tauri/{Cargo.lock,icons/**}`)
was deliberately NOT staged. Next: `gh pr create` / merge when ready, or continue the buildout
(T1/H1/E1/C1/S1/X1) on this branch. Current vault is throwaway (write/recompute freely).

**The encryption sweep is COMPLETE** (SEC-1..4) **and the Fisher keystone (K1) is SHIPPED**
(compute + encryption). Remaining functional buildout: **T1/H1/E1/C1/S1/X1**.

> **UPDATE 2026-06-04 (K1 SHIPPED — Fisher keystone, the movement pillar).** Ported
> `pipeline/{fisher.py, extract_activations.py, compute-fisher.py}` from canonical with the 3 audit
> fixes (sha256 window-seed — proven bit-identical by verify F6; clamp-inf-z; era-ISO via
> `stage_base.derive_era_id`). Added `extra_filters` to `era_skip`. Wired Step 7/7 in
> run-clustering.sh + jobs.js. **K1b** encrypted the fisher tables at rest via the SEC-4
> caller-encrypt pattern (Python `crypto_local.encrypt_str` on write → JS adapter auto-decrypts on
> read → `src/db/fisher.js` `coerceNums`; Python era-skip/milestone reads decrypt via
> `decrypt_safe`). NOT in ENCRYPTED_FIELDS (Python-write-only/JS-read-only). GOTCHA: numpy 2.x
> `repr(np.float64)` poisons values → coerce `float()` first. New gates `verify:fisher` (6) +
> `verify:fisher-encryption` (5). **Full `npm run verify` = 50 GO / 0 NO-GO, exit 0.**
> `getCurrentPhase` now returns a classified phase — `cognitiveState` movement is no longer hollow.

> **UPDATE 2026-06-04 (later session): SEC-4 DONE.** `clustering_points.nomic_embedding` is now
> encrypted at rest via the wrapped-DEK vector envelope (mirrors `embedding_768`: caller-encrypt,
> stays in `NEVER_AUTO_DECRYPT`). Built a **reusable, JS-byte-compatible Python crypto write path**
> in `pipeline/crypto_local.py` — `encrypt_bytes`/`encrypt_str`/`encrypt_vector` (+ `decrypt_vector`,
> `decrypt_safe`, a `__main__` self-test). Wired: JS `sync-clustering-points.js` write → `encryptVector`
> envelope TEXT; `cluster.py` read → `_decode_nomic_embedding` (envelope **or** legacy-raw fallback);
> `cluster.py._write_embeddings_to_d1` → `crypto_local.encrypt_vector`. No migration (SQLite dynamic
> typing). New gate `verify:nomic-embedding-encryption` (5 checks, real cross-language round-trips).
> **Full `npm run verify` = 48 GO / 0 NO-GO, exit 0.** Also fixed a latent bug: `decrypt_safe` was
> imported by cluster.py but didn't exist — now implemented. **The `pipeline/cache/*.npy` local cache
> residual is also RESOLVED** — `_save_cache`/`_load_cache` now encrypt-on-write / decrypt-on-read via
> the same `crypto_local` envelope, and a legacy plaintext cache is rejected + deleted on load (gate
> extended to NE1–NE7). No plaintext embedding bytes touch disk anywhere.

---

## What shipped this session (all verified GO)

Tracked as session tasks; see the three living docs for full detail:
- **State (as-built truth):** `docs/MEASUREMENT-LAYER-STATE-2026-06-04.md`
- **Buildout plan + canonical port map + changelog:** `docs/MEASUREMENT-LAYER-BUILDOUT-PLAN-2026-06-04.md`
- **Encryption design (column classification + phases):** `docs/MEASUREMENT-ENCRYPTION-DESIGN-2026-06-04.md`

1. **Honesty pass** — corrected stale code that lied about itself: `cluster.py` "UMAP+HDBSCAN"/"Leiden" docstrings (real algo = spherical k-means + Ward HAC; Leiden is dead code), `run-clustering.sh`/`jobs.js` labels, cofire half-life comment, growth_state 'stuck'. (STATE §8.)
2. **Gaps fix (G)** — `pipeline/compute-territory-neighbors.js` (new modular stage) populates `territory_neighbors` (centroid cosine top-K) so `getGaps` is live. Wired into run-clustering.sh (Step 5/6) + jobs.js.
3. **Foundation F1–F5:** F1 `src/metrics/primitives.js` (ported, 1e-12 Python-parity gate); F2 completed `pipeline/harmonics.py` (Hilbert/PAC/PLV/Welch-coherence/Haar) + PyWavelets dep; F3 true LZ76 + variance + Fiedler (`pipeline/graph_metrics.py`); F4 migrations `0007_cognitive_events` + `0008_metrics_language`; F5 `era_skip` run_id_column param + event_emit contract documented.
4. **Encryption sweep:**
   - **Type-agnostic fix** (`crypto-local.js`) — closed a **real latent leak**: the adapter only encrypted *string* params, so numeric `ENCRYPTED_FIELDS` columns (health_daily metrics, wealth_* amounts, cognitive_events.magnitude) were **stored plaintext despite being declared encrypted**. Now encrypts numbers too; readers coerce.
   - **SEC-1** centroids (`centroid_256`/`centroid_3d`).
   - **SEC-2** cofire strengths + neighbor `distance` → required **rewriting `src/db/topology.js`** to JS-side filter/sort/aggregate over decrypted values (joins on plaintext keys only).
   - **SEC-3** cognitive scalars (`energy`/`coherence`/`velocity`/`current_vitality`/`point_delta`) → `coerceScalars` helper + `energy`/`current_vitality` sorts moved to JS (`territory-docs.js`, `topology-tools.js`). **`message_count` kept plaintext** (structural ranking + search-index key).

---

## Verification

```bash
cd ~/mycelium.id
# Full chain (capture REAL exit — never `| tail`, it masks npm's code):
npm run verify > /tmp/verify.log 2>&1; echo "EXIT=$?"
# New gates added this session (all GO):
node scripts/verify-primitives.mjs                      # F1: 1e-12 Python parity
node scripts/verify-measurement-schema.mjs              # F4: cognitive_events + language + encryption
node scripts/verify-health-encryption.mjs              # leak fix: health numerics encrypted
node scripts/verify-centroid-encryption.mjs            # SEC-1
node scripts/verify-topology-encryption.mjs            # SEC-2: cofire/distance + JS-filter rework
node scripts/verify-territory-scalars-encryption.mjs   # SEC-3
node scripts/verify-nomic-embedding-encryption.mjs     # SEC-4: JS↔Python vector envelope parity
node scripts/verify-territory-neighbors.mjs            # gaps fix
node scripts/verify-fisher.mjs                         # K1a: keystone computes + era-skip + sha256 determinism
node scripts/verify-fisher-encryption.mjs              # K1b: fisher tables ciphertext at rest + adapter decrypt
PYTHONPATH=pipeline pipeline/.venv/bin/python3 pipeline/crypto_local.py  # reusable crypto self-test
PYTHONPATH=pipeline pipeline/.venv/bin/python3 pipeline/fisher.py        # fisher math self-test
# Python self-tests (need pipeline/.venv):
pipeline/.venv/bin/python3 pipeline/graph_metrics.py   # Fiedler
pipeline/.venv/bin/python3 pipeline/era_skip.py        # era-skip param
```
Regression each phase: `mindscape`, `cognition`, `chronicles`, `search`, `leak`, `portal-mindscape`, `generate` — all GO.

---

## Most-fragile knowledge (read before touching this)

1. **AES-GCM here is NON-DETERMINISTIC.** You cannot JOIN/range-filter/GROUP/dedup on an encrypted column. So the relational **skeleton MUST stay plaintext**: PKs/FKs/join keys (territory_id, realm_id, user_id…), time-range keys (date, window_end, created_at…), era/partition (era_id, clustering_run_id), low-card WHERE enums/flags (event_type, severity, is_catchall, growth_state, current_phase), content_hash. "Encrypt everything" = everything **sensitive/content/derived**, never the skeleton.
2. **The adapter encrypts STRING params only — numbers must be coerced.** `encryptablePlaintext()` (crypto-local.js) now `String()`-coerces numbers/bigints before encrypt. This was THE leak. Any numeric column you add to `ENCRYPTED_FIELDS` is now encrypted on JS-adapter write.
3. **Decrypt returns STRINGS.** A decrypted numeric column comes back as a string → readers must `Number()`-coerce. Patterns: `parseHealthRow` (health), `coerceScalars` (territory-docs), `loadTerritories`/`numOr0` (topology.js). Add coercion wherever you read a newly-encrypted numeric.
4. **Encrypted columns can't be SQL-filtered/sorted → do it in JS.** `src/db/topology.js` was rewritten to this pattern (fetch on plaintext keys → adapter decrypts → JS filter/sort/aggregate). Graphs are small (≤ a few hundred) so it's microseconds. Same pattern for territory-docs/topology-tools energy+current_vitality.
5. **`cluster.py` Python writes:** plaintext columns use `d1_batch`; **ENCRYPTED_FIELDS columns MUST use `d1_batch_encrypted`** (the Node bridge). Centroid + dynamics writes were switched. The bridge encrypts only the ENCRYPTED_FIELDS columns in the statement (mixed UPSERTs are fine). cluster.py reads of encrypted columns must `crypto_local.decrypt_bytes` (already done for embedding_768).
6. **`message_count` is deliberately plaintext** — a count + the primary ranking key for the in-RAM search corpus (search/index.js top-100) + many sorts. Operator-aligned: encrypt the cognitive *signal*, keep the structural ranking count plaintext (well-engineered; search stays fast/robust).
7. **The Fisher "movement" pillar is HOLLOW** — `fisher_trajectory`/`fisher_milestones` have NO writer anywhere (not even canonical). `cognitiveState` movement/milestones are always empty until K1 ports the compute. (STATE §3.4.)
8. **Canonical source = `~/Documents/GitHub/mycelium`** (Curious-Life/mycelium, main). The port map (which files to copy/strip/fix) is in BUILDOUT-PLAN §9, from 3 deep audits. Fisher = "complete a half-built port"; topology stages = copy+strip+fix (zero schema delta).
9. **Operator's research synthesis** (the *Cognitive Measurement System* unified spec) is the TARGET; it's in the conversation and **should be committed** to `docs/COGNITIVE-MEASUREMENT-SPEC-2026-06-04.md` (I didn't re-type it to avoid corrupting a source-of-truth doc).

---

## Open / pending (the pickup work)

### A. Finish the encryption sweep — **SEC-4 (`nomic_embedding`)** — ✅ DONE (see TL;DR update)
The below was the plan; it shipped exactly as designed (reusable Python `encrypt_vector` byte-matches
JS `encryptVector`, verified both directions). Kept for reference / the original risk analysis.
`clustering_points.nomic_embedding` is cluster.py's primary 256-D store, a **raw plaintext binary BLOB** (a semantic fingerprint — sensitive, README §7). Encrypt via the typed-vector envelope (mirror `embedding_768`):
- **Write (JS, sync):** `sync-clustering-points.js` → `encryptVector(...)` (exists, `src/search/ann/decode.js:88`) → store envelope TEXT (not BLOB).
- **Read (Python, cluster):** `decrypt_bytes` (exists, `pipeline/crypto_local.py:139`; cluster.py already uses it for embedding_768) → bytes → `np.frombuffer`.
- **Write (Python, cluster.py:382 ONNX fallback `nomic_embedding = X'<hex>'`):** ⚠️ NEEDS A NEW Python `encrypt_vector` in `crypto_local.py` that **byte-exactly matches** the JS `encryptVector` wrapped-DEK envelope. This is the risk — wrong format = silent clustering corruption. Add `nomic_embedding` to ENCRYPTED_FIELDS; keep it in `NEVER_AUTO_DECRYPT_COLUMNS` (typed consumers decrypt). Add `verify:nomic-embedding-encryption`. **Don't rush this.**

### B. The functional buildout (designed, NOT built) — tasks K1/T1/H1/E1/C1/S1/X1
Foundation + encryption are done; the actual metric families beyond the 3 live harmonic families are not. Per BUILDOUT-PLAN §5, recommended order:
- **K1 — Fisher keystone** (the hollow pillar): port `pipeline/{fisher,extract_activations,compute-fisher}.py` from canonical with 3 audit bug-fixes (sha256 seed, clamp `inf` z, ISO era fallback) + tests + run-clustering.sh step. Lights up cognitiveState movement.
- **T1** topology-graph stages (vitality/audit/complexity/frequency) — copy+strip+fix; **fixes flagged**: compute-frequency decrypts `messages.content` before gzip; compute-vitality magic-constants scale to vault size; compute-complexity `level_name` encryption.
- **H1** §4.24 cross-scale coupling (harmonics.py now has PAC/PLV/coherence/wavelet) + Wasserstein for §4.34.
- **E1** embedding-anchor family (Tier-1, greenfield). **C1** criticality (writes `cognitive_events`). **S1** surface-to-human (port the REST bridge so the Vitality page renders). **X1** CVP harness + behavioral-temporal + coherence.

### C. Host-verified residuals (need a real clustering run, not CI)
cluster.py's bridge writes (centroids SEC-1, dynamics SEC-3, cofire) are **verified-by-pattern** (JS round-trip proven; `d1_batch_encrypted` proven for activity_timeline) but need a **real `npm run` Generate on a populated vault** to confirm end-to-end Python-bridge encryption. The harmonics §4.24 functions + Fiedler are unit-smoke'd only.

---

## Pickup protocol (next session)
1. `cd ~/mycelium.id && git status` — confirm the 14 modified + new measurement files are still there (uncommitted).
2. Read `docs/MEASUREMENT-LAYER-STATE-2026-06-04.md` (truth) + BUILDOUT-PLAN §9 (port map) + ENCRYPTION-DESIGN §6 (SEC phases).
3. `npm run verify > /tmp/v.log 2>&1; echo $?` — confirm GREEN baseline before changing anything.
4. **If continuing encryption:** do SEC-4 carefully (§A above) — start by reading the JS `encryptVector` envelope format (`src/search/ann/decode.js`) + `crypto_local.py decrypt_bytes`, then write+test the Python `encrypt_vector` against a JS-encrypted fixture BEFORE wiring it.
5. **If building features:** start K1 (Fisher keystone) per BUILDOUT-PLAN; port from `~/Documents/GitHub/mycelium/scripts/{fisher,extract_activations,compute-fisher}.py`.
6. **Commit when ready:** branch off main first (don't commit to main directly); the session's work is a coherent "measurement foundation + encryption hardening" unit. Run `/security-review` on the crypto diff before merge.

## File inventory (this session's work — exclude pre-existing untracked noise)
**Modified:** `src/crypto/crypto-local.js`, `src/db/{topology,territory-docs,helpers,fisher}.js`, `src/tools/topology-tools.js`, `src/jobs.js`, `pipeline/{cluster.py,crypto_local.py,harmonics.py,era_skip.py,event_emit.py,run-clustering.sh,requirements.txt,sync-clustering-points.js}`, `migrations/0001_init.sql`, `package.json`.
**New (mine):** `src/metrics/{primitives,index}.js`; `pipeline/{compute-territory-neighbors.js,graph_metrics.py,fisher.py,extract_activations.py,compute-fisher.py}`; `migrations/0007_cognitive_events.sql`, `0008_metrics_language.sql`; `scripts/fixtures/primitives_fixture.json`; `scripts/verify-{primitives,measurement-schema,health-encryption,centroid-encryption,topology-encryption,territory-scalars-encryption,nomic-embedding-encryption,territory-neighbors,fisher,fisher-encryption}.mjs`; `docs/MEASUREMENT-LAYER-{STATE,BUILDOUT-PLAN,HANDOFF}-2026-06-04.md`, `docs/MEASUREMENT-ENCRYPTION-DESIGN-2026-06-04.md`.
**K1 specifically:** NEW `pipeline/{fisher.py,extract_activations.py,compute-fisher.py}`, `scripts/verify-fisher{,-encryption}.mjs`; MODIFIED `pipeline/{era_skip.py (extra_filters), run-clustering.sh (Step 7/7)}`, `src/jobs.js (label 7)`, `src/db/fisher.js (coerceNums)`, `package.json`.
**SEC-4 specifically touched:** `pipeline/crypto_local.py` (reusable encrypt path + self-test), `pipeline/sync-clustering-points.js` (envelope write), `pipeline/cluster.py` (`_decode_nomic_embedding` + `_write_embeddings_to_d1`), `src/crypto/crypto-local.js` (comment), `scripts/verify-nomic-embedding-encryption.mjs`, `package.json`.
**NOT mine (pre-existing untracked — do not attribute/commit with this work):** `.claude/launch.json`, `assets/mycelium-icon-square.svg`, `pipeline/cache/`, `src-tauri/Cargo.lock`, `src-tauri/icons/**`.
**To add:** `docs/COGNITIVE-MEASUREMENT-SPEC-2026-06-04.md` (operator's research synthesis — paste from the conversation).

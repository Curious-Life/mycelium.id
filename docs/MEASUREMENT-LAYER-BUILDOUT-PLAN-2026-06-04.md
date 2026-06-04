# Measurement Layer — Buildout Plan (v1.1, co-design) — 2026-06-04

> **What changed in v1.1:** the **research synthesis landed** — the *Mycelium Cognitive
> Measurement System: Theory, Design, and Implementation Specification* (Unified v1.0,
> Ada, 2026-06-04). That document is now the **TARGET**. This plan fuses it with the
> as-built ground truth in [`MEASUREMENT-LAYER-STATE-2026-06-04.md`](MEASUREMENT-LAYER-STATE-2026-06-04.md)
> (gap IDs **G1–G12**). §3 is the new reconciliation crosswalk; §6 marks which decisions
> the spec now resolves vs. which are still ours to make together.
>
> **ACTION:** commit the unified spec verbatim to `docs/COGNITIVE-MEASUREMENT-SPEC-2026-06-04.md`
> (the operator has the canonical copy; offered to drop it in). Citations below as
> `§4.NN` refer to that spec; `path:line` refer to this repo.
>
> **Still awaiting (optional but accelerating):** the canonical *implementation* code for
> the un-ported compute stages (see §2.2 / decision D-M1).

---

## 1. Goals & non-goals

**Goals** — make the measurement layer (1) **honest** (done — STATE §8), (2) **visible to
the human** not just the agent, (3) **complete** (fill the empty/absent pillars per the
spec's battery), (4) **coherent** (converge schema, kill drift), (5) **calibrated** (the
moat — baselines, CVP, honest rigor labels).

**Non-goals (now)** — Tier-3 sensor/EEG bridge; multi-tenant/V2; federation; the
aspirational frontier (regime/"7+ modes") until the substrate is real and calibrated.

---

## 2. The target & the inputs

### 2.1 The target (the synthesis) — what it gives us
- A **theoretical spine**: information geometry / Fisher-Rao as the bedrock (Cencov
  uniqueness) — i.e. the **Fisher trajectory is the foundation**, not an add-on.
- A **complete metric battery**: 35 spec'd metrics (§4.1–4.35) with KEEP/REPLACE/REMOVE
  verdicts + **13 new metrics**, organized into **13 method families**, each tagged with
  a **privacy tier (0/1/2/3)** and a **scientific-rigor label**
  (validated-clinical / validated-mathematical / well-grounded-heuristic / experimental).
- **Design discipline**: the 10-field spec-sheet, the **Construct Validity Protocol (CVP)**
  gate for every Tier-1 embedding metric, null-model z-scores, bootstrap CIs, and
  **presentation contracts** (agent may/​must-not say) — a direct extension of the honesty
  stance V1 already encodes (`src/metrics/contracts.js`, `low_confidence` on).
- **10 structural invariants (I1–I10)**: family = pipeline stage; era-mode skip-existing;
  one AppArmor + one decrypt boundary per Tier-2 family; wide tables + `language` col +
  `cognitive_events` table from day 1; per-family freshness; canonical primitives w/
  cross-language fixtures.
- The **keyword→embedding paradigm shift**: no keyword/lexicon/regex measures — use
  embedding-anchor clusters (Pokropek 2026 CFA framing).

### 2.2 The inputs
- ✅ **Research synthesis** — received (this is it).
- ⏳ **Canonical implementation export** — still useful for the un-ported compute stages
  (Fisher/trajectory `compute-frequency`/`check-milestones`, `compute-vitality`,
  `topology-audit`). **Gates D-M1** (port the proven code vs. rebuild from the spec's
  algorithms). The spec gives enough algorithm detail to rebuild if the code isn't handy.

---

## 3. Reconciliation crosswalk — TARGET (spec families) × NOW (V1 reality)

**The two headline consequences of laying the spec over the ground truth:**

1. **Keystone inversion.** The spec's theoretical bedrock — information geometry /
   Fisher-Rao / `phase_recent` (§4.1), which it labels "LIVE" — is exactly V1's **hollow
   pillar**: `fisher_trajectory`/`fisher_milestones` have **no writer anywhere** (STATE
   §3.4). The spec's "LIVE" reflects the *canonical* system; in V1 the foundation is the
   single biggest gap (**G3**). Everything in the information-geometry, criticality, and
   movement use-cases sits on top of it. **It is the keystone build.**
2. **V1 computes ~3 of the 13 families.** Only **information-harmonics** (§4.23/§4.33/§4.34)
   is actually written; co-firing **data** exists but its **metrics** don't; *everything
   else is absent* (grep-confirmed: no MTLD/HD-D/VADER/Lyapunov/integrative/Big-Five/
   critical-slowing/spaCy/Stanza in `src/`+`pipeline/`; no `cognitive_events` table). So
   the redesign is mostly a **greenfield build to spec**, not a port-and-patch — which is
   *good news*: it means we **skip the keyword era entirely** (the spec's 5 "REPLACE"
   verdicts become "build the embedding-anchor version from the start"; the Tier-2→1
   upgrades come for free).

**Legend:** ✅ LIVE (computed+written) · ◐ DATA-ONLY (data exists, metric not computed) ·
◑ EMPTY (schema present, no writer) · ✗ ABSENT (not in V1 at all).

| Spec family | Tier | Key spec metrics | V1 now | Gap |
|---|---|---|---|---|
| **information-geometry** (the keystone) | 0–1 | 4.1 phase_recent, 4.2 dominant_territories, 4.3 stance_shift, 4.4 recurrence_interval, 4.20 breadth_entropy, 4.22 activation_smoothness, 4.28 lyapunov | ◑ EMPTY — `fisher_trajectory` no writer | **G3** |
| **information-harmonics** | 1 | 4.23 harmonic_amplitude, 4.33 bigram_flow, 4.34 H0_persistence | ✅ LIVE (3 families) | refine: wavelet>FFT (4.23), Wasserstein (4.34) |
| | | 4.24 cross_scale_coupling (PAC/PLV/coh) | ✗ ABSENT | **G8** |
| **criticality-phase-transitions** | 0–1 | 4.25 CSD-autocorr, 4.26 CSD-variance, 4.27 phase_lock_event_σ, flickering, ml_transition | ✗ ABSENT (derivable once G3 + topology trajectory exist) | new |
| **topology-graph** | 0 | 4.15/4.16/4.17 cofire-rate/delta/half-life, 4.29 anchor_band_concentration, memory_depth_sensitivity, graph_spectral_gap | ◐ DATA-ONLY (`territory_cofire` written; metrics not) | **G4/G5/G6** + new |
| **embedding-anchor** (new shared infra) | 1 | 4.5 insight_proximity, 4.11 inner_presence, 4.12 reflective_density, 4.13 affective_volatility | ✗ ABSENT | new (foundational) |
| **coherence-universal** | 1–2 | 4.31 semantic_coherence_adjacent, discourse_coherence_embedding, entity_grid | ✗ ABSENT (4.31 cheap from embeddings) | new |
| **linguistic-structural** (renamed) | 1–2 | 4.6 temporal_frame_shift, 4.7 MTLD, 4.8 HD-D, 4.9 sentence_len, 4.10 syntactic_depth, metaphor, epistemic_stance, narrative_arc | ✗ ABSENT | new |
| **affect** | 1–2 | 4.13 (shared w/ anchor), emotional_inertia, affect_complexity | ✗ ABSENT | new |
| **compression-novelty** | 1–2 | 4.18 LZ76, 4.19 embedding_novelty_ratio | ✗ ABSENT (V1's old gzip-on-ciphertext metric is graveyarded) | new |
| **integrative-complexity** | 2 | 4.30 (verify not keyword-based) | ✗ ABSENT | new |
| **personality-text** | 2 | 4.35 big_five (defaults OUT) | ✗ ABSENT | new (opt-in) |
| **behavioral-temporal** | 0 | 4.21 language_share, diurnal_pattern, session_cadence | ✗ ABSENT (cheap, timestamp/metadata-only) | new |
| **cross-modal-bridge** | 3 | (deferred) | ✗ | future |

**Schema deltas the spec implies (vs STATE):** add a `cognitive_events` table (for §4.27
discrete events — none today); converge the dormant `cognitive_metrics_{window,trajectory,
per_territory}` onto the spec's grain (I4); ensure `language` column everywhere (already on
`cognitive_metrics_harmonic`); a new per-edge grain for 4.17; anchor-cluster definitions
storage (versioned).

---

## 4. Principles (carried + extended by the spec)

1. **Honesty in code first** — rigor labels surfaced at tool-call time; `low_confidence`
   stays on until calibration earns it off; **no overclaiming** (the spec's corrections are
   binding: CSD sensitivity **32.9% not 89%**; Bedi-2015 coherence is high-risk-cohort
   overfit, not general journaling; bands ≠ EEG Hz; within-user only).
2. **CVP gate** — every Tier-1 embedding metric passes discriminant + incremental +
   confound-neutralization before shipping (~2 days/family).
3. **Every metric carries a presentation contract** (may/​must-not say + refusal_mode),
   extending `src/metrics/contracts.js`.
4. **Null-model z + bootstrap CIs** near the noise floor.
5. **Family = one pipeline stage; one decrypt boundary per Tier-2 family** (I1/I3).
6. **Fail closed; encrypted-at-rest for every new metric column** (add to `ENCRYPTED_FIELDS`).
7. **Evidence over paper; one verifiable slice at a time** behind a `verify:*` gate.

---

## 5. Phased buildout (PROPOSED — sequence/scope pending your call, §6 D-M8/D-M9)

- **Phase 0 — Honesty** ✅ substantially done (STATE §8). Remaining: user-facing claims
  (README/VISION "200–400 territories"; Modules "Active" badge) — fold into Phase 1.
- **Phase PR0 — Foundations (gates the rest).** Per invariants I1–I10: stage-base scaffold
  (env/DB/log/UPSERT/era-skip — partly exists in `pipeline/stage_base.py`); the
  **embedding-anchor infrastructure** (versioned anchor clusters + cosine primitives — new
  shared family, unblocks §4.5/4.11/4.12/4.13); schema deltas (`cognitive_events`, grain
  convergence, anchor storage); canonical primitives (`harmonic regression`, `wavelet`,
  `PAC/PLV/coherence`, `AR(1)+variance`, `MTLD/HD-D`, `LZ76`) with cross-language fixtures;
  the CVP harness; the presentation-contract validator.
- **Phase 1 — Surface what's already real (G1, G2, G10).** Port the measurement REST
  bridge so the *shipped* Vitality page + cognitive-metrics tab render real
  harmonics/topology/series; un-park nav; fix the "Active" overclaim. **Unblocked now** —
  data exists, only the HTTP seam is missing.
- **Phase 2 — The keystone: information-geometry / Fisher (G3).** Build the trajectory +
  milestones compute stage → `fisher_trajectory`/`fisher_milestones` (Fisher-Rao+Hellinger,
  phase classification, R_recent, null-model z; Rosenstein/min-100 for 4.28). Lights up
  `cognitiveState` movement + the criticality family's inputs.
- **Phase 3 — Topology-graph metrics (G4/G5/G6 + new).** Turn the live cofire **data** into
  metrics; fill `territory_neighbors`/audit/vitality; compute `current_vitality`/`phase`
  (kill 0.50/'gift'); add graph_spectral_gap / anchor_band_concentration.
- **Phase 4 — High-value Tier-1 families.** information-harmonics §4.24 (G8) + refinements;
  criticality-phase-transitions; coherence (4.31 first); embedding-anchor metrics
  (insight/reflective/affective/inner); behavioral-temporal (cheap Tier-0).
- **Phase 5 — Tier-2 families (behind PR0 Tier-2 discipline, D-M8).** linguistic-structural;
  affect (Tier-2 parts); compression-novelty; integrative-complexity; personality (opt-in).
- **Phase 6 — Calibration moat (G7).** 90-day baselines; the `low_confidence`-off rule;
  CVP validation per family; null/bootstrap everywhere.
- **Phase 7 — Frontier.** regime / "7+ modes" / potential-landscape — only on the
  calibrated stack, claims gated by evidence.

---

## 6. Decisions — what the spec RESOLVES vs. what's still OUR call

**Resolved by the spec (adopt):**
- **D-M6 metric taxonomy** ✅ — the §4 battery + 13 families + tiers + keep/replace/remove.
- **D-M4 calibration framework** ✅ (framework) — CVP, null-models, bootstrap CIs, rigor
  labels, presentation contracts, corrected sensitivities. *Actual baselines still need
  data (→ Phase 6).*
- **D-M7 schema shape** ✅ — I4: fisher_trajectory grain, wide tables, `language` day-1,
  `cognitive_events` table, per-territory table, era-mode skip (I2).
- **D-M2 clustering** ✅ (mostly) — spec doesn't change clustering; keep k-means+Ward, add
  topology-graph metrics; dead-Leiden/HDBSCAN cleanup remains **G12**.
- **D-M1 Fisher algorithm** ◑ — algorithm specified (Fisher-Rao+Hellinger, phase classify,
  R_recent, null-z, Rosenstein); **open only on port-vs-rebuild** (needs canonical export).

**Still open — for us to decide together (the questions I'm putting to you now):**
- **D-M1′** — port the canonical Fisher/un-ported-stage code, or rebuild from the spec?
- **D-M3 cofire time model** — keep 7/14/30/90d, or bucket-matched half-lives? (spec keeps
  the metrics but doesn't settle this) — driven by what cofire feeds downstream.
- **D-M5 human surface** — port the existing Vitality page as-is, or redesign the
  measurement UX around the spec's use-case catalog (U1–U25)?
- **D-M8 Tier-2 discipline** — full AppArmor/process-isolation per I3, or a lighter
  single-user-localhost model (plaintext is already in-process for enrichment)?
- **D-M9 sequence & scope** — keystone-first vs surface-first; full battery vs a
  high-confidence Tier-1 core first.

---

## 7. Verification gates (per phase) — capture real exit (`> log 2>&1; echo $?`, never `| tail`)
- **PR0:** primitive fixtures pass at 1e-12 cross-language; anchor-cluster + CVP harness green.
- **Phase 1:** `verify:metrics-rest` (bridge serves window/series/contracts/vitality/freshness on a seeded vault) + live preview showing real numbers (not "Era unavailable").
- **Phase 2:** `verify:fisher` — seeded run writes ≥1 `weekly_step` row; `getCurrentPhase` returns a phase; `cognitiveState` movement non-empty.
- **Phase 3:** `verify:topology-fill` — gaps/audit/vitality populated; no static 0.50/'gift'.
- **Phase 4–5:** per-family `verify:<family>` + CVP pass; `npm run verify` stays GO.
- **Phase 6:** `verify:calibration` — baselines populated; `low_confidence` flips per rule; honesty copy intact.

---

## 8. Changelog
- **2026-06-04 v1.1** — Research synthesis received → set as TARGET; added the
  reconciliation crosswalk (§3); marked D-M6/D-M4/D-M7/D-M2 resolved-by-spec; refined phases
  (PR0 foundations, embedding-anchor infra, keystone-Fisher). Open forks → D-M1′/3/5/8/9.
- **2026-06-04 v1.0** — Skeleton created alongside the state-marking pass (honesty edits landed).

---

## 9. Canonical Port Map (from 3 deep audits of Curious-Life/mycelium)

**Canonical source:** `/Users/altus/Documents/GitHub/mycelium` (main, 2026-05-31). Read-only.
Decision: **port-and-fix** (operator: "check everything discovered there, test it, fix it fully").

**Reframes from the audits:**
- The **Fisher keystone is a half-built port, not greenfield** — V1 already has the schema,
  the read-side (`src/db/fisher.js`, `src/tools/fisher-tools.js`), and the Python harness
  (`pipeline/{d1_client,stage_base,era_skip,event_emit}.py`). Missing only the compute:
  `fisher.py` + `extract_activations.py` + `compute-fisher.py` (~1000 LOC, mostly verbatim).
- **Topology-graph stages need ZERO V1 schema changes** — all tables already in `0001_init`.
- **Criticality, embedding-anchor, cognitive_events, true-LZ76, Fiedler are greenfield in BOTH**
  repos — build to spec, not port.

**What to COPY / BUILD / FIX:**

| Item | Action | Canonical source → V1 dest | Fixes on port |
|---|---|---|---|
| primitives lib | **COPY** | `packages/metrics/*` → `src/metrics/` (relative imports) | monorepo→relative; keep V1 contracts.js |
| harmonics.py | **COPY (replace truncated)** | `scripts/harmonics.py` → `pipeline/harmonics.py` | +PyWavelets dep |
| LZ76 / variance / Fiedler | **BUILD** | — (heuristic/absent in canonical) | true LZ76 alongside heuristic |
| cognitive_events | **BUILD** | — (absent in canonical) | per spec I4 |
| Fisher (K1) | **COPY+FIX** | `scripts/{fisher,extract_activations,compute-fisher}.py` → `pipeline/` | sha256 seed · clamp inf-z · era-ISO fallback · strip event_emit/auth |
| vitality | **COPY+FIX** | `scripts/compute-vitality.js` → `pipeline/` | scale magic-constants to vault size |
| complexity | **COPY+FIX** | `scripts/compute-complexity.js` → `pipeline/` | encrypt `level_name` (zero-plaintext) |
| frequency | **COPY+FIX** | `scripts/compute-frequency.py` → `pipeline/` | decrypt `messages.content` before gzip |
| topology-audit | **COPY** | `scripts/topology-audit.js` → `pipeline/` | strip Worker/auth |
| REST bridge (S1) | **COPY** | `reference/server-routes/{portal-metrics,portal-vitality,internal-metrics,portal-metric-freshness}.js` → `src/` | mount in server-rest.js |

**Decisions taken (flag if you disagree):**
- **D-M1′ → port** the un-ported stages from canonical (per your call), with the audit's bug-fixes.
- **Primitives placement** → `src/metrics/` (JS) + `pipeline/` (Python), relative imports (V1 isn't a monorepo).
- **Coordinator** → append metric stages to `pipeline/run-clustering.sh` (V1's existing user-triggered model); **defer** porting `pipeline-health.js` (the cloud hourly-cron coordinator) — note it as optional.
- **`level_name` plaintext leak** → resolve in V1's favour: encrypt it (CLAUDE.md zero-plaintext) — canonical accepted the leak; V1 won't.
- **Missing primitives** → build now (Tier-1 core needs them): true LZ76, rolling variance, Fiedler.
- **territory_neighbors / "gaps"** → ✅ **DONE (2026-06-04, operator: "fix gaps first")** — authored
  `pipeline/compute-territory-neighbors.js` (modular stage, one-file-one-stage, centroid_256 cosine
  top-K → territory_neighbors); wired into run-clustering.sh (Step 5/6) + jobs.js labels;
  `getGaps` now live. `verify:territory-neighbors` GO (8/8), in the verify chain.

**Blockers cleared before wiring stages (F5):** `event_emit` signature mismatch; `era_skip`
hardcodes `clustering_run_id` (canonical-158 tables use `era_id`) → parameterize; PyWavelets dep.

**Sequence:** F1→F5 (foundation) → K1 (keystone) → T1 + H1 → (S1 in parallel) → E1, C1, X1.
Tasks tracked in the session task list (F1…X1).

- **2026-06-04 v1.9** — **T1 SHIPPED (topology-graph stages) + GREEN.** Ported all 4 from canonical
  → `pipeline/{compute-vitality.js, compute-complexity.js, topology-audit.js, compute-frequency.py}`
  (zero schema delta — all 5 target tables already in 0001). Flagged fixes done: vitality
  magic-constants → vault-derived denominators (realm/theme counts, p90 partner/intra/messages);
  complexity `level_name` encrypted; frequency decrypts `messages.content` BEFORE gzip; audit stripped
  of Worker/auth. Encryption: JS stages (vitality/complexity/audit) via ENCRYPTED_FIELDS auto-encrypt;
  Python frequency via caller-encrypt — every sensitive metric/distribution/explanation encrypted,
  structural keys/enums/counts plaintext; reworked `src/db/topology.js` getAuditFindings (moved the
  encrypted message_count ORDER BY to JS) + Number()-coercion in topology-tools.js. Wired Steps 8–11
  in run-clustering.sh + jobs.js labels 8–11 + 4 verify gates. **Found+fixed a real production bug
  the encryption sweep introduced:** `compute-cofire.js` + `compute-territory-neighbors.js` opened the
  vault via `getDb({userKey:<hex>})`, which CANNOT encrypt (subtle.deriveBits needs a CryptoKey) — so
  once SEC-2 encrypted cofire_*/distance, every CLI-spawned write threw and was swallowed →
  `territory_cofire`/`territory_neighbors` came out EMPTY in production (the in-process verify gates
  booted, so they missed it). Fixed both to `boot()`; added `verify:pipeline-cli-encryption`
  (reproduces the spawned-CLI path). Security-reviewed (adversarial subagent → SHIP). **Full
  `npm run verify` = 55 GO / 0 NO-GO, exit 0.**
- **2026-06-04 v1.8** — **K1a SHIPPED (Fisher keystone compute) + GREEN.** Ported the canonical
  Fisher stack → `pipeline/{fisher.py, extract_activations.py, compute-fisher.py}` with the audit
  fixes: **sha256 window-seed** (canonical seeded the null-model RNG with Python's per-process-salted
  `hash(tuple)`, silently breaking era-skip's bit-identical-recompute guarantee — replaced with a
  stable sha256 seed; PROVEN by verify F6: `--full` recompute is bit-identical across processes),
  **clamp-inf-z** (`null_model_z` → ±`Z_MAX`, no infinities at rest), **era-ISO run-id** (satisfied
  by V1 `stage_base.derive_era_id`). Added generic `extra_filters` to `era_skip.fetch_existing_keys`
  (fisher's window_start key collides across levels). Wired Step 7/7 in run-clustering.sh + jobs.js
  label 7 + `verify:fisher` in the chain. `verify:fisher` (6 checks: compute exits 0; trajectory rows
  + confident windows; `getCurrentPhase` returns a classified phase = movement no longer hollow;
  trajectory/top-movers parse; era-skip re-run skips; sha256 determinism) GO. **Full `npm run verify`
  = 49 GO / 0 NO-GO, exit 0.** The "movement" pillar now writes. **K1b (encrypt the fisher tables at
  rest) is the immediate follow-up** (task #19) — K1a writes plaintext; the encryption design lists
  the fisher tables as encrypted-by-K1. Read-side analysis done: `src/db/fisher.js` filters/sorts
  ONLY on plaintext-structural columns → encryption is transparent through the adapter (coercion only,
  no SEC-2-style query rework); the one delicate bit is decrypting `activation_vector` +
  `fisher_trajectory_length` in the era-skip read path (NOTE already in compute-fisher.py).
- **2026-06-04 v1.7** — **SEC-4 SHIPPED** (nomic_embedding + .npy cache encrypted; reusable Python
  crypto write path in crypto_local.py byte-compatible with JS encryptVector). Encryption sweep
  complete. See MEASUREMENT-ENCRYPTION-DESIGN §6/§7.
- **2026-06-04 v1.2** — Canonical located + 3 deep audits done → this Port Map; tasks F1–X1 created.
- **2026-06-04 v1.6** — **Encryption sweep SEC-1/2/3 SHIPPED + GREEN.** SEC-1 centroids
  (centroid_256/3d) encrypted; SEC-2 cofire strengths + neighbor distance encrypted + the whole
  `src/db/topology.js` reworked to JS-side filter/sort/aggregate over decrypted values (joins on
  plaintext keys only); SEC-3 cognitive scalars (energy/coherence/velocity/current_vitality/
  point_delta) encrypted + `territory-docs.js`/`topology-tools.js` reworked (coerceScalars helper +
  energy/current_vitality sorts→JS). cluster.py dynamics+centroid writes routed through
  d1_batch_encrypted. **message_count kept plaintext** (operator-aligned: structural ranking +
  search-index key, a count not content). New verifies: health/centroid/topology/territory-scalars-
  encryption — all wired; full regression GO (mindscape/cognition/chronicles/search/leak/…).
  **SEC-4 (nomic_embedding typed-vector binary path) PENDING** — the one delicate cross-language
  crypto piece (needs a Python `encrypt_vector` matching the JS `encryptVector` envelope; see
  MEASUREMENT-ENCRYPTION-DESIGN §6 / §5 finding 2). Don't rush binary crypto.
- **2026-06-04 v1.5** — **SECURITY (operator: "encrypt everything"): closed a real latent
  leak.** The auto-encrypt adapter (`autoEncryptParams`/`encryptFields`) only encrypted STRING
  params, so NUMERIC `ENCRYPTED_FIELDS` columns — `health_daily` metrics (sleep/HRV/steps),
  `wealth_*` amounts, `cognitive_events.magnitude` — were stored **PLAINTEXT despite being
  declared encrypted**. Fix: `encryptablePlaintext()` encrypts numbers/bigints (String coercion)
  at all 3 sites; `parseHealthRow` Number()-coerces on read (decrypt-everywhere); magnitude
  re-encrypted. New `verify:health-encryption` (leak closed + read coercion + range round-trip +
  pre-fix-plaintext backward-compat). **24/24 encryption-touching verifies GO incl. verify:leak.**
  **OPEN for operator (how far to take "everything encrypted"):** (a) embeddings/centroids —
  `territory_profiles.centroid_256` (a 256D semantic fingerprint, README §7 "sensitive") is
  currently PLAINTEXT and is NOT SQL-queried → safe to encrypt; (b) topology query-scalars
  (territory message_count/energy/coherence/current_vitality, cofire strengths) are plaintext
  *by design* so the topology engine can filter/ORDER in SQL → encrypting needs a query-layer
  redesign (fetch-all + filter/sort in JS). Flagged for a decision.
- **2026-06-04 v1.4** — **FOUNDATION (F1–F5) SHIPPED + GREEN.**
  F1 `src/metrics/primitives.js` (verbatim port + barrel; 1e-12 Python-parity gate
  `verify:primitives`; gaps stage refactored to consume `cosineSim`).
  F2 `pipeline/harmonics.py` completed (Hilbert/PAC-Tort2010/PLV/Welch-coherence/Haar
  wavelet) + `PyWavelets` dep (lazy-imported, installed).
  F3 true LZ76 (Kaspar-Schuster) + `variance` in primitives.js + Fiedler/algebraic-
  connectivity in new `pipeline/graph_metrics.py` (self-tests GO: disconnected→0,P3→1,K3→1.5).
  F4 migrations `0007_cognitive_events` (spec I4) + `0008_metrics_language` + ENCRYPTED_FIELDS
  (`verify:measurement-schema` GO, encryption-at-rest proven).
  F5 `era_skip` gains `run_id_column` param (for the era_id-keyed canonical-158 tables, backward-
  compatible) + `event_emit` contract documented (no change needed — V1 has no composed-name
  coordinator). New verifies wired into the chain; adjacent verifies (foundation/cognition/
  mindscape/generate) still GO. **Decisions:** `cognitive_events.magnitude` kept plaintext
  (context-free score; the adapter encrypts string params only; the WHAT lives in encrypted
  `detail`/`headline`); pipeline-health coordinator still deferred (stages append to
  run-clustering.sh). **NEXT: K1 — the Fisher keystone.**
- **2026-06-04 v1.3** — Architecture principle locked (operator: "no monolith"): V1 is a
  **modular monolith** — one stage per file, one module per metric family, shared primitives in
  exactly one place, clean compute→data→agent→human layers; no big-bang reorg of working files
  (moves go through caller audits). **Gaps fixed first** (operator request, before the foundation):
  `pipeline/compute-territory-neighbors.js` + `scripts/verify-territory-neighbors.mjs` (GO 8/8),
  wired into run-clustering.sh + jobs.js + the verify chain.

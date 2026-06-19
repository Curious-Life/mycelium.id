# Context Engine — Phase 2 build design: bi-temporal claims (sweep-verified)

**Date:** 2026-06-19 · **Status:** buildable design. Synthesizes **Ada's science brief** (`SCIENCE-phase2-bitemporal-claims-2026-06-19.md`) with the verified V1 claims layer. Supersedes/extends `DESIGN-step3-bitemporal-claims-2026-06-19.md` (which had the storage shape; this adds the distillation engine, the Whole-Trait honesty, the SPRT promotion bar, and the day-card source).

## 0. Headline
Phase 2 = the **stable-facts layer**, built by marrying three mature sciences (Ada) onto code we already have: **bi-temporal storage** (the time/audit substrate), **AGM belief revision** (the change ops), and **Generative-Agents reflection** (the day-card→arc engine) — governed by the one rule that says *what* we may store: **a stable fact about a person is a distribution of their states, never a fixed point.** The keystone discovery: **the day-cards (Phase 1d) are the episodic layer the distillation needs**, the **confidence posterior already exists** (`confidence.js`), and `person_claim_snapshots` **already gives transaction-time** — so this is **extend `person_claims`, not a new table.**

## 1. The five open questions — RESOLVED
| # | Ada's open Q | Decision (for this codebase) |
|---|---|---|
| 1 | **Promotion bar** (episodic→stable) | A claim is born `pending`. Promote to `active` when its log-odds `L ≥ fromConfidence(0.78)` **AND** support cites **≥3 distinct-day** corroborations (SPRT-style). `pending` claims are **excluded from getContext** (the CVP gate). Conservative start; calibratable. |
| 2 | **Active/stable boundary** | Reuse the existing **`decay_class`** — it already IS the axis: `boundary/identity/fact` = stable (trait-like, long τ), `preference/mood` = active (state-like, short τ). No new field; variability (Q-distribution) refines it. |
| 3 | **Forgetting** | **Never destructive-delete** (bi-temporal). Confidence **decays** for un-corroborated claims (already in `confidence.js`); below a floor → `archived` (system-closed, recoverable), not deleted, not negated. `boundary` λ=0 never fades. |
| 4 | **Reuse vs new table** | **Extend `person_claims`** (+4 plaintext cols). `person_claim_snapshots` already provides transaction-time history; no `claims_bitemporal` table. |
| 5 | **Distillation trigger** | **Both:** the **integration cycle** runs it nightly (schedule), but each claim proposal is **importance-gated** (a theme needs ≥3 corroborating day-cards before it's proposed). |

## 2. Storage — extend `person_claims` (migration `0033`)
The bi-temporal substrate is *mostly there* (`0011`): `created_at`/`updated_at` + the `person_claim_snapshots` series = **transaction-time**; `confidence_logodds` + `decay_class` = the posterior. **Add valid-time + the supersede link + the domain axis** (all plaintext — queryable):
```sql
ALTER TABLE person_claims ADD COLUMN valid_from    TEXT;  -- when the trait/fact became true (real-world)
ALTER TABLE person_claims ADD COLUMN valid_to      TEXT;  -- when it ceased; NULL = currently true
ALTER TABLE person_claims ADD COLUMN superseded_by TEXT;  -- successor claim id (the revision chain)
ALTER TABLE person_claims ADD COLUMN domain        TEXT;  -- Layer-1 axis (taxonomy v1) on the claim
UPDATE person_claims SET valid_from = created_at WHERE valid_from IS NULL;
CREATE INDEX IF NOT EXISTS idx_claims_validity ON person_claims(user_id, valid_to, valid_from);
```
- **`status` enum gains `pending`** (born-pending; the CVP gate). Existing: active|archived|superseded|rejected → +pending.
- **The Whole-Trait distribution lives in the existing encrypted `support` JSON** — extend it `{messages, territories, day_cards:[id…], variability, contexts:[…], source}` rather than add columns. `variability` is derivable from the snapshot series (`readSeries` → std of the confidence trajectory) and stored for surfacing; `source` = `user-stated | agent-inferred` (governance); `contexts` = the DIAMONDS-style situations (domains/registers) the state shifts with.
- **No new table.** Transaction-time "as-of" replay uses `created_at`/`updated_at` + `person_claim_snapshots`; valid-time uses the new cols.

## 3. Revision — AGM on the bi-temporal store (`src/claims/lifecycle.js`, new)
Map AGM's three operations onto a governed lifecycle (extends the existing `discovery.js` propose→identity-match→validate→confidence→snapshot):
| AGM | Our op | Effect |
|---|---|---|
| **Expansion** | `ADD` | new `pending` claim, `valid_from=now`, support cites its day-cards |
| **Revision** (corroborate) | `UPDATE` | `confidence.update()` (decay+ωE); promote `pending→active` at the bar (§1) |
| **Revision** (contradiction *with a successor*) | `RETRACT` | close the old (`valid_to=successor.valid_from`, `superseded_by=successor.id`, `status=superseded`); open the new — **never overwrite** |
| **Contraction** (un-corroborated / weakened) | `WEAKEN→ARCHIVE` | confidence decays; below floor → `status=archived` (system-closed, recoverable). **Not** negation. |
- **`decideOp({relation, isNew, confidence, decayClass})`** + **`validFrom(support)`** + **`RETIRE_FLOOR`** (the prior step-3 design, kept).
- **Entrenchment = confidence**; under conflict the *less entrenched* yields — **except `boundary`** (never auto-retracts; safety, λ=0).
- **Justifications (TMS) = the `support.day_cards`/`messages`** links → also the page's drill-to-evidence.

## 4. Contradiction resolution (`src/claims/resolve-contradictions.js`, new)
For a fresh proposal: **embedding** cosine-band `[0.50, 0.90]` (related-but-not-duplicate) lookup against active claims → `validator.js` classifies (strong/weak support vs conflict) → on **conflict with a successor**, `RETRACT` the old (§3). **Source-priority (governance):** a **user-stated** claim beats an **agent-inferred** one; recency is only a tiebreaker; both rows are preserved (the audit trail).

## 5. The distillation engine — day-cards → arcs (Generative-Agents reflection)
**The integration cycle gains Phase 3.8 — Distill stable claims.** After it consolidates `model.md` (3.5) + distills the Core (3.6), it distills *claims* from the **clean narrative + the dated day-cards**:
1. **Cluster** recent day-cards by **theme-embedding** (semantic, not string) — the day-card `themes` (Phase 1d) are the mid-tier of the reflection tree (day-card → theme → arc → claim).
2. For each theme-cluster with **≥3 corroborating day-cards**, the agent calls a new tool **`proposeClaim({claim_type, content, domain, decay_class, support_day_cards, source})`** — a *distribution* statement ("X tends to run high lately, more in Work contexts" — §6), never "is X".
3. The deterministic **lifecycle** (§3-4) governs it: identity-match → validate → confidence update → promotion-bar → contradiction-resolve → snapshot.
- **Replaces** `discover-claims.mjs` (the raw-message profiler) — see §9. The source shifts from *raw chat volume* (dev-polluted, anchoring-prone) to the *clean narrative + scored episodic day-cards*.
- **Anti-self-anchoring (Ada §6):** corroboration MUST come from day-cards (observations), not the agent restating `model.md`; the confidence ωE weights day-card evidence; a proposal with <3 day-card justifications stays `pending`.

## 6. What we store — distributions, not points (Whole Trait Theory — the honesty keystone)
A stable claim is **a distribution parameter, not a fixed identity assertion**:
- store **central tendency** (`content`+`confidence`) + **variability** (`support.variability`, from the snapshot series) + **context-dependence** (`support.contexts` = the domains/registers the state shifts with) + **validity interval** (`valid_from/valid_to`).
- **Trait** = low-variability + long validity (decay_class boundary/identity/fact); **state** = high-variability + short (preference/mood).
- **Surface as tendency, never as verdict** — the belief-layer twin of the never-conclude discipline: *"lately X seems to run high (and varies a lot in social contexts)"*, never *"you are X"*. This is enforced in the `proposeClaim` tool description + the render path.

## 7. Governance (SSGM / memory-poisoning)
- **Source attribution:** `support.source ∈ {user-stated, agent-inferred}`; an inferred claim can never silently override a user-stated one (§4).
- **Confidence-gating (CVP):** `pending` claims (< the bar) **do not influence** — excluded from getContext until promoted.
- **Bi-temporal audit = the undo:** nothing is destructively deleted; a bad revision is replayable + revertible via the snapshot series + the supersede chain.

## 8. getContext — the as-of swap (closes the 1c D3 deferral)
`db.claims` gains **`retract(id,{validTo,supersededBy})`**, **`asOf(userId, date)`** (`valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) AND status='active'`), **`promote(id)`**, and `validFrom` on `upsert`. `getContext` swaps the demoted raw `listActive` block (`context.js:198-204`) for **`asOf(now)` grouped by domain**, rendered as **tendencies** (§6). Confidence filter stays JS-side (encrypted). The Core (1c) still leads; claims sit below it, now clean + bi-temporal.

## 9. Deprecate `discover-claims.mjs` (pre-deletion caller audit)
Sole runtime caller: **`src/jobs.js:418`** (spawns the pipeline child; triggered by `claims/heartbeat.js`). Migration: point the heartbeat/integration distillation at the new `proposeClaim`+lifecycle path; **stop spawning** `discover-claims.mjs`; keep `discovery.js`/`validator.js`/`confidence.js`/snapshots (reused by the lifecycle). Falsifiable: after cutover, no `discover-claims` spawn in `jobs.js`; claims accrue only from day-card distillation. (`tools/claims.js:6` + `discovery.js:9` are comments — update.)

## 10. Build units · gates · LOC
| Unit | Build | Migration | Gate | LOC |
|---|---|---|---|---|
| 2a | `0033` (valid_from/valid_to/superseded_by/domain + `pending` status); `db.claims` retract/asOf/promote + validFrom on upsert + `valid_to IS NULL` on listActive | `0033` | `verify:claims-bitemporal` | ~120 |
| 2b | `src/claims/lifecycle.js` (decideOp/validFrom/RETIRE_FLOOR/promotion-bar) + `resolve-contradictions.js` (cosine-band → validate → retract + source-priority) | — | `verify:claims-lifecycle` | ~180 |
| 2c | `proposeClaim` tool (distribution-phrased, day-card-justified) + integration-cycle **Phase 3.8** distillation tail + cluster-by-theme-embedding | — | `verify:claims-distill` | ~160 |
| 2d | `getContext` asOf swap (render as tendencies, pending-excluded, by domain) + deprecate `discover-claims.mjs` (jobs.js:418) | — | `verify:context` + caller audit | ~80 |

**~540 LOC, migration `0033`.** Order 2a→2b→2c→2d. Each gated `VERDICT: GO`, security-sensitive (the highest-value memory) → **human-reviewed merge**.

## 11. Verification table (file:line, read this session)
| Assumption | At | Verdict |
|---|---|---|
| person_claims has the substrate but NOT valid_from/valid_to/superseded_by/domain | `migrations/0011_persona_claims.sql:18-35` | TRUE (extend) |
| person_claim_snapshots already gives transaction-time history | `0011:38-48` | TRUE |
| confidence is a Bayesian log-odds posterior with type-specific decay (Ada §6 mostly built) | `src/claims/confidence.js:22-75` | TRUE |
| decay_class already encodes active/stable (boundary/identity/fact vs preference/mood) | `confidence.js:22-28` | TRUE |
| db.claims has upsert/listActive/getById/listForMatch/findByHash/setStatus/writeSnapshot/readSeries; MISSING retract/asOf/promote | `src/db/claims.js:68-204` | TRUE (build 3) |
| src/claims has discovery/confidence/validator/heartbeat/windows/support-path/route; MISSING lifecycle/resolve-contradictions | `src/claims/` | TRUE (build 2) |
| day-cards (Phase 1d) are the episodic distillation source | `src/db/reflections.js:40,49` (recent/listRange) | TRUE |
| discover-claims.mjs sole runtime caller is jobs.js | `src/jobs.js:418` | TRUE (deprecate) |
| getContext claims block is the asOf-swap target (now demoted below Core) | `src/tools/context.js:198-204` | TRUE |
| confidence_logodds encrypted → confidence filters JS-side | `crypto-local.js:354` | TRUE |

## 12. The through-lines (Ada §9 — this is the whole session, one level up)
provenance everywhere (claims cite day-cards) · **distribution not point** (reflection-not-diagnosis at the belief layer) · confidence as an earned posterior with a bar (the CVP gate) · never-destructively-delete + supersede (the fail-loud audit trail) · semantic-not-string (cluster day-cards by embedding) · **guard the agent's self-anchoring** (corroborate from day-cards, not the belief restating itself).

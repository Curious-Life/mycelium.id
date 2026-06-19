# Step 3 (buildable): bi-temporal claims & the claim lifecycle — cycle-3 spec

**Date:** 2026-06-19 · **Status:** Buildable (seams read at file:line; SOTA cross-checked) · Parent: `DESIGN-persona-system-mapping-2026-06-19.md` step 3. This is the **crucial transformation feature**.

Goal (assembly-index): fold what we already built (confidence-decay + validator relations + snapshot series) and the SOTA (Zep bi-temporal, mem0/Memory-R1 operation taxonomy, STALE/SSGM safety) into **one coherent claim lifecycle** that is simple (3 new columns), robust (stable beliefs hard to corrupt), and effective (a transformation account becomes a SQL query).

---

## The core synthesis (why this is small)

A bi-temporal fact has two timelines: **transaction time** (when the system knew it) and **valid time** (when it was true in the person's life). **We already have the transaction timeline** — `created_at`, `updated_at`, `last_evidence_at`, and the `person_claim_snapshots` series. So the entire add is the **valid timeline + a supersession link**:

| Zep edge (4 ts + link) | Mycelium claim | Status |
|---|---|---|
| `t'_created` (txn create) | `created_at` | **exists** |
| `t'_expired` (txn invalidate) | `updated_at` + `status` flip | **exists** |
| `t_valid` (became true) | **`valid_from`** | NEW |
| `t_invalid` (ceased true) | **`valid_to`** (NULL = current) | NEW |
| invalidating edge link | **`superseded_by`** | NEW |

Three columns. Everything else is reuse.

---

## The unified lifecycle (one model, four operations)

Per proposal P (with matched existing claim C, evidence E, and the validator relation we already compute):

| Op | Trigger | Action |
|---|---|---|
| **ADD** | no match | write claim; `valid_from = min(created_at of support msgs)`, `valid_to = NULL` |
| **UPDATE** | match + `*_support` | confidence ↑ (existing log-odds), merge support, `valid_to` stays NULL |
| **WEAKEN** | match + `*_conflict` | confidence ↓ (existing decay path); if it crosses the **retire floor** → **RETIRE** (`status='retired'`, `valid_to = last_evidence_at`) |
| **NOOP** | match + `unrelated` | touch `last_evidence_at` only |
| **RETRACT** | a *new* ADD strong-conflicts a *related* existing claim | invalidate the old: `valid_to = new.valid_from`, `status='superseded'`, `superseded_by = new.id` (Zep: "invalidate by setting t_invalid to the invalidating edge's t_valid; prioritize new info") |

This reuses the validator (`validator.js` → relation ∈ {strong/weak_support, unrelated, weak/strong_conflict}) — we just stop using ω *only* for confidence and also use it to *choose the operation*. `decay_class` keeps setting the **rate** (boundary λ=0 … mood λ=1/7d); the relation chooses the **operation**.

### The missing piece: contradiction resolution (the *flip*)
The current code only validates against the *same* claim (content match). A flip ("CEO of Humy" → "now leads Atmosphere") has different content, so it never matches and both stay active (the STALE "implicit conflict" failure). Fix — a **bounded** pass after each ADD:
1. Find ≤3 *related-but-not-duplicate* existing claims via the embeddings we already compute (cosine in band **[0.50, 0.90]** — same topic, not a paraphrase).
2. `validate(new.content, old)` (the validator we already have).
3. On `strong_conflict` → RETRACT old, linked to new. Else NOOP.

Bounded (new claims only, top-3, only writes on conflict) → cheap and local.

---

## Governed retraction (robustness — SSGM/STALE-informed)

Stable beliefs must be **hard to corrupt** by a single observation:
- **`boundary` claims NEVER auto-retract** (allergy/trauma/hard limits; λ=0). User `forget` only. Fail-closed.
- **RETRACT requires a *successor*** — it only fires as part of an ADD that supplies the replacement state. A bare negation with no replacement → **WEAKEN only** (confidence path), never a hard flip. This naturally demands "evidence of the new state" and blocks spurious flips **without** new counter-state.
- **Non-destructive:** retract/retire flip `status` + set `valid_to`; the row stays (queryable + reversible). Never physical delete (mem0/Memory-R1: "mark invalid, don't remove — enables temporal reasoning").
- **Fail-safe:** validator unavailable → relation `unrelated` (existing behavior, `validator.js:70`) → NOOP, never a spurious retraction.
- **`valid_from` is observed-bound** (earliest *evidence*, not earliest *true*) — stored honestly as a lower bound; surfaced as "since ~<date>".

---

## Schema delta (migration `0031`)

```sql
-- person_claims: the valid (event) timeline + supersession link. All plaintext
-- time/structural keys (SQL must filter as-of windows). NOT encrypted.
ALTER TABLE person_claims ADD COLUMN valid_from   TEXT;  -- became true (earliest observed support)
ALTER TABLE person_claims ADD COLUMN valid_to     TEXT;  -- ceased true; NULL = currently held
ALTER TABLE person_claims ADD COLUMN superseded_by TEXT; -- claim id of the successor (the flip chain)
-- backfill existing rows: valid_from := created_at (best available lower bound)
UPDATE person_claims SET valid_from = created_at WHERE valid_from IS NULL;
-- as-of + transformation queries
CREATE INDEX IF NOT EXISTS idx_claims_validity ON person_claims(user_id, valid_to, valid_from);
```
Status enum becomes `active | superseded | retired | rejected` (map legacy `archived`→`retired`). `superseded` = flipped (has `superseded_by`); `retired` = faded below floor.

The **transformation account** (step 7) is then pure SQL — no reconstruction:
- *as of date D:* `valid_from <= D AND (valid_to IS NULL OR valid_to > D)`
- *what changed in [A,B]:* births (`valid_from` in range) + deaths (`valid_to` in range) + their `superseded_by` chains.

---

## Module shape (LOC ±20%)

- **`migrations/0031_claims_bitemporal.sql`** (~14)
- **`src/claims/lifecycle.js`** (NEW, ~90) — `decideOp({relation, isNew, confidence, decayClass}) → 'ADD'|'UPDATE'|'WEAKEN'|'RETIRE'|'NOOP'`; `validFrom(support, evidence)`; `RETIRE_FLOOR` const.
- **`src/claims/resolve-contradictions.js`** (NEW, ~60) — `resolveContradictions({db, userId, newClaim, vec, validate, embedPool}) → retractions[]`; cosine-band lookup + validator + `db.claims.retract`.
- **`src/claims/discovery.js`** (TWEAK, ~40) — set `valid_from` on ADD; route via `decideOp`; call `resolveContradictions` after each ADD; write final snapshot `delta_kind='contradicted'|'retired'` on retract/retire (reuse existing snapshot path).
- **`src/db/claims.js`** (TWEAK, ~45) — `upsert` learns `validFrom`; `retract(id,{validTo,supersededBy,status})`; `listActive` filters `valid_to IS NULL`; `asOf(userId,date)` reader.
- **`scripts/verify-claims-lifecycle.mjs`** (NEW, ~150) + chain entry (~2).

**Total ~400 LOC** — the transformation engine.

---

## Edge cases — decisions

| Case | Decision |
|---|---|
| Flip with no replacement ("I'm not CEO anymore", nothing new) | WEAKEN only; retires via floor over time. No orphan retract. |
| Two simultaneous successors contradict one claim | retract once; `superseded_by` = the highest-confidence successor; both successors live. |
| Successor later itself contradicted | chain extends (`A→B→C`); `asOf` still resolves correctly. |
| `boundary` strong-conflict | ignored for retract; logged for user review (never auto-flip safety facts). |
| Mis-retraction (false flip) | reversible: row kept; `valid_to`/`superseded_by` cleared restores it. Surfaced low-confidence first. |
| `valid_from` unknown (no support ts) | fall back to `created_at`; mark lower-bound. |
| Re-run idempotency | retract is a no-op if `valid_to` already set to the same successor. |

---

## Test strategy (`verify:claims-lifecycle`, mirrors existing gates; stub `infer`/`validate`, in-mem claims, PASS/FAIL + VERDICT)

- **L1** support evidence → UPDATE, confidence ↑, `valid_to` NULL.
- **L2** new claim strong-conflicts related existing → old RETRACT (`status=superseded`, `valid_to=new.valid_from`, `superseded_by=new.id`), new active.
- **L3** bare conflict, no successor → WEAKEN only, no retract.
- **L4** `boundary` strong-conflict → NOT retracted.
- **L5** confidence below floor → RETIRE (`status=retired`, `valid_to` set).
- **L6** `asOf(pastDate)` returns the retracted claim as active-then; `asOf(now)` returns the successor.
- **L7** validator unavailable → NOOP, no spurious retract.
- **L8** retract is non-destructive (row still SELECTable) + idempotent on re-run.
- **L9** `valid_from = min(support msg created_at)`.

---

## Implementation order (each smoke-able)
1. Migration `0031` + `db.claims` (`upsert.validFrom`, `retract`, `asOf`, `listActive` filter). Smoke: write+retract a claim, `asOf` resolves both eras.
2. `lifecycle.js` (`decideOp`, `validFrom`, floor) + unit table.
3. `resolve-contradictions.js` (cosine-band + validator + retract). Smoke: flip retracts old.
4. Wire into `discovery.js`; write death-snapshots. Smoke: run discovery with a flip fixture.
5. `verify:claims-lifecycle` → GO; add to `npm run verify`.
6. Live smoke on a copy: confirm the "CEO of Humy → leads Atmosphere" pair resolves to one active + one superseded with a link.

---

## Threat model
- **Belief-corruption / poisoning (SSGM):** a single crafted message can't flip a stable claim — RETRACT needs a successor *and* `strong_conflict`; `boundary` never auto-flips; non-destructive + reversible. Residual: a sustained poisoning campaign across windows — accepted (same trust boundary as all vault writes; user `forget` is the backstop).
- **No new egress:** validator + classify are `task:'classify'`/`sensitive:true` → local-only (`validator.js:65`, `router.js:25`). Verified.
- **Plaintext columns:** `valid_from/valid_to/superseded_by` are timestamps/ids — same exposure class as existing plaintext `status`/`last_evidence_at`. No content. Acceptable.
- **Fail-closed on key:** writes go through the keyed adapter; locked vault → discovery doesn't run.

---

## Verification table (load-bearing, read by me at file:line)

| # | Assumption | Verdict | Verified at |
|---|---|---|---|
| D1 | Discovery currently OVERWRITES on conflict, never writes `superseded`; flips don't match → both stay active (the gap) | TRUE | `src/claims/discovery.js:241-256` (only `status:'active'` written) |
| D2 | Validator already yields a graded conflict relation + ω, local-only, fail-safe to `unrelated` | TRUE | `src/claims/validator.js:18-24,55-71` |
| D3 | `person_claims` has no valid-time/supersession cols; `status` enum has unused `superseded`/`archived` to repurpose | TRUE | `migrations/0011_persona_claims.sql:18-34` |
| D4 | Snapshots already carry `delta_kind` incl. `contradicted`/`retired` → reuse for death-snapshots | TRUE | `migrations/0011_persona_claims.sql:49`; `discovery.js:271-275` |
| D5 | Embeddings for proposals + pool already computed → the related-claim lookup needs no new model call | TRUE | `src/claims/discovery.js:201-225` |
| D6 | Support carries message ids and evidence carries `ts` → `valid_from` computable with no extra query | TRUE | `src/claims/discovery.js:242,261` (support ids + `evidence` `{id,content,ts}`) |
| D7 | Next free migration is 0031 (step 1 took 0030; main at 0029) | TRUE | step-1 spec + `origin/main migrations/` |
| D8 | Zep invalidation = set old `t_invalid` to new `t_valid`, prioritize new info | TRUE (SOTA) | arXiv:2501.13956 §bi-temporal |

## Revision history
- **mapping sketch:** "add valid_at/invalid_at; retract-don't-delete."
- **cycle-3 (this):** synthesized into ONE lifecycle with the existing validator+decay+snapshots; **PIVOT 1:** only 3 new columns (we already own the transaction timeline) not Zep's 4. **PIVOT 2:** RETRACT requires a *successor* (governed retraction) — blocks single-observation belief corruption without new counter-state; bare conflicts WEAKEN only. **PIVOT 3:** the *flip* needs a bounded related-but-not-duplicate lookup (cosine band) — content-match alone misses implicit conflicts (STALE).

## Sources
Zep/Graphiti bi-temporal & invalidation: [arXiv:2501.13956](https://arxiv.org/abs/2501.13956). Operation taxonomy & non-destructive invalidation: [mem0 arXiv:2504.19413](https://arxiv.org/html/2504.19413v1), [Memory-R1 arXiv:2508.19828](https://arxiv.org/html/2508.19828v4). Stale-memory / implicit conflict: [STALE arXiv:2605.06527](https://arxiv.org/html/2605.06527). Governed evolving memory (safety): [SSGM arXiv:2603.11768](https://arxiv.org/html/2603.11768v1).

# FINDING — clustering-run inconsistency orphans the realm ("topics") layer

**Filed:** 2026-06-19 · **For:** the metrics-audit session · **Status:** OPEN (blocks named realm-level temporal views; not a code bug in Curious Life)
**Severity:** HIGH for the planned "topic river" redesign — the realm/topic altitude has no valid name mapping right now.

## What the redesign needs

The Curious Life redesign is moving to a **topic-river spine**: the activation distribution over topics, over time (anchor / active / dormant per window), with movement / novelty / disturbance as lenses on the same timeline. The natural "topics" altitude is **realms** (~tens), not territories (hundreds).

## The problem — three irreconcilable realm id-spaces

Probed live against `:8787` (`/api/v1/portal/*`) on 2026-06-19:

1. **`fisher_trajectory` activation vectors** (level=realm, run `era-2026-06-17T20:39:50.102Z`, 400 weekly windows 2018→2026) are keyed by realm ids **1–48**.
2. **`territory_profiles.realm_id`** (current 312 territories) reference realm ids **{1, 43, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56}** — 13 distinct, mostly 43–56.
3. **`realms` table** (`/portal/mindscape/realms`) contains only **2** realms (ids 43, 46).

These do not reconcile. The trajectory's 48 realm ids are orphaned: no name map (realms table has 2), and the territory→realm assignments use a different id range (43–56). Only id `1` coincidentally overlaps.

## Root cause (consistent with known issues)

Clustering re-runs have left the **temporal measurement layer** (computed against the `era-2026-06-17` partition with ~48 realms) **out of sync** with the **current topic labels** (realms collapsed to 2; territories re-assigned to realms 43–56). This is the same clustering-instability family as:
- the realm re-cluster collapse (memory: "re-cluster collapses 42→2 realms"),
- the Vitality ~52× over-count ([BUG-vitality-territory-count-inflation-2026-06-19.md](BUG-vitality-territory-count-inflation-2026-06-19.md)),
- and is the motivation for [#288](https://github.com/Curious-Life/mycelium.id/pull/288) (clustering validity diagnostics + low-confidence).

## What IS consistent / buildable today

- The activation-over-time data is internally consistent within the `era-2026-06-17` run (single run id across all 400 trajectory rows; velocity/z-scores/complexity/compression all from it).
- **Territory level reconciles:** 311 / 372 territory ids in the territory-level activation trajectory map to named territories. Territory rows carry `current_phase`, `is_anchored`, `first_active`, `last_active`, `days_active`, `temporal_saliency` — sufficient for an honest anchor/active/dormant read.

## Implication for the river

- **Realm-level ("topics") river: BLOCKED** until clustering runs are reconciled and realms are stably named & consistent with the trajectory the page reads.
- **Territory-level river: buildable now** (top-N named territories per window), but finer-grained than the ideal "topics" altitude, and still riding a clustering snapshot that current profiles have moved past.

## What the audit session needs to resolve (so the river can use realms)

1. **One source of truth for the active clustering run**, with the realms table, territory→realm assignments, and the fisher/frequency/complexity trajectories all keyed to the *same* run id and the *same* realm id-space.
2. **Stable, named realms** at a sane count (the collapse to 2 is itself a clustering-quality failure — see #288 validity).
3. Decide whether temporal series are **re-anchored on re-cluster** (recompute against the new partition) or the **partition is frozen** for a measurement era (and the page reads that era's names). Either is fine; the inconsistency is the bug.

## Verification after fix

- The realm id-set in `fisher_trajectory(level=realm)` activation vectors ⊆ the realm ids in the `realms` table, all under one run id.
- `territory_profiles.realm_id` values ⊆ the same realms.
- A spot-check window's top realms resolve to real names.

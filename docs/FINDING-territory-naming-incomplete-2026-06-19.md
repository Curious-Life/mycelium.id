# FINDING — territory describe/naming is incomplete (blocks a *named* river)

**Filed:** 2026-06-19 · **For:** the metrics-audit / enrichment-pipeline session · **Status:** OPEN
**Severity:** HIGH for the river redesign — the river's core value is *named topics over time*, and the dominant topics are unnamed.

## Symptom

The territory-river (`/portal/territory-river`) computes correct shape from real data (417 weekly windows, 2018→2026, active-territory count 0–174, persistent anchor bands), but the **anchor bands cannot be labeled**: the most-active, most-persistent territories come back unnamed.

## Evidence (live `:8787`, 2026-06-19)

The top anchor territories by weeks-active are real `phase: anchor` territories with large message counts, but every descriptive field is null:

| territory_id | messages | phase | name | essence | top_entities |
|---|--:|---|---|---|---|
| 2650 | 2900 | anchor | null | null | null |
| 2660 | 2400 | anchor | null | null | null |
| 2698 | 1287 | anchor | null | null | null |
| 2659 | 803 | anchor | null | null | null |
| 2714 | 510 | anchor | null | null | null |

Coverage across all territories (`/portal/mindscape/territories`, 312 total):
- **Named (non-empty `name`): 94 / 312** (~30%).
- **Unnamed: 218**; of those, **only 1** has usable `top_entities` — so there is **no fallback label source** (can't synthesize a label from entities/patterns).

## Root cause

The describe / enrichment step (territory naming → `name`, `essence`, `archetype`, `top_entities`, `signature_patterns`) has not run (or not completed) for the bulk of territories — including the dominant anchors. The activation trajectory and the territory partition exist and reconcile (ids present), but the **labels are missing**. Same measurement-layer-incompleteness family as the clustering-run inconsistency ([FINDING-clustering-run-inconsistency-blocks-topic-river-2026-06-19.md](FINDING-clustering-run-inconsistency-blocks-topic-river-2026-06-19.md)) and the Vitality over-count ([BUG-vitality-territory-count-inflation-2026-06-19.md](BUG-vitality-territory-count-inflation-2026-06-19.md)).

## What works regardless

- The river *shape* is honest and informative now: anchor-phase persistent core as bands, active-territory count per week, novelty overlays (text gzip + path LZ76). The `TerritoryRiver.svelte` component already flags unnamed bands as `(unnamed)`.

## The unlock

Re-run the territory **describe/naming** pipeline so `territory_profiles.name` (and ideally `top_entities`) is populated for the active/anchor territories. Once names exist, the river's bands become meaningful with **zero frontend changes** — the endpoint already joins `territory_profiles.name`.

## Verification after fix

- `SELECT COUNT(*) FROM territory_profiles WHERE name IS NOT NULL AND name<>''` approaches the active-territory count (esp. all `phase='anchor'` rows named).
- `/portal/territory-river` returns anchors with `named: true` and real names.

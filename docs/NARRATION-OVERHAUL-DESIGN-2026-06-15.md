# Narration overhaul + Option-A mindscape recovery — DESIGN (2026-06-15)

Status: **DESIGN — awaiting approval.** Sweep-first complete (file:line evidence below).
Trigger: post-import re-cluster incident left the live mindscape 96% blank; user spec'd a
richer narration pipeline; recovery decision = **Option A (restore from export)** then **fix everything found**.

## 0. TL;DR

Two phases, in order:

1. **RECOVER (Option A)** — restore the imported mindscape from the kept encrypted export, replacing
   the half-finished re-cluster. Deterministic, no LLM. Plus a **data-driven export-vs-live
   reconciliation** that objectively lists anything that didn't come over (covers "tinesanos").
2. **REBUILD the narration pipeline** so a *future* Generate enriches rather than degrades:
   timeline-stratified 20-sample draw, 5k chars, all source types, tags+entities, coverage tracking
   (% described), progressive title/description rewrite, and bottom-up hierarchical narration that
   regenerates on significant child change.

**Generate stays forbidden on the real vault** until Phase 2 ships + is gated.

## 1. Incident state (queried live 2026-06-15)

```
live territories 291  ·  WITH chronicle 12  ·  blank 279  ·  named 95
dissolved 1478 (hold the imported 674 chronicles — text intact)
lineage links 4513 (1639 dominant)  ·  time_chronicles 505 (intact)  ·  clustering_points 61758
```
cluster.py was killed **after** lineage writes ([cluster.py:2027-2035](../pipeline/cluster.py)) but
**before** chronicle inheritance ([cluster.py:2101-2143](../pipeline/cluster.py)) completed — so
successors are blank cards and the canonical narrative is stranded on dissolved rows.

## 2. Sweep evidence — current V1 vs canonical

Authoritative source for the rich originals: `~/Documents/GitHub/mycelium/scripts/`.

| Concern | V1 now | Canonical | File:line |
|---|---|---|---|
| Naming sample | 5 msgs, `created_at DESC` (recency) | 20 msgs, `RANDOM()` | [describe-clusters.js:265-273](../pipeline/describe-clusters.js) vs canonical :160 |
| Chronicle sample | 6 msgs, `created_at DESC` | unseen-content, `territory_seen_points`, multi-pass | [describe-chronicles.js:69-78](../pipeline/describe-chronicles.js) |
| Truncation | 300 / 400 chars | 200 chars | describe-clusters.js:80, describe-chronicles.js:93 |
| Source types | **messages only** | message/document/transcript/image_description | describe-clusters.js:267-270 vs canonical :146-162 |
| Tags/entities | none | aggregated top tags + entities | canonical describe-clusters.js:168-199 |
| Coverage (% described) | not computed | `explored_count`/`explored_percent` + seen-points | schema present, unused |
| Incrementality | input-hash skip / version+drift | seen-points accumulation + CASCADE roll-up | describe-clusters.js:44-48, describe-chronicles.js:38-44 |
| Levels narrated | realm + territory | realm + theme + territory + time + arc | run-clustering.sh:98-108 |
| Progressive rewrite | skip-if-named (no rewrite) | re-narrates with growing coverage | describe-clusters.js:153 |

Schema already supports the target design (no migrations expected):
`territory_seen_points(territory_id,user_id,source_id,pass_number,seen_at)` exists (46,685 rows imported);
`territory_profiles` has `explored_count, explored_percent, point_count_at_description, chronicle_cursor,
last_described_at, describe_input_hash`; `semantic_themes`/`theme_cards` exist; `realms`/`semantic_themes`
have `explored_percent, point_count_at_description, describe_input_hash`.

Surfaces already consume coverage/story (they just get zeros today):
[portal-mindscape.js:102-190](../src/portal-mindscape.js), [topology-tools.js:321-368](../src/tools/topology-tools.js),
[territory-docs.js](../src/db/territory-docs.js), [mindscape.js](../src/db/mindscape.js).

`theme_cards`=0 is **empty at source** (canonical has no INSERT into it) → not a loss.
Message timestamps **preserved** (2018→2026) → timeline sampling viable.

## 3. Requirements (from user)

1. 20 samples, **ordered by date, spread across the whole timeline** (not recency, not pure random).
2. **Save what is/ isn't described; show % described.** When describing more, feed the **already-described
   summary + new undescribed** samples.
3. **5k chars per message.**
4. **All sources.**
5. **Top tags + entities** in the prompt.
6. The model may **rewrite title + description** as understanding deepens (progressive enrichment).
7. **Hierarchical narration uses lower-level descriptions**, and **regenerates on significant change.**
8. Investigate/fix **import preservation gaps** ("tinesanos" — confirm term; reconcile data-driven).
9. **Option A** recovery; fix everything found. Proper sweep + plan.

## 4. Design

### Phase 1 — Recovery (Option A) + reconciliation
- Stop the app; snapshot the live DB (`*.pre-recover-<ts>`).
- Decrypt the kept export to a **temp dir** (plaintext only there; deleted after).
- **Restore clustering/mindscape tables** to the pristine import: for each of
  `territory_profiles, clustering_points, cluster_events, realms, semantic_themes, theme_cards,
  realm_neighbors, territory_cofire, territory_neighbors, territory_lineage, territory_pass_notes,
  territory_seen_points, time_seen_points, territory_vitality` → **DELETE existing rows for the user,
  then re-import** (importer is `INSERT OR IGNORE`, so DELETE-first is required for a clean overwrite),
  re-encrypting 256d/768d via `encryptVector`. Leave messages/people/attachments/health/wealth untouched.
- **Reconciliation:** after restore, compare **export row count vs live row count per table**; emit an
  encrypted in-vault report `imports/mindscape-recover-report-<ts>.json` + console ledger. This is what
  surfaces "tinesanos" objectively, whatever it maps to.
- Gate: `verify:mindscape-recover` (restore on a DB copy; assert live counts == export counts for the
  restored tables; chronicles present on live territories; idempotent).
- Relaunch app; verify the mindscape renders with names + chronicles + % described.

### Phase 2 — Narration pipeline (branch `feat/narration-overhaul`)

Shared sampler lib `pipeline/lib/narrate-sample.js`:
- **Timeline-stratified draw:** over the cluster's `clustering_points.created_at` min→max, split into
  ~20 buckets, pick one representative point per bucket (deterministic tiebreak on source_id), ordered
  by date. Falls back to fewer buckets for small clusters.
- **All source types:** CASE join message/document/transcript/image_description (port canonical:146-162).
- **5k char** per snippet (was 300/400).
- **Tags + entities** aggregation → `topTags`, `entities` passed to the prompt.
- **Coverage:** record sampled `source_id`s into `territory_seen_points` (with `pass_number`); compute
  `explored_count = distinct seen`, `explored_percent = seen / total_points`. Realms/themes roll up
  child coverage (CASCADE).

`describe-clusters.js` + `describe-chronicles.js`:
- **Progressive rewrite:** prompt includes the EXISTING name/essence/story (if any) + the new unseen
  samples, instructing the model to *refine/rewrite* as understanding grows. Replace skip-if-named with
  **enrich-on-new-coverage**: re-narrate when unseen content exists OR coverage% moved past a threshold;
  keep a coverage-aware signature so a fully-covered, unchanged cluster still skips (no churn).
- **Incremental:** each pass samples from **unseen** points first, includes the prior description as
  context so the model evolves rather than restarts.

### Phase 3 — Hierarchical narration
- **Bottom-up order:** territory → **theme** (port `semantic_themes` narration; `mindscape.js` already has
  the upsert) → realm. Each parent's prompt is fed its **children's names + essences + stories**, not just
  names (extends [describe-chronicles.js:271-287](../pipeline/describe-chronicles.js)).
- **Regenerate on significant child change:** parent re-narrates when aggregate child coverage/version
  drifted (child `description_version` set changed, or child count drift ≥ factor) — reuse `hasDrifted`
  shape at each level.
- cluster.py inheritance stays the cross-re-cluster carry; verify it runs to completion (the incident was
  an interrupted run, not a logic bug).

### Phase 4 — Surfaces
- Confirm `explored_percent`/coverage renders in portal mindscape + the MCP territory tool (already wired;
  ensure non-zero now that describe computes them). Show "described N% (X/Y)".

### Phase 5 — Verify gates
`verify:describe-sampling` (timeline stratification, all source types, 5k, tags/entities),
`verify:describe-coverage` (seen-points accumulation, % math, incremental unseen draw),
`verify:describe-progressive` (rewrite-on-new-coverage, skip-when-fully-covered-unchanged),
`verify:describe-hierarchy` (bottom-up, parent uses child descriptions, regen-on-child-change),
plus existing `verify:describe-gating` / chronicles gates stay green.

## 5. Sequencing & safety
1. Phase 1 recovery FIRST (un-break the live vault). App stopped, DB snapshotted, restore tested on a copy.
2. Phase 2-5 on `feat/narration-overhaul`; **never run Generate on the real vault** until gated.
3. Test narration on a **copy** of the recovered DB before any live Generate.
4. Merge via `/auto-merge-on-green`; living docs updated in the same commit.

## 6. Open question
**"tinesanos"** — not yet decoded. Timestamps, time_chronicles (505), semantic_themes (438),
territory_seen_points all imported; theme_cards empty-at-source. The Phase-1 reconciliation will list any
real gap objectively. Please confirm the intended term so it's explicitly covered.

---

# Phase 2b — describe-chronicles + hierarchy (DESIGN, sweep-first 2026-06-15)

Status: **DESIGN — describe-clusters (Phase 2a) shipped + gated** (`verify:narrate-sample` 6/6, `verify:describe-coverage` 5/5, `verify:describe-gating` 8/8 still green). This section designs the **story pass** + **hierarchy**.

## Sweep findings (consolidated, file:line)
- `db.territoryDocs.upsertDescription` writes all chronicle fields + `description_version` + `point_count_at_description` + `last_described_at=datetime('now')` + `generation_model`; **does NOT read the existing row first**, **no `generated_at`** on territory_profiles ([territory-docs.js:139-183](../src/db/territory-docs.js)).
- `db.mindscape.upsertRealmDescription` is **UPDATE-only** (never creates a realm), writes story fields + `generation_version` + `point_count_at_description` + `generated_at=datetime('now')` + `generation_model`; **no raw_response** at rest ([mindscape.js:121-144](../src/db/mindscape.js)).
- **No theme narration exists.** `cluster.py` assigns `theme_id` to clustering_points but **never INSERTs `semantic_themes`** ([cluster.py:1317-1326]); describe-* never touch `semantic_themes`; the portal reads them ([portal-mindscape.js:146-190](../src/portal-mindscape.js)) → NULL in practice. Live data: only **55/184** active territories have `semantic_theme_id`; 438 theme rows are import-only/historical (~50 live).
- `verify:chronicles` (C0–C9) seeds `clustering_points` + member messages ([verify-chronicles.mjs:56-72](../scripts/verify-chronicles.mjs)) → my sampler swap finds members. Contract to preserve: signature `describeChronicles({db,userId,infer,version,sample,sampleRealm,log,onProgress,modelLabel}) → {total,described,skipped,failed}`; version gate + `hasDrifted`; `point_count_at_description = LIVE message_count`; realm UPDATE-only; raw for territory / NULL realm; history snapshots; modelLabel→generation_model; fail-soft + `withTimeout`.
- `describeChronicles` + `hasDrifted` have NO callers beyond the CLI entry + verify gate. Spawned async post-Generate by `startChronicleNarrationJob` ([jobs.js:330-366](../src/jobs.js)), 180s timeout.

## Revision history
- v1 (Phase-2 design): territory → **theme** → realm bottom-up.
- v2 (first sweep): PIVOT — drop the theme level (cluster.py doesn't materialize `semantic_themes`).
- **v3 (user: "themes are imperative — fix the gaps"): themes BACK IN, materialized in the DESCRIBE stage** (canonical `scripts/describe-chronicles.js` `assignTerritoryThemes()`+`describeThemes()`). The v2 worry was misframed: themes need NO cluster.py change — `cluster.py` already assigns `clustering_points.theme_id` (the structural output); the DESCRIBE stage derives membership from it (canonical :765-783), owns `semantic_themes` rows + `territory_profiles.semantic_theme_id` + narration. Closeable now on recovered data, WITHOUT touching the locked cluster.py path. `theme_id === semantic_theme_id`, realm-local; a territory's theme = its points' DOMINANT theme_id.

## Theme architecture (canonical, to port — v3)
- Membership (canonical :765-783): `ROW_NUMBER() OVER (PARTITION BY territory_id ORDER BY COUNT(*) DESC)` over `clustering_points(territory_id, theme_id, realm_id)` → dominant theme per territory → `UPDATE territory_profiles SET semantic_theme_id`.
- Theme rows narrated from MEMBER TERRITORY descriptions (name/essence/story), NOT raw messages (canonical :878-945) — bottom-up synthesis.
- CASCADE explored_percent weighted by message_count, territory→theme→realm (canonical :712-736).
- **Realms read TERRITORIES directly, not themes** (canonical :1142-1158) — themes are a parallel mid-level drill-down. Hierarchy = {theme←its territories} ∥ {realm←its territories}; both regenerate on territory change.
- Order: assign-themes → cascade → describe-themes → describe-realms.
- V1 gaps: `db.mindscape` has NO semantic_themes write (only `getSemanticThemes`); `territory_profiles.semantic_theme_id` never written; schema + encryption (crypto-local.js:265-272) + `UNIQUE(user_id,realm_id,semantic_theme_id)` ready. Stale import-era themes (388 of 438 dead) → PRUNE rows with no live member points (fail-closed, like cluster.py realm-prune); preserve existing theme chronicles via version-gate (don't rewrite imported history).

## Design
**Sampling** — replace `sampleTerritoryContent` (6 recent) + `sampleRealmContext` (6 recent) with the shared `loadMembers`+`sampleMembers` (20 timeline-stratified, 5k, all sources, tags+entities). Territories pass `seenIds` (the **shared** `territory_seen_points` ledger — naming + chronicling advance ONE "% described" per territory). Realms draw a plain stratified spread (no per-realm seen table), same as the realm path in describe-clusters.

**Progressive** — `getTerritoriesToNarrate` SELECT adds `story_birth, story_arc, story_current_chapter, archetype_type`; `buildPrompt` shows the EXISTING chronicle ("Current chronicle: … Refine/extend as understanding deepens"). Same for realms.

**Coverage** — on a real narration, `recordSeen(sampledIds)` then a small `UPDATE territory_profiles SET explored_count/explored_percent` from the ledger (same shape as describe-clusters' coverage write; does NOT touch `upsertDescription`).

**Gate (territory)** — keep version-stale OR `hasDrifted`; ADD a cheap coverage trigger using the **column** (not per-row member loads): `explored_percent IS NULL OR explored_percent < 100`. → keep narrating until fully described.

**Hierarchy (realm)** — (1) `sampleRealmContext` fetches member territories' **name + essence + story_current_chapter** (not just names); `buildRealmPrompt` feeds them ("Its territories and their stories: …"). (2) `getRealmsToNarrate` ADDS a child-change trigger: re-narrate when any child territory was described after the realm: `MAX(child.last_described_at) > realms.generated_at`. Few realms (42) → cheap per-realm subquery.

**Theme (DEFERRED)** — documented; needs cluster.py to create+link `semantic_themes`, then a theme pass mirroring the realm pass (territory→theme→realm).

## Module shape / LOC
`pipeline/describe-chronicles.js`: swap the two `sample*` fns → sampler; enrich `buildPrompt`/`buildRealmPrompt`; add coverage write; widen `getTerritoriesToNarrate`/`getRealmsToNarrate` SELECT+filter. ≈ +90/−45. New `scripts/verify-chronicle-hierarchy.mjs` ≈ 130 LOC.

## Test strategy
- `verify:chronicles` stays GREEN (contract preserved; coverage is additive, drift/version carry C3/C5).
- NEW `verify:chronicle-hierarchy`: (H1) territory chronicle from all-source stratified sample; (H2) progressive — prior chronicle text appears in the prompt the model receives; (H3) realm prompt includes child territory descriptions; (H4) realm re-narrates when a child's `last_described_at` advances past `realms.generated_at`; (H5) coverage advances via the shared ledger.

## Implementation order
1. Rewire `describe-chronicles.js` sampling + progressive + coverage (territory). Smoke: `npm run verify:chronicles`.
2. Hierarchy: realm fed child descriptions + child-change regen. Smoke: `npm run verify:chronicle-hierarchy`.
3. (later) chronicle-safe Generate + lift kill-switch.

## Verification table
| Assumption | Verified at |
|---|---|
| upsertDescription writes desc_version/point_count_at_description/last_described_at, no read-first | territory-docs.js:139-183 (read) |
| upsertRealmDescription UPDATE-only, sets generated_at, no raw | mindscape.js:121-144 (sweep, quoted) |
| no theme narration; cluster.py only assigns theme_id | cluster.py:1317-1326; grep semantic_themes (sweep) |
| only 55/184 active territories theme-linked (theme pass unsafe) | live DB query 2026-06-15 |
| verify:chronicles seeds clustering_points → sampler finds members | verify-chronicles.mjs:67-70 (read) |
| describeChronicles contract (signature/return/gates/pcad/realm-update-only) | verify-chronicles.mjs:82-144 (read) |
| territory_profiles.last_described_at + realms.generated_at exist (child-change signal) | migrations/0001_init.sql:1408, :1071 (sweep) |
| shared territory_seen_points ledger (Phase 2a writes it) | narrate-sample.js:123-155; describe-clusters.js (shipped) |

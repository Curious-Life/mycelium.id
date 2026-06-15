# Describe-management design — 2026-06-11

One owner for "what has been described, from which input, and is it stale" across the
naming pass (describe-clusters), the chronicle pass (describe-chronicles), territory
dissolution (cluster.py), and the search index. Closes the gaps found in the 2026-06-10
dead-weight audit follow-up: names over-refresh (every Generate re-spends inference and
can clobber good names with placeholders) while chronicles under-refresh (version-gated
forever, never re-narrated as content grows).

## Revision history

- **v1 (sketch, conversation)** — "port the canonical `describe_input_hash` mechanism;
  successors already inherit names; gate chronicle drift on `point_count_at_description`."
- **v2.1 (implementation)** — gate-forced correction: `describe_input_hash` exists
  on **realms + semantic_themes only**, NOT territory_profiles (0001_init.sql:1075,
  1142; confirmed via PRAGMA on a migrated :memory: db after verify:describe-gating
  G1 failed with "no such column"). A cycle-1 sweep mis-cited "0001:1408
  territory_profiles"; the cycle-2 canonical sweep had it right. Migration 0012 now
  also adds the column to territory_profiles.
- **v2 (post-sweep)** — three pivots, all sweep-forced:
  1. **Canonical has no hash mechanism.** `describe_input_hash` is vestigial in
     reference/ too; canonical's real skip was `name IS NOT NULL` + `--force`
     (reference/server-routes equiv., describe-clusters.js:217-226) — which never
     refreshes on content change. We design fresh: an **ID-based input signature**
     (no content derivation — stronger than the canonical column ever was).
  2. **Successors do NOT inherit names today.** The inheritance block's `old_name`
     is dead code; only `predecessor_ids`/`evolved_from_count` are written
     (pipeline/cluster.py:2039-2069). Chronicle inheritance is NEW, placed AFTER
     `compute_dynamics()` because the successor row does not exist earlier.
  3. **`point_count_at_description` stores `samples.length` (≤6), not the territory
     size** (describe-chronicles.js parseChronicle → `point_count: pointCount` where
     pointCount = samples.length). Drift math against it would be broken from day
     one; the write site changes to store `t.message_count`.

## Sweep findings (consolidated, 3 cycles + red-team)

- **No skip logic exists in V1 naming.** describe-clusters loops every DISTINCT
  realm_id/territory_id from clustering_points and upserts name/essence
  unconditionally ([describe-clusters.js:89-151](../pipeline/describe-clusters.js)).
  Placeholder fallback `Realm ${id}` / `Territory ${id}` overwrites real names when
  the model fails (lines 108, 138).
- **Chronicle gate is decrypted-version-only**; no refresh ever
  ([describe-chronicles.js:37-46](../pipeline/describe-chronicles.js)). Fail-soft on
  model error already preserves existing data (lines 138-141). Progress math
  tolerates skips (numerator counts skipped).
- **Encryption boundary**: name/essence/story_*/description_version are ENCRYPTED
  (crypto-local.js ENCRYPTED_FIELDS.territory_profiles / .realms); SQL equality on
  them fails silently (non-deterministic AES-GCM), `IS NOT NULL` works.
  `describe_input_hash`, `last_described_at`, `point_count_at_description`,
  `message_count`, `generation_version` (realms) are PLAINTEXT.
- **Plaintext-hash precedent**: messages/documents `content_hash` is plaintext with
  documented inversion-risk acceptance (migrations/0007, crypto-local.js:241-250).
  This design avoids the risk class entirely: the signature hashes **random message
  UUIDs + a count** (capture.js:72 `crypto.randomUUID()`), never content.
- **clustering_points ids are deterministic** (`${USER}:cp:message:${source_id}`,
  sync-clustering-points.js:127, ON CONFLICT upsert) — the sample is stable when
  content is unchanged. forget() deletes points (messages.js:251) → sample/count
  change → signature changes → re-describe fires. That is change detection working,
  not instability.
- **cluster.py write order** (main): write_results → events → dissolve marking →
  realm prune → lineage+predecessor_ids → is_anchored → last_active →
  **compute_dynamics (creates/updates EVERY live territory row)** → catch-all →
  timelines → centroids → realm_neighbors. Chronicle inheritance must come after
  compute_dynamics.
- **Python d1_query returns ciphertext verbatim** (no decrypt); a row-to-row copy of
  encrypted columns is a valid ciphertext copy (envelopes are self-contained).
  Writes of COPIED values go through plain `local_db` — `batch_encrypted` would
  double-encrypt; it is only for NEW plaintext.
- **Realm UI already renders** `storyCurrentChapter` + `signaturePatterns` at realm
  level (MindscapeDetail.svelte:347-377) and the full RealmProfile type +
  aggregator plumbing exists (mindscape.ts:154-174, portal-mindscape.js:155-168).
  Only the writer is missing. Realms have `generation_version` (plaintext) +
  `describe_input_hash` but NO `point_count_at_description` → one migration column.
- **Search staleness**: in-RAM index builds once per process (ensureBuilt); nothing
  rebuilds after Generate → renames invisible in `searchMindscape` for the whole
  session (search/index.js:46-71; jobs.js close handler has no hook). The
  **mind-search registry** (search/registry.js, already consumed cross-module by
  db/messages.js:657) is the existing pattern for reaching the instance. Rebuild
  cost is bounded: loadFromDb rehydrates stored message vectors (zero re-embeds,
  verify-search-rehydrate R2); only profile texts re-embed (~hundreds, local).
- **No user-facing territory/realm rename exists** (the only rename endpoint is chat
  contexts, portal-compat.js:601-606) — no clobber conflict with users today;
  reserved for later via the hash sentinel (see deferred).

## Threat model

- **New plaintext at rest**: `describe_input_hash` = SHA-256 over sorted sample
  message UUIDs + point count. UUIDs are random (not content-derived) and already
  sit plaintext in clustering_points; the hash adds no inversion surface (strictly
  weaker signal than the accepted documents.content_hash precedent). Reveals only
  "this cluster's recent-sample composition changed between runs" — equivalent to
  what updated_at already leaks.
- **Chronicle inheritance** copies ciphertext between rows of the same table inside
  the local vault — no decrypt in Python, no new egress.
- **Realm narration egress** uses the existing narrator seam (local Ollama native /
  audited cloud router) — same surface as territory narration today, only sampled
  snippets leave (when the user configured cloud).
- **Fail-closed**: realm chronicle writes are UPDATE-only — a realm row is never
  created by the chronicle pass (rows exist only via describe-clusters from live
  points, or import). Failure paths never blank existing data.

## Module shape (~510 LOC total ±20%)

1. **migrations/0012_realm_describe_state.sql** (~4 LOC)
   `ALTER TABLE realms ADD COLUMN point_count_at_description INTEGER;` (migrate.js
   guards ADD COLUMN idempotently).

2. **pipeline/describe-clusters.js** (~70 LOC delta)
   - `sampleContent` returns `[{id, content}]`, ordered `created_at DESC, m.id DESC`
     (deterministic tiebreak).
   - `inputSignature(sampleIds, totalCount)` = sha256 hex.
   - Per cluster: read `name, describe_input_hash` (+counts query). Gate:
     `named && hash === sig && !FORCE` → **skip narration, still update counts**.
   - Success → full upsert incl. `describe_input_hash = sig`.
   - Failure + named → counts-only update (old hash stays ≠ sig → retried next run).
   - Failure + unnamed → placeholder upsert with `describe_input_hash = NULL`
     (placeholders are permanently retry-eligible; clobber impossible by
     construction).
   - `MYCELIUM_DESCRIBE_FORCE=1` / `--force` bypasses the gate.
   - Territory `message_count` now from a real COUNT (was `samples.length` on the
     mostly-dead INSERT path).

3. **pipeline/describe-chronicles.js** (~120 LOC delta)
   - Drift gate: narrate when `description_version !== version` OR
     `drifted(message_count, point_count_at_description)` where drifted =
     `pcad != null && |mc − pcad| ≥ DRIFT_MIN && max/min ≥ DRIFT_FACTOR`
     (env `MYCELIUM_CHRONICLE_DRIFT_MIN`=10, `_FACTOR`=1.5).
   - `point_count` stored = `t.message_count` (pivot 3).
   - **Realm pass**: `getRealmsToNarrate` (gate: `generation_version !== version` OR
     drift vs realms.point_count_at_description), realm prompt includes member
     territory names (decrypted via adapter), writes via new
     `db.mindscape.upsertRealmDescription` — UPDATE-only, sets story_*/archetype_*/
     uncertainty_*/agent_*/signature_patterns/essence + generation_version +
     point_count_at_description + generated_at + generation_model. Never name.
   - `generation_model` honest: narrator label threaded into
     `upsertDescription(…, modelLabel)` (replaces hardcoded `'claude-opus'`).

4. **src/db/mindscape.js** (~60 LOC) — `upsertRealmDescription(userId, realmId, desc,
   version, modelLabel, rawResponse)` (UPDATE … WHERE user_id/realm_id; returns
   changes count so the caller can count a missing row as skipped).

5. **src/db/territory-docs.js** (~6 LOC delta) — `upsertDescription` gains
   `modelLabel` param (default keeps old literal for back-compat callers).

6. **pipeline/cluster.py** (~45 LOC delta) — after `compute_dynamics(...)`:
   for each dominant `successor_inherits[new_id] = old_id`, if predecessor
   `description_version IS NOT NULL` and successor `description_version IS NULL`,
   copy chronicle-owned columns (story_*, archetype_*, uncertainty_*, agent_*,
   signature_patterns, top_entities, description_version,
   point_count_at_description, last_described_at, generation_model) — Python
   read-then-write of stored values verbatim (ciphertext copy; plain `d1_query`,
   NOT the encrypt bridge). Successor then drift-refreshes naturally (its
   message_count vs inherited point_count_at_description).

7. **src/jobs.js** (~12 LOC delta) — on Generate exit 0 AND on chronicle job exit:
   `getMindSearch()?.rebuild().catch(() => {})` (fire-and-forget; registry is
   populated at boot before any job can fire; cost bounded by vector rehydrate).
   Plus a module-level single-flight flag for the chronicle job (today two
   overlapping Generates could double-narrate).

## Edge cases — explicit decisions

| Case | Decision |
|---|---|
| Model fails on a NAMED cluster | Keep name/essence; update counts only. Old hash ≠ new sig → retries next Generate. (Today: clobbered with placeholder.) |
| Model fails on an UNNAMED cluster | Placeholder written for UX, hash NULL → retried every run until a model succeeds. |
| Message forgotten from a cluster | Sample/count change → sig change → re-describe. Desired (content changed). |
| Equal `created_at` timestamps in sample | `ORDER BY created_at DESC, m.id DESC` tiebreak — deterministic sig. |
| Chronicle drift vs stale message_count after forget | Not reachable: chronicles run only after Generate; compute_dynamics refreshes message_count from live points first. |
| Successor row missing at inheritance time | Cannot happen anymore — block moved after compute_dynamics (which upserts every live territory). Guarded `IS NULL` anyway. |
| Predecessor never chronicled | `description_version IS NOT NULL` guard → no-op. |
| Successor already has own chronicle | `description_version IS NULL` guard → never overwritten by inheritance. |
| Realm row absent at chronicle time | UPDATE matches 0 rows → counted skipped. Fail-closed: chronicle pass never creates realm rows. |
| Two overlapping chronicle jobs | New single-flight flag in jobs.js; accepted residual: a crashed job clears on process restart. |
| Inherited story stale vs successor's real content | Self-correcting: inherited point_count_at_description + drift gate re-narrates when content meaningfully diverges. |
| User-renamed territory (future feature) | Deferred — see below. Hash design leaves room: a rename surface sets a sentinel (e.g. hash `'user'`) the gate treats as always-skip. |
| `--dry-run` | All new writes (hash, inheritance, realm chronicle) gated exactly like existing writes. |

## Test strategy

- **scripts/verify-describe-gating.mjs (NEW)** — temp vault; spawn describe-clusters
  twice with a stub-friendly env: G1 first run writes names + hash; G2 second run
  with unchanged data narrates 0 (hash skip) but counts still update; G3 new
  message → sig change → re-describe fires; G4 model-failure on named cluster
  preserves name (no placeholder clobber); G5 placeholder run leaves hash NULL and
  retries; G6 hash is plaintext at rest + name ciphertext; G7 cluster.py contains
  the inheritance statements this gate mirrors + SQL-level inheritance simulation
  (copy fires only when predecessor has version and successor doesn't).
- **scripts/verify-chronicles.mjs (EXTEND)** — C5 drift: territory at version with
  message_count ≥ 1.5× stored pcad re-narrates; C6 no-drift skip; C7 pcad now
  stores message_count (not samples.length); C8 realm pass writes story fields +
  generation_version via UPDATE-only (absent realm row → skipped, not created); C9
  generation_model reflects the injected narrator label.
- **scripts/verify-jobs-search-refresh** — folded into verify-describe-gating as a
  unit assertion on jobs.js wiring (registry call present + guarded), since a full
  server boot is covered by verify:generate.

## Implementation order (each independently shippable)

1. Migration 0012 + `verify:measurement-schema` still GO. Smoke: `npm run verify:measurement-schema`.
2. describe-clusters gating + clobber guard. Smoke: `node scripts/verify-describe-gating.mjs`.
3. chronicles drift + pcad fix + model label. Smoke: `npm run verify:chronicles`.
4. Realm chronicle pass (db.mindscape.upsertRealmDescription + realm loop). Smoke: `npm run verify:chronicles` (C8).
5. cluster.py inheritance. Smoke: `verify-describe-gating` G7 + `py_compile`.
6. jobs.js search rebuild + chronicle single-flight. Smoke: `npm run verify:generate`.

## Decision criteria (falsifiable)

- Two consecutive Generates with zero new messages: second run's describe stage logs
  `skipped (unchanged)` for every cluster and makes **0 narration calls**.
- Add 1 message to one territory → exactly that territory (+its realm) re-describes.
- A territory whose message_count grew ≥1.5× since narration re-chronicles on the
  next pass; an unchanged one does not (across ≥3 runs).
- After Generate, `searchMindscape` returns the NEW territory names without a server
  restart.

## Risks

| Risk | L | I | Mitigation |
|---|---|---|---|
| Hash gate skips a cluster whose content changed but sample+count didn't | Low (only possible via same-count replace with older-timestamped rows) | Med | Count is part of sig; forget changes count; import resets nlp/cluster state → next Generate resamples |
| Ciphertext copy writes envelopes under wrong scope assumptions | Low | High | Same table, same scope key path; gate G7 simulates and `verify:chronicles` C4 confirms read-back decrypts |
| rebuild() races an in-flight search | Low | Low | Post-Generate timing; backend rebuild is additive load; accepted + noted |
| Realm narration spends on realms the user never opens | Med | Low | Realm count ≤ ~10; drift-gated; same narrator budget as one territory each |
| jobs.js registry empty in exotic boot modes (stdio MCP, tests) | Low | Low | Optional chaining + catch; rebuild is best-effort |

## Deferred (named, out of scope)

- **User rename surface** (portal "rename territory") + `user_named` sentinel honoring.
- **Realm story UI** beyond the already-rendered `storyCurrentChapter`/`signaturePatterns`
  (MindscapeDetail realm drill-in could show Origin/Arc like territories — frontend-only).
- **Incremental search indexing from ingest** (indexDocument is exported, uncalled).
- **`chronicle` column** (vestigial, confirmed unwritten) — candidate for a later
  pre-deletion-caller-audit.
- **`old_name` dead code** in cluster.py inheritance — removed opportunistically in step 5.

## Verification table

| # | Assumption | Verified at (read myself) |
|---|---|---|
| 1 | `describe_input_hash` schema-only, plaintext — on realms + semantic_themes in 0001; territory_profiles gets it via migration 0012 (v2.1 correction) | migrations/0001_init.sql:1075,1142 + PRAGMA on migrated :memory: db; absent from ENCRYPTED_FIELDS (src/crypto/crypto-local.js realms/territory lists, re-read) |
| 2 | Naming pass has no skip; ON CONFLICT overwrites name/essence; placeholder fallback | pipeline/describe-clusters.js:89-151 (read in full) |
| 3 | Chronicle gate version-only; pcad stores samples.length | pipeline/describe-chronicles.js:37-46, parseChronicle `point_count: pointCount` + call `parseChronicle(raw, t, samples.length)` (read) |
| 4 | upsertDescription writes pcad + hardcodes 'claude-opus' | src/db/territory-docs.js:138-181 (read) |
| 5 | Inheritance writes only predecessor_ids/evolved_from_count; old_name dead; successor row may not exist; compute_dynamics runs later and upserts every live territory | pipeline/cluster.py:2024-2069 + 2096-2100 (read) |
| 6 | Encrypted-column SQL equality fails; IS NULL works; Python reads ciphertext verbatim | src/crypto/crypto-local.js comments + pipeline/local_db.py query (sweeps 3,4; key lines re-read) |
| 7 | Message ids random UUIDs → sig derives nothing from content | src/ingest/capture.js:72 (red-team verified, quoted) |
| 8 | clustering_points ids deterministic per source_id | pipeline/sync-clustering-points.js:127-142 (red-team quoted) |
| 9 | Mind-search registry is the cross-module access pattern; rebuild rehydrates stored vectors (no message re-embeds) | src/search/registry.js:15-16, src/search/index.js:265, src/db/messages.js:657 (read); scripts/verify-search-rehydrate.mjs header R2 |
| 10 | No post-Generate search refresh exists today | src/jobs.js:163-181 close handler (read — no rebuild call) |
| 11 | Realm UI renders storyCurrentChapter + signaturePatterns; RealmProfile fully typed | MindscapeDetail.svelte:347-377, mindscape.ts:154-174 (sweep quoted; template re-checked) |
| 12 | realms has generation_version (plaintext) + describe_input_hash, lacks point_count_at_description | migrations/0001_init.sql realms block (read) |
| 13 | Only rename surface is chat contexts | src/portal-compat.js:601-606 (read) |
| 14 | verify:chronicles is stub-injectable (infer/sample params) | pipeline/describe-chronicles.js describeChronicles signature + scripts/verify-chronicles.mjs header (read) |

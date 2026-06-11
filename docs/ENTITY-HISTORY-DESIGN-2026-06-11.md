# Entity change-log (history) design — 2026-06-11

A single append-only `entity_snapshots` log so the full evolution of every territory
and realm — its **narrative** (name/essence/chronicle) and its **dynamics**
(energy/coherence/velocity/…) — is preserved forever, never overwritten. Today the
describe pipeline upserts in place: only dissolved rows (frozen) + `.myvault` backups
hold any past, and per-entity dynamics over time are lost on each Generate.

**Scope (user decision):** *Everything — unified change log*, *storage only for now*
(read surfaces — portal panel, MCP tool — deferred to a later phase).

## What is ALREADY logged (do NOT rebuild)

The sweeps found most "change over time" is already append-only and authoritative:

| Already logged | Table | Writer |
|---|---|---|
| Structural events (formed/grew/dissolved/stable) per Generate | `cluster_events` | pipeline/cluster.py:1353 |
| Territory ancestry (old→new, dominance, transfer) | `territory_lineage` | pipeline/cluster.py:2029 |
| System topology health over time | `topology_audit_snapshots` | pipeline/topology-audit.js:199 |
| Windowed cognitive metrics | `frequency_snapshots`, `complexity_snapshots` | compute-frequency.py / compute-complexity.js |
| Belief/claim evolution | `person_claim_snapshots` | src/db/claims.js:150 |

The **genuine gaps** are per-entity **narrative** history and per-entity **dynamics**
trajectory. Those are all this design adds.

## The pivot: "unified" by UNION-at-read, not by copy

The chosen option said "mirror structural events into one timeline." Copying
`cluster_events`/`territory_lineage` rows into a new table would create a **second
source of truth that drifts** from cluster.py's authoritative writes — exactly the
CLAUDE.md §10 anti-pattern ("validate every operation; never log-and-diverge"). So
the unified timeline is delivered **at read time** by a future view that `UNION`s
`entity_snapshots` + `cluster_events` + `territory_lineage` on shared keys
(`entity_kind`, `entity_id`, `cluster_version`, timestamp). Since reads are deferred,
storage only needs to be shaped so that union is trivial later — which it is (same
keys). Storage now writes **only** the non-duplicative gaps.

## Template choice

Two precedents (both swept + read):
- `space_knowledge_history` (src/db/space-knowledge.js:108) — append-only, writes the
  **prior** value on edit, transactional "history-row-first".
- `person_claim_snapshots` (src/db/claims.js:150) — per-window UPSERT, `readSeries`,
  delta enum, reuses `TimeSeries.svelte`.

Winner: a **synthesis** — append-only like space_knowledge (full log, never
overwrite), monotonic `seq` per entity (not window-keyed — descriptions change on
Generate/drift, not on a clock window), dedup-vs-latest so identical re-narrations
don't bloat. Snapshot-**after** (store each new version as-written) rather than
prior-value, because a "full version log" wants version N = the state at time T, with
the live row always == the latest snapshot.

## Schema — migration 0013

```sql
CREATE TABLE IF NOT EXISTS entity_snapshots (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id         TEXT NOT NULL,
  entity_kind     TEXT NOT NULL,   -- 'territory' | 'realm'  (extensible: 'theme')
  entity_id       INTEGER NOT NULL,-- territory_id / realm_id (stable across re-cluster)
  snapshot_kind   TEXT NOT NULL,   -- 'narrative' | 'dynamics'
  stage           TEXT,            -- narrative: 'name' | 'chronicle' ; dynamics: NULL
  seq             INTEGER NOT NULL,-- monotonic per (user,kind,id,snapshot_kind)
  payload         TEXT NOT NULL,   -- ENCRYPTED JSON blob (prose fields, or dynamics scalars)
  entity_version  TEXT,            -- description_version / generation_version label (non-sensitive)
  cluster_version TEXT,            -- Generate era; plaintext join key to cluster_events
  generation_model TEXT,           -- narrator label (plaintext)
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, entity_kind, entity_id, snapshot_kind, seq)
);
CREATE INDEX IF NOT EXISTS idx_entity_snapshots_lookup
  ON entity_snapshots(user_id, entity_kind, entity_id, snapshot_kind, seq);
```

**Crypto:** `ENCRYPTED_FIELDS.entity_snapshots = ['payload']`. Everything narrative or
SEC-3 lives inside the one blob → uniformly encrypted, and future narrative fields are
covered with no schema/policy change. All other columns are structural (id/fk/enum/
timestamp/label) → plaintext per the crypto-local.js classification rule (188-207).
A single encrypted JSON-blob column round-trips exactly like `raw_response` /
`activity_timeline` (auto-encrypt on write, auto-decrypt on read, `parseJson` on the
caller). It is **not** a vector column → not in `NEVER_AUTO_DECRYPT`.

**No content-hash column.** Dedup compares the new payload to the *latest* snapshot's
**decrypted** payload (one row read) — so we never store a plaintext hash of narrative
content (avoids the documents.content_hash inversion-risk class entirely). A revert
A→B→A correctly records three versions (a `UNIQUE(content_hash)` would have wrongly
blocked the third).

## Module shape (~300 LOC ±20%)

1. **migrations/0013_entity_snapshots.sql** (~10) — table + index above.
2. **src/crypto/crypto-local.js** (~2) — `entity_snapshots: ['payload']`.
3. **src/db/history.js** (NEW, ~80) — namespace:
   - `recordSnapshot(userId, { entityKind, entityId, snapshotKind, stage, payload, entityVersion, clusterVersion, model })`
     → canonicalize payload (stable key order); read latest payload for
     (entity,kind); if canonically equal → `{ skipped:true }`; else INSERT `seq+1`.
     Returns `{ seq }`.
   - `readHistory(userId, entityKind, entityId, { snapshotKind, limit=500 })`
     → rows ASC by seq, payload `parseJson`'d (for tests now, read surface later).
   - `canonicalize(obj)` — sorted-key JSON.
4. **src/db/index.js** (~3) — wire `db.history`.
5. **src/db/territory-docs.js** `upsertDescription` (~5) — after the upsert,
   `db.history.recordSnapshot(... kind:'territory', snapshotKind:'narrative',
   stage:'chronicle', payload: prose(desc), entityVersion:version, model:modelLabel)`.
6. **src/db/mindscape.js** `upsertRealmDescription` (~5) — same for realms.
7. **pipeline/describe-clusters.js** (~12) — after the realm + territory name/essence
   upserts, record a `stage:'name'` narrative snapshot (`{name, essence}`).
8. **pipeline/snapshot-entities.js** (NEW JS stage, ~70) + run-clustering.sh wire
   (~4) — runs after describe; for every live territory + realm, record a
   `snapshot_kind:'dynamics'` snapshot from the freshly-written profile row
   (territory: energy/coherence/velocity/current_vitality/point_delta/message_count/
   growth_state/is_anchored — adapter auto-decrypts the SEC-3 scalars; realm:
   message_count/territory_count). Dedup-vs-latest. This is the home for per-entity
   dynamics-over-time; it runs in JS with the db adapter (cluster.py's compute_dynamics
   already wrote the scalars in Step 2; snapshotting in JS avoids a Python crypto path).
9. **src/ingest/vault-import.js** (~1) — `await run('entity_snapshots',
   m.history?.entitySnapshots)` (no-op on current canonical exports; future-proofs a
   V1→V1 export/import). Backup/restore already covers it (whole-file snapshot).

**Narrative payload (`prose`)** = name, essence, archetype_type, archetype_character,
story_birth, story_arc, story_current_chapter, story_peak_moments, signature_patterns,
uncertainty_open_questions, uncertainty_edges, agent_expertise, agent_curious_about,
agent_can_help_with, agent_would_consult, top_entities. **Excludes** bookkeeping
(description_version, point_count_at_description, last_described_at) — those are
metadata columns / not "content", so a drift-only re-narration with identical prose
does not append a near-dup.

## Edge cases — explicit decisions

| Case | Decision |
|---|---|
| Identical re-narration (drift bumped version, prose unchanged) | Dedup-vs-latest on prose → no new row. Version bump alone is not a content change. |
| Description reverts A→B→A | Three rows (dedup is vs *latest* only, not all history). Correct for a full log. |
| Dynamics float jitter every Generate | Expected — that IS the trajectory. ~entities × Generates rows/yr (≈7k/yr at 20 terr daily); dedup still drops identical back-to-back runs. |
| cluster.py chronicle inheritance (Python, ciphertext-copy) | NOT snapshotted at inheritance (Python can't call the JS helper without a crypto path). The successor's inherited chronicle logs on its next JS (re)narration. Predecessor history is intact. Documented gap. |
| Territory dissolves | Its snapshots persist (append-only, never deleted); the frozen profile row + lineage already record the end-state. Future union view stitches them. |
| Realm pruned (no live points) | Its snapshots persist (history outlives the live row — the whole point). |
| Two overlapping Generates race `seq` | `UNIQUE(...seq)` makes a collision throw (fail-loud), not silently dup. Pipeline is single-flight (verify:generate G6d; chronicle job single-flight) so unreachable in practice. |
| Model failure / placeholder name | describe-clusters records `stage:'name'` only on a real write; a placeholder-with-NULL-hash path still writes name → snapshot captures it (honest: the log shows the placeholder existed). |
| New narrative field added later | Inside the JSON blob → encrypted + logged automatically, no migration. |
| Empty/first snapshot | latest is null → seq 1, always inserts. |

## Threat model

- **New encrypted-at-rest data:** `payload` is AES-GCM via the same adapter chokepoint
  as every other narrative column; never logged, never in HTTP responses (no read
  surface yet). Verified by a ciphertext-at-rest assertion in the gate.
- **No new plaintext hash:** dedup decrypts the latest row in-process; nothing about
  content is exposed in a plaintext column (stronger than the accepted
  documents.content_hash precedent).
- **Plaintext columns** (entity_kind/id, seq, cluster_version, model label, timestamps)
  are structural/non-sensitive — same class already plaintext on territory_profiles
  (realm_id, message_count, updated_at, generation_model).
- **Growth/DoS:** append-only could grow unbounded. Single-user, bounded by Generate
  cadence × entity count. No pruning in v1 (matches every existing snapshot table —
  none prune except background_jobs). A retention policy is a named deferred item.
- **Backup/restore:** whole-file SQLite backup includes the table automatically
  (src/account/backup.js:48 `src.backup`). Ciphertext copied verbatim.

## Test strategy — scripts/verify-history.mjs (NEW, ~120 LOC)

Temp vault, boot, seed; assert against the real `db.history` + a real
describe-chronicles run:
- **H1** recordSnapshot first call → seq 1; readHistory returns it, payload round-trips.
- **H2** identical payload again → `{skipped:true}`, still seq 1 (dedup-vs-latest).
- **H3** changed prose → seq 2; A→B→A third distinct write → seq 3 (revert logs).
- **H4** `upsertDescription` auto-records a `narrative/chronicle` snapshot; two
  drift re-narrations with identical prose but bumped version → ONE snapshot (version
  excluded from dedup).
- **H5** `upsertRealmDescription` auto-records a realm narrative snapshot.
- **H6** payload is ciphertext at rest (raw DB read shows no prose markers); structural
  columns (entity_kind, seq, cluster_version) plaintext.
- **H7** dynamics: snapshot-entities records a `dynamics` snapshot per live entity;
  re-run with unchanged scalars → deduped (0 new); changed energy → +1.
- **H8** history survives entity dissolution + realm prune (snapshot rows remain after
  the live row is gone).

Plus: `verify:measurement-schema` stays GO (0013 idempotent), `verify:chronicles` +
`verify:describe-gating` stay GO (hooks don't break existing writes),
`verify:vault-import` stays GO.

## Implementation order (each independently shippable)

1. Migration 0013 + crypto entry + `db.history` namespace + wire. Smoke: `verify:history` H1–H3, H6.
2. Narrative hooks (upsertDescription, upsertRealmDescription, describe-clusters). Smoke: `verify:history` H4–H5 + `verify:chronicles`/`verify:describe-gating` GO.
3. Dynamics stage (pipeline/snapshot-entities.js + run-clustering.sh). Smoke: `verify:history` H7–H8.
4. vault-import line. Smoke: `verify:vault-import` GO.

## Decision criteria (falsifiable)

- After two Generates with no content change: `SELECT COUNT(*) FROM entity_snapshots
  WHERE snapshot_kind='narrative'` is unchanged between runs (dedup holds).
- After editing one territory's content + re-Generate: exactly one new narrative row
  for that territory, seq incremented.
- After N Generates: a territory has ≥1 and ≤N dynamics rows (trajectory present,
  deduped).
- Raw DB read of any `payload` shows no plaintext prose.

## Risks

| Risk | L | I | Mitigation |
|---|---|---|---|
| Dedup decrypt cost per snapshot | Low | Low | One row read; single-user, low volume |
| Unbounded growth | Med | Low | Bounded by cadence×entities; retention deferred + noted; matches existing snapshot tables |
| Dynamics payload churn (float jitter) creates a row every run | High (expected) | Low | That's the trajectory; dedup drops identical runs; could round scalars in a later tuning pass |
| Python inheritance path unlogged | Low | Low | Successor logs on next narration; documented |
| seq race under concurrent Generate | Very low | Low | UNIQUE throws (fail-loud); pipeline single-flight |

## Deferred (named, out of scope)

- **Read surface**: portal "story over time" panel in MindscapeDetail + `GET
  /mindscape/:kind/:id/history` + an MCP tool (clone the persona-claims
  `readSeries`/`TimeSeries.svelte`/`personaClaims` pattern — src/tools/claims.js).
- **Unified timeline view**: the `UNION` of entity_snapshots + cluster_events +
  territory_lineage into one per-entity timeline (the "unified" read).
- **Retention/compaction** policy (keep all narrative; thin dynamics to weekly?).
- **Python-side inheritance logging** (a crypto path or a JS post-pass).
- **semantic_themes** history (dead table, 0 rows — no writer to hook).
- **User-edit history** (no user-facing rename/edit of territory/realm narrative exists
  today — portal-compat.js:601 renames chat contexts only).

## Verification table

| # | Load-bearing assumption | Verified at (read myself) |
|---|---|---|
| 1 | An append-only precedent exists to mirror (no 4th pattern) | src/db/space-knowledge.js:108-118 (history-first INSERT); src/db/claims.js:150-191 (writeSnapshot/readSeries) |
| 2 | Narrative write sites are bounded + known | src/db/territory-docs.js:138-182 (upsertDescription), src/db/mindscape.js upsertRealmDescription, pipeline/describe-clusters.js name/essence upserts (read this session) |
| 3 | Territory + realm narrative fields ARE encrypted (Sweep-4 said plaintext — WRONG) | src/crypto/crypto-local.js ENCRYPTED_FIELDS.territory_profiles (incl. 'name','essence','story_*') + .realms (read this turn); my own verify G6/R6 assert name ciphertext at rest |
| 4 | A single encrypted JSON-blob column round-trips (encrypt on write, auto-decrypt on read) | crypto-local.js classification rule 188-207; existing raw_response/activity_timeline/signature_patterns blobs; NEVER_AUTO_DECRYPT holds only vector cols |
| 5 | Backup includes a new table automatically (whole-file) | src/account/backup.js:44-48 (`src.backup(destPath)`, no table list) |
| 6 | vault-import needs an explicit `run('table', …)` line; re-encrypts via rawQuery | src/ingest/vault-import.js:115 (`run` helper) + 119-176 (explicit per-table list) |
| 7 | Dynamics scalars are SEC-3 encrypted, written by cluster.py Step 2 before describe Step 3 | crypto-local.js territory_profiles ['energy','coherence','velocity','current_vitality','point_delta']; pipeline/run-clustering.sh Step 2 (cluster.py) precedes Step 3 (describe) — read this session |
| 8 | "change over time" is already logged for structure/metrics (don't rebuild) | cluster_events (cluster.py:1353), territory_lineage (cluster.py:2029), *_snapshots, person_claim_snapshots — sweep-cited, schema read in migrations/0001_init.sql |
| 9 | Pipeline is single-flight (seq race unreachable) | src/jobs.js runningJobId guard (verify:generate G6d); chronicleChildRunning flag (this session) |

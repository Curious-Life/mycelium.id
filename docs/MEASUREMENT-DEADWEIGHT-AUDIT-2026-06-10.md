# Measurement-layer dead-weight audit — 2026-06-10

Pre-deletion caller audit (`/pre-deletion-caller-audit`) for three findings from the
2026-06-10 decrypted audit of the live measurement layer: (1) `cognitive_metrics_per_territory`
+ `topology_metrics` look like 0-row schema vestiges, (2) the `realms` table accumulates
stale rows (no dissolution concept), (3) `realms.territory_count`/`message_count` are 0
for every row (no writer).

## TL;DR — verdicts

| Finding | Verdict | Action |
|---|---|---|
| `cognitive_metrics_per_territory`, `topology_metrics` (0 rows) | **KEEP — not dead.** They are (a) live v4 canonical-import restore targets and (b) spec-designated homes for planned metrics | Documented here; falsifiable revisit criteria below |
| Stale `realms` rows (21 of 23 had no live points) | **PRUNE on re-cluster** | `pipeline/cluster.py` now deletes realm rows with no live `clustering_points`, in the same block that marks dissolved territories |
| `realms.territory_count`/`message_count` always 0 | **MAINTAIN** | `pipeline/describe-clusters.js` now computes both from live `clustering_points` in its upsert (insert + conflict-update) |

New gate: `npm run verify:realm-prune` (in the full `npm run verify` chain). GO at time of writing.

## Finding 1 — the two "dead" tables must stay

### Step 1-2: caller inventory + classification

`cognitive_metrics_per_territory`:

| # | Reference | Status | Notes |
|---|---|---|---|
| 1 | `migrations/0001_init.sql:372,1868` | (O) | Schema + index; migrations re-exec on every boot (no version tracking — `src/db/migrate.js`), so a DROP would need a new always-run guarded migration |
| 2 | `src/ingest/vault-import.js:242` | **(N) — live writer** | v4 canonical-export restore: `m.cognitiveMetrics?.perTerritory`. The canonical exporter DOES export this key (`reference/server-routes/portal-export-import.js:737`) |
| 3 | `src/crypto/crypto-local.js:516` | (O) | Encryption policy (recurrence intervals classified sensitive) — required the moment rows land via import |
| 4 | `docs/COGNITIVE-MEASUREMENT-SPEC-2026-06-04.md:411` | (O) | Spec §4.4 `territory_recurrence_interval` (Tier 0, STUB) names this table as its schema home |

`topology_metrics`:

| # | Reference | Status | Notes |
|---|---|---|---|
| 1 | `migrations/0001_init.sql:1536,1962` + `migrations/0008_metrics_language.sql:9` | (O) | Schema + ALTER (adds `language`); 0008 re-runs guarded on every boot |
| 2 | `src/ingest/vault-import.js:243` | **(N) — live writer** | v4 restore: `m.cognitiveMetrics?.topology`; canonical exports it (`reference/...:743`) |
| 3 | `scripts/verify-measurement-schema.mjs:34` | **(N) — verify-gate reader** | S3 asserts `topology_metrics.language` exists; dropping the table fails `verify:measurement-schema` |
| 4 | `src/crypto/crypto-local.js:543` | (O) | Encryption policy; `topology_audit_snapshots` policy comment explicitly says it "mirrors topology_metrics' classification" |
| 5 | `docs/COGNITIVE-MEASUREMENT-SPEC-2026-06-04.md:727` | (O) | topology-graph family (§4.15-4.17, 4.29 — 0 built) lists "topology_metrics table" as its pipeline target |

### Why the original audit read them as dead

No **local pipeline** stage writes them — true. V1 grows `topology_audit_snapshots`
(22 rows live; same column set) via `pipeline/topology-audit.js` instead. But "no
writer in pipeline/" missed the import path: the full-continuity receiver
(PR #143/#146 — the entire point of `feat/vault-import-chronicles`) restores both
tables from a canonical v4 export, and the user's first real canonical-export import
is the branch's remaining proof. Dropping them would regress exactly the
"is everything preserved?" guarantee that just shipped.

### Falsifiable criteria to revisit the drop

Drop becomes safe only when ALL hold:
1. The canonical-export import surface is retired, OR the canonical exporter
   versions past these keys (then `vault-import.js:242-243` rows become (D)).
2. Spec §4.4 + the topology-graph family land in a different table, or are descoped
   in a spec revision.
3. `verify:measurement-schema` S3 is updated in the same PR.
4. Live query `SELECT COUNT(*) FROM <table>` = 0 — i.e. no real import ever populated
   them (if an import did, dropping destroys user history → migrate, don't drop).

## Finding 2 — stale realms: prune on re-cluster (SHIPPED)

### Evidence (live vault, read-only, 2026-06-10)

```
realms total:                23
live realm_ids (points):     [0, 22]
stale rows:                  21  (realm_id 1..21)
territory_count = 0:         23 / 23
message_count   = 0:         23 / 23
```

### Why stale rows are harmful (reader inventory)

| Reader | Effect of ghost rows |
|---|---|
| `src/search/d1-loader.js:52` + `src/search/index.js:240` (`structure()`) | Ghosts indexed + returned; territories filter `dissolved_at IS NULL` one line up — realms had no equivalent |
| `src/portal-mindscape.js:216` (`GET /mindscape/realms`) | Returns all rows raw |
| `src/portal-compat.js:148,206` (`realm_count`) | Reported 23 instead of 2 |
| `src/db/profiles.js:219-224` (`publicRealms`) | **Ghost realm names leaked into the public realm-name list** |
| `src/db/search.js:71` (`matchRealms`) | Ghost centroids still match semantic search |

### Fix shape — DELETE, not `dissolved_at`

Territories get `dissolved_at` because lineage/identity-inheritance reads dissolved
rows (`territory_lineage`, `predecessor_ids` — `pipeline/cluster.py:1988-2030`).
Realms have no lineage machinery, and `cluster.py` already **computed** realm
`dissolved` events (`stabilize_ids` → summary print) without acting on them.
`realm_neighbors` already uses wipe-and-rebuild each run (`cluster.py:1589`).
Realm names/essences regenerate every Describe pass — nothing irreplaceable in a
ghost row.

Shipped in `pipeline/cluster.py` (after the dissolved-territories block): delete
realm rows whose `realm_id` is not in this run's live set. Fail-closed: never on
`--dry-run`, never when the run produced no live realms.

**Not a migration:** `applyMigrations` re-execs every file on every boot (no version
tracking), so a data-DELETE migration would be a recurring boot job, not a one-time
prune. The 21 live-vault ghosts disappear on the next Generate.

## Finding 3 — realms counters: maintain, don't drop (SHIPPED)

Readers that consumed the zeros: `src/search/index.js:163,240` (corpus **ranked** by
`message_count` — zeros = arbitrary order under the LIMIT 100), `src/db/search.js:84`,
`src/db/mindscape.js:96` (`getRealms` → portal), `src/portal-mindscape.js:160`
(fallback only — shadowed by live counts; the shadow stays as belt-and-braces).
Dropping the columns would touch 5+ read sites and diverge from `semantic_themes`
(same columns, populated by canonical import). Maintaining them fixes every reader.

Shipped in `pipeline/describe-clusters.js`: the realm upsert now computes
`message_count` (live points) + `territory_count` (distinct `territory_id >= 0`)
per realm and writes both on insert AND conflict-update. Both columns are plaintext
by design (SQL `ORDER BY` ranking key — same operator decision as
`territory_profiles.message_count`, see `docs/MEASUREMENT-LAYER-HANDOFF-2026-06-04.md` §6).

## Verification ledger

- [✓] `verify:realm-prune` (new) — counts on insert + conflict-update; prune deletes ghost keeps live; counters plaintext at rest, name still ciphertext → GO
- [✓] `verify:search` — 39/39 GO (realms search corpus unchanged)
- [✓] `verify:portal-mindscape` — GO (aggregator + panels)
- [✓] `verify:vault-import` — GO (restore targets untouched)
- [✓] `verify:measurement-schema` — GO (`topology_metrics.language` still asserted)
- [✓] `verify:generate` — GO (job lifecycle)
- [✓] `py_compile pipeline/cluster.py` + `node --check pipeline/describe-clusters.js`
- [—] Live-vault proof: next real Generate run must log `Pruning 21 stale realm rows` and leave `SELECT COUNT(*) FROM realms` = live realm count, with non-zero counters. (Pipeline runs are user-triggered; not run against the live vault in this session.)

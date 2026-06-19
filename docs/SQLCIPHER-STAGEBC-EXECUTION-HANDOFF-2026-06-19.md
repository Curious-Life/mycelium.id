# SQLCipher Stage B/C — execution handoff
**Date:** 2026-06-19
**Branch / worktree:** `feat/sqlcipher-stageBC-content` · `mycelium-id-worktrees/sqlcipher-stageBC`
**PR:** [#329](https://github.com/Curious-Life/mycelium.id/pull/329) (sequential per-cut commits; SECURITY-SENSITIVE → human review, NO auto-merge)
**Design (ground truth):** [`DESIGN-sqlcipher-stageBC-content-2026-06-19.md`](DESIGN-sqlcipher-stageBC-content-2026-06-19.md) (v3, sweep-verified)
**Audience:** the session continuing the collapse. **Read the design first, then this.**

---

## TL;DR — where it stands

The collapse removes the redundant per-field AES-GCM envelope on content, leaving content **plaintext-inside whole-file SQLCipher** (mandatory at-rest since #299). It's shipped as **sequential per-cut commits on one PR** (#329).

| Cut | Tables | Commit | Status |
|---|---|---|---|
| design v3 | — | `44c1985` | ✅ on branch |
| **1 — hot-path content** | documents (title/summary/metadata), realms, semantic_themes, theme_cards, territory_profiles narrative | `2f2a1b4` | ✅ built + verified |
| **2 — topology metrics** | territory_profiles scalars+centroids, territory_cofire, territory_neighbors, territory_vitality | `643c43a` | ✅ built + verified |
| **3 — claims + people** | person_claims, person_claim_snapshots, people | `dcb7b93` | ✅ built + verified (incl. the verify:leak reframe) |
| 4 — bulk content | messages + facts/entities/wealth/health/tasks/reflections/chronicles/attachments/folders/note_links/activity_sessions/internal_model_items/agent_*/connectors/ai_providers/… | — | ⏳ next |
| 5 — Python-only metrics | cognitive_metrics_{anchor,behavioral,coherence,criticality,harmonic}, fisher_*, frequency_snapshots, cognitive_events, complexity_snapshots, topology_metrics | — | ⏳ |
| 6 — finalize | ENCRYPTED_FIELDS → {secrets}; scope-guardian no-op; the SQL restores; VACUUM | — | ⏳ |
| **LIVE backfill campaign** | run all `content.*` targets on the real vault | — | ⏳ operator-gated |
| **SQL-restore cut** | topology.js/territory-docs.js/claims.js JS-sort → SQL; people.js ON CONFLICT | — | ⏳ AFTER backfill |

**Felt win lands only after the LIVE backfill** converts existing envelope rows. Cuts 1-2 stop the *writes* + reframe the gates; the existing rows stay envelopes (read-safe, lazy) until the campaign runs. On-disk size won't shrink until `VACUUM`.

---

## The mechanism (how every cut works — reuse this)

1. **Stop-write** — shrink/empty the table's `ENCRYPTED_FIELDS` entry in `src/crypto/crypto-local.js`. Verify the WRITER first: JS-adapter-written (incl. bridge `d1_batch_encrypted`) → the map shrink stops it; **Python caller-encrypt** (`stage_crypto.enc`/`_enc`/`encrypt_str` in `pipeline/compute-*.py`) → must ALSO drop that `_enc()` in lockstep (cut 5). Wrong side = column stuck mixed forever.
2. **Backfill target** — add a named entry to `BACKFILL_TARGETS` in `src/portal-mindscape.js`. Use the multi-column form `{ table, columns:[...], codec:{kind:'content'} }` (vectors use `{kind:'vector',dim}`). `expandBackfillTargets()` expands it server-side; the NAME gates (fail-closed), columns are server-defined.
3. **Gate reframe (ATOMIC with step 1)** — any gate that *writes* a now-plaintext column AND asserts envelope-ness breaks the instant the column leaves the map. Invert it: "ciphertext-at-column" → "plaintext-in-cipher". Where the seed value is known, assert it *positively* (`raw.includes('0.91')` / `=== 'Old Name'`) — a STRONGER test; else use the inline `isEnvelope` helper and assert `!isEnvelope(v)`. Keep the functional read/sort assertions (they work identically on plaintext). **Find breakers by running every gate that references the cut's tables** (don't trust static analysis alone — `verify:themes` T7's wording slipped a grep).
4. **Verify** — run the touched JS gates + the floor (`verify:secrets`/`:at-rest`/`:leak`) + `verify:backfill`. Push; CI runs the authoritative full chain (Python gates only run in CI — the bare worktree has no venv, so they crash locally; that is NOT a regression).

**SQL restores are deferred.** `ORDER BY energy DESC` is only live-correct once `energy` is 0-envelopes. So readers keep their mixed-tolerant JS-sort through cuts 1-5; the SQL restore is its own cut AFTER the live backfill. Cut 1 needed none (Library list already SQL on plaintext keys).

---

## Cut 3 — claims + people (NEXT). Pre-analysis.

**Tables/columns** (`crypto-local.js`): `person_claims: [claim_type, content, confidence_logodds, decay_class, support]` (NOTE: `embedding_768` stays in NEVER_AUTO_DECRYPT — untouched); `person_claim_snapshots: [confidence_logodds, content, evidence_count, delta_kind]`; `people: [name, aliases, description, metadata, email, phone, company, position, linkedin_url, notes, avatar_url]`.

**Writers** — verify with `grep -rln "INTO people\|people SET" src/ pipeline/`. people is JS (`src/db/people.js`); claims via `src/db/claims.js` / `src/claims/`. Likely all adapter-written (no Python `_enc`) — confirm.

**⚠️ THE SECURITY-CRITICAL REFRAME — `verify:leak`.** `scripts/verify-leak.mjs` boots a **PLAINTEXT** better-sqlite3 DB (`:19-20`) and plants tokens in facts/messages/**entities**/**people**, then scans the raw file bytes asserting absence. people tokens (`people_name`/`_email`/`_phone`/`_company`/`_linkedin`) are seeded via `people.upsert` (`:57-60`). The moment `people` leaves the map, those tokens appear in the plaintext test DB → **verify:leak fails**. Its premise ("field-encryption is the only thing hiding plaintext") died with Stage 0. **Reframe:** boot the leak gate's vault **keyed** (mirror `verify-at-rest.mjs` A7's `boot({...at-rest...})`), keep the token scan, assert tokens are absent from the now-CIPHERTEXT file. Invert the integrity check at `:96` (a plaintext id is NO LONGER in a ciphertext file → assert "readable through the keyed connection" instead). KEEP the fail-closed parser checks (`:67-74`) + guardian scrubbers (`:81-83`) + DB-COL guard (`:88`) — narrow the token scan to `secrets` + the keyed-vault proof. This reframe also covers cut 4's facts/entities/messages tokens, so **do it in whichever cut first removes any of {facts, entities, messages, people} from the map** (i.e. cut 3). Until then leak stays green (those tables still encrypted).

**people SQL restore** (deferred to the post-backfill restore cut): plaintext `name` + `UNIQUE(user_id, name)` + `ON CONFLICT(user_id, name) DO UPDATE`; drop `loadNameIndex`/JS dedup (`people.js:26-48`). Migration runs AFTER `name` is backfilled + de-duped (merge same-name rows first).

**Other cut-3 gates** to check (run them): `verify:claims`, `:claims-rest`, `:claims-discovery`, `:managed-claim`, `:context`, `:related`. Find any that assert claims/people columns are envelopes and invert.

## Cut 4 — bulk content
messages (`content/thinking/tags/entities/entity_summary/suggested_new_tag/relations/metadata/nlp_error`) + the long tail: documents remainder (`content/tags/entities/relations/entity_summary/source_path`), facts, entities, attachments, clustering_points, territory_river_cache, agent_events/tasks/customizations, wealth_*, health_daily, activity_sessions, internal_model_items, reflections, tasks, folders, note_links, entity_snapshots, user_identities, provisioning_jobs, time_chronicles, current_arc_chronicles, contact_chronicles, territory_pass_notes, space_rooms, space_knowledge, share_links, **ai_providers (credentials), connectors, scheduled_tasks, conversation_summaries, peer_messages, sharing_contexts, inbound_shares, channel_access**.

**CREDENTIALS DECISION (resolved — collapse them too):** `ai_providers.credentials` (BYOK API keys), `connectors`, `scheduled_tasks.prompt` etc. are USER_MASTER-encrypted. Keeping them field-encrypted adds NO protection beyond whole-file SQLCipher — the field DEK is wrapped by the SAME USER_MASTER that opens the file (attacker-with-file-but-no-key → whole-file already protects; attacker-with-key → derives the field DEK anyway). The ONLY table with a genuinely separate key is `secrets` (SYSTEM_KEY) → that alone stays. So collapse credentials with the rest. (If you later want SYSTEM_KEY-grade separation for BYOK keys, MOVE them into `secrets` — a separate change, not this collapse.)

`messages.content` is the LARGEST backfill. Gate breakers to invert (run each table's gates to confirm): `verify:health-encryption` HE1; `verify:import` I2, `:obsidian` O2, `:obsidian-images` I4, `:full-export-import` F7, `:frequency` FQ0 (all assert `messages.content` envelope); `verify:entities` EN4/EN15 (entities.name); `verify:facts`; `verify:providers-leak`/`:connectors*` (ai_providers/connectors — verify these don't assert the credential blob is an envelope in a way that should now invert, AND that no plaintext-credential-in-HTTP-response check breaks — egress redaction is separate from at-rest). `verify:mindfiles` M7 (documents.content). Run ALL gates referencing each table; reframe atomically.

## Cut 5 — Python-only metrics (the lockstep Python edit)
Drop the caller-encrypt in `pipeline/compute-{frequency,criticality,coherence,behavioral,anchor,fisher}.py`, `compute_information_harmonics.py`, `compute-cross-scale-coupling.py` (the `stage_crypto.enc`/`_enc` wrappers). Tables: cognitive_metrics_*, fisher_trajectory/milestones, frequency_snapshots, cognitive_events, complexity_snapshots, topology_metrics. Invert the `isEnvelope` side-gates: `verify:complexity` C3, `:frequency` FQ3, `:criticality` C7, `:coherence`, `:behavioral`, `:vitality` (already done in cut 2 for territory_vitality — these are the cognitive_metrics_* ones), `:fisher-encryption` FE1, `:harmonics-encryption`, `:pipeline-cli-encryption` (cofire/neighbors already done cut 2; check for metrics asserts), `:measurement-schema` S5, `:history` H6 (entity_snapshots — actually that's a payload, check), `:topology-audit` A3/A4. Python decrypt-on-read stays (`stage_crypto.dec` dual-reads) for the mixed window.

## Cut 6 — finalize
- Shrink `ENCRYPTED_FIELDS` to `{secrets}` exactly (remove all now-empty entries).
- Neutralize scope guardians for content (keep `secrets` tagging).
- Land the SQL restores (topology.js / territory-docs.js / claims.js / people.js) — but ONLY after the live backfill confirms 0 envelopes in those columns. Golden-diff each restored query vs the old JS-sort on a real-vault clone.
- `VACUUM` to reclaim the envelope overhead (size shrink).
- Full `npm run verify` green; floor (`secrets`/at-rest/leak-reframed) intact.

---

## LIVE backfill campaign (operator-gated — the felt win)
Once the code cuts are merged + the app rebuilt from main:
1. **Clone-test first** on a copy of the real vault (the campaign rewrites data). Measure Library cold-open + Mindscape render before.
2. Trigger per named target (loopback only):
   ```
   curl -s --max-time 600 -X POST http://127.0.0.1:8787/api/v1/portal/mycelium/backfill \
     -H 'content-type: application/json' \
     -d '{"confirm":true,"targets":["content.documents","content.realms","content.semantic_themes","content.theme_cards","content.territory_profiles_narrative","content.territory_profiles_scalars","content.territory_cofire","content.territory_neighbors","content.territory_vitality"]}'
   ```
   (the synchronous pre-campaign backup blocks the HTTP response on a 2GB vault → curl may time out while the job runs; poll job status / check for the `.pre-backfill` file. The job asserts 0 envelopes per column + purges the backup only on a clean run.)
3. Re-measure. `VACUUM` for the size win. Then land the SQL-restore cut.

GOTCHAS (from the Stage-A campaigns): launch `/Applications/Mycelium.app` by explicit path (not the iCloud build-output bundle → white screen); keyed boot ~90s warmup before :8787 binds; the bare worktree has no python venv (CI green).

---

## Pickup protocol
1. Read the design v3 + this handoff cold.
2. `cd mycelium-id-worktrees/sqlcipher-stageBC`; confirm `git log` shows `643c43a` (cut 2); rebase onto origin/main if it moved.
3. Confirm #329 CI is green for cuts 1-2 before stacking cut 3.
4. Cut 3: verify people/claims writers (grep) → stop-write → backfill targets → **reframe verify:leak to keyed (the security-critical step above)** + run all claims/people gates to find other breakers → invert → `node --check` + run touched gates + floor + backfill → commit + push.
5. Repeat for cuts 4-6. Each: stop-write + targets + atomic gate reframe + verify. SQL restores + VACUUM last, after the live backfill.
6. `node_modules` is symlinked from the main tree (`ln -s …/mycelium.id/node_modules`); python gates only pass in CI.

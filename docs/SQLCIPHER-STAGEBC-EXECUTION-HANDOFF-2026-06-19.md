# SQLCipher Stage B/C — execution handoff
**Date:** 2026-06-19
**Branch / worktree:** `feat/sqlcipher-stageBC-content` · `mycelium-id-worktrees/sqlcipher-stageBC`
**PR:** [#329](https://github.com/Curious-Life/mycelium.id/pull/329) (sequential per-cut commits; SECURITY-SENSITIVE → human review, NO auto-merge)
**Design (ground truth):** [`DESIGN-sqlcipher-stageBC-content-2026-06-19.md`](DESIGN-sqlcipher-stageBC-content-2026-06-19.md) (v3, sweep-verified)
**Audience:** the session continuing the collapse. **Read the design first, then this.**

---

## ▶ START HERE (cold pickup) — orient in 4 commands

```bash
cd /Users/altus/Documents/GitHub/mycelium-id-worktrees/sqlcipher-stageBC
git fetch origin -q && git log --oneline -1            # expect 2b4c144 (or later); rebase onto origin/main if it moved
git status --short                                      # expect clean
[ -e node_modules ] || ln -s /Users/altus/Documents/GitHub/mycelium.id/node_modules ./node_modules
gh pr checks 329                                         # cuts 1-3 = green; PR #329 OPEN + CLEAN
```

**State (2026-06-19 late):** Cuts **1, 2, 3, 4 DONE + pushed** on PR #329; merged `origin/main` into the branch (merge `a6a80fa`, clean) so the branch is current. Cut 4 = `766cea0` (43 tables collapsed + 40 backfill targets + 21 gate inversions + verify-leak pivot + foundation B6 reframe); 22/22 touched JS gates GO locally; **CI verifying the full suite (incl. Python gates).** **Next = cut 5 (Python metrics caller-encrypt drop), then cut 6 (finalize: shrink ENCRYPTED_FIELDS to {secrets}, SQL restores, VACUUM), then the operator-gated live backfill.**

**CUT 4 LEARNINGS (critical for cut 5/6):**
- **Two test-harness DB modes — check which before inverting.** Gates that boot a **KEYED** vault (`startRestServer`/`boot` with at-rest) and scan **file bytes** (`readFileSync`) are testing **whole-file SQLCipher** (verify:at-rest), NOT field encryption → they PASS after a field collapse, **leave them** (import, obsidian, obsidian-images I4). Gates that boot **plaintext** + read the **column value** (isEnvelope/looksEncrypted) ARE field-encryption tests → **invert** to plaintext-in-cipher.
- **WAL gotcha:** `readFileSync(DB)` reads only the MAIN db file; freshly-written data sits in the un-checkpointed **-wal** → a "plaintext present in file" assertion is unreliable. Don't assert file-bytes-PRESENT; assert the **column reads back the plaintext** (leak/providers/connectors-store scan db+wal+shm so their absence-checks are fine).
- **foundation B6 reframed:** content's wrong-key protection is now whole-file SQLCipher (verify:at-rest); B6 retargeted to `secrets` + a WRONG SYSTEM_KEY (genuine defense-in-depth — secrets uses a SEPARATE key). `secrets.id` is INTEGER autoincrement + `secrets.key` is encrypted → seed without id, query by `user_id`.
- **verify-leak pivoted to `secrets`** (only field-encrypted table left): seeds a SYSTEM_KEY secret, scans absence, fail-closed parser checks retargeted to `secrets.value`.
- **Python gates NO-GO locally = no venv** (anchors, embedding-novelty, frequency FQ1+) — NOT the collapse; CI authoritative. Confirmed no Python gate asserts envelope-ness on a cut-4 column (they assert cut-5 metric columns, still encrypted, + read cut-4 via dual-read).

**The mechanism is PROVEN over 3 cuts — apply it verbatim to cut 4:**
1. **Verify the writer** for each table: `grep -rln "INTO <t>\|UPDATE <t>" src/ pipeline/`. JS-adapter-written (incl. `d1_batch_encrypted`) → the map shrink stops it. Python caller-encrypt (`stage_crypto.enc`/`_enc` in `compute-*.py`) → must ALSO drop that in lockstep (that's cut 5's nature; cut-4 tables are all JS).
2. **Stop-write**: empty/shrink the table's `ENCRYPTED_FIELDS` entry in `src/crypto/crypto-local.js` (with a collapse-note comment).
3. **Backfill target**: add a multi-column `content.<table>` entry to `BACKFILL_TARGETS` in `src/portal-mindscape.js` (codec `{kind:'content'}`).
4. **Find gate breakers by RUNNING** every gate that references the cut's tables (NOT just grep — wording slips): `for g in <gates>; do npm run verify:$g 2>&1 | grep VERDICT; done`. A gate that writes a now-plaintext column AND asserts envelope-ness breaks instantly.
5. **Invert atomically** (same commit): "ciphertext-at-column" → "plaintext-in-cipher". Where the seed value is known, assert it POSITIVELY (`raw.includes('0.91')`/`=== 'Old Name'`) — stronger than the old negation; else inline `isEnvelope` and assert `!isEnvelope(v)`. Keep functional read/sort assertions (work identically on plaintext). For `verify:leak`-style per-field-leak gates, NARROW the token scan (drop the now-plaintext table's tokens; keep the still-encrypted ones) — do NOT boot keyed.
6. **Verify**: `node --check` the edited files; run the touched JS gates + floor (`verify:secrets`/`:at-rest`/`:leak`) + `verify:backfill`; all GO. Python gates crash locally (bare worktree has no venv — NOT a regression); CI runs them.
7. **Commit + push** to the same branch (one commit per cut). CI re-runs the authoritative full chain. NO auto-merge (security-sensitive).

**Cut 4 specifics + the resolved credentials decision are in the "Cut 4" section below.** SQL restores + VACUUM + the live backfill come AFTER all code cuts (ordering law).

---

## TL;DR — where it stands

The collapse removes the redundant per-field AES-GCM envelope on content, leaving content **plaintext-inside whole-file SQLCipher** (mandatory at-rest since #299). It's shipped as **sequential per-cut commits on one PR** (#329).

| Cut | Tables | Commit | Status |
|---|---|---|---|
| design v3 | — | `44c1985` | ✅ on branch |
| **1 — hot-path content** | documents (title/summary/metadata), realms, semantic_themes, theme_cards, territory_profiles narrative | `2f2a1b4` | ✅ built + verified |
| **2 — topology metrics** | territory_profiles scalars+centroids, territory_cofire, territory_neighbors, territory_vitality | `643c43a` | ✅ built + verified |
| **3 — claims + people** | person_claims, person_claim_snapshots, people | `dcb7b93` | ✅ built + verified (incl. the verify:leak reframe) |
| 4 — bulk content | messages + facts/entities/wealth/health/tasks/reflections/chronicles/attachments/folders/note_links/activity_sessions/internal_model_items/agent_*/connectors/ai_providers/… (43 tables) | `766cea0` | ✅ DONE (22/22 JS gates GO; CI verifying) |
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

### Cut-4 sweep — VERIFIED 2026-06-19 (pre-execution, sweep-first)

**Writer boundary (Sweep B — RESOLVED): every cut-4 table is JS-adapter-written or dead/import-only. ZERO Python caller-encrypt paths.** So cut 4 = pure `ENCRYPTED_FIELDS` shrink (+ backfill targets + gate reframes) — **no Python edits** (those are exclusively cut 5). The one Python *writer*, `agent_events` via `pipeline/event_emit.py:69`, INSERTs **plaintext** JSON and relies on the JS adapter to auto-encrypt → removing it from the map lands plaintext correctly. `entities` and ~10 long-tail tables read "no JS writer found" in the sweep (Explore reads excerpts) — irrelevant to the cut: removing from the map is safe whether live-written or import-only; backfill converts any existing envelope rows.

**`ENCRYPTED_FIELDS` ground truth (Sweep A — crypto-local.js):** every cut-4 table is still present with columns (none pre-emptied). `secrets`=`['key','value','description']` is the lone `SYSTEM_KEY_TABLES` entry and is the ONLY table that stays field-encrypted. `SCOPE_AWARE_TABLES` (crypto-local.js:676) is INDEPENDENT of `ENCRYPTED_FIELDS` — scope tagging survives the collapse untouched (scope is a plaintext routing column); do NOT touch it in cut 4. Vector columns (`embedding_768`/`nomic_embedding`/`anchor_vector`) are already in `NEVER_AUTO_DECRYPT_COLUMNS` (Stage A) — `clustering_points.content` collapses, its `nomic_embedding` is already raw.

**EXHAUSTIVE gate breakers to INVERT (verified by grep + read, NOT just the sweep — the Explore sweep missed 7 of these):**

| Gate | Assertion | Table.column | Action |
|---|---|---|---|
| `verify-facts` | FA4 (value envelope) | facts.value | invert → plaintext |
| `verify-entities` | EN4 :44 (name envelope); re-check for an EN15 | entities.name | invert → plaintext |
| `verify-frequency` | FQ0 :73 (`isEnvelope(m.content)`) | messages.content | invert |
| `verify-import` | I2 :94 (no plaintext in db file) | messages.content | invert |
| `verify-ingest` | I2 :52 (raw content envelope) | messages.content | invert |
| `verify-obsidian` | O2 :73 (note content at rest) | messages.content | invert |
| `verify-obsidian-images` | I4 :105 (note text — **image BYTES are a separate MYCB blob, keep that half**) | messages.content | partial invert |
| `verify-mindfiles` | M7 :108 (documents.content envelope) | documents.content | invert |
| `verify-harness-channel-dal` | D1 :56 (content ≠ plaintext) | messages.content | invert |
| `verify-health-encryption` | HE1 :45 (steps/hrv envelope) | health_daily | invert |
| `verify-territory-river-cache` | #2 :87 (payload envelope) | territory_river_cache.payload | invert |
| `verify-channel-access` | A13 :67 (allowed_senders_json envelope) | channel_access | invert |
| `verify-harness-channel-compaction` | H3 :62 (summary at rest) | conversation_summaries.summary | invert |
| `verify-connector-upsert` | clustering_points content at-rest (:4 comment → find assert) | clustering_points.content | invert |
| `verify-connectors-store` | S3 :102 (account_label/last_error/recent_runs envelopes) | connectors | invert |
| `verify-connectors` | C4 :76 (message contentLeak) | messages.content | invert; **C3 :71 token is in `secrets` → KEEP** |
| `verify-providers-leak` | PV2 :34 (apiKey absent from raw bytes) + PV3 :39 (`looksEncrypted(rawCred)`) | ai_providers.credentials | **invert both** to plaintext-in-cipher; **PV4 list-omits + PV5 round-trip KEEP** (egress/read-path) |
| `verify-leak` | T-map tokens fact_value/msg_content/entity_name/entity_summary | facts/messages/entities | **PIVOT (below)** |

**`verify-leak` pivot — FEASIBLE + decided.** After cut 4 NO content table is field-encrypted; only `secrets` remains. The token-scan loop would empty out. **Pivot:** drop the 4 content tokens from `T`; seed a `secrets` row via `db.secrets.set(uid,{key,value,scope,description})` (API confirmed at `verify-secrets.mjs:43`) with a distinctive token; keep the raw-byte scan asserting that token is ABSENT (secrets stays SYSTEM_KEY-encrypted → ciphertext in the plaintext test DB). Keep the scan-integrity check (a plaintext id IS present), the fail-closed parser checks (`:57-64`), guardian scrubbers (`:67-74`), DB-COL guard (`:77`). This preserves verify-leak's unique value (raw-byte scan + parser fail-closed + guardians, none of which `verify-secrets` covers) targeted at the one remaining field-encrypted table.

**Same reframe shape as cut 3:** `verify-leak` + `verify-providers-leak` both boot a **plaintext** better-sqlite3 DB; their at-rest-confidentiality premise for collapsed columns moves to whole-file SQLCipher (`verify:at-rest`). Invert with an inline comment pointing there (mirror the cut-3 claims/leak reframe).

**KEEP (NOT breakers, confirmed by read):** `verify-secrets` (secrets stays), `verify-attachment-context` (HTTP egress, not at-rest), `verify-channel-egress` ("envelope-dedup" = message dedup, unrelated to encryption), `verify-gateway`/`verify-mcp` (response envelopes), `verify-search`/`verify-search-rehydrate` (decrypt-on-read), `verify-backfill` (exercises the engine on its own scratch table). `verify-full-export-import` :116 is a **vector dual-read** comment, not a content-at-rest assert — confirm no F7 content-envelope assert exists before assuming it breaks. `verify-fisher-encryption` FE3 + all cognitive_metrics_*/complexity/topology_audit asserts are **cut 5**.

**Backfill targets (add to `BACKFILL_TARGETS`, all `codec:{kind:'content'}`):** one `content.<table>` entry per cut-4 table with its full column list from `ENCRYPTED_FIELDS` (Sweep A list). Add targets for ALL of them incl. the "dead/import-only" tables — existing rows may hold envelopes from prior imports.

## Cut 5 — Python-only metrics (the lockstep Python edit) — SWEEP-VERIFIED 2026-06-19

**THE WORK = drop the Python caller-encrypt. No JS source/map edits in cut 5** (no JS writes these tables; the JS map entries get emptied in cut 6 — reads tolerate plaintext via `isEncrypted` value-shape). `stage_crypto.py` + `crypto_local.py` STAY (`dec()` is needed for reads + other services).

**Load-bearing assumptions — VERIFIED:**
- **Write path is RAW (no auto-encrypt).** Every metric script writes via `d1_client.query()` → `_post("/query", …)` (`pipeline/d1_client.py:118`) — the raw bridge endpoint (A7-raw proves `/query` does NOT auto-encrypt). So the Python `.enc()`/`_enc()` is the ONLY encryption on these columns → **dropping it yields plaintext**. (NOT `/batch_encrypted`.)
- **Dual-read holds.** `stage_crypto.dec()` (`pipeline/stage_crypto.py:61-68`) returns a non-envelope value UNCHANGED → after writers stop encrypting, reads pass plaintext through; old envelope rows still decrypt. No reader change.
- **No raw-bytes/bridge-blob blocker.** Metrics are scalars/JSON strings (not raw float bytes like the vectors), so the JSON `/query` bridge carries plaintext fine — unlike the cluster.py nomic case that was deferred.
- **No JS writers** for any cut-5 table (all are Python-written or unwritten); `cognitive_metrics_window/trajectory` have NO writer at all (likely legacy/aggregate — their map entries are dead, cleaned in cut 6).

**⚠️ REFINED APPROACH (do NOT drop call sites — convert the helper to serialize-only).** `enc()`/`_enc()` do TWO things: (1) numpy-safe **coercion** (`None→None`; `bool→repr(1.0/0.0)`; `str→verbatim`; number→`repr(float(x))` — without this, numpy 2.x stores `'np.float64(x)'` GARBAGE), then (2) `encrypt_str(...)`. Naively replacing `_enc(x)`→`x` at call sites would lose the coercion. Instead, in **3 places** change the helper to RETURN the coerced string `s` and drop the `encrypt_str` call:
- `pipeline/stage_crypto.py` `enc()` (`:39-58`) — covers all 8 `stage_crypto.enc`/`e=` callers.
- `pipeline/compute-frequency.py` local `_enc` (`:79`).
- `pipeline/compute-fisher.py` local `_enc` (`:129`).
Every call site stays `_enc(x)` / `e(x)` but now writes coerced plaintext. VERIFIED every `enc()` caller writes a cut-5-collapsing metric table (`cognitive_anchor_vectors` is the VECTOR store on the Stage-A raw path, NOT an `enc()` target). `dec()` is unchanged (still dual-reads). Keep the name `enc` (renaming touches 8 callers) + a loud comment that it's serialize-only post-collapse; optional rename in cut 6. Per-table call sites below are for the GATE/backfill mapping, not edit targets:


| script | table | enc sites |
|---|---|---|
| compute-frequency.py | frequency_snapshots | `:336-338` (+ local `_enc` `:79`) |
| compute-criticality.py | cognitive_metrics_criticality + cognitive_events | `:173-177`, `:187` |
| compute-coherence.py | cognitive_metrics_coherence | `:116-120` |
| compute-behavioral.py | cognitive_metrics_behavioral | `:152-155` |
| compute-anchors.py | cognitive_metrics_anchor | `:240-247` |
| compute-fisher.py | fisher_trajectory + fisher_milestones | `:433-456` (+ local `_enc` `:129`) |
| compute_information_harmonics.py | cognitive_metrics_harmonic (42 cols) | `:493-514` |
| compute-cross-scale-coupling.py | cognitive_metrics_harmonic (pac/plv/coh + h0_wasserstein) | `:345-355` |
| compute-embedding-novelty.py | complexity_snapshots.embedding_novelty | `:130` |
| compute-embedding-trajectory.py | embedding_trajectory.centroid_drift/dispersion | `:193` |

**Gate inversions (~16 assertions / ~13 files) — invert envelope/at-rest → plaintext-in-cipher; KEEP every structural-plaintext assert (user_id/window_end/granularity/level/window_type/territory_id/era_id/low_confidence):**
`verify-fisher-encryption` (fisher_trajectory+milestones, isEnvelope) · `verify-embedding-trajectory` (centroid_drift/dispersion) · `verify-complexity` (complexity_snapshots) · `verify-frequency` FQ3 (metric cols — FQ0 already done cut 4) · `verify-criticality` (criticality + cognitive_events) · `verify-behavioral` · `verify-cross-scale-coupling` (harmonic coupling) · `verify-harmonics-encryption` (harmonic) · `verify-anchors` (cognitive_metrics_anchor — its A1-A5 NO-GO locally is the no-venv issue, not collapse) · `verify-embedding-novelty` (embedding_novelty) · **NODE-only (run locally before push):** `verify-topology-audit` (snapshots+findings isEnvelope) · `verify-complexity` · `verify-measurement-schema` (cognitive_events marker scan) · `verify-metrics-rest` (`looksLikeCiphertext` envelope scan).

**⚠️ VERIFICATION = CI-ONLY for most of cut 5.** ~10 of the gates SPAWN Python (`compute-*.py`) and the bare worktree has NO venv → they crash locally (NOT a regression — same as cut 4's frequency/anchors). So the loop is: edit Python + gates → run the **node-only** gates locally (topology-audit, complexity, measurement-schema, metrics-rest) → push → **CI verifies the Python gates (~6 min/round)**. This is the slow-paced cut; read carefully before each push. GOTCHA: when removing the local `_enc` helpers, confirm nothing else in the script calls them.

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

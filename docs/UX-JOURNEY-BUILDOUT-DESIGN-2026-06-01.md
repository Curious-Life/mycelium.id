# V1 User-Journey Build-Out — Design (2026-06-01)

> Produced via `/sweep-first-design` (3 sweep cycles + pivots). The goal: make the
> whole journey — **open → (already unlocked) → import data → enrich → generate
> mindscape → explore the described mindscape** — simple, coherent, and seamless,
> with each screen backed by real local data.
>
> **Status:** design locked. Slice 0 (auth) already shipped (#24); the rest is
> phased below. **Audience:** the implementing session.

---

## 0. The coherent journey (the through-line)

A first-time user, end to end, with the seams this build-out removes marked ⟵:

1. **Install + keys (terminal, one-time).** `npm install` → `npm run init-db` →
   `npm run set-keys` (Keychain/1Password) → `npm run portal`. The vault unlocks
   *at boot* from the key source; there is no browser login. *(Structural — see Pivot 1.)*
2. **Open the app.** Lands on `/mindscape`, signed in, **no login wall** ⟵ *(shipped #24)*.
   First run shows a **welcome** ("your vault is empty — import to begin").
3. **Import.** Drag a Claude/ChatGPT/Obsidian export → server detects format,
   parses, stores encrypted, returns counts, kicks enrichment ⟵ *(Phase I)*.
4. **Enrich (background).** `:8095` embeds + tags new messages (`0→2→1`). The UI
   shows "enriching N…" and settles. *(Exists; surface the status — Phase I.)*
5. **Generate mindscape.** One button → runs the clustering pipeline with a
   **progress view**; on completion the mindscape is populated ⟵ *(Phase G)*.
6. **Explore.** The mindscape screen renders realms/territories/3D points from
   real tables; territory cards show name + essence + **chronicle narrative** ⟵
   *(Phase M for read, Phase C for narrative)*.

The seams this removes: the login wall (done), "import does nothing in the UI",
"no way to build the mindscape from the app", "mindscape screen is empty", and
"territories have no story".

---

## 1. Revision history

- **v1 (sketch, pre-sweep):** 5 independent features — onboarding/unlock, import,
  generate, mindscape-read, chronicles — each "wire the screen to an endpoint."
- **v2 (this doc, post-sweep) — two structural pivots:**
  - **🔴 Pivot 1 — "unlock" is not an auth screen.** The server boots *already
    unlocked* (keys from the source at startup; process **exits** on a wrong key —
    boot-time KCV gate) and the REST surface has **no per-request auth**. A browser
    login has nothing to authenticate and V1 has **no `/auth/*` backend**. So
    onboarding becomes a **local auth-shim** (`/auth/session` → signed-in) + a
    **first-run welcome**, *not* a passkey/OAuth ceremony. **Shipped as Slice 0 (#24).**
  - **🔴 Pivot 2 — import needs ported parsers, not just wiring.** The portal posts
    chunked FormData to `/portal/upload[/chunk|/complete]` expecting **server-side
    format detection** (claude/chatgpt/obsidian/linkedin); V1 has only raw
    `/api/v1/upload` + `importMessages`, and the **parsers live only in `reference/`**.
    Import is a real port, phased by format (Claude/ChatGPT first).
  - Minor: generate-pipeline must **re-resolve keys at spawn** (boot exposes only
    `ENCRYPTION_MASTER_KEY=userHex`, not `systemHex`); `db.mindscape`/`territoryDocs`
    are unwired and must be added.

---

## 2. Sweep findings (consolidated, file:line)

**Sweep A — boot/unlock/auth.**
- Keys resolved + unlocked at boot: `src/index.js:51-59` (`resolveKeys` → `unlock`);
  process throws/exits on missing/wrong key (`src/index.js:56-57`, `src/crypto/keys.js:31-39`).
- `boot()` sets `process.env.ENCRYPTION_MASTER_KEY = userHex` (`src/index.js:69`) but
  **returns no keys** (`src/index.js:77` → `{server,db,close,tools,handlers,deferred,userId}`).
- No per-request auth on REST (`src/api.js`, `src/portal-compat.js`); documented
  localhost-only (`src/server-rest.js` SECURITY note).
- Portal expects ~11 `/auth/*` endpoints (`portal-app/src/routes/login/+page.svelte:21,257,351,374,400,425,450,464`);
  none exist in V1 (better-auth at `/api/auth/*`, only on `--http`: `src/server-http.js:73`).
- Root layout bounces to `/login` only when `/auth/session` fails
  (`portal-app/src/routes/+layout.svelte` onMount) — `(app)/+layout.svelte` does **not**
  gate. → **Auth-shim resolves it (shipped).**

**Sweep B — import.**
- Portal posts FormData to `/portal/upload`, `/portal/upload/chunk`,
  `/portal/upload/complete` (`portal-app/src/lib/chunked-upload.ts:74-141`), expects
  `{importResult:{type,imported,skipped,stats,enrichmentJobId}}` (`import/+page.svelte:29-35,109`),
  format detection **server-side**.
- V1 has raw `/api/v1/upload` (`src/api.js:47-67`) + `importMessages` (`src/tools/ingest.js`),
  no `/portal/upload/*`, **no parsers** (parsers only in `reference/server-routes/portal-uploads.js:31-36`,
  importing a non-existent `@mycelium/core/import-parsers.js`).
- Encrypted-at-rest storage path solid: `src/ingest/blob-store.js:36-61` + `src/ingest/upload.js:41-58`.
- Synchronous; no job/enrichmentId concept.

**Sweep C — mindscape read.**
- ~56% of the screen maps to real columns. `src/db/mindscape.js` has
  `getTerritoryProfiles():67`, `getRealms():93`, `getPoints():21` (with `landscape_x/y/z`),
  `getNoiseStats():34`, `getSemanticThemes():115` — **but `db.mindscape` is NOT wired**
  in `src/db/index.js:38-62`.
- `fisher_trajectory` has phase/exploration_ratio (`src/db/fisher.js:99-110`).
- No V1 source for fingerprint (depth/breadth/coherence/exploration), complexity (LZ),
  health summary, `activation.surprise/agents`, `energy`, `growth_state` → graceful-empty.

**Sweep D — generate + chronicles.**
- Subprocess pattern: arg-arrays via `execFile(Sync)` (`src/crypto/key-source.js:24-32`,
  `pipeline/describe-clusters.js:24-58` calls local Claude CLI).
- Orchestrator `pipeline/run-clustering.sh` needs env `USER_MASTER, SYSTEM_KEY,
  MYCELIUM_DB, MYCELIUM_USER_ID`; 5 stages; prints `Step N/5:` lines (parseable).
- **No job/SSE infra in V1** (enrich service is sync `/health` + `/enrich-all`,
  `src/enrich/server.js:98-125`). Reference job-spawner exists
  (`reference/server-routes/portal-mindscape-jobs.js:118-296`: in-memory map, `Step N/M`
  parse, env allowlist, 45-min timeout) — not ported.
- Chronicles: `territory-docs.js:116-161` `upsertDescription` exists but **unwired/dead**;
  `describe-chronicles.js` absent (reference outline in `portal-mindscape-explore.js`);
  inference router `infer({prompt,task})` ready (`src/inference/router.js:84-106`, task
  `narrate` → cloud-if-keyed-else-local).

---

## 3. Verification table (load-bearing assumptions — read myself)

| # | Assumption | Verified at |
|---|---|---|
| 1 | Server boots already-unlocked; exits on wrong key (no runtime unlock) | `src/index.js:51-59`, `src/crypto/keys.js:31-39` (read) |
| 2 | `boot()` exposes `ENCRYPTION_MASTER_KEY=userHex` but not `systemHex` | `src/index.js:69,77` (read) |
| 3 | REST surface has no per-request auth | `src/server-rest.js` (read), `src/api.js` (read) |
| 4 | `(app)/+layout` does not gate; only `api.ts` 401 + root layout `/auth/session` redirect to /login | `portal-app/src/routes/(app)/+layout.svelte:36-46` (read), `portal-app/src/routes/+layout.svelte` onMount (read) |
| 5 | `db.mindscape` + `db.territoryDocs` are NOT wired | `src/db/index.js:38-62` (read) |
| 6 | mindscape read methods exist on the namespace | `src/db/mindscape.js:21,34,67,93,115` (read) |
| 7 | `run-clustering.sh` needs USER_MASTER+SYSTEM_KEY+MYCELIUM_DB+MYCELIUM_USER_ID, prints `Step N/5:` | `pipeline/run-clustering.sh` (read) |
| 8 | describe stage shells local Claude CLI via execFile arg-array | `pipeline/describe-clusters.js:24-58` (read) |
| 9 | `territory-docs.upsertDescription` exists, unwired | `src/db/territory-docs.js:116-161` (sweep), `src/db/index.js` absence (read) |
| 10 | inference router `infer({prompt,task})`; `narrate` cloud-or-local | `src/inference/router.js:84-106` (read) |
| 11 | compat router json-parser must be path-scoped (raw /upload) | proven: verify:rest broke until `/api/v1/portal` + `/auth` prefixes scoped (this session) |
| 12 | import parsers exist only in reference, need `@mycelium/core` shims | `reference/server-routes/portal-uploads.js:26-36` (sweep) |

---

## 4. Threat model / security

- **Auth-shim grants no new access.** The data surface already had no auth and is
  localhost-only by design (Phase 4 adds real auth for networked deploys). The shim
  only stops the UI demanding a login. Accepted.
- **Master keys → pipeline child.** The generate-trigger must **re-resolve keys via
  the key source at spawn** and pass them in the **child's env object** (not args →
  not `ps`-visible; never logged), with an **env allowlist** (PATH/HOME/USER/LANG +
  the two keys + MYCELIUM_DB/USER_ID). Keys are not stored in the server's long-lived
  scope. Mirrors `reference/...jobs.js:169-176`.
- **Single-job concurrency.** A module-level lock prevents two clustering runs racing
  the same SQLite vault.
- **Chronicles → LLM.** `task:'narrate'` may egress to a cloud model **iff** a key is
  configured (BYOK, opt-in); default is local Ollama or the local Claude CLI. Never
  send raw vault plaintext beyond the sampled messages needed to name a cluster;
  document the egress in the audit log. Embedding/plaintext paranoia per CLAUDE.md §7.
- **Import parsing** runs on attacker-influenced files (an export could be malicious):
  parse defensively (size caps, no `eval`, JSON only), store via the existing
  encrypt-at-rest path; never echo file contents in errors (§1 zero-leak).

---

## 5. Phases (each independently shippable + smoke-tested)

> **Slice 0 — local auth-shim + no login wall. ✅ SHIPPED (#24).**
> `src/auth-shim.js` + mount; `verify-portal-data` D9/D10.

### Phase M — Mindscape read (highest impact on what's already generated)
- Wire `db.mindscape` (and `db.territoryDocs`) into `src/db/index.js` (2 lines).
- Add to `portal-compat`: `GET /mindscape/territories|realms|noise-stats|points`,
  `GET /trajectory/summary` (from `db.fisher`), and **graceful-empty** stubs for
  `/mindscape/fingerprint|complexity|exploration-status` + `/health/summary` (`{}`/zeros).
- LOC: ~140 (compat endpoints) + 2 (db wiring). Smoke: `verify:portal-mindscape`
  (seed territory_profiles/realms rows → assert the screen shapes).

### Phase I — Import (port parsers, format-by-format)
- Port a self-contained `src/ingest/import-parsers.js` (no `@mycelium/core` dep):
  `detectExportType(zip)` + `processClaudeExport` + `processOpenAIExport` first;
  `processObsidian` (md folder) + `processLinkedIn` (csv) next.
- Add compat `POST /upload` (single) + `/upload/chunk` + `/upload/complete` (assemble
  → detect → parse → `captureMessage`/`saveDocument` → enqueue enrich), returning
  `{importResult:{type,imported,skipped,stats}}`. Use `jszip` (add dep).
- LOC: ~300 (parsers) + ~120 (endpoints). Smoke: `verify:import` (feed a tiny fixture
  Claude/ChatGPT export → assert counts + rows encrypted at rest).

### Phase G — Generate mindscape (trigger + progress)
- `src/jobs.js`: minimal in-memory job registry (`start/get`, single-flight lock,
  `Step N/5:` stdout parser, 45-min timeout, key re-resolve + env allowlist).
- Compat `POST /mycelium/generate` → `{jobId}`; `GET /mycelium/generate/status/:id`
  → `{status,step,totalSteps,stageLabel}`. Spawns `pipeline/run-clustering.sh`.
- LOC: ~180. Smoke: `verify:generate` (spawn a `--dry-run` of the pipeline → assert
  job lifecycle + progress parse; gated Tier-2 for the real Python run).

### Phase C — Chronicles (the narrative layer)
- Add `pipeline/describe-chronicles.js`: for each under-described territory, sample
  member messages, call `infer({task:'narrate',prompt})` (or local Claude CLI), write
  `story_*/archetype_*/uncertainty_*/agent_*` via `db.territoryDocs.upsertDescription`.
  Add as stage 3b of `run-clustering.sh` (after describe) and as a standalone script.
- LOC: ~200. Smoke: `verify:chronicles` (stub inferer → assert columns populated +
  `territoryDetail` renders them).

### Phase O — First-run welcome polish (small)
- `portal-compat onboarding/status`: return `showWelcome:true` when `messageCount===0`.
- LOC: ~10. Smoke: extend `verify-portal-data` D8.

---

## 6. Edge cases — decided

- **Wrong/no keys** → server never starts; nothing for the UI to do (correct).
- **Pipeline run with no embeddings yet** → clustering no-ops; generate returns a
  job that completes with "0 points — import + enrich first" (don't error).
- **Two generate clicks** → second returns the in-flight `jobId` (single-flight).
- **Chronicles with no cloud key** → uses local model; if neither available, writes
  the deterministic name+essence only (graceful, like `describe-clusters.js`).
- **Import of a huge export** → client chunks (existing); server caps per-file bytes;
  enrichment is async so the response returns promptly with counts.
- **Mindscape fields with no V1 source** → render empty/"not yet computed", never throw.

---

## 7. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Import parser drift from real export formats | Med | Med | Port + test against real fixtures; ship Claude/ChatGPT first, others behind a "format not supported yet" message |
| Pipeline spawn leaks keys | Low | High | Re-resolve at spawn, env-object (not args), allowlist, never log; audit entry |
| Long clustering blocks UX | Med | Low | Background job + progress; single-flight; timeout |
| Chronicles egress of plaintext | Low | High | Sample-only, BYOK opt-in, default local, audit-logged |
| Mindscape screen looks broken when empty | Med | Med | Graceful-empty everywhere + first-run welcome guiding to import |

---

## 8. Open questions

**Resolved during sweep:** unlock is boot-time not in-app (Pivot 1); import needs
parser port not just wiring (Pivot 2); keys aren't fully in env for the child
(re-resolve at spawn); `db.mindscape`/`territoryDocs` unwired; no job/SSE infra (build
a minimal in-memory one, polling not SSE for v1).

**Deferred (out of scope here):** real auth (Phase 4 OAuth/passkey for networked
deploys); fingerprint/complexity/health metric computation; SSE streaming for
chronicles (polling suffices); the in-app key-rotation ceremony; LinkedIn import.

---

## 9. Implementation order + decision criteria

Order: **M → I → G → C → O** (M lights up what's already generated; I gets data in;
G builds topology; C makes it read like a story; O polishes first-run). Each phase
ships behind its own `verify:*` (GO) and a Mac visual check before the next.

**Proceed to the next phase when:** the current phase's verify is GO **and** the
operator confirms the screen renders correctly on the Mac (this environment has no
browser). Stop and reassess if a phase's real-data render contradicts the shapes here.

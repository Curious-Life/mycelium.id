# MEMORY — cross-session index

Quick-reference pointers for Claude Code sessions in this repo. Keep entries terse;
detail lives in the linked docs. Newest-relevant first.

## In Progress

- **Complete-UX design LOCKED (2026-06-01).** Canonical portal adopted + served, no login wall,
  Library wired. The **whole experience is now designed** (4-sweep `/sweep-first-design`, security
  pivot: keys never touch HTTP): [`docs/UX-COMPLETE-DESIGN-2026-06-01.md`](docs/UX-COMPLETE-DESIGN-2026-06-01.md).
  **Operator calls:** (1) key ceremony = **Tauri native first-run** (Rust gens keys → Keychain →
  boots Node, bundled setup view); (2) **tight 6-screen nav** (Mindscape/Library/Import/Timeline/
  Profile/Settings) + disabled **"Coming later"** group. **BUILD ORDER: N→M→I→G→C→(T,P,S)→K→O**
  (N=nav trim first, frontend-only, instant coherence; K=ceremony Mac-gated last). Detailed
  M/I/G/C/O shapes in [`docs/UX-JOURNEY-BUILDOUT-DESIGN-2026-06-01.md`](docs/UX-JOURNEY-BUILDOUT-DESIGN-2026-06-01.md).
  `npm run verify` → **23× GO**. ⚠️ Branch off `origin/main` (local `main` is stale).
  **Phases N + M + I DONE** on branch `claude/ux-complete-design`: **N** = tight 6-screen nav +
  "Coming later" group (`verify:nav`). **M** = mindscape read — wired `db.mindscape`+`db.territoryDocs`,
  `src/portal-mindscape.js` aggregator + panels + graceful-empty (`verify:portal-mindscape` 7/7).
  **I** = import — wrote `src/ingest/import-parsers.js` (Claude + ChatGPT) + `src/portal-uploads.js`
  (busboy multipart, single-shot + chunked assembly, caps, → `captureMessage` encrypt+dedup+enrich);
  added deps `jszip`+`busboy`; `verify:import` 7/7 (incl. zero-plaintext-at-rest check).
  **NEXT: Phase G** (generate — `src/jobs.js` in-memory job + `POST /mycelium/explore`/`generate`
  + status; spawn `pipeline/run-clustering.sh` with key re-resolve; real Python run is Tier-2-gated).

- **V1 build — Wave 1+2 DONE; UX pass + ingestion/uploads BUILT.** MCP server serves **31 tools**
  over stdio + HTTP/OAuth. Added getContext, captureMessage, importMessages, listTasks; folded
  metrics 8→6. **Ingestion + uploads fully built** (capture choke-point, encrypted blob store,
  /ingest/{message,import,upload} Bearer routes, migration runner, enrichment hand-off seam) —
  see [`docs/INGESTION-UPLOADS-DESIGN-2026-05-31.md`](docs/INGESTION-UPLOADS-DESIGN-2026-05-31.md).
  Pick up: [`docs/V1-BUILD-HANDOFF-2026-05-30.md`](docs/V1-BUILD-HANDOFF-2026-05-30.md) (read the
  **2026-05-31 (late)** section). Branch `claude/repo-overview-mC69M` @ `8d7a8e7`.
  Proof: `npm install --legacy-peer-deps && npm run verify` → **13× GO, EXIT 0**.
  NEXT: D7 enrichment service (:8095) skeleton. ⚠️ No autonomous wake-loop in this env (no
  ScheduleWakeup/Cron/Monitor); Tier-2 (real models/deploy/tokens) needs a networked host.

## Key docs

- Spec: [`docs/V1-BUILD-SPEC.md`](docs/V1-BUILD-SPEC.md) (v1.2, verification table, D1–D7)
- Plan: [`docs/V1-IMPLEMENTATION-PLAN.md`](docs/V1-IMPLEMENTATION-PLAN.md) (6 phases; Steps 1–4 done)
- Verified results: [`docs/FOUNDATION-WAVE1-RESULT.md`](docs/FOUNDATION-WAVE1-RESULT.md)
- Spikes (verified GO): `spike/oauth/RESULT.md` (R1 better-auth), `spike/crypto/RESULT.md` (D3/D4/D6)

## Standing disciplines (see CLAUDE.md)

- Verify every step with running code before building on it; never claim green without
  watching the ledger reach `VERDICT … EXIT=0`.
- Run tasks to completion; fold sweep findings in rather than pausing.

# MEMORY — cross-session index

Quick-reference pointers for Claude Code sessions in this repo. Keep entries terse;
detail lives in the linked docs. Newest-relevant first.

## In Progress

- **V1 UX build-out + bug-hunt + Mac-fixes SHIPPED TO MAIN (2026-06-02).** `main @ d3a3506`,
  `npm run verify` → **29× GO**. Merged #27 (nav/Mindscape-read/import[hardened]/Timeline/Profile/
  Settings/welcome + window-drag + import-dnd) · #28 (**Phase G** generate `src/jobs.js`; **Phase C**
  chronicles `pipeline/describe-chronicles.js`) · #29 (docs) · #30 (**profile editing** `user_profiles`
  + **MCP err.message redaction**) · #31 (**design-system channel-var accent fix** — ported from another
  agent's `reference/portal` commit) · **#34** (Mac-test session's import fixes, integrated from #32:
  **upload-404** [`chunked-upload.ts` bypassed the api.ts rewrite], **clustering-empty-DB**, original
  timestamps, Mac drag-drop, batched embeds; + `verify:import-timestamps`).
  **4 bug-hunt sweeps**: mostly false positives (ON-CONFLICT-order, jobs-race, enrichment-self-heals —
  disproven); real finds: MCP leak + profile gap. **The real Mac test caught 2 bugs Tier-1 verify
  missed (upload path, child dbPath) — verify the seam the frontend/child uses, not just the endpoint.**
  NEXT (here-doable): rest of the design-system port (/design styleguide, agent-colors), `/mindscape/
  explore` job. Deferred: Phase K, parser parity (canonical repo), distribution (LAST). Full handoff:
  [`docs/HANDOFF-2026-06-02.md`](docs/HANDOFF-2026-06-02.md). ⚠️ Branch off `origin/main` (local `main`
  is stale legacy); `reference/portal` edits ≠ live `portal-app`.

- **Complete-UX design LOCKED (2026-06-01).** Canonical portal adopted + served, no login wall,
  Library wired. The **whole experience is now designed** (4-sweep `/sweep-first-design`, security
  pivot: keys never touch HTTP): [`docs/UX-COMPLETE-DESIGN-2026-06-01.md`](docs/UX-COMPLETE-DESIGN-2026-06-01.md).
  **Operator calls:** (1) key ceremony = **Tauri native first-run** (Rust gens keys → Keychain →
  boots Node, bundled setup view); (2) **tight 6-screen nav** (Mindscape/Library/Import/Timeline/
  Profile/Settings) + disabled **"Coming later"** group. **BUILD ORDER: N→M→I→G→C→(T,P,S)→K→O**
  (N=nav trim first, frontend-only, instant coherence; K=ceremony Mac-gated last). Detailed
  M/I/G/C/O shapes in [`docs/UX-JOURNEY-BUILDOUT-DESIGN-2026-06-01.md`](docs/UX-JOURNEY-BUILDOUT-DESIGN-2026-06-01.md).
  `npm run verify` → **24× GO**. ⚠️ Branch off `origin/main` (local `main` is stale).
  **Phases N+M+I+T+P+S+O DONE** on branch `claude/ux-complete-design` — **all 6 primary-nav screens
  render real local data.** N=nav trim (`verify:nav`); M=mindscape read (`src/portal-mindscape.js`,
  `verify:portal-mindscape`); I=import (`src/ingest/import-parsers.js`+`src/portal-uploads.js`, busboy,
  jszip, `verify:import`); T/P/S/O=Timeline+Profile+Settings+first-run-welcome (`src/portal-compat.js`,
  `verify:portal-tps`). Commits: `5328329`,`f0972f7`,`2158b96`,`1cffd9b` (+design `0cd40f5`).
  **NEXT (env-gated): Phase G** (generate — `src/jobs.js` + explore/generate endpoints; job lifecycle
  verifiable vs a dry-run, real clustering is Tier-2), then **C** (chronicles, needs LLM) and **K**
  (Tauri key ceremony, Mac/Rust-gated). Full status: [`docs/UX-HANDOFF-2026-06-01.md`](docs/UX-HANDOFF-2026-06-01.md).

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

## Pre-launch

- **Readiness map (2026-06-01):** [`docs/PRE-LAUNCH-READINESS-2026-06-01.md`](docs/PRE-LAUNCH-READINESS-2026-06-01.md)
  — journeys A–G, functionality × {built/verified/Tier-2/unbuilt}, test-coverage map, ranked P0/P1/P2.
  **Core is verified (26 suites); the launch gaps are distribution (npm `private`, Tauri unbundled),
  remote deploy (Tunnel doc-only), the in-app generate-mindscape trigger (Phase G) + clustering being
  manual/Tier-2/unverified, and onboarding friction.** Reader doc: [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md).

## Key docs

- Spec: [`docs/V1-BUILD-SPEC.md`](docs/V1-BUILD-SPEC.md) (v1.2, verification table, D1–D7)
- Plan: [`docs/V1-IMPLEMENTATION-PLAN.md`](docs/V1-IMPLEMENTATION-PLAN.md) (6 phases; Steps 1–4 done)
- Verified results: [`docs/FOUNDATION-WAVE1-RESULT.md`](docs/FOUNDATION-WAVE1-RESULT.md)
- Spikes (verified GO): `spike/oauth/RESULT.md` (R1 better-auth), `spike/crypto/RESULT.md` (D3/D4/D6)

## Standing disciplines (see CLAUDE.md)

- Verify every step with running code before building on it; never claim green without
  watching the ledger reach `VERDICT … EXIT=0`.
- Run tasks to completion; fold sweep findings in rather than pausing.

# Mycelium V1 — UX Build-Out Handoff

**Date:** 2026-06-01 (PM session)
**Companions:** [`docs/UX-JOURNEY-BUILDOUT-DESIGN-2026-06-01.md`](UX-JOURNEY-BUILDOUT-DESIGN-2026-06-01.md) (the design), [`docs/SESSION-HANDOFF-2026-06-01.md`](SESSION-HANDOFF-2026-06-01.md) (prior), [`docs/ARCHITECTURE.md`](ARCHITECTURE.md), [`docs/SETUP.md`](SETUP.md).
**Audience:** the next Claude Code instance — picking up the **complete-UX design** + the phased build-out.

---

## TL;DR — current state

`main @ 091e222`. Full verify suite **20 GO** locally. The canonical SvelteKit portal is adopted, opens with **no login wall**, and the **Library** screen is wired to real local data. A sweep-first design for the rest of the journey is written but **not yet implemented**.

| PR | Commit | What | Status |
|----|--------|------|--------|
| #18 | `50a2511` | publishing foundation (ed25519 identity, signed links, fail-closed public server) **+ revocation nonce + 2nd adversarial round hardening** | ✅ merged |
| #23 | `8145471` | adopt canonical SvelteKit portal (`portal-app/`) — builds + served (M1) | ✅ merged |
| #24 | `885a9b7` | **local auth-shim** — app opens straight in, no `/login` wall | ✅ merged |
| #25 | `091e222` | funding scaffolding (Sponsors + Stripe) with **BEFORE-LAUNCH placeholders** | ✅ merged |
| — | branch `claude/ux-buildout-design` | the build-out **design doc** (sweep-first, 3 cycles, 2 pivots) | 🟡 pushed, **unmerged** |

**The next task is a scope-up:** the operator wants to design the **complete, exquisite, every-touchpoint UX** — account creation, the key ceremony (how keys get generated + saved to Keychain/1Password), and a keep/cut/change decision for *every* screen — not just the 5 build-out items. That needs **new sweeps first** (§ Next task).

---

## What shipped this session

- **#18 publishing — hardened to merge-ready.** Revocable unlisted links via a per-doc `publish_nonce` capability epoch (closed a CRITICAL fail-open: leaked links served forever). Then a **second 3-agent adversarial round** (both SHIP-WITH-FIXES) → applied: boot-time schema interlock (refuse to serve if `publish_nonce` column absent), byte-accurate doc-size cap, `/p/`-after-unpublish + non-canonical-signature + nonce-less-payload tests. `verify-publish` = **33 checks GO**. Files: `src/publish/{links,public-server}.js`, `src/db/documents.js`, `migrations/0003_documents_publish_nonce.sql`, `scripts/verify-publish.mjs`, `src/identity/identity.js`.
- **#23 canonical portal (M1).** `reference/portal` → `portal-app/`; reconstructed `tailwind.config.js`/`postcss.config.js` (semantic utilities → `src/lib/styles/tokens.css`); CSR-only build; encrypted-WS channel off; `resolvePortal()` in `src/server-rest.js` serves `portal-app/build` (SPA fallback) or the legacy single-file portal (`MYCELIUM_PORTAL=auto|canonical|legacy`). `scripts/verify-portal-serve.mjs` (SKIPs clean without a build). `npm run portal:install|build|dev`.
- **M2 slice 1 — Library wired** (in #23 follow-ups, on main): `src/portal-compat.js` serves `/api/v1/portal/*` (documents list/detail/create/pin/move/delete, folders, onboarding/status) in the exact shapes the screens consume; `portal-app/src/lib/api.ts` rewrites `/portal/*` → `/api/v1/portal/*`. `scripts/verify-portal-data.mjs` D1–D10.
- **#24 auth-shim.** `src/auth-shim.js` (mounted `/auth`) serves `/auth/session`→`{user}`, `/auth/setup-status`, `/auth/logout` so the portal's session check passes and the app opens (no `/login`). `/auth` excluded from the SPA fallback.
- **#25 funding.** `.github/FUNDING.yml` (entries **commented** — no broken button), README "Support development" section, `docs/PRE-LAUNCH-CHECKLIST.md`. All placeholders marked `BEFORE LAUNCH`.
- **Design doc.** `docs/UX-JOURNEY-BUILDOUT-DESIGN-2026-06-01.md` — the phased plan (below), on branch `claude/ux-buildout-design`.

## What was learned (the pivots — most valuable lines here)

1. **In-app "unlock" is structurally impossible in V1.** The server boots *already unlocked* (keys resolved at boot `src/index.js:51-59`; process **exits** on wrong key — boot-time KCV gate `src/crypto/keys.js:31-39`) and the REST surface has **no per-request auth**. There is nothing for a browser login to unlock; V1 has **no `/auth/*` backend** (better-auth is at `/api/auth/*`, only on `--http`). → onboarding = **auth-shim (shipped) + first-run welcome**, NOT a passkey ceremony. *(This is also why the operator's "it should connect with Keychain/1Password" is already satisfied — that's the SERVER key source, not a browser login.)*
2. **Import needs ported parsers, not just wiring.** Portal posts chunked FormData to `/portal/upload[/chunk|/complete]` expecting **server-side format detection**; the parsers live **only in `reference/`** (`reference/server-routes/portal-uploads.js`). Real port (Claude/ChatGPT first).
3. **`boot()` exposes only `ENCRYPTION_MASTER_KEY=userHex`, not `systemHex`** (`src/index.js:69,77`) — the generate-pipeline trigger must **re-resolve keys at spawn** and pass via the child's env (allowlisted, never args/logs).
4. **`db.mindscape` and `db.territoryDocs` are unwired** in `src/db/index.js:38-62` — must add to serve the mindscape screen + chronicles writes.
5. **Router `express.json()` must be path-scoped.** Mounting a router with `router.use(express.json())` app-wide breaks the raw-bytes `/api/v1/upload` route (verify:rest fails with a JSON parse error). Both `portal-compat` and `auth-shim` are mounted under prefixes (`/api/v1/portal`, `/auth`) for this reason. **(2026-06-01 gotcha.)**
6. **No job/SSE infra in V1** — the reference job-spawner pattern (in-memory map, `Step N/5:` stdout parse, env allowlist, timeout) must be ported minimally; polling, not SSE, for v1.

## Operator's directional calls

- Adopt the canonical UI (done). App must open with no login (done). Keep pushing the journey to be **simple, coherent, seamless** — now elevated to "**exquisite, every touchpoint, the whole shape**."
- Funding: GitHub Sponsors default + Stripe link, skip third-party, non-apologetic tone, **placeholders marked before-launch** (done).
- Merge cadence this session: operator approved merging #18 (explicit security sign-off), #23, #24, #25.

---

## ✅ DONE — complete-UX design is LOCKED → [`docs/UX-COMPLETE-DESIGN-2026-06-01.md`](UX-COMPLETE-DESIGN-2026-06-01.md)

Ran `/sweep-first-design` with the 4 sweeps below (+ a security pivot: keys never
touch HTTP). Operator decisions: **(1) key ceremony = Tauri native first-run**;
**(2) tight 6-screen primary nav + disabled "Coming later" group.** Build order:
**N→M→I→G→C→(T,P,S)→K→O** (N=nav trim first, frontend-only; K=Tauri ceremony,
Mac-gated, last). **Next action: implement Phase N.** The original sweep brief is
preserved below for the record.

### (original) NEXT TASK brief — design the complete, exquisite end-to-end UX

The prior design doc covered only the 5 build-out items. The operator now wants the **whole experience** designed first. **Run these sweeps before locking it** (sweep-first-design, ≥3 cycles):

1. **Account/key ceremony — can it be exquisite given the boot constraint?** Sweep: can a **Tauri-driven first-run** generate the two keys → write them to Keychain/1Password (`security` / `op`) → *then* boot the Node server (chicken-and-egg: server needs keys to boot, so the ceremony must run *before*/*around* boot, likely in the Tauri shell `src-tauri/src/main.rs` or a wrapper)? What does a menubar/CLI fallback look like? How is "back up your keys" made safe + unmissable? This is the part the prior doc punted to "stays CLI."
2. **Full screen/route inventory** — all 25 routes in `portal-app/src/routes/(app)/` + ~50 components: **keep / cut / merge / rebuild**, each with a reason + a V1-data backing decision. (Library done; mindscape/import/profile/settings/chat next; wealth/intel/fleet/connections/spaces/etc. — decide their fate, don't just leave empty.)
3. **Information architecture / navigation** — `Sidebar.svelte`, `Header.svelte`, `BottomTabBar.svelte`: what's primary, what's progressive-disclosure, the coherent shape. The current nav exposes ~20 screens, most empty — that's the opposite of exquisite.
4. **Per-screen data audit** for every *kept* screen (real vs graceful-empty), extending sweep C.

Output: a **complete-UX design doc** (`docs/UX-COMPLETE-DESIGN-<date>.md`) with the screen-by-screen keep/cut table, the key ceremony, the IA, and a revised phase order. UI quality needs **eyes** — iterate on the operator's Mac (`npm run portal:dev` :5173).

## In-flight build-out phases (from the design doc — implement after the complete-UX design, or fold in)

`M → I → G → C → O`, each independently shippable + `verify:*`-gated:
- **M — Mindscape read:** wire `db.mindscape`/`db.territoryDocs` (2 lines, `src/db/index.js`) + `/api/v1/portal/mindscape/*` + `/trajectory/summary` compat endpoints (graceful-empty for fingerprint/complexity/health). ~140 LOC. **Highest immediate win** — renders already-generatable topology.
- **I — Import:** port `src/ingest/import-parsers.js` (detect + Claude/ChatGPT first) + `/upload[/chunk|/complete]` compat endpoints (add `jszip`). ~420 LOC.
- **G — Generate:** `src/jobs.js` (in-memory job, single-flight, `Step N/5:` parse, key re-resolve, allowlist, 45-min timeout) + `POST /mycelium/generate` + status. ~180 LOC.
- **C — Chronicles:** `pipeline/describe-chronicles.js` using `infer({task:'narrate'})` → `db.territoryDocs.upsertDescription` (story_*/archetype_*); add as stage 3b of `run-clustering.sh`. ~200 LOC.
- **O — First-run welcome:** `onboarding/status` returns `showWelcome:true` when `messageCount===0`. ~10 LOC.

---

## Open branches (status)

| Branch | What | Action |
|---|---|---|
| `claude/ux-buildout-design` | the build-out design doc | merge to main (planning artifact) or keep as ref |
| `claude/funding-placeholders` | **MERGED as #25** | stale — ignore/delete |
| `claude/funding` | superseded (stale README base), no PR | stale — ignore/delete (remote delete was denied) |
| `claude/canonical-portal`, `claude/publish-foundation` | **MERGED** (#23/#18) | stale |
| older `claude/*-mC69M`, `key-source`, `local-setup`, etc. | pre-merged feature branches | stale |

## Gotchas / lessons (dated)

- **Local `main` is the STALE legacy branch** (`fbaddb4 @mycelium/agent-framework`). `git checkout main` lands there; `git pull` fails on divergence. **Always branch off `origin/main`:** `git checkout -B <name> origin/main`. (2026-06-01)
- **Router-level `express.json()` breaks `/api/v1/upload`** (raw bytes → JSON parse error → verify:rest NO-GO). Mount compat/auth routers under a path prefix so the parser is scoped. (2026-06-01)
- **The portal `build/` is gitignored** — after pulling, `npm run portal:build` to get the canonical UI; otherwise the server serves the legacy single-file portal. (2026-06-01)
- **No browser in this environment** — UI work can't be visually verified here; produce buildable changes + verify scripts, and the operator confirms on the Mac. (2026-06-01)
- **#18 unlisted mint/revoke has no MCP tool yet** — the `/s/` capability surface is foundation-only (fail-closed: nothing mintable = nothing leaks); wiring it is a future publishing slice. (2026-06-01)

## Open decisions for the operator

1. **Key ceremony shape** (drives onboarding): (a) Tauri first-run wizard that writes Keychain/1Password then boots the server [recommended — most "exquisite"]; (b) guided CLI/`set-keys` + a portal welcome; (c) menubar helper. Pick before designing onboarding.
2. **Screen fate** — for the ~15 screens with no V1 backend (wealth, intel, fleet, connections, spaces, agents, cycles, body, vitality, media, contexts, modules): **cut from nav**, **"coming soon" placeholder**, or **build a V1 backing**? (Recommend: cut from primary nav; keep a short, honest set.)
3. **Funding values** — GitHub Sponsors handle + Stripe link (fill `BEFORE LAUNCH` placeholders).
4. **Merge the design doc** to main now, or keep on its branch?

## Pickup protocol

1. Read this handoff cold, then `docs/UX-JOURNEY-BUILDOUT-DESIGN-2026-06-01.md`.
2. Verify state: `git checkout -B work origin/main` (NOT local main); `git rev-parse --short origin/main` → expect `091e222` (or later); `npm install && npm run verify` → expect **20× VERDICT: GO**.
3. For the **complete-UX design**: run `/sweep-first-design` with the 4 sweeps above (≥3 cycles), write `docs/UX-COMPLETE-DESIGN-<date>.md`, get the operator's calls on the 2 open decisions (key ceremony, screen fate).
4. To **build** a phase: `git checkout -B claude/phase-<x> origin/main`; implement; add a `verify:<x>`; `npm run verify` GO; push + PR; operator visual-checks on the Mac (`npm run portal:dev`) before merge.
5. Run `/deploy-and-verify` mental model on each (this env can't deploy/see UI; the operator's Mac is the verification surface).

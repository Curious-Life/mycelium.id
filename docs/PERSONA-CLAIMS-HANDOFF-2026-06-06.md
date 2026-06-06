# Persona-Claims — Handoff (2026-06-06)

## TL;DR
Adopted PersonaTree's portable mechanisms + a new "discover person-level claims on a day/week/month/quarter cadence and track them over time" capability into Mycelium. **Backend core + cadence engine + getContext graft are built, tested, and verified.** Remaining work (MCP tool, searchMindscape routing, portal UI, full Tier-3) needs a live local model and a WebKit browser to verify per CLAUDE.md, so it was deliberately deferred rather than shipped unverified.

Design doc (source of truth, with verification table + per-step Build status): [docs/PERSONA-CLAIMS-DESIGN-2026-06-06.md](PERSONA-CLAIMS-DESIGN-2026-06-06.md).

## Branch + commits
Branch `feat/persona-claims` (off `main`):
- `fd53207` — core steps 1–6: schema/crypto, confidence, store, validator, support-path+route, discovery logic.
- `615b262` — step 5 glue (windows, heartbeat, discovery child, jobs spawner, boot wiring) + step 7a (getContext graft).

Not committed: nothing of this feature is left uncommitted. (Pre-existing untracked files — `.claude/launch.json`, `docs/LANDING-REDESIGN-*`, `scripts/run-real-generate.mjs`, `src-tauri/Cargo.lock` — are unrelated and were left alone.)

## What's done + verified
- 51 unit tests (`tests/claims/*.test.js`) pass.
- Gates GO: `verify:claims` (schema/crypto, no cleartext leak, phantom-column fix), `verify:claims-discovery` (stubbed-model end-to-end persist + getContext render + real-child Tier-3 fail-soft), `verify:rest`, `verify:context`.
- Regression: `verify:measurement-schema`, `verify:frequency`, `verify:mindfiles` still GO after the shared `crypto-local.js` edit.

Modules: `migrations/0011_persona_claims.sql`, `src/db/claims.js`, `src/claims/{confidence,validator,support-path,route,discovery,windows,heartbeat}.js`, `pipeline/discover-claims.mjs`, grafts in `src/db/index.js`/`src/jobs.js`/`src/server-rest.js`/`src/tools/context.js`, gates `scripts/verify-claims*.mjs`.

## Pickup protocol (remaining work, in order)
1. **`personaClaims` MCP read tool** — `list` (active claims + latest delta) + `series` (one claim over time) over `db.claims`. New `src/tools/claims.js` domain wired in `src/mcp.js`. ⚠️ Adds a tool → **tool-list/discovery change → MUST verify with the official MCP Inspector in a REAL WebKit browser** (curl gives a false green — see `docs/REMOTE-CONNECT-HANDOFF-2026-06-03.md`). Smoke `verify:mcp` first.
2. **searchMindscape routing graft** — `src/tools/mindscape.js`: when `scope==='all'`, call `routeLevel(text)` (already built), resolve the routed claims' support paths (depth from the route), prepend, apply `selectUnderBudget`. Same browser caveat (it's an MCP tool).
3. **Portal** — `GET /portal/claims/current` + `/portal/claims/series` (clone `/portal/frequency/series` in `src/portal-measurement.js`, owner-gated, decrypt-on-read) + `ClaimsView.svelte` reusing `TimeSeries.svelte`. Needs portal build + browser live-render (the `e1dc958` bar). New `verify:claims-rest` (clone `verify:metrics-rest`, assert no ciphertext leak).
4. **Full Tier-3 verification** — pull a local Ollama model, run `node pipeline/discover-claims.mjs --cadence=day` against a seeded real vault, confirm real claims + snapshots appear and the heartbeat spawns on a window roll-over.
5. **Living-docs sweep** — update `docs/V1-BUILD-SPEC.md` status table + `docs/ARCHITECTURE.md` (new claims subsystem + Tier-3) in the same commit as the final code.
6. **Merge** — via `/auto-merge-on-green`; security-sensitive diff (crypto + new model-call path) ⇒ requires a human approval.

## Key decisions made (so they're not re-litigated)
- Discovery LLM work runs as a **pipeline child** spawned by a **zero-LLM REST heartbeat** — NOT an LLM-calling timer (router.infer is only gateway-wired; a timer call would be first-of-its-kind + race Generate). See design §1 v4.
- v1 claim identity-match = `content_hash` + token-Jaccard over **decrypted** claim text, NOT embedding cosine (avoided decrypting stored vectors). `embedding_768` retained for retrieval.
- Every discovery/validator model call is `sensitive:true` (router hard-blocks US-cloud egress → on-box local). Non-negotiable.
- Boundary claims never decay (λ=0); claim_type/delta_kind encrypted (a plaintext "boundary" would leak boundary existence).
- DB layer follows the repo's `db.<ns>` namespace convention (`src/db/claims.js`), not the design's `src/claims/store.js`.

# Persona-Claims — Handoff (2026-06-06)

## TL;DR
Adopted PersonaTree's portable mechanisms + a new "discover person-level claims on a day/week/month/quarter cadence and track them over time" capability into Mycelium. **All 9 design steps are now built, tested, and live-validated** — schema/crypto, confidence, store, validator, support-path+routing, discovery + cadence engine, getContext + searchMindscape grafts, the personaClaims MCP tool, and the portal Claims view. Tier-3 was validated end-to-end against a real local model (Ollama + Nomic), which drove a proposal-prompt fix and the semantic cross-cadence dedup (threshold calibrated live). The portal was live-rendered. **Remaining: the living-docs are updated; only the PR + merge (via `/auto-merge-on-green`, human approval on the security-sensitive diff) and a full `npm run verify` chain on CI remain.**

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

## Done (all steps 1–9)
1. ✅ **`personaClaims` MCP tool** — `src/tools/claims.js`, registered in `src/mcp.js`. `verify:mcp` GO (output/tool-list verified over stdio; no auth/CORS/discovery change, so no browser check needed).
2. ✅ **searchMindscape routing graft** — `src/tools/mindscape.js`: `routeLevel` → claim-level queries prepend a budgeted "Claims about you" support-path block. Output-only change. Smoke D3e/D3f.
3. ✅ **Portal** — `src/portal-claims.js` (`/claims/current` + `/claims/series`, owner-gated, decrypt-on-read) + `ClaimsView.svelte` (reuses `TimeSeries.svelte`). `verify:claims-rest` GO (no ciphertext leak); **live-rendered** against a seeded vault.
4. ✅ **Full Tier-3** — Ollama (`--cask`, not the formula) + llama3.1 + embed service; ran the real pipe → tuned the proposal prompt + calibrated the dedup threshold (0.62) live.
5. ✅ **Living-docs** — `ARCHITECTURE.md` §4b + schema note updated; design-doc Build status current; this handoff updated.

## Remaining (final)
- **Open PR + merge** via `/auto-merge-on-green`. The diff is **security-sensitive** (crypto field changes + a new on-box model-call path) ⇒ requires an explicit **human approval** regardless of CI.
- **CI must run the full `npm run verify` chain** (I ran the touched gates locally: `claims`, `claims-discovery`, `claims-rest`, `mcp`, `context`, `rest`, `search`, `measurement-schema`, `frequency`, `mindfiles` — all GO — but not the entire ~90-gate chain).
- **Optional follow-ups (not blockers):** searchMindscape claim support-paths render at depth 0 (claim only) — depth-2 evidence resolution into the search result is a future enhancement; live-tune the proposal prompt further (phrasing was occasionally terse). Benchmarks: see the `benchmark-persona-claims` memory.

## Key decisions made (so they're not re-litigated)
- Discovery LLM work runs as a **pipeline child** spawned by a **zero-LLM REST heartbeat** — NOT an LLM-calling timer (router.infer is only gateway-wired; a timer call would be first-of-its-kind + race Generate). See design §1 v4.
- v1 claim identity-match = `content_hash` + token-Jaccard over **decrypted** claim text, NOT embedding cosine (avoided decrypting stored vectors). `embedding_768` retained for retrieval.
- Every discovery/validator model call is `sensitive:true` (router hard-blocks US-cloud egress → on-box local). Non-negotiable.
- Boundary claims never decay (λ=0); claim_type/delta_kind encrypted (a plaintext "boundary" would leak boundary existence).
- DB layer follows the repo's `db.<ns>` namespace convention (`src/db/claims.js`), not the design's `src/claims/store.js`.

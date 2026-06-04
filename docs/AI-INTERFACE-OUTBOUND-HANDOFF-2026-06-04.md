# AI Interface Layer — OUTBOUND build — Handoff Doc

**Date:** 2026-06-04
**Audience:** the next Claude Code instance picking up this work (post-compaction).
**Companions (read these for design rationale):**
- [`docs/DESIGN-ai-interface-layer-2026-06-04.md`](DESIGN-ai-interface-layer-2026-06-04.md) — the two-membrane design + **Part 8 = the S0–S8 build status (live)**.
- [`docs/DESIGN-relay-and-gateway-2026-06-04.md`](DESIGN-relay-and-gateway-2026-06-04.md) — **Part B = the S8 gateway design (build from this)**.
- [`docs/RESEARCH-agent-harnesses-2026-06-04.md`](RESEARCH-agent-harnesses-2026-06-04.md) — the harnesses (opencode/Goose/Codex…) that will consume the gateway.

---

## TL;DR — current state (all MERGED TO MAIN)

PR **#64** merged → `main @ 01d4e27`. The **outbound-LLM lane** is built through S3 + the Intelligence UI. **S8 (the gateway) is now BUILT too** (this branch / PR #79) — see the S8 row + the 🔴 security note below.

> 🔴 **Security fix shipped with S8 (2026-06-04).** The gateway's end-to-end smoke surfaced a **pre-existing auth-bypass** on every Bearer-guarded surface (`/mcp`, `/ingest/*`, `/v1`): `authenticate()` called `auth.api.getMcpSession({request,headers})` **without `asResponse:false`**, which returns a truthy `{}` for *any* input (valid token, garbage token, even no token) — so **any non-empty `Bearer` header authenticated**. Fixed in `src/server-http.js` (`asResponse:false` → real token row / `null`, mirroring better-auth's `withMcpAuth`; **+ fail-closed `accessTokenExpiresAt` check**). Regression guard: **garbage-Bearer→401** added to `verify:oauth` (the missing case — it had only tested *no-token* and *valid-token*). Verified: wrong/expired/garbage → 401, valid → 200, full chain GO.

| Step | Commit | Status | What it is |
|---|---|---|---|
| S0 — encrypt provider creds | `9a5160a` | ✅ merged | `ai_providers.credentials` in `ENCRYPTED_FIELDS` (ciphertext at rest) |
| S1 — `/portal/providers` backend | `9a5160a` | ✅ merged | CRUD + `setActive` + `/test` probe + presets; Claude-sub-OAuth dropped (ToS) |
| S2 — router reads the store | `bbf5059` | ✅ merged | `resolveInferenceConfig` maps active provider → router opts (authoritative over env) |
| S3a — base_url widening + jurisdiction | `64195c0` | ✅ merged | OpenAI-compatible adapter → EU-sovereign/OpenRouter/Ollama/LM Studio; jurisdiction tags |
| Intelligence Settings UI | `d0c8f55` | ✅ merged | `IntelligenceSection.svelte` — connect any provider, grouped by jurisdiction |
| S3b — egress boundary | `3e03a98` | ✅ merged | `sensitive` hard-block from US providers + egress audit (hash-only, via `db.audit`) |
| **S8 — `/v1/chat/completions` gateway** | this branch (#79) | ✅ **BUILT** | `src/gateway/openai-compat.js` (`/v1/chat/completions` + `/v1/models`) on :4711, composing the S2/S3 seams; **§3b static bearer** `src/gateway/static-bearer.js`; `X-Mycelium-Sensitive` opt-in; `verify:gateway` GO (14 checks) + smoke GO |
| **🔴 Auth-bypass fix** | this branch (#79) | ✅ **FIXED** | `getMcpSession` `asResponse:false` + expiry guard in `authenticate()`; garbage-Bearer→401 regression in `verify:oauth` |
| S6 — hardware "Cookbook" recommender | — | deferred | §4h — detect HW → recommend a local model → one-click `ollama pull`→provider row |

Design-doc commits (also on main): `90ec677` (interface design), `803303b` (harness research), `3de6113` (routing policy §4g), `e2f10c0` (§4h recommender), `90ef512` (relay+gateway design).

**The whole outbound spine works today:** open Settings → Intelligence → connect Regolo/Ollama/etc. → Mycelium's own inference (`describe-chronicles`, future callers) routes there, jurisdiction-gated + audited.

---

## 2026-06-04 (PM) — MERGE PICKUP — START HERE (your job: checks → merge when ready)

**The build is DONE.** S8 + the security fix + a relay-lane flaky-test fix are committed and pushed to **PR #79** (branch `claude/elegant-ritchie-034Ub`, base `main`, **draft**). **Your job is NOT to build — it is to get #79 green and MERGE it through the gate once the operator approves.**

### PR #79 — exact state
- Head: **`0284a2c`** (latest). Base: `main @ 5779e29` (main was merged into the branch — up to date).
- Commits added this session (all pushed):
  - **`39a038b`** — feat(gateway): S8 `/v1` gateway + §3b static bearer + **the 🔴 auth-bypass fix** (the security-sensitive diff).
  - **`3ce39f3`** — ci: empty re-trigger commit (documents the flake; harmless no-op).
  - **`0284a2c`** — test(managed-claim): make MC2 signature tamper deterministic (**fixes the ~5% flake**).
- Files in the diff: `src/gateway/openai-compat.js` (new), `src/gateway/static-bearer.js` (new), `src/server-http.js` (gateway mount + static bearer + auth fix), `scripts/verify-gateway.mjs` (new), `scripts/verify-oauth.mjs` (garbage→401 guard), `scripts/verify-managed-claim.mjs` (flaky-fix), `package.json` (verify:gateway wired), + docs/MEMORY.
- **All local gates GO:** full `npm run verify` chain GO (~60 gates, exit 0) + `verify:gateway` (14 checks) + a real-server end-to-end smoke GO.

### ⛔ MERGE GATE — fail-closed (`/auto-merge-on-green`). Do NOT merge unless ALL hold:
1. **Every CI check completed = success** (the `verify` check on `0284a2c`). Pending/missing/failed → HOLD.
2. PR is **mergeable** (no conflicts) **and NOT a draft** (it's draft now — the operator marks it ready, or tells you to).
3. **🔴 Explicit human approval of the security-sensitive diff is MANDATORY** — this PR changes auth (`getMcpSession` validation) and adds a static-bearer auth path. CI-green alone is NOT sufficient. Per `/auto-merge-on-green`, security diffs always need a human approve. **Never self-merge this on green.**

### Pickup protocol (execute in order)
1. Read this section + the 🔴 security note in the TL;DR above. Then skim the PR #79 body (it leads with the security fix).
2. **Check CI:** `pull_request_read get_check_runs` on #79. The `verify` check should be `success` on `0284a2c`.
   - If it **failed on `verify:managed-claim` MC2 again** — that flake is FIXED in `0284a2c`; a recurrence would mean something else. Re-read the log.
   - If it failed on a **different** gate — diagnose (it would be a real regression; the full chain was GO locally, so suspect environment first). Re-kick by pushing, or investigate.
   - If `success` → go to step 3.
3. **Confirm with the operator** that they've reviewed/approved the security diff (the auth fix + static bearer). If not yet → HOLD and ask. This is the one human gate.
4. When green **and** approved **and** not-draft: **merge** (the prior outbound PR #64 used **merge** method; match that unless told otherwise). Then:
   - Verify `main` head moved + the lane files are present (`git fetch origin main` → `git cat-file -e origin/main:src/gateway/openai-compat.js`).
   - Update this handoff (flip S8 row → ✅ **MERGED @ <hash>**) + the MEMORY.md "In Progress" pointer.
5. **Unsubscribe** from #79 once MERGED (or keep watching per operator preference).

### What was learned this session (the durable lines — these are why the PR is what it is)
- 🔴 **`getMcpSession` without `asResponse:false` returns a truthy `{}` for ANY input** — valid token, garbage, even no token (proven in isolation). So the shipped `authenticate()` authenticated **any non-empty Bearer** on `/mcp` + `/ingest/*`. `verify:oauth` missed it because it only tested *no-token* (short-circuits before the call) and *valid-token* — never a *garbage* token. **Fix:** `asResponse:false` + a fail-closed expiry check. **Lesson:** an auth gate's test MUST include a garbage-credential case, not just present/absent.
- **`verify:managed-claim` MC2 was ~5% flaky** (not 1/256): the tamper `sig.slice(0,-2)+"AA"` zeroes the 64th signature byte, but ed25519's `S` scalar is `< 2^252` so that byte is always `< 16` → already `0x00` ~1/16 of runs → tamper = no-op (proven 255/5000, matching last-byte==0x00 exactly). Fixed by flipping a *decoded* byte (deterministic: 0/5000, 15/15 GO).
- **The portal builds in this container** and the **end-to-end smoke is achievable** (spawn `src/index.js --http` + a mock-OpenAI upstream via `INFERENCE_BASE_URL`) — the smoke is what caught the auth bug. Always smoke the real server, not just the handler-with-stub-guard.

### Operator's directional calls (this session)
- Both S8 open decisions were **deferred to my judgment** ("what's best?") → built the **§3b static bearer** (fail-closed, off unless `MYCELIUM_MCP_BEARER` set) + honored **`X-Mycelium-Sensitive`** (additive, default off).
- Operator **approved the cross-lane flaky-test fix** (`verify-managed-claim.mjs` is the relay session's file; edited with explicit OK). ⚠️ **Flag for the relay session** so they don't double-fix.
- Operator wants **a fresh session to run the checks + merge** (this handoff) — they will review/approve the security diff.

### Gotchas (2026-06-04)
- The static bearer is **fail-closed**: it does nothing unless `MYCELIUM_MCP_BEARER` is set (≥24 chars). Default posture is unchanged OAuth-only. Don't "test" it by expecting it on by default.
- `mergeable_state`: **`dirty`** = real conflicts (re-merge main); **`unstable`** = mergeable, CI just pending. **`blocked`** = a required review/approval is missing (expected here until the operator approves).
- Gateway is **non-streaming v1** (single terminal SSE chunk) and **drops `tools`** — by design (router is single-shot, prompt-only). Don't file these as bugs; they're named fast-follows.

### v1 limits (named, deferred — NOT this PR)
True token-streaming · tool pass-through · the §4g multi-provider cascade (v1 uses the single active provider) · `/v1/embeddings` · the S4 remainder (`MYCELIUM_HTTP_HOST` default-loopback, server `instructions`) · S6 hardware recommender.

---

## 2026-06-04 session summary — start here

### What shipped (merged to main, PR #64 → `01d4e27`)
The outbound membrane: provider credential store → backend → router wiring → multi-provider widening → egress security → the connect-UI. Each step has a `verify:*` gate (all GO). Full per-step detail above.

### What was learned (the most valuable lines — corrections to earlier assumptions)
- **The SvelteKit portal DOES build in this container** (`npm --prefix portal-app install` ≈10s + `run build` ≈30s). Earlier I assumed frontend was un-CI-able here — **wrong**. Frontend IS verifiable: build it before declaring a `.svelte` change done.
- **`egress_audit` is channel-shaped** (telegram/discord, likely CHECK-constrained `channel_kind`/`provenance_kind`) — a **poor fit for LLM egress**. Inference egress goes through the **general `db.audit` table** (`action:'inference-egress'`). See `src/inference/egress.js`.
- **The local D1 adapter DOES populate `meta.last_row_id`** on INSERT (`src/adapter/d1.js:48`) — so `db.providers.create`'s `result.meta?.last_row_id` works (no `RETURNING` needed).
- **The router's `infer` is prompt-only, single-shot, no tools, no streaming** (`src/inference/router.js`). → the **gateway (S8) must flatten `messages[]`→a prompt, be non-streaming in v1, and drop `tools`**.
- **Claude-subscription-OAuth is ToS-banned (2026-02-19)** → BYOK API key only. The `/auth/claude*` routes are deliberate refusal stubs.
- **Credential storage = encrypt-in-place** (`ENCRYPTED_FIELDS.ai_providers=['credentials']`), chosen over the `secrets` table (which is now also on main from the connectors session) — self-contained, zero coupling. Could migrate later; not needed.
- `mergeable_state`: **`dirty`** = real conflicts (main moved — re-merge main); **`unstable`** = mergeable, just CI pending.

### Operator's directional calls (locked this session)
- **Routing priority (§4g):** EU-sovereign ZDR → frontier (Anthropic/OpenAI/Google) → local (test tier) — **inverts** the shipped local-first default. `sensitive` hard-blocked from US providers (fail-closed).
- **Remote reachability = the relay** (now built + merged by the parallel session, `src/remote/*`).
- **Merge to main:** done, through the fail-closed gate (CI green + mergeable + non-draft + explicit owner approval for the security-sensitive diff).

### Lane boundaries — DO NOT TOUCH (other sessions own these; all on main)
- `src/remote/*`, `src/auth.js` remote bits, `src-tauri/*` relay bits, `scripts/verify-{remote-config,loopback,dns,ct-monitor,managed-claim,provision,newproxy-auth,remote-runtime}.mjs` — **relay session**.
- `src/connectors/*`, `src/db/secrets.js`, `src/portal-{settings,connectors,import}.js`, `src/ingest/{markdown,obsidian-import}.js`, `scripts/verify-{secrets,connectors,adapters,obsidian}.mjs` — **import-connectors session**.
- ⚠️ Root **`_*.mjs` debug debris** (`_reset-operator.mjs`, `_setpw.mjs`, `_decode-token.mjs`, …) landed on main from a relay `TEMP: REMOVE before merge` commit. Not our lane — flag for cleanup, don't depend on them.

---

## S8 — the gateway (NEXT). Build from `DESIGN-relay-and-gateway` Part B.

**Goal:** `POST /v1/chat/completions` (+ `GET /v1/models`) on **:4711** (the OAuth/MCP HTTP server, `src/server-http.js`), Bearer-guarded, fronting the outbound router. A user's harness (opencode/Codex/Goose) points its model base-URL at `https://<handle>.mycelium.id/v1` → it gets memory (MCP) **and** model (gateway) through one sovereign, audited endpoint.

### Reusable seams (already built — just compose them)
| Seam | File | Signature / note |
|---|---|---|
| Resolve active provider → router opts | `src/inference/resolve.js` | `await resolveInferenceConfig(db, userId)` → `{anthropicApiKey, openaiApiKey, baseUrl, cloudModel, jurisdiction}` |
| The router | `src/inference/router.js` | `createInferenceRouter({...cfg, onEgress})` → `.infer({prompt, task, maxTokens, sensitive})` → `Promise<string>` (prompt-only, single-shot) |
| Egress audit sink | `src/inference/egress.js` | `createEgressAuditSink(db, userId)` → pass as `onEgress` |
| Bearer guard | `src/server-http.js` | `requireAuth(req,res)` (~`:197`/`:268`) — use exactly like `app.post('/ingest/message', …)` (`:208`+) |

### Module shape (≈150 LOC + a verify gate)
- **`src/gateway/openai-compat.js`** (new): `parse {model, messages[], max_tokens, stream}` → flatten `messages[]`→a role-tagged prompt (system→preamble) → resolve route (`model:"mycelium-auto"`/unknown → the active provider via `resolveInferenceConfig`; `"<provider-label>"` → pin) → `router.infer({prompt, task:'complex', maxTokens, sensitive})` → wrap → OpenAI `ChatCompletion` JSON `{choices:[{message:{role:'assistant',content}}], usage}`.
- **Mount in `src/server-http.js`**: `app.post('/v1/chat/completions', async (req,res) => { if(!await requireAuth(req,res)) return; … })` + `GET /v1/models` (list configured providers as model ids).
- **`scripts/verify-gateway.mjs`** (new, into the chain): mount the route on a throwaway app over a temp vault (mirror `verify:providers`); assert `messages[]`→prompt mapping, OpenAI JSON envelope, Bearer-guard 401, **one egress-audit row per call (hash-only)**, `stream:true` → terminal-chunk shim.

### Explicit v1 decisions (from the design — don't relitigate)
- **NON-streaming v1.** `stream:true` → emit a single terminal SSE chunk (`data: {…delta…}` + `data: [DONE]`) for client compatibility. True token-streaming = fast-follow (needs router/adapter streaming, which doesn't exist).
- **Drop `tools`/`tool_choice` in v1** (router has no tool support; the harness runs its own tool loop and only needs raw completions).
- **`sensitive` on gateway input:** the prompt is opaque harness text with **no vault flag** → can't classify. Gateway defaults `sensitive:false`; gate by **configured jurisdiction + per-provider consent + audit** instead. (Optional: honor an `X-Mycelium-Sensitive: true` request header so a harness can opt-in — operator decision below.)
- **Bearer-guarded, never on the no-auth REST :8787** (it spends the user's keys). For a purely-local harness, the low-friction path is the **§3b static bearer — which is NOT built** (it was North-ergonomics S4). See open decisions.

### ⚠️ S8 sweep-before-build (the one real unknown)
`src/server-http.js` boots a **per-`mcp-session` vault** for `/mcp`. **Verify how the Bearer-guarded `/ingest/*` routes obtain their `db` + `userId`** (do they share one booted vault, or boot per request?) — the gateway must use the **same** db-handle pattern to call `resolveInferenceConfig(db,userId)` + the audit sink. Read `src/server-http.js` around the `/ingest/message` handler (`:208`+) and the boot/session wiring before writing the gateway. This is the load-bearing seam; everything else is composition.

---

## Verify gates (this lane)
`verify:providers-leak` · `verify:providers` · `verify:resolve` · `verify:egress` — all in the `npm run verify` chain (package.json). Add **`verify:gateway`** for S8. The full chain is green in CI on main (`verify` check, `01d4e27`).

Quick local re-confirm:
```bash
npm run verify:providers-leak && npm run verify:providers && npm run verify:resolve && npm run verify:egress
# each → VERDICT: GO  EXIT=0
```

## Build / run it (from main)
```bash
git checkout main && git pull          # main @ 01d4e27 (or later)
npm install --legacy-peer-deps
npm run portal:build                    # builds the Svelte UI → Settings → Intelligence shows
npm run portal                          # REST+portal :8787 (loopback) — Settings → Intelligence
# For S8 you'll exercise the OAuth server:
npm run start:http                      # :4711 /mcp + (after S8) /v1/chat/completions, Bearer-guarded
```
Verify the lane is present on main:
```bash
for f in src/portal-providers.js src/inference/resolve.js src/inference/presets.js src/inference/egress.js \
         portal-app/src/lib/components/settings/IntelligenceSection.svelte; do
  git cat-file -e origin/main:$f && echo "✓ $f"; done   # all ✓ (verified 2026-06-04)
```

---

## Open decisions for the operator (before/within S8)
1. **Local-harness auth.** Gateway is on :4711 (OAuth Bearer). A purely-local harness then needs the OAuth flow. **Build the §3b static-bearer mode** (`MYCELIUM_MCP_BEARER`, ~40 LOC in `server-http.js`) for copy-paste low-friction? **Recommendation: yes, build it alongside S8** — every top harness (opencode `oauth:false`+headers, Codex `bearer_token_env_var`, Goose headers) wants a static bearer.
2. **`sensitive` on the gateway.** Honor an `X-Mycelium-Sensitive: true` header so a harness can opt a request into the §4g hard-block? **Recommendation: yes, cheap + honest** (default false).
3. **Model routing depth.** S8 v1 uses the single *active* provider (the S2 resolver). A full §4g **cascade** (try EU→frontier→local on failure) is NOT built. Ship v1 with the active provider; cascade is a later refinement.
4. **Streaming.** v1 non-streaming (single-chunk shim). Build true token-streaming when a harness demands it (needs router + cloud/local adapter streaming — net-new).

## Pickup protocol (execute in order)
1. Read this handoff cold. Then `DESIGN-relay-and-gateway-2026-06-04.md` **Part B**.
2. `git checkout main && git pull` — confirm the lane files are present (command above).
3. **`/sweep-first-design`** before writing: sweep `src/server-http.js` for (a) how `/ingest/*` gets `db`+`userId`, (b) `requireAuth`, (c) CORS — per the "S8 sweep-before-build" note. Confirm the `resolve.js`/`router.js`/`egress.js` seam signatures (they're stable).
4. Build `src/gateway/openai-compat.js` + mount in `server-http.js` + `scripts/verify-gateway.mjs`. Compose the four seams above. Decide open-questions 1–2 with the operator.
5. **`/deploy-and-verify`**: run `verify:gateway` + the lane gates; smoke via `npm run start:http` + a `curl` to `/v1/chat/completions` with a Bearer token; point a real harness's base-URL at it for one turn.
6. Develop on a fresh branch off `main`; PR as draft; merge through `/auto-merge-on-green` (security-sensitive → explicit owner approval).

## Skills that fired this session
`/sweep-first-design` (the interface + relay-gateway designs, with verification tables) · `/deploy-and-verify` discipline (every step gated to `VERDICT: GO`) · `/auto-merge-on-green` (the merge: held on pending CI, merged on green) · `/handoff-discipline` (this doc). The egress audit + sensitive hard-block were built under the §1-§13 security non-negotiables (zero plaintext: the audit is hash-only; fail-closed: sensitive→local).

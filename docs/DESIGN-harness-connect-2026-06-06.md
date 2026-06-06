# Harness Connect — Design

**Date:** 2026-06-06
**Status:** Design (sweep-first). 3 Explore sweeps + own-eyes reads of the live surfaces. Builds on the shipped AI-interface layer (S0–S8).
**Skill:** `/sweep-first-design`. Companions: [`DESIGN-ai-interface-layer-2026-06-04.md`](DESIGN-ai-interface-layer-2026-06-04.md), [`DESIGN-ai-interface-fastfollows-2026-06-04.md`](DESIGN-ai-interface-fastfollows-2026-06-04.md), [`RESEARCH-agent-harnesses-2026-06-04.md`](RESEARCH-agent-harnesses-2026-06-04.md), [`CONNECT-YOUR-AI.md`](CONNECT-YOUR-AI.md).
**Scope:** A curated *"pick your agent harness"* surface that makes connecting **any** harness to the vault one-click for **UI users** and one-copy for **devs** — Mycelium-native, **opencode**, **openclaw**, **hermes-agent**, the common MCP desktops, and a custom escape hatch. **UI + docs only — no new backend, no auth changes.**

---

## TL;DR — the headline

The plumbing is **already built**; what's missing is **curation and coverage**. Mycelium exposes **two doors** and they already accept every spec-compliant harness:

```
   any agent harness ──▶  NORTH — memory (MCP)     :4711/mcp  (or stdio)   OAuth 2.1 │ static bearer
   (Claude · opencode ·   ───────────────────────────────────────────────────────────────────────
    openclaw · hermes ·   SOUTH — model (gateway)  :4711/v1   (OpenAI-compat)        static bearer
    Goose · Cline · …)    ──▶  routes to your active provider (model id `mycelium-auto`)
```

**Three findings reframe the work:**

1. **No blockers remain.** The earlier security concerns are resolved: provider creds are encrypted (`ai_providers:['credentials']`, [crypto-local.js:214](../src/crypto/crypto-local.js)); the static-bearer connect path is built, fail-closed, ≥24-char, constant-time ([static-bearer.js](../src/gateway/static-bearer.js), wired in `authenticate()` [server-http.js:220-228](../src/server-http.js)); OAuth 2.1 (PKCE/DCR/RFC 9728) is the default ([auth.js:79-96](../src/auth.js)); both doors are live (S8).

2. **The gap is product, not protocol.** There is **no curated harness menu**; the docs ([CONNECT-YOUR-AI.md §3](CONNECT-YOUR-AI.md)) cover only the *model-gateway* door for a coding-tool subset (opencode/Codex/Goose/Cline/Continue) and **omit openclaw + hermes-agent entirely**. Nothing organizes the experience around the two audiences.

3. **openclaw and hermes-agent are a different species** ([RESEARCH §1](RESEARCH-agent-harnesses-2026-06-04.md)). They are *personal-assistant* harnesses — Mycelium's category neighbors — not coding mirrors. They connect the **same one-line way** (North/MCP), so adding them is *curation*, not integration. openclaw carries a **scam-safety caveat** (heavily impersonated — trust only `openclaw/openclaw` + `openclaw.ai`).

**Outcome:** one small design (this doc) → a per-harness recipes doc → a curated portal picker. Any user or dev connects their harness to both doors in under a minute.

---

## Part 1 — The model: two doors, N harnesses, 2 audiences

### 1a. The two doors (as-built)

| Door | Endpoint | Transport | Auth | What a harness gets |
|---|---|---|---|---|
| **North — memory (MCP)** | `:4711/mcp` or stdio | Streamable HTTP / stdio | OAuth 2.1 **or** static bearer | the vault's MCP tools: `getContext`, `searchMindscape`, `remember`, `captureMessage`, … |
| **South — model (gateway)** | `:4711/v1` (+ `/v1/embeddings`) | OpenAI-compatible | static bearer (as API key) | sovereign, jurisdiction-gated, audited inference via *your* provider keys; model id `mycelium-auto` |

A harness uses **one or both**. The vault becomes the harness's **long-term memory** (North) and optionally its **model router** (South). This is the whole integration — no per-harness code.

### 1b. The harness taxonomy (first-class menu entries)

Grouped by the research doc's species split, so users self-identify:

| Entry | Species | Doors | Notes |
|---|---|---|---|
| **Mycelium-native** | the vault's own assistant | — | "No external harness — talk to your vault directly." The default. |
| **opencode** (SST, MIT) | coding harness (the Claude Code mirror) | North + South | dev-leaning; MCP client + OpenAI-compatible model base-URL. |
| **openclaw** (MIT) | omni-channel personal assistant | North (MCP `streamable-http`) | ⚠️ **scam-safety note**: trust only `openclaw/openclaw` + `openclaw.ai`. |
| **hermes-agent** (NousResearch, MIT) | self-improving personal assistant | North (MCP-native) | the agent, **not** the Hermes LLM family. |
| **Claude Desktop / Claude Code** | the common MCP desktops | North (stdio) | reuse the existing `.mcp.json` generator. |
| **Custom — any MCP / OpenAI-compatible client** | escape hatch | North + South | the raw endpoints. This is what makes it "connect *whatever* you use." |

### 1c. The two audiences, one source of truth

- **UI users** → the **portal picker**: cards in Settings; click one → expand a tailored recipe with copy buttons; desktop clients get a generated config blob.
- **Devs** → the **recipes doc** ([`HARNESS-RECIPES.md`](HARNESS-RECIPES.md)): per-harness CLI/config snippets for both doors; the cards deep-link into it.

Both render the **same facts** (`:4711/mcp`, `:4711/v1`, `mycelium-auto`, the bearer) sourced from the existing endpoints (`GET /api/v1/remote/status`, `GET /api/v1/remote/local-config`) — they cannot drift.

---

## Part 2 — Reachability & honest caveats

- **Local-only today.** Remote (`https://<handle>.mycelium.id/…`) depends on the TLS-passthrough relay, which is **not live end-to-end** ([CONNECT-YOUR-AI.md:127](CONNECT-YOUR-AI.md)). The picker shows remote rows as **"coming soon (relay)"** and steers everyone to stdio / loopback for V1. North-side bind stays loopback by default ([server-http.js:399-402](../src/server-http.js)).
- **Verify exact config keys at build time.** [RESEARCH §7](RESEARCH-agent-harnesses-2026-06-04.md) flags that several vendor doc pages 403'd. The openclaw `streamable-http` block and the hermes-agent MCP config **must be checked against each harness's current docs** when writing the recipes — do not ship guessed keys.
- **Bearer is boot-time.** `MYCELIUM_MCP_BEARER` is read at server start ([static-bearer.js](../src/gateway/static-bearer.js)). The UI **guides** token setup (generate + restart); it does not hot-apply a token. A future backend helper to surface "bearer configured?" status is a deferred follow-up.

---

## Part 3 — Dev/build-harness stance (the "both")

Connecting a **developer's** harness is the *same two doors* — opencode-as-a-dev-tool points at `:4711/mcp` for memory and optionally `:4711/v1` for model. No special path.

Separately, the **build harness** (how Mycelium itself is built) is unchanged:
- **Claude Code stays primary** — the autonomous routine ([AUTONOMOUS-ROUTINE.md](AUTONOMOUS-ROUTINE.md)) is Claude-Code-shaped (subagents, hooks, `auto-merge-on-green`).
- **opencode is the recommended secondary dev option** (model-agnostic, LSP, MIT) — documented, not wired into the routine.
- **openclaw + hermes-agent are product-menu options, not dev tools.**

---

## Part 4 — Implementation (slices)

- **Slice A — docs.** This design doc + [`HARNESS-RECIPES.md`](HARNESS-RECIPES.md) (per-harness, both doors, scam note, local-only banner). [`CONNECT-YOUR-AI.md`](CONNECT-YOUR-AI.md) becomes the overview that links here.
- **Slice B — UI + gate.** `portal-app/src/lib/components/settings/HarnessPickerSection.svelte` (curated cards → expandable recipes), mounted in [`SettingsView.svelte`](../portal-app/src/lib/views/SettingsView.svelte) above the existing `ConnectYourAISection` (kept as the "Custom / raw endpoints" reference). Reuses the endpoint/bearer/`copy()` logic from [`ConnectYourAISection.svelte`](../portal-app/src/lib/components/settings/ConnectYourAISection.svelte) and the `.mcp.json` generator from [`LocalConnectSection.svelte`](../portal-app/src/lib/components/settings/LocalConnectSection.svelte). New `scripts/verify-harness-connect.mjs` (PASS/FAIL ledger + `VERDICT: GO`) asserts coverage of every named harness + the scam note + every endpoint string. Update living docs in the same commit.

**Out of scope:** relay/reachability work; any `server-http.js` auth/CORS change (would trigger the real-browser MCP-Inspector gate); new backend routes.

---

## Part 5 — Verification

1. `node scripts/verify-harness-connect.mjs` → `VERDICT: GO`, exit 0; `npm run verify` stays green.
2. Portal build succeeds with the new section.
3. UI smoke (`npm run portal` :8787): picker renders all cards; opencode + openclaw recipes expand; Copy works; openclaw shows the safety note; remote rows show "coming soon".
4. Real local connect: point opencode at `:4711/mcp` with a bearer → it lists Mycelium's tools; optionally model base-URL `:4711/v1` + `mycelium-auto`.
5. Recipes doc renders; card links resolve; living docs updated.

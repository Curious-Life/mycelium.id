# Handoff — G2 Prompt Caching (for a fresh session)

**Date:** 2026-06-19
**Audience:** the next Claude Code session, picking up G2 (prompt caching) cold.
**Companions:** `docs/HARNESS-STATE-AND-GAP-ANALYSIS-2026-06-18.md` (the gap table, G2 row), `docs/HOOK-BUS-DESIGN-2026-06-18.md` (G1, just shipped — the sibling gap).
**Skills to invoke first:** `/claude-api` (prompt-caching reference — re-load it; the facts below are a cache, not a substitute) and `/sweep-first-design` (this touches the hot path).

---

## TL;DR

G2 = make the agent engine use **prompt caching** so the large, stable system preamble isn't re-billed every turn. It's the highest **$/effort** item in the harness gap-analysis. **But it is NOT the slam-dunk it looks like** — see the reframe in §1. Start with a **measurement spike**, not a design. Three providers, three different caching mechanisms (§3). The hard part is a structural one already identified: Mycelium builds `system` as a single **string** with **volatile content (time/activity) interleaved into a large mostly-stable block**, and `cache_control` needs a **structured** system with the stable prefix first. So G2 is a preamble-restructuring + per-adapter change, gated by real cache-hit measurements.

This handoff exists so you **don't re-discover** any of that. Sweep from here.

---

## 1. ⚠️ READ FIRST — the reframe (why "cache the getContext preamble" is too naïve)

The obvious pitch is "the `getContext` preamble is large and stable → cache it." Two facts complicate it:

1. **Min cacheable prefix on Opus 4.8 = 4096 tokens** (Sonnet 4.6 / Fable 5 = 2048; Sonnet 4.5 = 1024). A prefix shorter than the floor **silently won't cache** (`cache_creation_input_tokens: 0`, no error).
2. **The large part of the preamble — `getContext` — is largely *volatile*.** It embeds current time, recent activity/messages, health snapshots — regenerated almost every turn. The genuinely *stable* part (persona + tool instructions) may be **below the 4096-token floor**, so caching it alone yields **nothing** on Opus.

And Mycelium's `streamTurn` is **single-message-in** (history rides the preamble; chat is one user message), so there is **no growing cached message history** like a normal chat loop — the usual multi-turn cache win doesn't apply directly.

**Conclusion:** the cache value depends entirely on *what bytes are actually identical across consecutive turns in one conversation*. That is an empirical question. **Do the spike in §6 before designing anything.** (CLAUDE.md design-rigor: hard evidence over paper reasoning — a spike that reads `usage.cache_read_input_tokens` beats a confident assumption. This is the same discipline that caught the `oAuthProvider` and per-request-transport bugs.)

If the spike shows the stable prefix is too small / too volatile to cache meaningfully, the real G2 work may be **restructuring `getContext`** to split a stable core (mindscape summary, persona, instructions — changes rarely) from a volatile tail (time, recent messages) so the stable core clears the floor and sits before the breakpoint. That's a bigger, more valuable change than "add `cache_control`."

---

## 2. Goal + done-criteria

- **Goal:** measurably cut input-token billing on repeated turns within a conversation by caching the stable prefix, across the providers where it's a real lever (Anthropic primarily).
- **Done when:** a spike + (if warranted) a design proves `usage.cache_read_input_tokens > 0` on consecutive real turns, the stable/volatile split is correct (no silent invalidator), chat stays byte-for-byte unchanged when caching is off, and `cacheRead/cacheWrite` land in usage accounting (the G3-adjacent piece). New gate `verify:harness-caching`. Full `verify` green.

---

## 3. Foundational context — cross-provider caching is THREE mechanisms

| Adapter (in `src/agent/harness.js`) | Mechanism | What G2 must do |
|---|---|---|
| **Anthropic native** | **Explicit** — mark `cache_control: {type:"ephemeral"}` breakpoints (max 4). 5-min TTL default (`ttl:"1h"` opt-in). Reads ≈0.1× input, writes 1.25× → **break-even ~2 requests**. **Min prefix Opus 4.8 = 4096 tokens.** | The real work: split system into stable+volatile, mark a breakpoint at the boundary. **Requires a structured `system` (array of blocks), not the current string.** |
| **OpenAI-compatible** | **Automatic** — no API flag; caches the longest stable prefix >1024 tokens, ~50% discount. | Nothing to set — just keep the prefix byte-stable + first (the same reorder helps it for free). |
| **Ollama / local** | **Automatic KV-cache reuse** (context-shift); no billing — latency only. | Nothing to set — same stable-prefix ordering helps latency. |

**The unifying insight:** all three reward the *same* discipline — **a large, byte-stable prefix first, volatile content last.** Only Anthropic needs the explicit `cache_control` marker. So the core change (preamble reorder/split) benefits everyone; the adapter marker is Anthropic-only.

**Caching mechanics (from `/claude-api` — re-verify by re-loading the skill):**
- Render order is `tools → system → messages`. A byte change anywhere in the prefix invalidates everything after.
- **Silent invalidators** (audit the preamble for these): `datetime.now()` / timestamps in the prefix, UUIDs/request-ids, unsorted JSON (`JSON.stringify` of an object without stable key order), a tool set that varies per request, conditional system sections. **Mycelium's `getContext` injects current time + recent activity → these ARE in the prefix today.**
- **Caches are model-scoped.** The provider-fallback chain (sovereign→frontier→local) pays a cold write on fallback — acceptable (fallback is the exception path).
- Verify with `usage.cache_read_input_tokens` — zero across identical-prefix repeats ⇒ a silent invalidator.
- Pre-warming (`max_tokens:0`) exists but is likely out of scope for v1.

---

## 4. As-built — where the preamble is assembled + where caching attaches

> Line anchors are **pre-G1** (the hook-bus PR #272). G1 shifted `harness.js`'s tool loop (+~16 lines) and `run-turn.js`'s deps. **Re-grep by symbol**, don't trust raw line numbers if you branch post-merge.

**Two assembly paths (chat differs from autonomous):**
- **Autonomous** (`src/agent/run-turn.js`, `runAgentTurn`): builds `system = \`Your name is ${name}. ${systemExtra}\`` (≈line 69) → **appends `getContext`** (≈71, `handlers.getContext({recentMessages})`) → appends the history block (≈81, `hydrateHistoryBlock`) → trims to budget (≈89). **Volatile `getContext` sits in the MIDDLE of the stable text — the silent-invalidator problem in one line.**
- **Chat** (`src/portal-chat.js`): its own preamble assembly (grep `getContext` / `system` around the `loop.run` call ≈line 244–256). Chat is the highest-traffic surface → the main caching beneficiary. **Sweep this path separately.**

**The engine** (`src/agent/harness.js`, `streamTurn`): receives `system` as a **STRING** and hands it to each adapter's `streamOnce`. The **OpenAI adapter** builds `messages: [{role:'system', content: system}, ...]` (≈line 165). The **Anthropic adapter** sends `system` as the Anthropic top-level `system` field (read its body-builder ≈lines 100–145 — confirm exactly how, and whether it's a string or already block-capable). **For `cache_control`, the Anthropic `system` must be an ARRAY of `{type:'text', text, cache_control?}` blocks.** → the stable/volatile split must be carried from assembly → `streamTurn` → adapter (the adapter can't know the boundary itself). **This contract change is the load-bearing design problem.**

**Usage accounting** (`harness.js` `recordUsage` ≈390 + the per-adapter usage parse): today captures `inputTokens`/`outputTokens` from `message_start`/`message_delta`. For caching you must also read `cache_creation_input_tokens` + `cache_read_input_tokens` (Anthropic `message_start.usage` ≈line 116) and thread them through `onUsage` → the `llm_usage` DAL (`src/db/llm-usage.js`). This is the G3-adjacent split (cacheRead/cacheWrite).

---

## 5. Load-bearing assumptions to verify (your verification-table targets)

1. How does each adapter pass `system` to the wire (Anthropic top-level vs OpenAI message vs Ollama)? Is the Anthropic `system` a string or already an array? (`harness.js` adapter bodies.)
2. What is the contract to carry a stable/volatile split through `streamTurn` without breaking the OpenAI/Ollama string path? (Options: pass `{stable, volatile}`; or a sentinel marker; or a structured `system` everywhere.)
3. Across two consecutive real turns in one conversation, **what bytes are actually identical?** (THE spike, §6.)
4. Is the stable prefix ≥ the 4096-token floor (Opus 4.8)? If not, what stable content can be hoisted into it from `getContext`?
5. Where exactly does `getContext` inject time/activity (the silent invalidators)? (`src/tools/*` getContext domain — grep.)
6. Does the chat path (`portal-chat.js`) assemble `system` identically to `run-turn.js`, or differently? (Two reorders, or one shared helper.)
7. How is `usage` parsed per adapter, and what's the path to `llm_usage` for new cache-token fields?
8. Does changing the Anthropic `system` to a block array break any existing gate (`verify:harness` H-series, `verify:chat`, `verify:gateway*`)? (Regression surface.)

---

## 6. Step 0 — the measurement spike (do this BEFORE any design)

A faithful spike that runs real code, isolated (its own `spike/` dir, not wired into product):
1. Take the **current** chat preamble for a real conversation; mark a `cache_control` breakpoint at the end of the stable persona/instructions block (Anthropic adapter, scratch copy).
2. Run **2 consecutive turns** against a real Anthropic key (or a faithful stub that echoes `usage`), same conversation.
3. Read `usage.cache_creation_input_tokens` (turn 1) and `usage.cache_read_input_tokens` (turn 2).
4. **Decision:** if turn-2 `cache_read_input_tokens` is a meaningful fraction of input → the simple breakpoint works, proceed to a small design. If it's ~0 → the stable prefix is below the floor or a silent invalidator is in it → the real work is restructuring `getContext` (stable core vs volatile tail). Record the RESULT.md either way.

This spike decides whether G2 is a 1-day adapter change or a 3-day getContext-restructuring. Don't skip it.

---

## 7. Decision points the session must resolve

- **Split contract** through `streamTurn` (assumption #2) — pick the minimal one that keeps OpenAI/Ollama unchanged.
- **What counts as "stable"** in `getContext` — and whether to restructure it (depends on the spike).
- **TTL** — 5-min default vs 1h (1h doubles write cost; only worth it for bursty gaps). Probably 5-min for interactive chat.
- **Scope** — chat only (highest traffic) first, or all surfaces? Chat is the clear v1 target.
- **Accounting** — add `cacheRead`/`cacheWrite` to `llm_usage` now (small, pairs naturally) or defer.

---

## 8. ⚠️ Coordination with G1 (the hook bus — PR #272)

G1 and G2 are independent features but **both touch `src/agent/harness.js` and `src/agent/run-turn.js`**:
- G1 added tool-hook fires in `streamTurn`'s tool loop + a `hooks`/`surface` ctor option; threaded `hooks` through `run-turn.js`.
- G2 will touch the adapter `system`/body builders + the `run-turn.js`/`portal-chat.js` preamble assembly.

**To avoid merge conflicts: branch G2 off `origin/main` AFTER #272 merges, OR off `feat/hook-bus`.** Do NOT branch off a pre-G1 main and edit the same regions in parallel. Confirm #272's status first (`gh pr view 272`).

---

## 9. Startup checklist (this repo's recurring traps)

1. **`git fetch origin`** — local `main` is often behind origin (docs commits). Branch off `origin/main`.
2. **Concurrent-session collision is LIVE** — the shared `mycelium.id` main tree gets switched to other sessions' branches mid-work (it was on `fix/verify-pipeline-integrity-i7-batch` during the G1 build). **Work in an ISOLATED worktree** (`git worktree add -b feat/prompt-caching <path> origin/main`), `ln -sfn <main-tree>/node_modules <worktree>/node_modules`, commit + push each step early. Confirm isolation with `git rev-parse --show-toplevel` + `git worktree list`.
3. **Python venv can't run in a worktree** — `pipeline/.venv` is path-anchored; symlinking it fails (exit 127). So `npm run verify` halts at `verify:nomic-embedding-encryption` (~12th gate). Your G2 change is JS-only and agent-layer → run the JS gates explicitly (`verify:harness*`, `verify:chat`, `verify:gateway*`, security gates) and note the venv gap; the real env / CI runs the full chain.
4. **`/claude-api`** — re-load it for the authoritative caching syntax (`cache_control` block shape per language, TTL, min-prefix table, the silent-invalidator audit). Don't hand-write the API shape from this doc — verify against the skill.

---

## 10. Reference

- Caching mechanics: `/claude-api` → `shared/prompt-caching.md` (prefix invariant, placement patterns, silent-invalidator table, economics, verifying hits).
- Cross-provider engine reference: `~/Developer/openclaw` (`run-executor.ts` deterministic cache key on job/agent/provider/model; `agent-core/.../types.ts` `cacheRetention` + `cacheRead`/`cacheWrite` accounting) — for how a mature harness models cache tokens.
- The G1 design (`docs/HOOK-BUS-DESIGN-2026-06-18.md`) is the format/quality bar for the G2 design doc (revision history + sweep findings + verification table + threat model + LOC budget + test strategy + impl order).

## 11. Pickup protocol

1. Read this handoff cold, then re-load `/claude-api`.
2. `gh pr view 272` — if G1 unmerged, branch G2 off `feat/hook-bus`; if merged, off `origin/main`. Isolated worktree (§9).
3. **Run the Step-0 spike (§6) FIRST.** Record RESULT.md. Let it decide the design's size.
4. `/sweep-first-design` — sweep assumptions #1–#8 (§5) with file:line; pivot if the spike contradicts the "just add cache_control" plan.
5. Write `docs/PROMPT-CACHING-DESIGN-<date>.md` with a verification table; then build in gated steps; full `verify` (JS gates in-worktree) before any PR.
6. Update memory ([[native-agent-harness-design]]) + this handoff's status when done.
</content>

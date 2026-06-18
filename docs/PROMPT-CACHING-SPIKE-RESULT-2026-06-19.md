# Spike RESULT — G2 Prompt Caching (Step 0, measure-before-design)

**Date:** 2026-06-19
**Branch:** `feat/prompt-caching` (off `feat/hook-bus`)
**Method:** two consecutive real `getContext` calls against the LIVE vault (chat's cloud default `recentMessages:12`), via the authenticated MCP channel. Sizes measured; **no vault plaintext recorded here** (§1).
**Reference:** `docs/HANDOFF-G2-PROMPT-CACHING-2026-06-19.md` §1 (the reframe this spike tests), `/claude-api shared/prompt-caching.md` (floors + economics).

---

## What the spike tested

The handoff's load-bearing question (§5 #3, #4): across two consecutive real turns in one
conversation, **what bytes are identical, and does the stable portion clear Opus 4.8's
4096-token minimum cacheable prefix?** If yes → a small adapter change. If no → either
restructure `getContext`, or the premise is dead.

## Measured (live vault, the developer's own — 58,711 msgs / 1.7 GB, a HEAVY vault by volume)

| Portion | ~est tokens | Stability across chat turns |
|---|---:|---|
| Orientation preamble (persona + `CHAT_SYSTEM`) | ~150 | stable |
| `Current time` (getContext, **emitted FIRST**) | ~15 | volatile — changes every minute |
| FACTS + COGNITIVE PHASE + BODY STATE + CLAIMS | ~285 | stable within a session |
| RECENT MESSAGES (12) — **the largest single block** | ~540 | volatile — changes every turn |
| **Total system preamble** | **~975** | — |
| **Stable subset** (orientation + facts/phase/body/claims) | **~435** | — |

`model.md` (internal model), `flagged.md`, and PEOPLE were **empty** for this vault — the
three unbounded/large stable sources contributed **nothing**. Every other getContext section
is hard-capped (facts ≤30, people ≤20, claims ≤600 tok budget, messages ≤40).

The two consecutive calls were **byte-identical** (same minute, no new message) — confirming
the volatile fields are time + recent-messages, exactly as the code predicted
(`src/tools/context.js:71` time, `:113-130` messages).

## Verdict

**On the default model (Opus 4.8, 4096-token floor), prompt caching of the system preamble
yields exactly ZERO for the realistic vault.**

- Stable subset (~435 tok) is **~9× below** the floor → `cache_creation_input_tokens: 0`, a silent no-op.
- The **whole** preamble (~975 tok) is **~4× below** the floor — and below even OpenAI-compatible's
  ~1024-token automatic floor.
- The dominant block (recent messages, ~540 tok) is **volatile anyway**, and `Current time` sits at the
  very FRONT (`context.js:71`) — poisoning any prefix even if size weren't the blocker.

**Bounding the maximal case:** even a maximally-populated vault's stable sections (excluding
`model.md`) cap out at ~150 (orient) + ~1500 (30 facts) + ~800 (20 people) + ~600 (claims) + ~60
≈ **~3,110 tokens — still below 4096.** Only a large `model.md` would push a vault's stable
prefix over the Opus floor. Most users won't clear it.

## The two levers that DO survive the evidence

1. **Volatile-last reorder (free, zero-risk).** Restructure the preamble so all stable sections
   come first and the volatile tail (`Current time` + RECENT MESSAGES + per-query search hits)
   comes LAST. Costs ~nothing, breaks nothing. Unlocks: OpenAI-compatible **automatic** prefix
   caching (1024 floor, ~50% off) + Ollama **KV reuse** (latency) for any vault that clears their
   lower floors, and is the correct foundation if Anthropic caching is ever worth it. Strictly positive.

2. **Intra-turn tool-loop caching (Opus-effective, bursty).** The handoff under-weighted this.
   Within ONE turn, `harness.js` `streamTurn` makes up to `maxIterations:8` Anthropic calls,
   re-sending `system` + the growing `messages` each round. A single tool result can be up to
   `TOOL_OUTPUT_MAX` ≈ 32 000 chars (~8k tok). A multi-tool turn's **accumulated** prompt readily
   clears 4096 → a `cache_control` breakpoint on the last message block (the "multi-turn" pattern,
   prompt-caching.md) makes iteration N+1 read iterations 1..N at 0.1×. Real on Opus, but only for
   turns with several rounds / large results (research turns, not "hi"). 20-block lookback is safe
   (8 iters = 16 blocks). Needs the Anthropic block-array contract change + cache-token accounting.

## What is PROVEN worthless (do not build)

**System-preamble `cache_control` across turns** — the handoff's headline framing. The preamble
is 4–9× below the Opus floor; it writes nothing. This is the pivot.

## Honest value caveat (for the scope decision)

Mycelium is **single-user, local-first, low-volume** (interactive chat, not a high-QPS service).
Even where caching fires (lever 2, heavy turns), the absolute $ saved per user is small; the
benefit is mostly **latency** on heavy research turns. Lever 1 is worth doing because it's free.
Lever 2 is worth it only if heavy multi-tool turns are common. The original "highest $/effort"
billing-savings framing does not hold for the realistic product.

## Assumptions verified by this spike

| Assumption | Verified at |
|---|---|
| Stable preamble portion is below the Opus 4.8 4096 floor for a real vault | this spike — ~435 tok measured |
| `Current time` is emitted first in getContext (front-of-prefix invalidator) | `src/tools/context.js:71` |
| Recent messages (volatile) dominate getContext by size | this spike — ~540/975 tok |
| `model.md`/`flagged.md`/people are the only unbounded stable sources, often empty | `src/tools/context.js:77-110`; empty here |
| `trimToTokenBudget` trims the TAIL → preserves any stable prefix | `src/inference/token-budget.js:99-104` |
| Anthropic adapter sends `system` as a STRING (no block array, no cache_control) | `src/agent/harness.js:105` |
| Anthropic usage parse ignores cache tokens today | `src/agent/harness.js:117,129` |

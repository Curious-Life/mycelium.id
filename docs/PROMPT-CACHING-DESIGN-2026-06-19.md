# Design — G2 Prompt Caching (two levers, evidence-gated)

> **BUILD STATUS (2026-06-19): BUILT + GATED on `feat/prompt-caching`.** All four impl steps
> shipped — Lever 1 (getContext volatile-last reorder), Lever 2 core (Anthropic intra-turn
> `cache_control` breakpoint + `MYCELIUM_PROMPT_CACHE` off-switch), accounting (turn-level usage
> accumulation + cache-token parse + `llm_usage` columns + migration `0024`). New gate
> `verify:harness-caching` GO; 18 regression gates GO (harness family, gateway, mcp, chat, usage);
> migration idempotency proven (apply-twice). NOT live-smoked against a real Anthropic key (no key
> in env) — the cache_read>0 confirmation is contractual (prompt-caching.md) + the body-shape is
> gated; an operator live-smoke is the only remaining check. PR pending (egress-adjacent → human approval).

**Date:** 2026-06-19
**Branch:** `feat/prompt-caching` (off `feat/hook-bus` — coordinates with G1/PR #272; rebase onto `origin/main` before PR)
**Companions:** `docs/HANDOFF-G2-PROMPT-CACHING-2026-06-19.md` (the brief), `docs/PROMPT-CACHING-SPIKE-RESULT-2026-06-19.md` (Step-0 measurement — read first), `docs/HOOK-BUS-DESIGN-2026-06-18.md` (the quality/format bar).
**Skill:** `/claude-api shared/prompt-caching.md` (floors, economics, the prefix invariant), `/sweep-first-design`.

---

## Revision history

- **v1 (handoff premise):** "The `getContext` system preamble is large + stable → cache it with `cache_control`." Expected: highest $/effort item.
- **v2 (this doc, post-spike PIVOT):** the Step-0 spike measured the **real** chat preamble against the live vault: **~975 tokens total, ~435 stable — 4–9× below Opus 4.8's 4096-token floor.** System-preamble caching writes **nothing** on the default model. The headline lever is **dead**. Two narrower levers survive and are what this doc builds:
  1. **Volatile-last reorder** of the preamble (free; unlocks OpenAI-auto + Ollama-KV; correct foundation).
  2. **Intra-turn tool-loop caching** on the Anthropic adapter (Opus-effective for multi-tool turns, where accumulated tool results clear the floor) + cache-token accounting.
  System-preamble `cache_control` (v1's plan) is **explicitly NOT built** — proven worthless.

---

## Sweep findings (consolidated, file:line)

**Two preamble assembly paths, both build `system` as a single string:**
- Chat (highest traffic): `src/portal-chat.js:227-241` — `[orientation] + getContext + searchMindscape-hits`, then `trimToTokenBudget`.
- Autonomous: `src/agent/run-turn.js:69-90` — `[name+role] + getContext + history-block`, then trim. Stable prefix here is *tiny* (`"Your name is X. <systemExtra>"`).

**`getContext` (`src/tools/context.js:60-174`) interleaves volatile + stable:**
- `:71` `Current time` — emitted **FIRST**, changes every minute (front-of-prefix invalidator).
- `:113-130` RECENT MESSAGES — volatile, the **largest** block (~540/975 tok measured), sits in the **middle**.
- `:77-110,133-171` model.md / flagged / facts / people / phase / body / claims — stable within a session; the unbounded sources (model.md, flagged, people) were **empty** in the measured vault.

**The three adapters (`src/agent/harness.js`):**
- Anthropic `streamOnce:104-107`: `body.system = system` (a **STRING**, top-level field); usage parse `:117,129` reads only `input_tokens`/`output_tokens` — **no cache tokens**. Messages built via `init:94` (string content) / `pushToolResults:102` (array of `tool_result` blocks).
- OpenAI `:165-166`: system as a `{role:'system',content:string}` message — **automatic** prefix caching (≥1024 tok), nothing to mark.
- Ollama `:234-238`: system in a message — **automatic** KV reuse, latency only.

**The tool loop (`harness.js:405-456`) is the real Opus-caching opportunity:** up to `maxIterations:8` (`:55`) `streamOnce` calls per turn, each re-sending `system` + the **growing** `messages`. One tool result can be `TOOL_OUTPUT_MAX` ≈ 32 000 chars ≈ 8k tok (`:44`). A multi-tool turn's accumulated prompt readily clears 4096 → caching across iterations pays.

**Supporting facts:**
- `trimToTokenBudget` (`src/inference/token-budget.js:99-104`) trims the **tail** → preserves any stable prefix. ✓
- `applyMigrations` re-execs every file each boot but **guards every bare `ALTER TABLE … ADD COLUMN`** by column-existence (`src/db/migrate.js:33-37`; `migrations/0004` is the multi-ADD precedent) → adding cache columns is idempotent-safe.
- No consumer parses getContext positionally (`src/server-http.js:528` returns the bare string; `portal-chat.js:228` / `run-turn.js:71` append it) → reordering sections is safe.
- Usage flow: adapter `usage` → `recordUsage` (`harness.js:391`) → `onUsage` → `createUsageSink` (`src/inference/usage.js:41`) → `db.usage.record` (`src/db/llm-usage.js:53`, INSERT into `llm_usage`).

---

## What this builds (module shape)

### Lever 1 — volatile-last reorder (`src/tools/context.js`)

Split section assembly into two arrays; emit stable first, volatile last:

```js
const stable = [];     // mind(model+flagged), facts, people, phase, health, claims
const volatile = [];   // Current time, RECENT MESSAGES
// ...push each section into the right array (same content, same guards)...
return [...stable, ...volatile].join('\n\n');
```

- **No content change**, no schema change, no contract change — only emission order.
- `Current time` moves from first → last. Tradeoff: the date is still always present (the `:9` anti-hallucination intent holds — an LLM reads the whole blob); it just sits at the end. Documented.
- Search hits (`portal-chat.js:231`) already append **after** getContext → all volatile content ends up clustered at the tail. ✓
- **Effect:** stable prefix becomes contiguous at the front. Helps OpenAI-auto (≥1024) + Ollama-KV for any vault that clears their floors, and is the correct foundation for Anthropic. **No-op (but harmless) on small vaults** like the measured one. ~15 LOC.

### Lever 2 — intra-turn tool-loop caching (`src/agent/harness.js`, Anthropic adapter only)

Mark **one** `cache_control` breakpoint on the **last content block of the last message** each `streamOnce` (the prompt-caching.md "multi-turn" pattern — caches `tools`+`system`+all prior `messages` together, since they render before it):

```js
const CACHE_ON = process.env.MYCELIUM_PROMPT_CACHE !== '0';   // default ON, off-switch
function withCacheBreakpoint(messages) {
  if (!CACHE_ON || !messages.length) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  const content = typeof last.content === 'string'
    ? [{ type: 'text', text: last.content }]      // wrap string content
    : last.content.slice();                        // clone block array
  const tail = { ...content[content.length - 1], cache_control: { type: 'ephemeral' } };
  content[content.length - 1] = tail;
  out[out.length - 1] = { ...last, content };
  return out;
}
// in anthropicAdapter.streamOnce: body.messages = withCacheBreakpoint(messages)
```

- **Adapter-local** — no change to `streamTurn`, `run-turn.js`, `portal-chat.js`, or any caller. OpenAI/Ollama untouched.
- **Graceful below floor:** Anthropic silently writes nothing when the prefix <4096 (`cache_creation_input_tokens:0`) — zero harm on small turns.
- **20-block lookback safe:** 8 iterations × 2 blocks = 16 < 20 (`harness.js:55`). Noted: if `maxIterations` rises, add an intermediate breakpoint.
- **Off-switch:** `MYCELIUM_PROMPT_CACHE=0` restores byte-identical bodies (used by tests that assert exact body).
- ~25 LOC.

### Lever 2 (pair) — cache-token accounting

- Anthropic `streamOnce` usage parse (`harness.js:117`): also read `ev.message.usage.cache_creation_input_tokens` + `cache_read_input_tokens` → `usage.cacheWriteTokens` / `usage.cacheReadTokens`. (Optional cheap add: OpenAI `ev.usage.prompt_tokens_details.cached_tokens` → `cacheReadTokens`.)
- `recordUsage` (`harness.js:391`): pass `cacheReadTokens`/`cacheWriteTokens` through `onUsage`.
- `createUsageSink` (`usage.js:41`): already spreads `...e` → no change needed beyond the record DAL.
- `db.usage.record` (`llm-usage.js:53`): add the two columns to the INSERT (default 0 when absent). `summary.totals` optionally sums them (defer the portal read surface).
- **Migration** `migrations/0024_llm_usage_cache_tokens.sql`:
  ```sql
  ALTER TABLE llm_usage ADD COLUMN cache_read_tokens INTEGER DEFAULT 0;
  ALTER TABLE llm_usage ADD COLUMN cache_write_tokens INTEGER DEFAULT 0;
  ```
- ~15 LOC + 1 migration. Counts only, never text (§1).

---

## Threat model

- **Egress boundary unchanged.** Caching does not change *what* plaintext is sent to the provider — only that Anthropic retains the (already-sent) prefix in an **ephemeral** (5-min) server-side cache, scoped to the user's own API key/org. The caller (`portal-chat`/§4g policy) already decided cloud is acceptable for this content; caching does not widen the trust boundary. Local/Ollama has no server retention. **Accepted**, documented; `MYCELIUM_PROMPT_CACHE=0` opts out.
- **No new plaintext surface.** `cache_control` is a marker on blocks already being sent; egress audit (`harness.js:382-387`, hash+len) is unchanged. Cache-token accounting is **counts only** (§1), same boundary as the existing token accounting.
- **Fail-open optimization.** Caching is a no-op below floor and disable-able; a wrong breakpoint costs at worst a missed cache (never a correctness bug). It cannot block or alter a turn.

---

## Edge cases — explicit decisions

| Case | Decision |
|---|---|
| Vault below the floor (the common case) | Anthropic writes nothing (silent no-op). Lever 1 still reorders (harmless). No error, no harm. |
| String vs array message content | `withCacheBreakpoint` wraps string content into a `[{type:'text'}]` block before marking. |
| Final no-tools answer pass (`harness.js:464`) | Also routed through `withCacheBreakpoint` (it calls `streamOnce` directly) → reads the cache the loop wrote. |
| Provider fallback mid-turn (`run-turn.js:57-61`) | Caches are model-scoped; fallback pays a cold write — acceptable (exception path). |
| `maxIterations` raised >9 | 20-block lookback could miss; noted as a follow-up (add intermediate breakpoint). Not a v1 concern. |
| Sensitive/jurisdiction turn | Already routed by §4g before the harness; if it reached a cloud provider it was deemed OK. Caching stays within that decision. |
| Tests asserting exact Anthropic body | `MYCELIUM_PROMPT_CACHE=0` restores the prior body byte-for-byte. |

---

## Test strategy (new gate `verify:harness-caching`, `scripts/verify-harness-caching.mjs`)

- **C1** `withCacheBreakpoint` marks the last block of the last message; string content wrapped; earlier messages untouched.
- **C2** Default-ON: the Anthropic `body.messages` last block carries `cache_control:{type:'ephemeral'}`; `MYCELIUM_PROMPT_CACHE=0` → no marker, body byte-identical to pre-change.
- **C3** OpenAI + Ollama bodies are **unchanged** (no `cache_control` anywhere) regardless of the flag.
- **C4** Usage parse: a `message_start` carrying `cache_creation_input_tokens`/`cache_read_input_tokens` populates `usage.cacheWrite/cacheReadTokens`; absent → 0.
- **C5** `recordUsage` threads cache tokens into `onUsage`; `db.usage.record` INSERTs them (in-memory sqlite stub) and reads back.
- **C6** Lever 1: getContext output places `Current time` + `RECENT MESSAGES` **after** all stable sections (assert index ordering); `include` filter still works; byte-content of each section unchanged.
- **C7** Multi-iteration integration (self-contained SSE fixture, mirrors `verify-harness.mjs`): a 2-tool-round turn marks a fresh breakpoint each `streamOnce`; below-floor fixture asserts the no-op path still completes.
- **Regression:** `verify:harness`, `verify:harness-loop`, `verify:chat`, `verify:usage`, `verify:gateway*` stay GREEN (run explicitly — venv blocks the full chain in-worktree, see handoff §9).

---

## Implementation order (each independently shippable + gated)

1. **Lever 1** — getContext volatile-last reorder + C6. Smoke: `node scripts/verify-harness-caching.mjs` (C6 subset) + `verify:chat`.
2. **Lever 2 core** — `withCacheBreakpoint` + Anthropic adapter wiring + flag + C1-C3, C7. Smoke: `verify:harness` + `verify:harness-caching`.
3. **Accounting** — usage parse + `recordUsage` passthrough + DAL + migration 0024 + C4-C5. Smoke: `verify:usage` + `verify:harness-caching`.
4. **Regression sweep** — curated JS gates GREEN; update memory + handoff status; PR (do NOT auto-merge — egress-adjacent).

LOC budget: ~60 product LOC + 1 migration + ~220 LOC gate. (±20%.)

---

## Decision criteria for "is Lever 2 paying off" (post-ship, falsifiable)

Query `llm_usage`: `SUM(cache_read_tokens) / SUM(cache_read_tokens + input_tokens)` over chat turns. If cache reads are a non-trivial fraction on heavy-tool days → it's working. If ~0 after weeks (turns are mostly 0-1 tool calls) → the lever is inert for this usage pattern; consider reverting Lever 2 and keeping only Lever 1.

---

## Verification table

| Assumption | Verified at |
|---|---|
| Real chat stable prefix is below Opus 4.8's 4096 floor → system-preamble caching is worthless | spike RESULT (~435 tok measured) + `/claude-api` floor table |
| Anthropic adapter sends `system` as a string; messages built via init/pushToolResults | `src/agent/harness.js:105,94,102` |
| Anthropic usage today ignores cache tokens | `src/agent/harness.js:117,129` |
| Tool loop re-sends growing messages up to 8× per turn (the intra-turn lever) | `src/agent/harness.js:55,405-456,464` |
| One tool result can reach ~8k tok → multi-tool turns clear the floor | `src/agent/harness.js:44` |
| 20-block lookback safe at 8 iterations (16 blocks) | `src/agent/harness.js:55` + `/claude-api` lookback note |
| `trimToTokenBudget` trims the tail → preserves a stable prefix | `src/inference/token-budget.js:99-104` |
| `ALTER TABLE … ADD COLUMN` is made idempotent across re-exec | `src/db/migrate.js:33-37`; `migrations/0004_context_bank.sql:14-17` |
| No consumer parses getContext positionally → reorder is safe | `src/server-http.js:528`, `src/portal-chat.js:228`, `src/agent/run-turn.js:71` |
| Usage path to `llm_usage` for new cache fields | `usage.js:41-46` → `llm-usage.js:53-69` |
| OpenAI/Ollama need no marker (automatic) | `/claude-api shared/prompt-caching.md` + `harness.js:166,238` |

---

## Open questions deferred

- **Portal Usage read surface** for cache tokens (the `/portal/usage` cards) — store now, surface later; out of scope.
- **Pre-warming** (`max_tokens:0`) — not worth it for low-volume single-user interactive chat (prompt-caching.md "skip when… traffic continuous / prefix small").
- **getContext stable/volatile split as a structured return** (so the Anthropic *system* could be block-marked) — only worth it for power-users whose stable context clears 4096; revisit if `model.md`-heavy vaults appear. Not built.

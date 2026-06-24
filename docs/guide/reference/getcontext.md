# `getContext` — orient first

**If you build one habit into your agent, make it this: call `getContext` at the start
of every conversation.**

`getContext` is the preamble. In one call it hands the agent a compact, current
briefing about the user — who they are, what's on their mind, how they like to be
treated — so the rest of the conversation is grounded instead of guessing. Then the
agent pulls detail on demand with [`searchMindscape`](mcp-tools.md#search--recall) and the
other tools.

This is the difference between an assistant that *has access to* your memory and one
that actually *shows up knowing you*.

## When to call it

- **Once, at the top of a conversation**, before responding to the user's first
  message.
- Optionally again after a long gap, or when the topic shifts hard enough that a fresh
  orientation helps.

It's cheap and read-only. There's no harm in calling it first, every time.

## What it returns

A single Markdown briefing — human-readable, ready to drop into a system preamble.
Every section is best-effort: missing subsystems are simply skipped (a fresh vault
returns a clean, mostly-empty briefing, not an error).

| Section | What it contains |
|---|---|
| **Current time** | Date, weekday, and time in the user's timezone. |
| **Internal model** | The agent's own private working notes about the user (never shown to the user). |
| **Flagged for discussion** | Topics the agent previously flagged to raise this conversation. |
| **Facts you know** | Top durable facts (category / key / value), pinned first. Sensitive facts excluded. |
| **People & projects** | Top entities (people, projects, places, orgs) with summaries, pinned first. Sensitive excluded. |
| **Recent messages** | The last *N* messages across channels (default 10), pinned first. |
| **Cognitive phase** | The user's current phase (stable / cycling / exploring / transforming), when the mindscape is computed. |
| **Body state** | Recent Apple Health averages (sleep, HRV, resting HR, steps), if synced. |
| **Persona claims** | The most confident durable claims about the user (values, identity, boundaries). |

## Parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `recentMessages` | integer 1–40 | `10` | How many recent messages to include. |
| `include` | string[] | all | Restrict to a subset of sections: `mind`, `facts`, `people`, `messages`, `phase`, `health`, `claims`. |

```jsonc
// Minimal — the whole briefing
{}

// Trim it: just facts, people, and the last 5 messages
{ "include": ["facts", "people", "messages"], "recentMessages": 5 }
```

## What's deliberately *not* in it

- **Nothing marked sensitive.** Sensitive facts and entities are excluded from the
  preamble entirely — they're recallable only when the user explicitly searches for
  them, never surfaced proactively.
- **Raw vault contents.** `getContext` is a curated briefing, not a dump. For depth on
  any thread, follow up with `searchMindscape`.
- **Anything that would blow the budget.** Sections are capped (e.g. top-30 facts,
  top-20 entities) and the persona-claims section is token-budgeted, so the preamble
  stays small enough to prepend to every turn.

## Pattern: orient → recall → act

```
1. getContext            → "Here's who I'm talking to and what's live."
2. searchMindscape       → pull the specific thread the user just raised
   (use relatedTo: <the user's message> for proactive recall)
3. …answer the user…
4. captureMessage        → save the turn so next time getContext is richer
   remember / mark        → persist durable facts; pin or mark-sensitive as needed
```

Steps 1 and 4 are what make Mycelium *compound*: the more faithfully you capture, the
sharper every future `getContext` becomes.

## Over the gateway, automatically

If you connect through the **model gateway** instead of MCP, you don't have to call
`getContext` yourself — add the capture header and the gateway injects the preamble for
you. See **[Memory bridge](memory-bridge.md)**.

---

→ Next: the full **[MCP tool reference](mcp-tools.md)**.

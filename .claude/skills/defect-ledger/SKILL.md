---
name: defect-ledger
description: >-
  Use whenever a QA defect changes state — a user reports a bug, a fix PR merges,
  the operator confirms (or fails to confirm) a symptom is gone, a sprint opens or
  closes, or someone asks "is this fixed?" / "have we seen this before?" / "what's
  recurring?". Enforces the permanent defect record in docs/QA-DEFECT-LEDGER.md:
  stable D-nnn ids that are never renumbered, a recurrence counter instead of a new
  id, RECURRING kept separate from CARRIED, and a CLOSED bar that requires a merged
  PR AND a gate that fails on the old behaviour AND operator confirmation on a build
  they ran. Refuses to close a defect on a merged PR alone, and refuses to close on
  absence of evidence ("no crash observed yet") — the exact mistake that let the
  compute-crash defect recur one release later. Gated by `npm run verify:defect-ledger`.
---

# Defect ledger discipline

`docs/QA-DEFECT-LEDGER.md` is the **permanent** status record. Sprint plans
(`docs/QA<N>-SPRINT-PLAN-<date>.md`) own *this cycle's work* and reference `D-nnn` ids; they
**never** own status. When the two disagree, the ledger wins.

## Why this exists

Sprint plans renumber defects every cycle. QA6 called the engine-select bug `P1.6`; QA7 called it
`P3.1` — the same defect, its second appearance, with one failed fix in between. Neither document
made that visible. **Renumbering hides recurrence**, and recurrence is the single most useful
quality signal a product team has.

## The rules

1. **New defect → new `D-nnn`, same day.** Assigned once. Never renumbered, never reused.
2. **A returning defect increments `↻` on its existing id.** It does not get a new one.
3. **CLOSED needs three things:**
   - a merged PR, **and**
   - a gate that **fails on the old behaviour** (mutation-test it — see below), **and**
   - **operator confirmation on a build they actually ran.**

   Two of three is `MERGED-UNCONFIRMED`. **A merged PR is not a closed defect.**
4. **Never close on absence of evidence.** QA6 closed its compute-crash item on *"no crash observed
   yet on 1.11"*. It crashed the operator's machine on 1.12. If nobody has *looked*, the state is
   MERGED-UNCONFIRMED, not CLOSED.
5. **Keep RECURRING and CARRIED apart.** Fixed-and-came-back is an *engineering* failure; named-and-
   never-attempted is a *prioritisation* failure. Different remedies. Merging the two categories
   hides both.
6. **Record the reported symptom next to the fix.** This is the check that catches a too-narrow fix
   before it becomes a recurrence.
7. **ESCAPED** (reached a public release, found by a user) is tracked separately — it measures the
   gate suite, not the code.

## The failure mode this is designed to catch

**Both recurrences to date happened because the fix was narrower than the report.**

| Reported | What shipped | Result |
|---|---|---|
| "the machine crashes" | stage ordering *inside ingest* (`#329`) | crashed again, `D-001 ↻2` |
| "Illuminate does nothing" | added a route | the skip predicate still starves it, `D-004 ↻1` |

Both times the nearest tractable sub-problem was fixed and the *report* was marked done. Before
moving anything to CLOSED, restate the user's original words and show the fix addresses **those**.

## When you act

**A user reports a bug** → search the ledger first. Existing id? Increment `↻`, move to OPEN, note
what the previous fix addressed and why it wasn't enough. No match? New `D-nnn`.

**A fix PR merges** → `MERGED-UNCONFIRMED`, with the PR and the reported symptom recorded. Do not
write CLOSED.

**The operator confirms a symptom is gone** → CLOSED, but only if a gate also fails on the old
behaviour. If there is no such gate, say so plainly and keep it MERGED-UNCONFIRMED.

**A sprint opens** → review CARRIED (schedule or drop honestly) and RECURRING (these get priority —
they already cost a review cycle and the user's trust).

**A sprint closes** → what moved to CLOSED *with evidence*, and what is still MERGED-UNCONFIRMED.
Update the scoreboard; `verify:defect-ledger` fails if the counts drift.

## Gate

```bash
npm run verify:defect-ledger
```

Asserts the mechanical invariants only: ids unique (a duplicate means a renumber), scoreboard counts
match their sections, no CLOSED row with a blank evidence cell, every sprint-plan `D-id` reference
resolves, and the CLOSED bar is still stated in the file. All five checks are mutation-tested.

It claims **nothing** about whether a defect is actually fixed — that is human judgement. It only
makes the bookkeeping impossible to break by accident.

## Related

`/handoff-discipline` (session-end), `/living-docs` (what the system *is*), `/deploy-and-verify`
(the gate run before "done"). This skill covers what is *broken* and whether it stayed fixed.

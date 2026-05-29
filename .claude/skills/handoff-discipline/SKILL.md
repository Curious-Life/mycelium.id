---
name: handoff-discipline
description: >-
  Use proactively when ending a working session that produced commits or
  decisions, before context compaction, when a phase of multi-phase work
  completes, when the user signals end-of-session ("compact", "wrap up",
  "we'll continue later", "next session", "let's stop here", "handoff"),
  or when work is being parked/paused. Enforces the discipline of writing
  a structured handoff doc that lets a fresh session pick up cleanly with
  no re-discovery. The handoff is the artifact that proves the work is
  recoverable across sessions; without one, every compact loses
  unrecoverable context. Pairs with /sweep-first-design (verifies a
  design was written), /deploy-and-verify (verifies deploys are
  documented), and /pre-deletion-caller-audit (verifies the audit table
  persists).
---

# Handoff-Discipline Protocol

Before a session ends — whether by compaction, user pause, or natural stopping point — write a handoff doc. The handoff is not optional. It is the artifact that proves the work survives the session boundary.

This is the fourth leg of the operational discipline alongside `/sweep-first-design` (additions), `/deploy-and-verify` (shipping), and `/pre-deletion-caller-audit` (subtractions). Where those govern *doing* the work, this governs *bequeathing* the work.

A session without a handoff has produced ephemeral knowledge — even if commits shipped, the rationale, the pivots, the open decisions, the gotchas, the pickup protocol all live only in the operator's memory and the conversation transcript. The transcript can be lost, summarized into compaction artifacts, or simply not re-read. The handoff is the durable record.

## When this skill applies

YES — invoke when:
- The user says "compact", "wrap up", "let's stop here", "next session", "we'll continue later", "handoff", "wrap this up", "end of session", "let's pause".
- A multi-step task ships its phase: design doc done, commits landed, ready to hand off the next phase.
- The conversation has produced ≥1 commit and is winding down.
- A long investigation concludes (root cause found, decision made, fix planned or shipped).
- Before invoking `/compact` proactively (write the handoff first; compaction reads from it).
- Returning to work after operator interruption ("I'll be back in a few hours, ship what's safe and write a handoff").
- A blocker has been hit and work is parking until the blocker clears.

NO — skip when:
- The session was purely conversational (no commits, no decisions made worth persisting).
- The user invoked a one-shot Q&A.
- The work is single-step trivial (renamed a variable; fixed a typo).
- A handoff for this exact phase was just updated and nothing has changed since.

## Step 1 — Audit what produced this session

Before writing, list:
- **Commits shipped** (with hashes, file by file).
- **Files created or significantly modified** (paths only — file content lives in the diff).
- **Design decisions made** (with rationale and any pivots).
- **Findings/learnings** that contradict, refine, or add to the prior understanding (THESE are the most valuable; they're what dies if not written).
- **Failed approaches** that were tried and abandoned (saves the next session from rediscovering).
- **Open questions** that remain.
- **Production state changes** (deploys, migrations applied, services restarted).

A handoff with nothing to put in these buckets is suspicious — either the session was unproductive, or the audit was lazy. Re-check before writing nothing.

## Step 2 — Locate the right handoff target

The Mycelium convention: `docs/<TOPIC>-HANDOFF-<YYYY-MM-DD>.md`. Examples canonical to this codebase:
- `docs/EGRESS-PROVENANCE-HANDOFF-2026-05-06.md`
- `docs/CLAUDE-SUBSCRIPTION-HANDOFF-2026-05-05.md`
- `docs/D1-COST-HANDOFF-2026-05-06.md`

**Update an existing handoff** when the session continued the same work thread. Add a session-summary section dated to today; preserve prior content untouched. The doc grows over time; treat it as append-mostly with structural updates only when status materially shifts.

**Write a new handoff** when the session opens a new work thread that doesn't fit any existing handoff (new investigation, new module, new phase plan).

**Don't fragment** by writing tiny per-session handoffs for the same thread. Three handoffs for the same work make pickup harder, not easier — the next session has to read all three.

## Step 3 — The handoff document spec

Mirror the canonical format (CLAUDE-SUBSCRIPTION-HANDOFF or EGRESS-PROVENANCE-HANDOFF). Required sections:

### a. Header
```
# <Topic> — Handoff Doc
**Date:** YYYY-MM-DD
**Companions:** (links to plan doc, design docs, predecessor handoffs)
**Audience:** the next Claude Code instance picking up this work.
```

### b. TL;DR — current state
A status block that's instantly scannable. Phase table for multi-phase work; commit table for ship-oriented work. Examples:
```
Phase 0   commit b5ac696   ✅ shipped admin + fleet
Phase 1   commit def925b   ✅ shipped admin + fleet
Phase 2   step 1 ✅ admin   step 2-4 pending
```
or
```
B1   commit b9fb7dd   shipped admin   stderr visibility on resume failure
B2   pending          fate TBD        downgraded after correcting failure rate (99.4%)
```

Be specific about scope (admin-only vs full fleet). Be specific about commit hashes. The TL;DR is the only thing the next session is guaranteed to read.

### c. Session summary (when appending to existing handoff)
A dated section: "## YYYY-MM-DD <morning|PM> session summary — start here when picking up". Contains:
- **What shipped this session** — table of commits with scope + description.
- **What was learned** — findings/pivots/corrections to prior diagnoses. THESE ARE THE MOST IMPORTANT LINES IN THE DOC.
- **Operator's directional calls** — decisions the operator made about scope, direction, sequencing.
- **Pickup protocol for next session** — concrete: read these files, in this order, run these probes to verify, decide these things.
- **Open decisions for the operator** — named, with options.

### d. Engineering principles (for new handoff docs only)
What discipline earned its keep this session. Not generic platitudes — specific examples:
> "Three sweep cycles caught a hidden third Layer-B caller (`recovery.notifyRecovery`) on the third pass. Without it the migration would have shipped half-complete."

Skip this section when appending; it lives in the original.

### e. Phase status / commit detail
Per-phase or per-commit detail with:
- File paths modified.
- LOC delta (if material).
- Test status.
- Smoke-test result.
- What the change locks in / unlocks for next phase.

### f. Production state
Per VPS / fleet host, what's deployed:
```
| VPS | Phase 1 | Phase 2 step 1 | Notes |
|---|---|---|---|
| admin | ✅ | ✅ | Live deploys 2026-05-06 |
| 0mm | ✅ | — | Customer fleet HOLD |
| puh | ✅ | — | Customer fleet HOLD |
| nati | ✅ | — | Customer fleet HOLD |
```

Verification commands so a fresh session can re-confirm:
```
ssh mycelium-vps "cd /home/claude/mycelium && git log -1 --format='%h'"
# expected: 9789f3c
```

### g. Gotchas + lessons
With dates and citations. Examples that earned their keep in this codebase:
- "1Password CLI Touch ID can't surface in Claude bash sessions (2026-05-06)"
- "chat.test.js dedupe failures are pre-existing — verified via stash + baseline (commit fad28d5, 2026-04-23)"
- "Hidden third Layer-B caller `recovery.notifyRecovery` (Phase 1 design 2026-05-06)"

Each gotcha names the date so future sessions can decide whether it still applies.

### h. Open decisions for the operator
NOT vague gestures. Concrete options, with the recommendation if you have one. Examples:
- "Sub-agent reply during parent's active turn: (1) accept the edge case, (2) per-turn token plumbing, (3) PID check via SO_PEERCRED. Recommendation: option 1, revisit if audit shows it firing."
- "Customer fleet rollout for B1: wait 24h or ship symmetric now? Risk: minimal (one log statement)."

### i. Pickup protocol
The most important section. A concrete checklist a fresh session can execute step-by-step:
```
1. Read this handoff cold. Don't skim.
2. Read the companion design doc for the in-flight phase.
3. Verify production state matches: `git log` on admin should show <hash>.
4. Run /sweep-first-design before any structural change.
5. Run /deploy-and-verify after any deploy.
6. Decide: ship next step now, or wait for observation data?
```

### j. Glossary (when terms are session-specific)
Define terms used throughout that aren't standard. "Layer A vs Layer B", "system-template", "active-turn registry" all needed glossary entries in the egress-provenance work. Skip when terms are project-standard.

### k. Deploy runbook (for ship-oriented work)
Exact commands, in order, with expected output. Mirrors `/deploy-and-verify`'s ledger format but tailored to the specific phase.

## Step 4 — Update MEMORY.md and CLAUDE.md cross-references

After writing the handoff doc:
- **MEMORY.md "In Progress" entry** — add or update a one-liner pointing at the handoff with the most-recent finding/status. Keep under ~150 chars; the index gets truncated past 200 lines.
- **CLAUDE.md** — update only if the handoff introduces a load-bearing operational change (new env var, new deploy step, new principle). Most handoffs don't qualify.

The MEMORY.md entry is the discoverability surface for the next session. If the entry doesn't say "read this handoff doc", the doc may as well not exist for cross-conversation purposes.

## Step 5 — Verify the handoff (the verification table for the verification doc)

Before declaring the handoff done, audit:

| Check | Pass criterion |
|---|---|
| Every commit named with hash | Every. Hash. |
| Every cited file path is correct | Spot-check via Read on a few |
| Every claim about production state has a verification command | At least one per VPS |
| Open decisions are concrete (options + recommendation) | Not "we should think about this" |
| Pickup protocol is executable, not aspirational | A fresh session can follow each step |
| Predecessor handoffs are linked | Chain exists, not orphan |
| Today's gotchas have dates | YYYY-MM-DD on each |
| MEMORY.md updated | One-liner pointer present |
| Failed approaches noted | Saves rediscovery |

If any row fails — fix it before considering the handoff complete. A handoff with placeholders or "TBD" is technical debt the next session pays.

## Anti-patterns to refuse

- **"We made progress"** — vague, useless. Either name what shipped + what was learned, or admit nothing tangible happened.
- **No commit hashes** — citations without hashes are unverifiable. Always include the short SHA.
- **"Trust me" claims about production state** — without a verification command, the claim is fiction by next week.
- **Updating only the conversation transcript, not a doc** — transcripts get summarized, lost, paged out. Docs persist.
- **Writing a handoff at the end of a 6-hour session, all at once** — by then half the rationale is forgotten. Update the handoff incrementally, mid-session, when each phase ships.
- **Forking handoffs per session for the same work thread** — three docs for one phase make pickup harder. Append to the existing handoff with dated sections.
- **Treating the handoff as the operator's job** — the operator may not write it, may write it badly, or forget. The agent writing the work is the right party to write the handoff.
- **No open-decisions section** — the next session inherits decisions you didn't make. Name them.
- **No pickup protocol** — the most expensive omission. Without a step-by-step pickup, the next session re-discovers the architecture from scratch.
- **Handoff written but MEMORY.md not updated** — the doc is invisible to cross-session memory recall. Cross-link or it's orphaned.

## What good handoffs look like in this codebase (canonical examples)

Read these to calibrate your output:

- **[docs/CLAUDE-SUBSCRIPTION-HANDOFF-2026-05-05.md](../../../docs/CLAUDE-SUBSCRIPTION-HANDOFF-2026-05-05.md)** — multi-PR work with clear phase tracking, gotchas with dates, pickup protocol up front.
- **[docs/EGRESS-PROVENANCE-HANDOFF-2026-05-06.md](../../../docs/EGRESS-PROVENANCE-HANDOFF-2026-05-06.md)** — multi-phase + multi-session; dated session summaries appended; operator's directional calls preserved.
- **[docs/D1-COST-HANDOFF-2026-05-06.md](../../../docs/D1-COST-HANDOFF-2026-05-06.md)** — investigation-style handoff with specific findings + change-by-change ledger.

## Cadence — write the handoff INCREMENTALLY, not at session end

The most valuable handoff entries are the ones written *while the rationale is fresh* — right after the pivot happens, right after the smoke-test result lands. Two patterns:

**Pattern A — phase-shipped triggers handoff update.** When a commit lands on admin + verify-deploy passes + smoke-test confirms, immediately update the handoff with what just shipped, what the smoke confirmed, and what's pending next. Do NOT wait until "end of session" — by then the specifics blur.

**Pattern B — pivot-discovered triggers handoff update.** When a sweep contradicts a design, when a hypothesis falsifies, when a number turns out wrong (e.g. "0 successful resumes" → "99.4% success"), document the pivot IMMEDIATELY in the handoff's revision history or session summary. The pivot's reasoning is the most fragile thing in your context.

By session end, the handoff should already be ~90% written. The "wrap up" step is just verification + final pickup-protocol authoring.

## Output expectations

When this skill fires, the user should see:
1. A short message: "writing the handoff for <topic>; updating <doc-path>".
2. Targeted Edit operations on the handoff doc + MEMORY.md (not full rewrites — additive).
3. A verification ledger at the end showing which Step 5 rows pass.
4. The handoff path + a one-line summary of what's in it for the user to skim.

Never declare a session "done" without producing or updating a handoff. If the user signals end-of-session and no handoff has been touched, refuse the close: "before we stop, let me update the handoff" is the correct response.

## Mycelium-specific reminders

- Handoff doc lives in `docs/`, named `<TOPIC>-HANDOFF-<YYYY-MM-DD>.md`.
- MEMORY.md "In Progress" section is the cross-conversation index — every handoff doc gets a one-liner there.
- CLAUDE.md is reserved for principles + operational pointers, NOT phase-specific work; handoffs don't typically belong there.
- The egress-provenance handoff format is the maturest local exemplar; mirror it for new docs.
- Today's date for relative-time conversion: convert "Thursday" / "yesterday" to absolute YYYY-MM-DD before writing. Future-you will thank you.
- The 3-skill operational triad (`/sweep-first-design`, `/deploy-and-verify`, `/pre-deletion-caller-audit`) plus this one form a complete loop: design → ship → subtract → bequeath. Each session's handoff should reference which skills fired and what artifacts they produced.
- When writing a session summary that includes corrections to prior diagnoses (the "Gap #4 was real, my grep was wrong" case from 2026-05-06), call out the correction explicitly. Future sessions reading the doc need to know which prior claims are now wrong.

## The closing thought

A session ends one of three ways:
1. The handoff is written → the work survives. ✓
2. The handoff is partial → the next session does archeology and rediscovers. Costly.
3. The handoff is absent → the work was ephemeral. Whatever wasn't shipped is lost; whatever was shipped lacks rationale.

Sessions that produce shipped commits and decisions deserve handoffs. The discipline is non-optional. When the user says "compact" or "wrap up" — the handoff IS the wrap-up. Write it before you stop.
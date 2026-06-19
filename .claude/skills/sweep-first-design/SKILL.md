---
name: sweep-first-design
description: >-
  Use proactively before designing or implementing any structural change in
  this codebase — picking up a handoff doc, planning Phase N of a multi-phase
  refactor, designing a new module that touches shared abstractions (egress,
  encryption, channel registry, scheduling, lanes, MCP tools, send-handler),
  or about to write a design doc. Enforces the sweep-before-design discipline:
  every load-bearing assumption must be inventoried, verified against live
  code with file:line citations, and addressed before the design is locked.
  Pivots when sweeps contradict the plan. Mandatory for work that will produce
  code in packages/, migrations/, or affect cross-process boundaries.
---

# Sweep-First Design Protocol

When you pick up a handoff doc, are asked to "plan", "design", "implement Phase N", "refactor X", or to write any structural code that affects shared abstractions — **STOP before designing**. Run this protocol first.

This is not a checklist to perform once and forget. It is the discipline that makes structural work tractable in a security-critical codebase. Skipping it produces code that compiles, passes tests, and is wrong in ways that surface only in production. Every shipped phase of the egress-provenance refactor (Phases 0, 1, the Phase 2 design itself) caught at least one structural defect that would have been a bug if the protocol had been skipped — including the file-on-disk plan in the Phase 2 sketch that was structurally infeasible because MCP tool handlers receive only `args`.

## When this skill applies

YES — invoke this protocol when:
- A handoff doc, plan doc, or "Phase N design" is referenced.
- The user says "plan", "design", "implement", "refactor", "investigate" something that touches multiple files.
- Code changes will affect shared abstractions: egress, send-handler, channel registry, encryption, scheduling, lanes, MCP tools, recovery, hook bus, audit, persistence.
- The work involves cross-process boundaries (loopback HTTP, MCP child, bot subprocess, Worker).
- You're tempted to write a design doc.
- You're picking up a session that compacted; the summary is a starting point, not ground truth.

NO — skip when:
- The change is a single-file fix with no caller surface change.
- A typo, comment edit, formatting.
- The user explicitly says "just do X, don't sweep first" (rare; usually means they accept the risk).

## Step 1 — Read cold and inventory load-bearing assumptions

Read every referenced doc + the prior phase's design doc end to end. Don't skim. Then build an explicit list of the assumptions the plan rests on. An assumption is **load-bearing** if the plan breaks when the assumption is wrong.

Categories to look for:
- **Path assumptions** — files, directories, env vars the plan presumes exist.
- **Shape assumptions** — function signatures, request bodies, response shapes, schema columns.
- **Lifecycle assumptions** — when state is set/cleared, who has access at what time, what survives a process restart.
- **Permission assumptions** — what AppArmor allows, what auth gates pass, what UID things run as.
- **Boundary assumptions** — what crosses process / network / filesystem / encryption boundaries.
- **Concurrency assumptions** — lane serialization, mutex coverage, "exactly one of X at a time".

Write the list down. Numbered. You will return to it in Step 4.

## Step 2 — Spawn parallel sweep agents

Use the Agent tool with `subagent_type: "Explore"`. ONE agent per concern. Spawn them in a single message — independent sweeps run concurrently.

Each prompt MUST require:
- File:line citations for every claim.
- "If a thing doesn't exist, say so explicitly. Don't speculate."
- "Quote actual code; don't summarize what functions 'generally do'."
- Bounded scope (single concern, named files / directories / patterns).
- Word cap on the report (under 800 words; forces tight reasoning).

Typical sweep concerns (vary by phase, never one-size-fits-all):
- Existing module shape at the modification point.
- Caller/consumer audit of a function you're about to change.
- Per-process boundary semantics (env at spawn, IPC patterns, lifetime).
- Permission/authorization surface (AppArmor profile, auth gates, loopback scope).
- Test patterns for similar code in the repo (so new tests match conventions).
- Edge-case behavior under recovery, sub-agents, scheduler-triggered runs.

Three sweep cycles minimum for structural work. The first cycle maps the surface; the second pressure-tests the design choice; the third catches what the first two missed (almost always something).

## Step 3 — Pressure-test before locking the design

After sweeps return, do NOT immediately write the design doc. Instead:

1. **Identify gaps.** What assumption did no sweep cover? What sweep returned a thinner answer than expected? Run a focused additional sweep.
2. **Read the cited code yourself.** Sweep agents summarize. For any load-bearing claim, open the file at the cited line and verify with your own eyes. Use Read or Bash grep — never trust a paraphrase for a security gate, an auth check, or a state machine.
3. **Run pressure-test scenarios.** "What happens if X fires twice? If Y is null? If Z runs in parallel?" Each scenario should map to a code path you've actually read.
4. **PIVOT IF THE CODE CONTRADICTS THE PLAN.** This is the most important step in the entire protocol. Do not quietly conform to a plan the code refuses to support. Document the pivot in the design doc's revision history with a "v1 → v2" note explaining what the sweep found.

If you reach this step and want to skip the pivot — stop. That impulse is the bug. Write the pivot.

## Step 4 — Write the design with a verification table

The design doc must end with a table:

| Assumption | Verified at |
|---|---|
| ... | file:line |

Every load-bearing assumption from Step 1's list appears here. The "verified at" column is a file:line you have READ YOURSELF (not just one a sweep agent cited). If you can't fill a row honestly, the assumption isn't verified — fix that before locking the design.

The design doc should also include:
- **Revision history** — v1 sketch → v2 (or v3, vN) with the reason for each pivot.
- **Sweep findings (consolidated)** — the substantive output of Step 2-3 distilled to its load-bearing parts. Cite file:line throughout, not in summary.
- **Threat model** — what the design assumes about adversaries; what new attack surface is added; what's accepted with rationale.
- **Module shape** — exact function signatures, exact request shapes, exact LOC budget. If you can't state the LOC budget within ±20%, you don't understand the change yet.
- **Edge cases — explicit decisions** — every "what about X" you considered, with the chosen answer + why the alternatives lose.
- **Test strategy** — tests by file, what each test asserts. Don't ship a design that says "tests TBD".
- **Implementation order** — N steps, each independently shippable, each with a smoke-test command.
- **Decision criteria for proceeding to next phase** — falsifiable, queryable. "When audit log shows X over Y days."
- **Risks + mitigations** — table. Likelihood + impact + mitigation per risk.
- **Open questions resolved during sweep** — what you almost got wrong; future you / future Claude will thank you.
- **Open questions deferred** — what's out of scope and why; named so they don't ambush a later phase.

## Step 5 — Track the protocol with TodoWrite

Use the TodoWrite tool to track the protocol itself, not just the eventual implementation. Concrete shape:

```
1. Read handoff + plan + prior phase docs
2. Verify production state (git log, current code state)
3. Sweep 1 — <concern>
4. Sweep 2 — <concern>
5. Sweep 3 — <concern>
6. Pressure-test storage / structure / boundary assumptions
7. Verify each load-bearing claim by reading the cited code
8. Write design doc with verification table
9. Update MEMORY.md / handoff to point at design doc
```

Mark each complete IMMEDIATELY when done — don't batch. The trail is what tells the user (and future-you) that you didn't skip.

## Anti-patterns to refuse

- **Designing from a handoff sketch without sweeping.** The sketch is a starting point. The code is ground truth.
- **Citing without reading.** A file:line in a sweep agent's report is a hypothesis that needs your verification for any load-bearing claim.
- **"Looks fine, ship it" after one sweep cycle on structural work.** Three cycles is the floor. If the change has cross-process / cross-boundary / cross-tenant implications, more.
- **Shipping a design doc with no verification table.** This is the artifact that proves you did the work.
- **Quietly conforming to a wrong plan.** If sweeps reveal the plan is structurally infeasible, PIVOT. Document the pivot in revision history.
- **Skipping the verification table because "it's obvious".** It's only obvious because you just did the work. Two weeks later it's a question; in a year it's a regression.
- **Inventing assumptions.** If you didn't see a thing in the sweep, you don't know it's true. Either sweep again or call it out as deferred.

## Output expectations

When this protocol fires, the user should see (typically in order):
1. A short message describing the plan + sweeps about to run.
2. Parallel Agent tool calls in a single message (multiple Explore agents).
3. Brief consolidation of sweep findings, naming the load-bearing surprises.
4. Pressure-test reads (Read / Bash grep on cited code).
5. The design doc, written to disk with a verification table.
6. Updates to MEMORY.md or handoff so the next session can pick up cleanly.

If you're tempted to compress this into "let me sweep and then write the doc" without showing the work — don't. The trail is the artifact. The user is paying attention to whether the discipline was applied; show that it was.

## Mycelium-specific reminders

- This codebase is a cognitive vault. Security non-negotiable (see CLAUDE.md §1-13). Sweep cycles must explicitly address: data exposure surface, fail-closed guarantees, encryption boundary, audit trail, cross-tenant isolation, encryption-at-rest invariants.
- The egress-provenance refactor (Phases 0-7) is the canonical example of this protocol in practice. Read docs/EGRESS-PROVENANCE-PHASE2-DESIGN-2026-05-06.md for the format the verification-table + revision-history + sweep-findings sections should follow.
- The `Explore` agent type is the right tool for sweeps. The `Plan` agent type can be used after sweeps for the design-doc structure if helpful, but `Plan` should never run before `Explore` for this codebase.
- Sub-agents have isolated runtimes. The sweep prompts must be self-contained; agents do not see your conversation context.
- Lane serialization in the agent-server (`enqueue` keyed by `agent:${AGENT_ID}`) is a recurring assumption that DOES hold — but only for `/chat`, not for `/chat/stream`, `/portal/chat/stream`, `/triage`, `/think`, or scheduler runs. Always verify which lane an endpoint runs in before assuming.
- Cross-process state in this codebase has three honest patterns: tmpfs at `/run/mycelium/`, loopback HTTP between agent-server and MCP children, D1 ciphertext via Worker. There is NO fourth pattern; if your design needs one, sweep until you find the existing pattern that already does what you want.

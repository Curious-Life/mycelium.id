---
name: Hand off before stopping
description: Before ending any Mycelium session that produced commits or decisions (or invoking /compact), invoke /handoff-discipline. Required output: docs/<TOPIC>-HANDOFF-<YYYY-MM-DD>.md with TL;DR + commit hashes + what-was-learned + production state + open decisions + concrete pickup protocol; cross-linked via MEMORY.md "In Progress".
type: feedback
originSessionId: d31a0231-7a2f-4b43-8214-ddf8e32b6681
---
Before ending any working session in Mycelium that produced commits, design decisions, or shifts in direction — and ALWAYS before invoking `/compact` — invoke `/handoff-discipline`. The skill enforces writing a structured handoff doc at `docs/<TOPIC>-HANDOFF-<YYYY-MM-DD>.md` (or appending a dated session-summary section to an existing handoff for the same work thread).

**Why:** sessions without handoffs produce ephemeral knowledge. The transcript can be lost, summarized into compaction artifacts, or paged out of attention. The handoff is the durable record that proves the work survives the session boundary. Three concrete cases prove the discipline pays for itself:
- Today (2026-05-06): I shipped two commits (b9fb7dd, 9789f3c), wrote three design docs, and found two real bugs — but didn't deliver a complete handoff until the operator asked. The work was at risk of being half-recoverable.
- Phase 1 of egress-provenance: handoff doc dated 2026-05-06 captured the third Layer-B caller pivot + 1Password TouchID gotcha + chat.test.js pre-existing failures. Without it, every fresh session would have re-discovered each.
- Claude subscription mgmt 2026-05-05: PR1+PR2a+PR2b shipped with a comprehensive handoff that named the cache-helper architecture + per-agent assignment + stream-chat resilience patches. Multiple subsequent sessions picked up cleanly via that doc.

**How to apply:**
- When user signals end-of-session ("compact", "wrap up", "let's stop here", "next session", "we'll continue later", "handoff") → invoke /handoff-discipline as the first action, BEFORE any cleanup or compaction.
- When a multi-phase plan ships its phase → update the handoff doc with what shipped + what's next.
- When a pivot happens mid-session → write the pivot into the handoff IMMEDIATELY (rationale is fragile). Don't batch.
- Append to an existing handoff for the same work thread (don't fragment by session). Add a dated "## YYYY-MM-DD <morning|PM> session summary" section.
- The handoff MUST include: commit hashes (every one), production state with verification commands per VPS, open decisions for the operator (concrete options + recommendation, not "we should think about"), and a step-by-step pickup protocol the next session can execute.
- Cross-link via MEMORY.md "In Progress" — one-liner pointing at the doc with the most-recent finding.
- Refuse to declare a session "done" without producing or updating a handoff. "Before we stop, let me update the handoff" is the correct response when the user signals close.

**Skill location:** `.claude/skills/handoff-discipline/SKILL.md` in the Mycelium repo. CLAUDE.md has a pointer immediately after the pre-deletion-caller-audit pointer.

**Reference handoffs (canonical examples):** docs/CLAUDE-SUBSCRIPTION-HANDOFF-2026-05-05.md (multi-PR work), docs/EGRESS-PROVENANCE-HANDOFF-2026-05-06.md (multi-phase + multi-session, dated session summaries appended), docs/D1-COST-HANDOFF-2026-05-06.md (investigation-style with change-by-change ledger).

**Cross-references:** completes the operational triad → quartet. Pairs with `feedback_sweep_first_design.md` (verifies design was written), `feedback_deploy_and_verify.md` (verifies deploys are documented in the handoff's production-state section), `feedback_pre_deletion_caller_audit.md` (verifies the caller-audit table persists in the handoff). Together: design → ship → subtract → bequeath.

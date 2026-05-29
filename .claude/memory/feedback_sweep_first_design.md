---
name: Sweep before designing
description: For ANY structural change in Mycelium (handoffs, multi-phase refactors, new modules touching shared abstractions), invoke the /sweep-first-design skill BEFORE writing the design doc. Three sweep cycles minimum, file:line citations required, pivot when code contradicts plan, end the design with a verification table.
type: feedback
originSessionId: d31a0231-7a2f-4b43-8214-ddf8e32b6681
---
For any structural change in this codebase — picking up a handoff, planning Phase N, designing a new module, refactoring shared abstractions (egress, encryption, channel registry, scheduling, lanes, MCP tools, send-handler) — invoke `/sweep-first-design` BEFORE writing any design doc. Three sweep cycles minimum. File:line citations required. Pivot when sweeps contradict the plan. End the design with a verification table.

**Why:** Two concrete cases proved the discipline pays for itself:
- Phase 1 of egress-provenance: caught a hidden third Layer-B caller (`recovery.notifyRecovery`) that wasn't in the design doc — third sweep cycle surfaced it. Without it, the migration would have shipped half-complete.
- Phase 2 of egress-provenance: the handoff sketch specified `/run/mycelium/inbound/<taskId>.json` as the storage primitive. Sweep #2 surfaced that MCP tool handlers receive ONLY `args` from CallToolRequest — there is no per-call `taskId` available to the child process. The file approach was structurally infeasible. Pivoted to in-memory active-turn registry + loopback HTTP-callback. Without the sweep, this would have been a runtime bug discovered in step 1 of implementation.

Skipping sweeps produces designs that compile, pass tests, and are wrong in ways that surface only in production. In a security-critical codebase that is unacceptable.

**How to apply:**
- When user says "plan", "design", "implement Phase N", "refactor X" → invoke /sweep-first-design as the first action. Don't write the design doc first.
- When user hands you a doc that summarizes prior work → read it cold, then sweep. Don't trust the summary as ground truth.
- Spawn parallel Explore agents (one per concern, focused questions, file:line citations required, "if it doesn't exist say so", word-capped output). Multiple in a single message so they run concurrently.
- After sweeps return, do NOT write the doc immediately — pressure-test the gaps, read cited code yourself for any load-bearing claim, run a focused additional sweep.
- If sweeps contradict the plan: PIVOT. Document the pivot in the design doc's revision history. Never quietly conform to a wrong plan.
- Design doc ends with a verification table mapping every load-bearing assumption to a file:line you READ YOURSELF (not just one a sweep cited).
- Use TodoWrite to track the protocol, not just the implementation. Mark each cycle complete immediately.

**Skill location:** `.claude/skills/sweep-first-design/SKILL.md` in the Mycelium repo. CLAUDE.md has a pointer between the security principles and Server Access sections.

**Reference design (canonical example):** `docs/EGRESS-PROVENANCE-PHASE2-DESIGN-2026-05-06.md`. The verification table at the end + the v1→v2 revision history show what the artifact should look like when the protocol is followed correctly.

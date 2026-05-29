---
name: Audit callers before deleting
description: Before deleting or replacing existing code, schema, env vars, endpoints, routes (including renames) in Mycelium, invoke /pre-deletion-caller-audit. Inventory every caller, classify each, prove migration with concrete evidence, define falsifiable criteria BEFORE the deletion, run pre-flight gate, then execute.
type: feedback
originSessionId: d31a0231-7a2f-4b43-8214-ddf8e32b6681
---
Before deleting or replacing any existing code, schema, env var, config flag, D1 table/column, endpoint, Worker route, MCP tool, or package in Mycelium — including renames — invoke `/pre-deletion-caller-audit`. The skill enforces inventory-classify-prove-define-gate-execute as a six-step protocol.

**Why:** deletions have a unique failure mode where a caller you didn't know existed silently breaks because you removed its target. Three concrete cases prove the discipline pays for itself:
- Phase 1 of egress-provenance: design doc identified two Layer-B callers; sweep #3 surfaced a hidden third (`recovery.notifyRecovery`). If the migration had shipped without that catch, recovery notifications would have continued bypassing the chokepoint.
- Phase 3 of egress-provenance (upcoming): deletes `deliverNaturalReplyFallback` + `proactiveSendFallback`. Pre-flight criteria already defined in the plan: "Phase 0 audit data must show `agent-explicit-via-tool` count covering historical fallback fire count." Without falsifiable criteria, the deletion would be a coin-flip.
- BGE-M3 / Vectorize amputation (Wave 4b, May 2026): multi-PR migration; Worker bindings deleted last after callers all moved to local Nomic ONNX. Skipping caller audit would have left dangling references to removed bindings.

Anti-patterns refused by the skill: "I think nothing uses it", trusting grep when a symbol has aliases / dynamic dispatch, "soft delete" comments saying `// REMOVE THIS LATER`, deleting tests of the old path without preserving contract coverage, forgetting cross-process callers (MCP children, Worker, bot subprocesses, scripts/, war-room Python), forgetting prompt references in `prompt-sections.js` / `prompt-builders.js`.

**How to apply:**
- When user says "delete X", "remove Y", "drop the column Z", "rename A to B", or work hits Phase N "delete the old path" → invoke /pre-deletion-caller-audit as first action.
- Step 1 inventory: grep packages/, scripts/, migrations/, tests/, agents/, docs/, ecosystem.config.cjs, configs, prompts, AND cross-repo paths (mycelium.id, MYA-0.2, mycelium-ios, mycelium-transcriber, mycelium.id-site, war-room).
- Step 2 classify each (M)igrated / (N)ot-migrated / (D)ead / (O)ut-of-scope.
- Step 3 prove migrated rows with test + audit data + smoke (all three for critical paths).
- Step 4 define falsifiable criteria BEFORE the deletion ("audit shows X = 0 over 7 days"). Time-bound; "currently" is not a duration.
- Step 5 run criteria queries; numbers go in the deletion PR description.
- Step 6 execute deletion + run /deploy-and-verify; ledger includes deletion-smoke + replacement-smoke + grep-clean lines.
- Always grep one more time before declaring "all callers migrated" — the third caller is usually in a sibling file with a slightly-different signature.

**Skill location:** `.claude/skills/pre-deletion-caller-audit/SKILL.md` in the Mycelium repo. CLAUDE.md has a pointer immediately after the deploy-and-verify pointer.

**Reference deletions:** BGE-M3 amputation (Wave 4b, May 2026) and A2 worker amputation (commits f74f351, e7d17166) — both followed this protocol implicitly. Phase 3 of egress-provenance is the canonical next use.

**Cross-references:** complements `feedback_sweep_first_design.md` (additions) and `feedback_deploy_and_verify.md` (shipping). The three together form the complete operational triad: design → ship → subtract.

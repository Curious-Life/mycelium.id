---
name: No fallbacks to deprecated functionality
description: When a path is deprecated, remove it cleanly — don't keep it alive as a silent fallback "just in case." Stale fallbacks introduce bugs and hide regressions.
type: feedback
originSessionId: 71b0db27-201e-42f6-b4e5-86cf389aba5e
---
When migrating away from a backend or path, **remove the old path completely** rather than keeping it as a silent fallback. Deprecated paths kept "for safety" become bug sources because they're no longer maintained or tested in their failure modes — and they hide regressions in the new path because callers silently degrade instead of surfacing the issue.

**Why:** Discovered during search-mindscape Wave 4b (2026-05-04). Mind-search shipped on admin with Vectorize kept as a fallback "during the rollout window." That fallback then 400'd on tenants with empty corpora ("Missing vector" — Float32Array doesn't JSON-serialize as the array Vectorize wants), making the search look broken when actually the new path was working fine. The Vectorize index was 1024D (BGE) and had been dead since the BGE shutdown anyway — keeping it caused real bugs and zero benefit.

**How to apply:**
- When you ship a replacement, also rip the predecessor in the same wave or the very next one. Don't let a "fallback during rollout" become permanent deadweight.
- If subsystems aren't ready (cold start, warming), surface that **explicitly** via 503 + Retry-After or equivalent — don't paper over it with a silent fallback that returns possibly-wrong data.
- Update tests to assert the new contract (return [] on unavailable matcher) rather than testing legacy fallback behavior.
- Delete the dead module entirely (e.g., shadow-emitter that compares mind-search to the deprecated Vectorize path is no longer meaningful).

This applies fleet-wide across Mycelium: if BGE is shut down, don't keep a BGE codepath. If matchMessages should be mind-search-only, don't fall back to Vectorize. If FTS is broken on encrypted rows, don't keep an FTS-fallback that pretends to work.

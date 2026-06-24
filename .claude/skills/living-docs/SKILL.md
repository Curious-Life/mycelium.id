---
name: living-docs
description: >-
  Use proactively after any change that alters what the system IS or what the
  plan SAYS — a new/removed module, tool, endpoint, port, data-flow, schema
  migration, decision, or a shift in scope/sequence. Before declaring a unit
  done, update the three living docs so they never drift from reality: the PLAN
  (docs/V1-BUILD-SPEC.md status + verification table), the ARCHITECTURE
  (docs/ARCHITECTURE.md — the as-built system), and the build log
  (docs/V1-BUILD-HANDOFF-*.md). Docs describe what is ACTUALLY built, with
  file-path evidence, distinguishing built from planned — never aspirational.
  Pairs with handoff-discipline (session-end recap) and deploy-and-verify
  (verified state). Refuses "I'll document it later".
---

# Living-docs discipline

Documentation is part of the change, not a follow-up. A unit isn't done until
the docs that describe the system and the plan match what you just did. Drifted
docs are worse than none — they actively mislead the next session (human or
agent). The bar: **a fresh reader could trust these docs without reading the
code.**

## The three living docs (keep all three current)

1. **The plan — `docs/V1-BUILD-SPEC.md`.** The source of truth for *what we're
   building and in what order*. After a change: flip the affected component's
   status (planned → built → verified) in the verification table; if scope or
   sequence shifted, edit the plan to say so. The plan must always reflect the
   real next step, not a stale one.
2. **The architecture — `docs/ARCHITECTURE.md`.** The as-built system: process
   model, components (with file paths), data flow, storage, crypto/security
   model, transports, ports, verification. After a change: add/update the
   component, redraw the affected data-flow step, update counts (tools,
   migrations, suites, ports). This is *as-built*, not *as-designed* — if code
   and doc disagree, the doc is wrong.
3. **The build log — `docs/V1-BUILD-HANDOFF-*.md`.** The running journal:
   dated entries with what landed, commit hashes, new verify checks, decisions,
   and what's next. (handoff-discipline owns the session-end version of this.)

## After-change checklist (run before calling a unit done)

- [ ] **Plan:** spec status / verification table reflects the new reality; the
      "what's next" pointer is still correct.
- [ ] **Architecture:** every component/flow/port/count the change touched is
      updated; new modules are listed with their file path.
- [ ] **Build log:** a dated entry with the commit hash + new verify checks.
- [ ] **README** (if the public-facing surface or positioning changed): corrected
      to the actual built state — never overclaim.
- [ ] **No drift:** every file path / port / tool name / count cited in the docs
      exists in the code (spot-check the ones you touched).
- [ ] Docs are committed **in the same commit (or PR)** as the code change.

## Anti-drift rules

- **Built vs planned is always explicit.** Use a clear marker (✅ built+verified,
  ◑ partial, ⬜ planned, ⚠️ Tier-2/gated). Never describe a planned thing in the
  present tense as if it exists.
- **Evidence, not prose.** Cite file paths (and line numbers where it helps).
  A claim with no referent is a future lie.
- **Counts must be real.** Tool count, suite count, migration count, ports —
  derive them from the code, don't guess. When they change, update them.
- **One change, one truth.** If the code says one thing and a doc says another,
  the code wins and the doc gets fixed in the same breath.
- **Delete confidently.** When a thing is removed, remove it from the docs too —
  a doc describing a deleted module is drift.

## When NOT to touch docs

Pure internal refactors that change no component boundary, flow, count, plan
item, or public behavior don't need a doc edit — but they still get a build-log
line if they're worth a commit. When unsure, a one-line build-log note is cheap
insurance.

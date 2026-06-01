# Autonomous build routine — instructions

This file is the standing instruction set for the **hourly (or self-paced)
build routine** that continues Mycelium V1 on its own. The routine reads this
file at the start of every run. It and the interactive sessions share one
branch and one handoff doc — that doc is the coordination mechanism.

The routine does the full loop for one unit of work each run: **build →
self-review → test → score its own confidence → land it (merge to `main` when
it's confident and green, otherwise leave it for a human) → log it.** The repo
keeps evolving on `main` as work completes.

---

## The coordination model

- **Working branch:** `claude/repo-overview-mC69M`. Develop here, never force-push.
- **Target:** completed, green, high-confidence units merge to **`main`** so the
  repo evolves. Low-confidence or security-sensitive units are left as an open
  PR for a human to review instead of auto-merging.
- **Shared log:** `docs/V1-BUILD-HANDOFF-2026-05-30.md`. Every run reads the
  bottom and appends to it. This is how the routine and live sessions avoid
  duplicating a unit.

---

## Per-run lifecycle

### 1. SYNC — make sure it's safe to work
- `git fetch origin && git checkout claude/repo-overview-mC69M`
- `git pull --ff-only origin claude/repo-overview-mC69M`
- If the pull is **not** a clean fast-forward, **or** `git status` shows changes
  you didn't make: **STOP.** Another session may be mid-task. Leave a one-line
  note in the handoff and end the run. Never reset, force, or stash.
- Read the newest section of `docs/V1-BUILD-HANDOFF-2026-05-30.md`. No re-discovery.

### 2. PICK — one unit
- Take the next "remaining / next" item from the handoff that is **buildable in
  this environment** (no real ML models, no platform tokens, no deploy).
- If the only remaining items are environment-gated (Tier-2: onnxruntime / Ollama
  / `:8091`, deploy, real OAuth tokens) **or** need a product decision: do **not**
  guess. Write a short "blocked on X — needs your call" note in the handoff,
  commit, push, end the run. **A clean no-op run is a success.**

### 3. BUILD
- Recon first — read the real code you'll touch (file:line), find the contract,
  spot footguns **before** writing. Prefer reading over assuming.
- Implement the one unit. Match surrounding code style. The CLAUDE.md security
  rules are non-negotiable (fail closed, never log plaintext, two-key vault, no
  `--no-verify`, no `--force`).

### 4. SELF-REVIEW
- Re-read your own diff as an adversarial reviewer. Run `/code-review` (or the
  equivalent reasoning) over the change. Fix what you find. Look specifically for:
  unhandled errors, missing `userId` scoping, plaintext leakage, broken contracts
  with callers, and anything that contradicts the handoff/spec.

### 5. TEST / GATE — do not proceed unless green
- Add/extend a `scripts/verify-*.mjs` with a PASS/FAIL ledger + VERDICT line.
  Every new behavior gets a check.
- Run the **full** suite: `npm run verify`. It must print `VERDICT: GO` for every
  suite and exit 0.
- If anything is `NO-GO`: fix it, or `git checkout .` to discard the change and
  leave a note. **Never commit or merge a red tree.**

### 6. SCORE — self-assess confidence (gates how it lands)
Assign a confidence score **0–100** for "this change is correct, complete, and
safe to land on `main` unattended," using the rubric below. Write the score +
one-line justification into the handoff entry.

| Score | Meaning | Action |
|---|---|---|
| **≥ 85** | Green suite, clean self-review, well-understood surface, isolated blast radius | **Merge to `main`** (see step 7) |
| **60–84** | Works + green, but non-trivial blast radius, a judgment call, or partial coverage | **Do not merge.** Commit + push the branch, open/update a PR, leave a note asking for human review |
| **< 60** | Uncertain correctness, fuzzy requirement, or you had to guess | **Discard** (`git checkout .`) or park on a branch; write a "needs your call" note. Do not merge |

**Hard override — never auto-merge regardless of score** if the change touches a
**security-sensitive surface**: crypto/keys, auth/OAuth, the encryption adapter
or `ENCRYPTED_FIELDS`, RLS/tenant scoping, egress chokepoints, or a DB migration.
These always go to a PR for a human, even at score 100.

### 7. LAND
The routine **never merges to `main` directly.** Every unit lands as a PR, and
the merge to `main` happens only through the **`auto-merge-on-green` skill**,
whose fail-closed gate requires green checks **and** passing reviews. This keeps
one merge policy across the routine and interactive sessions.
- Commit on the branch with a clear message, `git push -u origin <branch>`.
- Open or update a PR against `main`.
- **If score ≥ 85 and non-sensitive:** invoke `auto-merge-on-green` for the PR.
  It merges the instant CI is green and reviews pass; until then it holds. The
  routine does not force or shortcut this.
- **If score 60–84, or security-sensitive:** push + open the PR, leave a "needs
  review" note, and do **not** request auto-merge — a human reviews first.

### 8. LOG
- Append a dated section to `docs/V1-BUILD-HANDOFF-2026-05-30.md`: what you built,
  new verify checks, the **confidence score + justification**, where it landed
  (merged to `main` / left as PR #N), what's next, and any decision punted to the
  user. Commit + push this.
- Confirm `git status` is clean and HEAD == origin. End the run.

---

## Guardrails (never)

- One unit per run. Stop at the first genuine wall (env-gated, decision fork, or
  can't-reach-green). Stopping cleanly is success, not failure.
- Never merge a red tree. Never auto-merge a security-sensitive change.
- Never `--force`, never `--no-verify`, never reset/stash another session's work.
- Never touch other repos. Never delete/overwrite a file you didn't create
  without reading it first.
- Keep the handoff doc current every run — it's the shared source of truth.

---

## Copy-paste prompt for the routine

```
Continue the Mycelium V1 build per docs/AUTONOMOUS-ROUTINE.md. Do exactly one
unit this run, following the lifecycle in that file: SYNC (git fetch + pull
--ff-only on claude/repo-overview-mC69M; stop if not a clean fast-forward or the
tree is dirty) → read the bottom of docs/V1-BUILD-HANDOFF-2026-05-30.md → PICK
one buildable, non-env-gated unit (if only env-gated/decision items remain, leave
a "blocked, needs your call" note and end) → BUILD (recon first, file:line) →
SELF-REVIEW the diff adversarially → GATE on `npm run verify` (must be all GO,
exit 0; never commit red) → SCORE confidence 0–100 → LAND: merge to main only if
score ≥ 85 AND the surface is non-sensitive (never auto-merge crypto/auth/
encryption/migration/egress — leave those as a PR), otherwise push the branch and
open/update a PR for review → LOG a dated handoff entry with the score + where it
landed. Never force-push, never --no-verify, one unit per run, a clean no-op is a
success. Do not message anyone.
```

---
name: build-from-spec
description: >-
  Use when you have a READY spec (a design doc + a unit-level build-execution
  plan) and want it built to completion under full gates — not surveyed-and-
  chosen like /autonomous-build-loop, but the specific spec you hand it. Drives
  the AUTONOMOUS-ROUTINE loop per unit: BUILD → GATE (verify) → REVIEW (code
  review + MULTIPLE independent adversarial security audits + functionality-
  completeness check against the spec) → CONVERGE till green → LAND (fail-closed,
  human-gated for security-sensitive surfaces) → LOG. Refuses to start on an
  unready spec; hard-stops (never fakes) at human-review gates, cross-OS
  verification it can't run, and credential/outward-action boundaries. Runs in a
  git worktree on its own branch; never touches the main checkout.
---

# Build-From-Spec Protocol

`/autonomous-build-loop` **surveys** the repo and picks its own safe work. This skill is the opposite: you hand it a **specific, ready spec** and it drives that spec — and only that spec — to shipped, through every gate, looping until green. It is the disciplined executor for a design you have already locked.

It composes the existing disciplines rather than replacing them: `/sweep-first-design` (design readiness), `/deploy-and-verify` (gates), `/pre-deletion-caller-audit` (deletes), `/security-review` + `/code-review` (review), `/auto-merge-on-green` (land), `/living-docs` + `/handoff-discipline` (log). It is the REVIEW gate turned up to eleven: **multiple independent security audits + a functionality-completeness check** per security-sensitive unit.

## The one rule it will not break

**It never lands a security-sensitive change without a human on record, and it never claims to have verified something it could not actually run.** Cross-OS, credentialed, and outward-facing steps are STOP points, not skip points. A green CI on the wrong OS is a false green; this skill refuses to treat it as done.

---

## Step 0 — Readiness gate (refuse an unready spec)

Before any code, confirm the spec is genuinely buildable. REFUSE and route to `/sweep-first-design` if any is missing:

1. **A design doc** with a verification table (load-bearing assumptions verified at file:line) and a threat model.
2. **A build-execution plan** that slices the work into **units**, each with:
   - exact files touched + an LOC budget,
   - a **falsifiable done-criterion** (a `verify:*` command or a specific smoke that prints GO/exits 0),
   - a **dependency order** (what must land first),
   - a **classification**: `mechanical` | `structural` | `security-sensitive`.
3. **A frozen-contract list** — the interfaces/signatures/derivations that MUST NOT change (so the functionality check has something to assert against).

If the plan exists but a unit lacks a done-criterion, that unit is not ready — write the gate first or split it out. Do not "build and figure out the test later."

## Step 1 — Set up isolation

- `scripts/new-worktree.sh <branch>` (branch namespace e.g. `claude/spec-build/<topic>`). Never build in the main checkout — other sessions share it.
- Confirm the baseline is green: run the spec's touched-area `verify:*` gates on an unchanged tree so a later red is attributable to your diff, not a pre-existing flake (see `flaky-at-rest-migration-gate` memory for the known one).

## Step 2 — Per-unit loop (in dependency order)

For each unit, in order, smallest/lowest-risk first:

### 2a. BUILD
Write the change to the unit's exact files, within the LOC budget. Match surrounding code idiom. If the unit is a **delete/replace/rename**, run `/pre-deletion-caller-audit` FIRST — inventory every caller, prove migration, define kill criteria.

### 2b. GATE (`/deploy-and-verify`)
Run the unit's done-criterion gate until it prints `VERDICT: GO` / exits 0. Then run `verify:core` (never let a unit regress the core). CONVERGE: fix → re-run, don't proceed on red. Never `--no-verify`, never bypass a hook to get green.

### 2c. REVIEW — the amplified gate
Run these as **independent passes prompted to REFUTE, not to bless** (a self-eyeball of your own diff is not a review):

- **Code review** (`/code-review`): correctness + reuse/simplification on the unit diff.
- **Functionality-completeness check**: spawn an agent that reads the diff against the spec's **functionality inventory + frozen-contract list** and answers, with file:line: *Did any frozen contract (signature, derivation, stdout/env contract) change? Is every interface the spec says must keep working still wired? What functionality did this unit remove or alter that the spec did not authorize?* Any unauthorized contract change → CONVERGE, do not proceed.
- **Security audits — MULTIPLE, independent, adversarial** (scaled to classification):
  - `mechanical` unit → 1 audit.
  - `structural` unit → 2 audits, distinct lenses.
  - `security-sensitive` unit → **≥3 independent audits, each a different lens** (e.g. *key/plaintext leakage*, *fail-closed / auth-bypass*, *does-it-actually-reproduce / can-I-break-it*). Each auditor is told to assume the diff is wrong and find the hole. A finding survives only if it isn't refuted; **majority-must-clear** to pass. Route confirmed findings back through fix → re-verify → re-audit BEFORE land.
  - The mandatory surfaces (CLAUDE.md): crypto/keys, auth/OAuth, the encryption adapter / `ENCRYPTED_FIELDS`, RLS/tenant scoping, egress chokepoints, remote-access, DB migrations. Touching any → the unit is `security-sensitive` regardless of size.

### 2d. REGRESSION guard
Before landing the unit: run the **frozen-contract assertions** (the spec's derivation-stability / signature / stdout-contract gates) + the full relevant `verify` chain. A frozen contract that changed is an automatic STOP, even if every gate is green — greenness on an incomplete gate is not proof.

### 2e. LAND (`/auto-merge-on-green`) — or STOP
- **Mechanical / structural, all gates + reviews green, mergeable, non-draft** → land via the fail-closed merge gate.
- **Security-sensitive** → **STOP. Do not self-merge.** Package a reviewable PR (diff + the audit ledger + the verify ledger + the functionality-check result) and hand it to the human. A verbal "merge on green" is sign-off, not review — the independent audits must be *on record* first, and a human must approve the security surface.

### 2f. LOG
Update the three living docs (`/living-docs`) in the same unit; emit a `[✓]/[—]` ledger line for the unit.

## Step 3 — Hard STOP conditions (report, never fake)

The loop pauses and hands back — it does not skip, guess, or simulate — when it hits:

- **Human-review gate** on a security-sensitive land (Step 2e).
- **Cross-OS verification it cannot run** — a unit whose done-criterion needs Windows/Linux/a VPS/a device this host isn't. Build the code, but mark the unit `BUILT, UNVERIFIED-ON-<os>` and stop before claiming done. Never treat a pass on the wrong OS as the criterion met.
- **Credentials / accounts** needed (signing certs, `npm publish` token, registry push, a real remote box).
- **Outward-facing or destructive** action (publish, deploy, DNS, a migration on live data) — confirm with the operator; approval in one context doesn't carry to the next.
- **A frozen contract would have to change** to make the unit work — that is a design defect; STOP and route back to `/sweep-first-design` for a pivot, don't quietly conform.

At every STOP, write a `/handoff-discipline` note: what's built, what's green, what's blocked and on what, exact resume command.

## Step 4 — Completion

The spec is done only when **every** unit is either landed-green or explicitly parked at a named STOP with a handoff. Emit a final ledger: unit → status → gate → audits → land/stop. Update `/living-docs`. If units are parked, the spec is NOT shipped — say so plainly (CLAUDE.md §10: no "might have worked").

## Anti-patterns it refuses

- Building from a spec with no per-unit done-criteria ("I'll test it after").
- One security "review" that is a self-read of your own diff.
- Landing a crypto/keys/auth diff on a verbal go-ahead without the independent audits on record.
- Calling a unit done because CI is green on Linux when the unit targets Windows.
- Changing a frozen contract to make a test pass.
- Merging directly instead of through `/auto-merge-on-green`.
- Continuing past a red gate, or `--no-verify`/`--force` to get green.

## Relationship to the other drivers

the autonomous routine names three drivers, one policy. This is a fourth *entry shape* into the same policy: **spec-in, shipped-or-parked-out**, single-spec, human-gated at the security boundary. The REVIEW and LAND gates are identical to the routine's; what this skill adds is (a) the readiness precondition, (b) the multi-audit REVIEW amplification, and (c) the explicit STOP taxonomy so an unattended run parks honestly instead of over-claiming.

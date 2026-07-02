---
name: auto-merge-on-green
description: >-
  Use when asked to auto-merge, merge-when-green, land-on-pass, or "merge once
  CI/reviews pass" for a pull request, or when subscribed to a PR's activity and
  a check/review event arrives that could unblock a merge. Enforces a fail-closed
  merge gate: a PR merges ONLY when every CI check completed successfully AND
  reviews pass (no changes requested, required approvals met) AND the PR is
  mergeable and not a draft. Any check still pending, missing, or failed — or any
  blocking/absent-but-required review — means HOLD, never merge. Security-
  sensitive diffs always require an explicit human approval regardless of CI.
  Pairs with the autonomous build routine (docs/AUTONOMOUS-ROUTINE.md): the
  routine never merges directly — landing to main goes through this gate.
---

# Auto-merge-on-green

Merge a PR the instant it is genuinely safe — and not one moment before. The
gate is fail-closed: the default is **do not merge**. A merge only happens when
every precondition below is affirmatively true. When in doubt, hold and report.

## The merge gate (ALL must hold — fail-closed)

1. **Checks complete + green.** Every check run on the PR head SHA has
   `status: completed` AND `conclusion: success` (or `neutral`/`skipped`). If
   *any* check is `queued`/`in_progress`, or `failure`/`cancelled`/`timed_out`,
   or there are **zero** checks where checks are expected → **HOLD**. Never merge
   on a partial or empty check set when CI is configured.
2. **Reviews pass.**
   - No review is in `CHANGES_REQUESTED` state (unless later superseded by an
     `APPROVED` from the same reviewer).
   - Every requested reviewer who has responded has `APPROVED`.
   - If branch protection requires N approvals, the count is met.
   - If reviews are *required* by policy and none exist yet → **HOLD** for review.
3. **Mergeable.** The PR is not a draft, has no merge conflicts
   (`mergeable_state` is clean/has a mergeable base), and the base branch is the
   intended target.
4. **Not security-sensitive without BOTH sign-off AND a review on record.** If the
   diff touches crypto/keys, auth/OAuth, the encryption adapter or
   `ENCRYPTED_FIELDS`, RLS/tenant scoping, egress chokepoints, remote-access, or a
   DB migration → require **(a)** an explicit human `APPROVED` (a verbal "merge on
   green" counts as the human sign-off) **AND (b)** an independent review actually
   run on this diff — `/security-review` (or `/code-review`) — with any confirmed
   findings resolved. The human nod is **not** a substitute for the review having
   happened; if no review is on record, run it first, then re-evaluate. Never
   auto-merge these on checks + a verbal go alone. (A recovery-key + remote-auth
   diff merged on 2026-06-25 with the human go but no review — this clause closes
   that hole.)

If every item holds → merge. Otherwise → do not merge; post nothing noisy, just
hold and (if asked to watch) wait for the next event.

## Procedure

1. **Read state** via the GitHub MCP tools, against the PR's current head SHA:
   - `pull_request_read method=get_check_runs` — confirm all completed + success.
   - `pull_request_read method=get_reviews` — confirm no CHANGES_REQUESTED and
     required approvals met.
   - `pull_request_read method=get` — confirm not draft, mergeable, correct base.
2. **Evaluate the gate** above. If any item fails, STOP — report one line on what
   is blocking (e.g. "holding: 1 check in_progress" / "holding: awaiting review")
   and end. Do not merge.
3. **Merge** with `merge_pull_request`. Default `merge_method: merge` to preserve
   the verify-gated commit history (use `squash` only if the repo convention is
   squash). Use the PR title for the merge title.
4. **Verify the merge landed** — re-read the PR (`merged: true`) and confirm the
   base branch advanced. Report the merge SHA. If the merge call errored
   (e.g. base moved, became unmergeable), do NOT force — report and hold.
5. **Log** if this is part of a build session: note the merge in the handoff doc.

## When subscribed to PR activity

If watching a PR and a `<github-webhook-activity>` event arrives (check
completed, review submitted), re-run the gate. The gate is the single source of
truth — a green CI event alone does not merge if reviews still block, and an
approving review alone does not merge if a check is red. Only the full gate
merges. This makes the skill safe to fire on every event: it is idempotent and
self-guarding.

## Never

- Never merge with a check pending, missing, or failed.
- Never merge over a CHANGES_REQUESTED review or a missing required approval.
- Never auto-merge a security-sensitive diff without an explicit human approval.
- Never let a verbal "merge on green" stand in for an actual `/security-review` on
  a security-sensitive diff — the human go and the review are two separate gates.
- Never `--force`, never bypass branch protection, never merge a draft.

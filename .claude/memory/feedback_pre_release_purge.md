---
name: Pre-public-release purge list — internal-only files must not ship in the AGPL artifact
description: Before the repo flips public (AGPL), remove developer/operator-internal files that disclose unfixed weaknesses, real infra, or ship attacker tooling. Tracked from the 2026-06-11 adversarial security review (GEN-1/GEN-2).
type: feedback
---

The repo is heading for a **public AGPL release**. The 2026-06-11 adversarial
security review (`docs/SECURITY-REVIEW-2026-06-11.md`) flagged that several
git-tracked, developer/operator-internal files are safe in the private repo but
**must be purged before the repo goes public** — they disclose unfixed
weaknesses, real infrastructure, or ship a turnkey attacker toolkit. Left in for
now (per operator decision 2026-06-11) — **remove pre-release.**

**Purge before public release (and scrub from git history, not just HEAD):**

1. **`.claude/memory/`** — internal agent/dev notes. Several advertise
   known-deferred weaknesses + internal topology to anyone reading the public
   repo, e.g.:
   - `feedback_per_agent_internal_secret.md` — documents the unfixed shared
     `AGENT_INTERNAL_SECRET` cross-call gap on `/internal/*` (ports, agent names).
   - `feedback_secrets_bootstrap.md`, `feedback_security.md` — secret-handling
     internals.
   Recommend: move `.claude/memory/` out of the published tree (it's dev state,
   like the already-gitignored `.claude/projects/`).

2. **Root `_*.mjs` debug scripts** — `_setpw.mjs`, `_reset-operator.mjs`,
   `_clean-oauth.mjs`, `_clean-oauth-safe.mjs`, `_decode-token.mjs`, `_email.mjs`,
   `_oauth-probe.mjs`. No hardcoded secrets, but a turnkey
   operator-password-reset / OAuth-token-decode / user-email-dump toolkit, and
   `_oauth-probe.mjs` hardcodes the real relay host `0m.mycelium.id`. Move to an
   ignored `scratch/`/`tools/dev/` dir or add a package `files` allowlist so they
   never reach the published artifact.

3. **`docs/SECURITY-REVIEW-2026-06-11.md`** (this review) and any other
   `docs/*HANDOFF*` / `docs/REMOTE-CONNECT-*` / `docs/CLAUDE-CONNECTOR-*` that
   carry live exploit chains or the `0m.mycelium.id` host + `operator@mycelium.local`.
   Keep internal; do not ship.

**How to apply:** add a pre-release checklist step that (a) `git rm`s these from
the public branch, (b) rewrites history (`git filter-repo`) so they're not
recoverable from the public repo's history, and (c) adds them to `.gitignore` /
a package `files` allowlist so they can't be re-added. Verify with
`git ls-files | grep -E '^_|\.claude/memory/'` returning nothing on the public branch.

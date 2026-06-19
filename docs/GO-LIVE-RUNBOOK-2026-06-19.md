# Go-Live Runbook — freeze → public release (refreshed 2026-06-19)

> Supersedes the original "squash `public-release` → force-push" sketch. That is now
> **DANGEROUS**: `public-release` is branched from the stale `c6f8c8d` and `main` has
> moved 60+ commits. Force-pushing the stale branch over `mycelium.id` would
> **destroy today's work**. The corrected mechanic: **re-derive the clean public tree
> FROM the frozen `main`**, never replace `main` with the old branch.

## State / repos
- **`Curious-Life/mycelium.id`** — currently PRIVATE; the active dev repo (other sessions push here). Becomes the PUBLIC repo at flip.
- **`Curious-Life/mycelium.id-dev`** — PRIVATE mirror; holds full history. Branch **`public-release`** = the proven cleanup+security work (built on `c6f8c8d`). **It is the SPEC for what to change, not the thing we ship.**
- All cleanup + security work is currently ONLY on `public-release`; the live product (`main`) still has every issue.

## 🔴 Invariants (do not violate)
1. **Never** force-push the stale `public-release` over a moved `main`. Re-derive from frozen `main`.
2. Full history must be mirrored into `mycelium.id-dev` **before** any scrub.
3. **Do not push the public artifact until the grep gates are clean** — the first public push IS the artifact.
4. The squash commit author must be a **project identity** (`Curious Life <noreply@mycelium.id>`), NOT `altus@…-MacBook-Pro.local`.

---

## TRACK A — land BEFORE freeze (as normal PRs on `main`; safe on the private dev repo)
These are *content* improvements (additions/edits, not deletions) — landing them on `main` reduces freeze-day to deletions + publish, and gets them reviewed + CI'd. Re-apply from the `public-release` reference:

- **Security fixes** (the product has these live vulns today):
  - SSRF HIGH — `fetchProvider` in `src/inference/base-url.js` + wire into `cloud.js`/`openai-compat.js`/`harness.js` (clean-apply; harness +1 commit minor).
  - recovery-key `no-store` — `src/account/router.js` (+1 commit, minor).
  - publish `sensitive`-doc gate — `src/publish/public-server.js` (clean).
  - REST-TLS bind opt-in — `src/server-rest.js` (**+6 commits → reconcile carefully**).
  - System-B passkey excision — `portal-app/src/routes/login/+page.svelte` (**+3 commits → reconcile carefully**; design `docs/DESIGN-system-b-passkey-excision-2026-06-19.md`).
  - truth-check copy — `README.md` + `docs/guide/handbook/the-vault.md` (clean).
- **Governance files** (new, no conflict): `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config.yml}`, `.github/PULL_REQUEST_TEMPLATE.md`.
- **README / CLAUDE.md / package.json** accuracy edits (key-model, counts, metadata, lean public CLAUDE.md, MCP/data-flow doc fixes). *(README/CLAUDE had 0 main-side commits → near-clean re-apply.)*
- **CI**: confirm `desktop-release.yml` is Apple-Silicon-only (already done on `public-release`).
- **Optional prep:** pre-write the deletion as a script (`scripts/release/scrub.sh` with the rm-lists + keep-lists) so freeze-day F1 is a one-shot.

Each as its own PR; security diffs need a human approval. `npm run verify` green before merge.

---

## TRACK B — FREEZE DAY (deletions + irreversible publish)

### F0 — Freeze + preserve
1. Confirm **all sessions stopped**, all wanted PRs merged, **CI green on `main`**. Record the frozen `main` SHA.
2. **Mirror to dev** (full history incl. today): `git clone --mirror …/mycelium.id /tmp/m.git && cd /tmp/m.git && git push --mirror …/mycelium.id-dev` (or fast-forward `mycelium.id-dev` main).

### F1 — Re-derive the clean public tree FROM frozen `main`
Fresh clone of frozen `main` → apply the known transformations (spec = `public-release` + `docs/PUBLIC-RELEASE-CLEANUP-PLAN-2026-06-18.md`):
- **Purge:** `git rm` 7 `_*.mjs`, `MEMORY.md`, `.claude/memory/`, `docs/SECURITY-REVIEW-2026-06-11.md`, `docs/SECURITY-FOLLOWUP-LIVE-ENV-2026-06-11.md`, the 3 host-leak remote-connect docs; add `.gitignore` guard (`_*.mjs`, `MEMORY.md`, `.claude/memory/`).
- **Structure:** `git rm -r reference/ mycelium-managed/ spike/ research/` (+ harvest `spike/**/RESULT.md`→`docs/spikes/`, `research/`→`docs/`); remove `mycelium-managed`'s **7 verify scripts + their `package.json` keys + their tokens in the `verify` aggregate**; delete the 8 orphan one-off scripts.
- **Docs curation:** keep-list = `docs/guide/**`, `docs/legacy/**`, `docs/spikes/**`, + evergreen top-level (`SETUP, ARCHITECTURE, HOW-IT-WORKS, VISION, ACCOUNT-AND-DATA, HARNESS-RECIPES`); delete everything else under `docs/` (now ~245 files → ~36; **re-run the dangling-link scan + fix** — new docs today may add refs).
- **Ensure governance + README/CLAUDE fixes present** (already on `main` if Track A done; else apply).
- **Ensure the security fixes are present** (on `main` if Track A done).

### F1-gate — grep gates (ALL must be empty)
```
git ls-files | grep -E '^_[^/]*\.mjs$|^MEMORY\.md$|\.claude/memory/|SECURITY-REVIEW-2026-06-11|SECURITY-FOLLOWUP-LIVE-ENV'
git grep -n '0m\.mycelium\.id' -- .            # → nothing
# dangling-link scan over docs/ → empty
```

### F2 — Verify the clean tree
- **Full `npm run verify` GREEN on an ML-equipped checkout** (install `pipeline/setup.sh` venv + Ollama, or run on an equipped machine — the clean room only ran Tier-1 + security gates).
- **Clean-clone smoke:** `npm ci && npm run init-db && node src/index.js` → `36 tools registered` (proven method).
- `npm run portal:check` (svelte-check) green.

### F3 — Publish (DESTRUCTIVE — point of no return)
1. Squash the clean tree → ONE orphan initial commit with the project author:
   `git checkout --orphan public && git add -A && git commit --author="Curious Life <noreply@mycelium.id>" -m "Mycelium — initial public release"`.
2. Force-push over `mycelium.id` `main`. (History preserved in `mycelium.id-dev`.)
3. **Re-create the `v0.1.0` tag** on a valid commit (or skip — see F4; the GitHub Release + its DMG asset are independent of the tag's commit and survive).
4. **Flip `mycelium.id` → PUBLIC** (repo Settings) — only after F1-gate + F2 pass.
5. **Repoint working trees:** `git remote set-url origin …/mycelium.id-dev` in each dev tree/worktree (ongoing private dev).

### F4 — Release artifact + download
1. Tag **`v0.1.1`** (fresh, off the clean code incl. security fixes — the existing v0.1.0 DMG predates them) → `desktop-release` CI builds + signs + notarizes the ARM DMG (~30 min, automated).
2. Landing page (separate repo): add the **Download** button → the public release asset (`/releases/latest/download/Mycelium_<v>_aarch64.dmg`). The asset is only publicly reachable AFTER the repo is public (F3.4).

### F5 — Operator items (do at/just before the public flip)
- Provision `security@`/`conduct@` OR enable **GitHub private vulnerability reporting** (Settings → Security) — SECURITY.md / CoC reference it.
- Set real Sponsors/Stripe links (or leave the removed-placeholder copy).
- Add a `THIRD-PARTY-LICENSES`/`NOTICE` (packaged app bundles GPL `igraph`/`leidenalg` as separate subprocess tools — compatible, attribution is good practice).

---

## POST-LAUNCH (track C — not blocking)
- In-app **update banner** (notify-now → Tauri updater later).
- **Cloudflare** branded download (`get.mycelium.id`) + OS-detect + edge `latest.json`.
- **Linux `npm install`** path (then AppImage/.deb); Intel + Windows later.
- Deferred security: recovery-key step-up re-auth; the LOW findings; manual passkey browser test once remote is live.

## Quick "are we ready?" checklist
- [ ] All sessions stopped, PRs merged, CI green on `main` (frozen SHA recorded)
- [ ] Full history mirrored → `mycelium.id-dev`
- [ ] Clean tree re-derived from frozen `main`; grep gates empty
- [ ] Full `npm run verify` GREEN (ML checkout) + clean-clone smoke + portal:check
- [ ] Squash w/ project author → force-push → **flip public**
- [ ] `v0.1.1` tagged → DMG built → download button live
- [ ] Operator items (security contact, sponsors) done

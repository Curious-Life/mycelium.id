---
name: L1 lockdown blocks git pull / build / tar extract — use the NOPASSWD helper
description: packages/ is mode 555 and ecosystem.config.cjs is root-owned under L1 — never call sudo bash interactively, use the deploy-helper verbs
type: feedback
originSessionId: d31a0231-7a2f-4b43-8214-ddf8e32b6681
---
After L1 lockdown, `packages/**` is read-only (555) and `ecosystem.config.cjs` is root:root 444. Any deploy that writes into those paths (git pull, tar extract, `npm run build:portal`) will fail without unlocking first.

**Why:** L1 enforces "kernel immutable at runtime." A naive `sudo bash scripts/deploy/pull.sh` will also fail — it requires a password that an agent session can't type. There's a NOPASSWD helper installed for exactly this reason; use it. Past stumble: a separate Claude session hit the sudo wall and stalled before realizing the helper existed.

**How to apply:**
- Canonical reference: read `docs/DEPLOYING.md` first. It covers the helper verbs, the canonical recipes, and the things you must NOT do.
- Admin pull: `ssh mycelium-vps "sudo -n /usr/local/sbin/mycelium-deploy-helper.sh pull"` — atomic unlock → `git pull --ff-only` → relock. Never `sudo bash …` and never `git pull` directly.
- Portal rebuild: `unlock && cd ~/mycelium && npm run build:portal && relock` via the helper's `unlock` / `relock` verbs.
- Customer VPSes: `scripts/update-customers.sh` already has inline unlock around the tar extract. Don't remove those hooks.
- Pre-L1 VPSes gracefully skip the relock (helper absent), so the flow is forward-compatible.
- On pull failure, the helper re-applies lockdown before exiting — the box is never left unlocked.

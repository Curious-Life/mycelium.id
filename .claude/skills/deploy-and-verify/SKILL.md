---
name: deploy-and-verify
description: >-
  Use proactively when shipping any code change in this codebase — after a
  commit lands, before declaring "done", or when the user says "deploy",
  "ship", "roll out", "push to production", or "let's deploy". Enforces the
  staged deploy protocol with per-stage verification: admin first → smoke-test
  the changed surface → customer fleet → per-host endpoint check → ledger.
  Refuses the CLAUDE.md §10 anti-pattern ("might have worked"); every step
  validates its own success or fails hard. Includes change-class smoke-test
  recipes (server, worker, D1 migration, portal, bot, egress chokepoint) and
  the SSH cert TouchID gotcha workaround.
---

# Deploy-and-Verify Protocol

When code is about to ship — admin push, customer fleet rollout, Worker deploy, D1 migration, portal rebuild — STOP before declaring "done." Run this protocol. Each step validates its own success; failure halts the deploy.

This is the operational counterpart to `sweep-first-design`. Where sweep-first-design covers thinking, deploy-and-verify covers shipping. Skipping it produces the CLAUDE.md §10 anti-pattern ("Validate every operation; never log a warning and continue. A deployment that 'might have worked' is a deployment that didn't work.").

## When this skill applies

YES — invoke after:
- Any commit that affects `packages/server/`, `packages/core/`, `packages/portal/`, `packages/worker/`, `packages/bots/`, `packages/tools/`, `migrations/`, `agents/`, or `ecosystem.config.cjs`.
- The user says "deploy", "ship", "push", "roll out", "let's deploy", "send it to admin", "update customers", "fleet rollout".
- The user asks "did the deploy work?" or "is it live?" — verify and answer with evidence, not optimism.
- A migration is being applied to D1.
- A Worker change needs `wrangler deploy`.
- A bot subprocess needs restart.

NO — skip when:
- Editing docs (`docs/`, `*.md`) only.
- Editing the `.claude/` config or skill files only (no runtime impact).
- Editing tests without shipping the corresponding code change.
- The user explicitly says "don't deploy yet, I'll do it later."

## The SSH-cert TouchID gotcha — read this first

`bash scripts/sign-cert.sh <handle>` calls 1Password (`op read`) which prompts for TouchID. **TouchID prompts cannot surface from a Claude bash session** — the prompt has nowhere to render. Symptom: `sign-cert.sh` hangs silently for the agent.

**Workaround:** ask the operator to run `bash scripts/sign-cert.sh <handle>` in their OWN terminal. The cert lands at `~/.ssh/mycelium-cert-<handle>.pub` (5-minute TTL, configured in `~/.ssh/config`). After the cert exists, **the agent's SSH commands work without re-prompting** — SSH reads the cert file directly. Verify with `ssh-keygen -L -f ~/.ssh/mycelium-cert-<handle>.pub | grep Valid:` before relying on it.

If the cert expires mid-deploy (5 min is short), ask the operator to re-sign. Don't try to drive `op` from your bash.

## The protocol

### Step 0 — Pre-deploy gate (before pushing anything)

Before `git push`:
- [ ] Tests green locally (`node --test <relevant test files>`).
- [ ] No staged-but-uncommitted code that needs to ship together (`git status` clean modulo intentional WIP).
- [ ] Smoke-test plan written down — what command will prove this change shipped (Step 4 below). If you can't name it, you don't understand the change well enough to deploy it.

Push to origin:
```bash
git push
```

### Step 1 — Operator signs admin cert

Tell the operator:
> Run `bash scripts/sign-cert.sh admin-vps` in your own terminal. (TouchID surfaces there, not here.)

Wait for confirmation. Verify the cert is current:
```bash
ssh-keygen -L -f ~/.ssh/mycelium-cert-admin-vps.pub | grep Valid:
```
Expect a `Valid:` line within 5 minutes of now. If absent or expired → ask operator to re-sign.

### Step 2 — Pull on admin

```bash
ssh mycelium-vps "sudo -n /usr/local/sbin/mycelium-deploy-helper.sh pull"
```

The helper does: unlock `packages/` → `git pull --ff-only` → relock. NOPASSWD; no interactive prompt. **Verify the pull actually advanced:**
```bash
ssh mycelium-vps "cd /home/claude/mycelium && git log -1 --format='%h %s'"
```
Compare to your local `git log -1 --format='%h %s'`. They MUST match. If not, the pull failed silently — investigate before continuing (most common cause: branch divergence; needs operator intervention).

### Step 3 — Restart what changed (PM2 ≠ a magic spell)

Restart logic depends on what changed (consult `docs/DEPLOYING.md` rebuild matrix):

| Changed | Restart |
|---|---|
| `packages/server/`, `packages/core/`, `packages/tools/`, `agents/`, `ecosystem.config.cjs` | restart agent processes |
| `packages/portal/src/` | rebuild portal (unlock → `npm run build:portal` → relock); no restart needed |
| `packages/bots/` (one bot) | `pm2 restart <bot-name>` |
| `migrations/` | apply migration (Step 5 details), no restart unless server code also changed |
| `packages/worker/` | `wrangler deploy` from laptop (Step 6 details); no admin restart |

For agent restarts, **prefer `pm2 restart`** for code-only changes:
```bash
ssh mycelium-vps "pm2 restart personal-agent"
```

**WARNING — env caching gotcha (CLAUDE.md, Claude subscription mgmt):** `pm2 restart` does NOT re-read `ecosystem.config.cjs` env vars. If the change involves env-var assignment (e.g., new `CLAUDE_CONFIG_DIR_<AGENT>`), you MUST delete and re-start:
```bash
ssh mycelium-vps "pm2 delete <name> && pm2 start ecosystem.config.cjs --only <name>"
```
Verify the env was picked up:
```bash
ssh mycelium-vps "PID=\$(pm2 pid <name>) && cat /proc/\$PID/environ | tr '\0' '\n' | grep <VAR>"
```

For full-fleet restart (multiple agents touched):
```bash
ssh mycelium-vps "pm2 restart commercial-intelligence-agent company-agent intel-agent moms-agent ops-agent personal-agent publishing-agent qa-agent research-agent wealth-agent"
```

### Step 4 — Run verify-deploy.sh

```bash
ssh mycelium-vps "cd /home/claude/mycelium && bash scripts/verify-deploy.sh"
```

Auto-detects operator vs customer profile. Checks: PM2 process count, agent health endpoints, portal serves, crash loops, telegram polling, embed-service + llama-server, encryption state. **Exit code is load-bearing:** non-zero → STOP, fix, do not continue to customer fleet.

If `verify-deploy.sh` is silent on a category you care about, fall through to the change-class smoke-test below — `pm2 status: online` alone is NOT verification (CLAUDE.md note about embed-service silently broken after monorepo migration).

### Step 5 — Phase-specific smoke test (the proof your change shipped)

This is the step that's most often skipped and most expensive to skip. Run a command that would FAIL if your code didn't deploy. See "Change-class recipes" below.

**General principle:** prove the new code path executed by either (a) observing a side effect in D1 / logs / audit / response shape, or (b) hitting an endpoint that didn't exist before, or (c) querying state that the new code wrote. "Endpoint returns 200" is rarely sufficient — the endpoint may have returned 200 before your change too.

### Step 6 — Worker deploy (only if `packages/worker/` changed)

```bash
cd packages/worker && npx wrangler deploy
```

**Verify the version bumped:**
```bash
npx wrangler deployments list mycelium 2>&1 | head -5
```
Compare the topmost deployment ID to what was there before. If unchanged, the deploy didn't push.

Smoke-test the Worker endpoint that the change touched:
```bash
curl -s "$MYA_WORKER_URL/api/<endpoint>" -H "Authorization: Bearer $ADMIN_SECRET" | head
```

### Step 7 — Migration (only if `migrations/<NNN>_*.sql` was added)

Apply to admin D1 first:
```bash
cd packages/worker
npx wrangler d1 execute mycelium-db --remote --file=../../migrations/<file>
```

> **Note:** the canonical D1 binding is `mycelium-db`, NOT `mycelium-v2`. `docs/DEPLOYING.md` may still reference `mycelium-v2` — that's stale.

Verify the migration landed:
```bash
npx wrangler d1 execute mycelium-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name='<expected_new_table>'"
# OR for column adds:
npx wrangler d1 execute mycelium-db --remote \
  --command "PRAGMA table_info(<table>)" 2>&1 | grep '<expected_column>'
```

Then each tenant D1 (only if migration touches per-user tables — check `@scope: tenant` annotations in the migration file):
```bash
for tenant in 0mm puh nati; do
  npx wrangler d1 execute mycelium-tenant-$tenant --remote --file=../../migrations/<file>
done
# marti is currently inactive — skip unless reactivated
```

Verify on each tenant the same way as admin. **All five (admin + 4 tenants minus inactive marti) must succeed before declaring migration complete.** If a tenant migration fails, recovery is forward-only — investigate root cause, do not retry blindly.

After migration: regenerate the schema dump:
```bash
bash scripts/generate-schema.sh
git add packages/core/db-d1/schema.sql
git commit -m "schema: regenerate after migration <NNN>"
git push
```

### Step 8 — Customer fleet rollout (only if customer-relevant change)

A change is customer-relevant if it touches `packages/` (excluding admin-only paths) or `ecosystem.config.cjs` for tenant-deployed processes (personal-agent + telegram-bot only on customer VPSes).

Operator signs each customer's cert (TouchID, in their terminal):
> Run `for h in 0mm puh nati; do bash scripts/sign-cert.sh $h; done` in your own terminal. (marti currently inactive; verify before adding.)

Get the admin secret + worker URL once:
```bash
SECRET=$(ssh mycelium-vps "grep -E '^ADMIN_SECRET=' /home/claude/mycelium/.env" | cut -d= -f2-) && \
  export ADMIN_SECRET="$SECRET" && \
  export MYA_WORKER_URL="https://mya.martinam-balodim.workers.dev"
```

Roll the fleet:
```bash
bash scripts/update-customers.sh --restart
```

Flag semantics:
- `--restart` restarts `personal-agent` + `enrichment-service` only (default).
- `--restart-bots` ALSO restarts bot processes (telegram, discord, whatsapp). Implies `--restart`. Pass this only when bot code or env changed; default off.
- `--dry-run` prints what would happen, makes no changes.
- `--backfill-vitality` runs `scripts/backfill-vitality.js` per customer (one-shot; idempotent for backfill-v1 rows only).

The script fails LOUD on every step (per the FAIL-LOUD rewrite). If you see "deployed to N customers, M failed" — investigate which failed and why before declaring done.

### Step 9 — Per-customer endpoint verification

Don't trust `update-customers.sh`'s exit code alone. Verify each customer responds:
```bash
for h in 0mm puh nati; do
  echo "=== $h ==="
  ssh $h "curl -s http://127.0.0.1:3004/health" | head -c 200
  echo
done
```

For phase-specific verification (e.g., new endpoint just shipped):
```bash
for h in 0mm puh nati; do
  echo "=== $h ==="
  ssh $h "curl -s http://127.0.0.1:3004/internal/<your-new-endpoint>" | head -c 200
  echo
done
```

### Step 10 — Verification ledger (the artifact)

Output a ledger to the user. Concrete shape:

```
Deploy verification — <change name> @ <commit>

Admin:
  [✓] git pull advanced to <hash>
  [✓] verify-deploy.sh: 14 pass, 0 fail, 2 warn (telegram polling timing — known)
  [✓] phase-specific smoke: <command> → <expected output>

Worker (if changed):
  [✓] wrangler deploy: version <id>
  [✓] endpoint smoke: <command> → <output>

Migration (if applied):
  [✓] mycelium-db: table/column present
  [✓] tenant 0mm: present
  [✓] tenant puh: present
  [✓] tenant nati: present
  [—] marti: skipped (inactive)
  [✓] schema regenerated + committed

Customer fleet:
  [✓] 0mm: deployed + endpoint OK
  [✓] puh: deployed + endpoint OK
  [✓] nati: deployed + endpoint OK
  [—] marti: skipped (inactive)
```

If any line is anything other than `[✓]` or an explicitly-named `[—] skipped` — the deploy is NOT done. Surface the issue, halt, ask.

## Change-class smoke-test recipes

### Server / core code change (most common)

After admin restart:
```bash
# Health probes
ssh mycelium-vps "curl -s http://127.0.0.1:3004/health | jq ."

# If the change adds/modifies an endpoint, hit it directly
ssh mycelium-vps "curl -s http://127.0.0.1:3004/<new-endpoint>"

# Watch logs for first request (fail-loud catches startup errors)
ssh mycelium-vps "pm2 logs personal-agent --lines 50 --nostream | tail -20"
```

Expect: no error spike in the post-restart window, healthy response shape.

### Egress chokepoint change (Phase 1+ of egress-provenance)

The chokepoint accepts the new header → audit row carries the new provenance class. Manual smoke:
```bash
# Trigger the new path with a known-fake target so you can pattern-match the audit row
ssh mycelium-vps "curl -X POST http://127.0.0.1:3004/telegram/send \
  -H 'x-egress-provenance: <new-class>' \
  -H 'x-egress-template-id: deploy-smoke-test' \
  -H 'Content-Type: application/json' \
  -d '{\"chatId\":\"deploy-smoke\",\"text\":\"smoke test from deploy verify\"}'"

# Confirm audit row classified correctly
ssh mycelium-vps "curl -s http://127.0.0.1:3004/admin/egress-audit/recent?limit=5 \
  -H 'Authorization: Bearer <token>' | jq '.[] | select(.template_id == \"deploy-smoke-test\")'"
```
Expect: row exists, `provenance_kind` matches the new class, `decision` reflects the gate path you intended (likely `denied:apicall-failed:chat_not_found` because chatId was fake — that's correct).

### Portal change

After unlock → build → relock:
```bash
# Verify build artifact is fresh
ssh mycelium-vps "ls -la /home/claude/mycelium/packages/portal/build/ | head -5"

# Hit the portal route the change affects
ssh mycelium-vps "curl -s http://127.0.0.1:3004/portal/<route> | head -c 500"
```
Expect: build directory mtime is post-deploy, route returns expected HTML.

### Bot change

```bash
# Restart the specific bot
ssh mycelium-vps "pm2 restart mya-telegram-bot"

# Confirm it picked up + is polling
ssh mycelium-vps "pm2 logs mya-telegram-bot --lines 30 --nostream | tail -10"
```
Look for the bot's "polling started" or equivalent ready signal. **Then ask the operator to send a real test message** — bot polling is the only thing that surfaces auth/token issues. PM2 "online" with bad token looks identical to PM2 "online" with good token.

### Worker change

After `wrangler deploy`:
```bash
# Confirm version bumped
cd packages/worker && npx wrangler deployments list mycelium 2>&1 | head -5

# Hit the changed Worker endpoint
curl -s "$MYA_WORKER_URL/<endpoint>" -H "Authorization: Bearer $ADMIN_SECRET" | head -c 300
```

### D1 migration

(See Step 7 above for the full pattern.) Beyond verifying the table/column exists, **also verify a write succeeds end-to-end** if the migration adds new write paths. A column that exists but rejects writes (constraint mismatch) is a half-deployed migration.

## Anti-patterns to refuse

- **"PM2 says online, deploy done."** PM2 reports process state, not health. Always run `verify-deploy.sh` AND a phase-specific smoke. (Embed-service incident: online but silently broken after monorepo migration.)
- **`pm2 restart` after env change.** PM2 caches env; restart doesn't re-read. Use `pm2 delete && pm2 start` for env-var changes.
- **Skipping smoke test "because the tests passed locally."** Tests verify code correctness; smoke verifies deploy correctness. They prove different things.
- **Trusting `update-customers.sh` exit code without per-host check.** The script can declare success while a customer is in a half-deployed state. Per-customer endpoint check is mandatory.
- **Applying migration to admin only.** Tenant DBs need it too unless `@scope: operator-only` is annotated. Forgotten tenant migrations surface as cryptic "no such column" errors days later.
- **Forgetting to regenerate schema after migration.** `bash scripts/generate-schema.sh` must run + commit, or the next agent reading the schema dump sees stale state.
- **Re-trying a failed migration without root-cause.** D1 migrations are forward-only. Investigate the failure (constraint? syntax? race?) before retry.
- **`--no-verify` / `--force` to "make the deploy go through."** CLAUDE.md §6 — security shortcuts are non-negotiable refusals. If a hook blocks, the hook is right; investigate.
- **Declaring deploy done without writing the verification ledger.** The ledger is the artifact. No ledger = the user can't audit; future-you can't trace.

## Rollback discipline

If verify-deploy fails or the smoke-test reveals the change is broken:

```bash
# Admin
git revert <commit> && git push
ssh mycelium-vps "sudo -n /usr/local/sbin/mycelium-deploy-helper.sh pull"
ssh mycelium-vps "pm2 restart <agents>"

# Customer fleet (re-roll with the reverted commit)
bash scripts/update-customers.sh --restart
```

D1 migrations don't roll back (forward-only). If a migration is broken, the fix is a NEW migration that corrects the previous one. Never `DROP TABLE` to "undo" — that destroys data.

Worker rollback:
```bash
cd packages/worker && npx wrangler rollback --message "<reason>"
```

Always tell the user when rollback fired, with the reason. Silent rollbacks erode trust.

## Output expectations

When this skill fires, the user should see (in order):
1. Acknowledgement of the change being shipped + named smoke-test plan.
2. Each step's command + its verification command, with output.
3. The verification ledger at the end.

If a step fails:
1. Stop.
2. Surface the failure with the exact command output.
3. Propose a diagnosis and ask before retrying.

Never declare "deployed!" without a verification ledger. Never declare a step succeeded without showing the verification command's output.

## Mycelium-specific reminders

- The customer fleet is **0mm, puh, nati** today. **marti is inactive** — skip it explicitly in the ledger as `[—] skipped (inactive)`. If you're unsure, check `~/.config/mycelium-ssh/customers.yml`.
- Worker deploys run from the laptop (`packages/worker/`), not from the VPS. Don't try to `wrangler deploy` over SSH.
- Bot subprocesses (telegram, discord, whatsapp) load secrets from D1's `secrets` table at startup via `bootstrap-secrets.js`. A bot that worked yesterday and fails today after restart often = D1 / Worker auth issue, not bot code issue. Check the bootstrap log lines first.
- The `mya-` prefix on bot processes is being renamed to `personal-` (per `project_bot_rename_pending.md`); during the transition both names may be in flight. Confirm process names with `pm2 list` before restart.
- Master key recovery: if the VPS rebooted and master.key is missing from `/run/mycelium/master.key`, the agent crashes loudly. Recovery is operator-only via portal master-key endpoint. Do not try to derive the key.
- Customer VPSes have a different PM2 process set than admin (5 vs ~30). `verify-deploy.sh --profile customer` auto-applies the right thresholds.
- `MYA_WORKER_URL` and `MYA_USER_ID` env vars on customer VPSes determine routing. After provisioning, verify they're set with `ssh <customer> "cd /home/claude/mycelium && grep -E '^MYA_(WORKER_URL|USER_ID)=' .env"`.

## Reference: prior verified deploys (canonical examples)

- Phase 0 of egress-provenance (commit `b5ac696`) — admin + customer fleet rollout, verified with audit-row pattern. Egress-chokepoint smoke recipe above is exactly what was run.
- Phase 1 of egress-provenance (commit `def925b`) — same flow + manual `x-egress-provenance: system-template` curl probe to confirm audit classification.

When the operator says "deploy looks good" without showing a ledger, ask for the ledger. When you ship without producing one, you owe the operator one.
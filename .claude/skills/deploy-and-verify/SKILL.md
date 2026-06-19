---
name: deploy-and-verify
description: >-
  Use proactively when shipping any change in this self-hosted V1 vault — after
  a commit lands, before declaring "done", or when the user says "ship",
  "release", "deploy", "is it working?". Enforces verify-ledger-first shipping:
  run the `verify:*` gate(s) for the changed surface (and the full `npm run
  verify` chain before declaring done) until each prints `VERDICT: GO` / exits
  0, then smoke-test the changed path against the actual process the user runs
  (stdio MCP, REST+portal on :8787, public publish on :8788), update the living
  docs, and emit a [✓]/[—] ledger. Refuses the CLAUDE.md §10 anti-pattern
  ("might have worked"). Includes V1 change-class smoke recipes (foundation/
  crypto, MCP tools, REST+portal, ingest/blob, embed/pipeline, migrations,
  publish) and flags that distribution (npm/Tauri) and remote (Tunnel) are
  unshipped — there is nothing to push to yet.
---

# Deploy-and-Verify Protocol (V1 self-hosted)

V1 is a **self-hosted, single-user** cognitive vault: one encrypted `mycelium.db`,
run on the user's own machine over stdio (MCP), localhost REST + portal (`:8787`),
or the public publish server (`:8788`). There is **no fleet, no SSH deploy, no
`wrangler`, no PM2, no customer VPSes.** "Deploying" V1 means landing a change to
that local vault such that you can *prove* it works — not pushing to remote hosts.

This is the operational counterpart to `sweep-first-design`. Where sweep-first-design
covers thinking, deploy-and-verify covers shipping. Skipping it produces the
CLAUDE.md §10 anti-pattern: *"Validate every operation; never log a warning and
continue. A change that 'might have worked' is a change that didn't work."*

## What "shipping" means in V1

There is no remote target to deploy to. Shipping a change = **all four, in order:**

1. **Verify green** — the `verify:*` gate(s) covering the changed surface reach
   `VERDICT: GO` and exit 0 (full `npm run verify` before declaring done).
2. **Smoke the changed surface** — boot the actual process the user runs and
   exercise the path you changed; prove the new code executed.
3. **Living docs current** — spec status / ARCHITECTURE / build log updated in
   the same commit (pairs with `living-docs`).
4. **Commit (+ PR)** on the working branch.

> **Distribution and remote access are NOT shipped yet.** `package.json` is
> `"private": true` (no npm publish); `src-tauri/` is a scaffold (macOS dmg
> target, points at the legacy portal, bundles no Node, unsigned); Cloudflare
> Tunnel / Tailscale are **doc-only** (`docs/SETUP.md`, `docs/CONNECTORS.md`) —
> there is zero remote-deploy infra code (`docs/PRE-LAUNCH-READINESS-*.md`).
> Don't write a deploy step for a target that doesn't exist. See the last
> section for what to verify *when* these land.

## When this skill applies

**YES — invoke after / when:**
- A commit touches `src/`, `migrations/`, `pipeline/`, `portal-app/`, `scripts/`,
  or a `scripts/verify-*.mjs` gate.
- The user says "ship", "release", "deploy", "is it live/working?", "did that work?".
- A migration file (`migrations/<NNN>_*.sql`) was added or changed.
- Before declaring any build unit "done".

**NO — skip when:**
- Editing `docs/**.md` only.
- Editing `.claude/` config or skill files only (no runtime impact).
- Editing tests without shipping the corresponding code change.

## The protocol

### Step 0 — Pre-ship gate (before committing)

- [ ] Working tree is intentional (`git status` — no stray WIP riding along).
- [ ] You can **name the `verify:*` gate** that covers this change (Step 1) and
      the **smoke command** that would FAIL if the change didn't take (Step 2).
      If you can't name both, you don't understand the change well enough to ship it.

### Step 1 — Run the verify ledger (the gate)

Run the gate for the surface you touched for a fast loop, then the **full chain**
before declaring done:

```bash
npm run verify:<surface>     # fast loop on the changed surface
npm run verify               # full chain — required before "done"
```

Each gate prints `PASS`/`FAIL` per check and a final verdict; the exit code is
load-bearing. The convention (verified at `scripts/verify-foundation.mjs`):

```js
const allPass = ledger.every(Boolean);
console.log(`VERDICT: ${allPass ? 'GO — …' : 'NO-GO — see FAIL rows'}`);
process.exit(allPass ? 0 : 1);          // some gates also print `EXIT=0|1`
```

**Never claim green without watching the ledger reach `VERDICT: GO` and EXIT 0.**
"The command finished" is not "the command passed" — read the verdict line.

> **Tier-2 honesty.** Gates that need real models / a networked host (real Nomic
> embeddings, real clustering, live LLM enrichment, OAuth against a real IdP) may
> be unrunnable in this environment. If so, say **"Tier-2 — needs a networked
> host"** and mark that row `[—]` in the ledger. Do **not** fake a green you
> could not run (CLAUDE.md §10).

### Step 2 — Smoke the changed surface (the proof)

The gate proves the suite passes; the smoke proves *your change* shipped. Boot the
actual process the user runs and exercise the changed path. **General principle:**
prove the new code path executed — a side effect in the vault, a changed response
shape, or a route/tool that didn't exist before. "It boots" / "returns 200" is
rarely proof; it may have done that before your change too.

See the change-class recipes below. There is **no `/health` endpoint** — readiness
is inferred (`GET /api/v1/tools` → 200 = vault open; `GET /api/v1/account/status`
→ setup mode; `GET /` → portal loads).

### Step 3 — Update living docs (same commit)

Per `living-docs`: flip the spec/verification-table status, update `docs/ARCHITECTURE.md`
for any component/flow/port/count the change touched, add a build-log line with the
commit hash + new verify check. Docs land **in the same commit** as the code.

### Step 4 — Emit the verification ledger (the artifact)

```
Ship verification — <change> @ <commit>
  [✓] verify:<surface>           VERDICT: GO  (n PASS, 0 FAIL)
  [✓] npm run verify             full chain GO, EXIT 0
  [✓] smoke: <command>           → <observed side effect / shape>
  [—] <tier-2 row>               skipped — needs networked host
  [✓] living docs updated        (ARCHITECTURE §X, spec table row)
```

Anything that isn't `[✓]` or an explicitly-named `[—] skipped` means the change is
**not done**. Surface it, halt, ask.

## Change-class smoke recipes

### Foundation / crypto (`src/crypto`, `src/adapter`, `src/account`)
```bash
npm run verify:foundation && npm run verify:keysource && npm run verify:account
```
Prove: boots, **encrypts at rest** (ciphertext on disk, not plaintext), **fails
closed** on a wrong/missing key. CLAUDE.md §1: the smoke itself must never print
vault plaintext — if it does, fix the smoke, not the assertion.

### MCP tools (`src/tools`)
```bash
npm run verify:mcp && npm run verify:context
```
Prove the tool is **registered, invokable**, and its **error path redacts** (no
plaintext / no `err.message` leak in tool errors — the #30 / #37 lesson). A new
tool that returns 200 but isn't in `getContext`/`listTools` is half-shipped.

### REST + portal (`src/server-rest.js`, `portal-app/`)
```bash
npm run verify:rest && npm run verify:portal-serve && npm run verify:integration
npm run portal     # boot the real server on :8787, then:
#   GET /api/v1/tools           → 200 + tool list  (vault open)
#   GET /api/v1/account/status  → setup-mode markers (vault closed)
#   GET /                       → portal HTML
```
`verify:integration` boots REST on an ephemeral port and runs the real journey
(import → timeline → profile → mindscape) + edge cases. **Visual correctness needs
a human eyeball** — there's no browser here; say so and ask the operator to look.

### Ingest / blob (`src/ingest`)
```bash
npm run verify:ingest && npm run verify:blob && npm run verify:import && \
  npm run verify:import-timestamps && npm run verify:import-security
```
Prove the capture choke-point **persists + encrypts** and the import journey works
end to end. **Verify the seam the frontend/child actually uses, not just the
endpoint** — the real Mac test caught an upload-path bug and a child `dbPath` bug
that the endpoint-level gates missed.

### Embed / pipeline (`src/embed`, `pipeline/`)
```bash
npm run verify:embed     # adapter/wiring
```
Real Nomic embeddings, clustering (`pipeline/cluster.py`), harmonics, and LLM
chronicles are **Tier-2** — they need a networked host with the model server.
Verify the wiring/contract here; mark the model-dependent rows `[—] Tier-2`.

### Migration (`migrations/<NNN>_*.sql`)  ← folded in from the removed tenant-schema-parity skill

V1 has **one** vault file and **no fleet** — cross-DB drift is impossible. But the
runner is only **"idempotent-ish"**, so a migration still needs hygiene before it ships.

Migrations are applied in lexical order by `applyMigrations()`
(`src/db/migrate.js:26-39`), automatically on first boot via `ensureVaultSchema()`
in `src/server-rest.js`, and manually via `npm run init-db`. The runner guards
re-runs for exactly **one** bare `ALTER TABLE … ADD COLUMN` per file — the regex
matches the **first** such statement only (`src/db/migrate.js:31`). So a file with
**multiple** `ADD COLUMN`s, a bare `CREATE INDEX`, a `RENAME`, or a backfill
`UPDATE`/`INSERT` is **NOT** re-run-safe (`migrate.js:5-7` says so in its own words).

Before shipping a migration:

1. **Make each statement self-idempotent** — the runner can't help beyond the first
   ADD COLUMN. Use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. For
   several new columns, prefer **one `ADD COLUMN` per file** (so the per-file guard
   fires for each) rather than many in one file.
2. **Prove idempotency on fresh AND populated** — run it twice; the second run must
   not throw:
   ```bash
   MYCELIUM_DB=/tmp/mig-check.db npm run init-db   # fresh
   MYCELIUM_DB=/tmp/mig-check.db npm run init-db   # re-run: expect no "duplicate column" / "already exists" throw
   rm -f /tmp/mig-check.db
   ```
3. **Fail closed in the reading code** — code that depends on the new column/table
   must verify it exists and refuse if absent. The exemplar is `src/publish/public-server.js`,
   which checks `documents.publish_nonce` at boot and throws *"apply migration 0003
   before serving"*. Never ship a query that silently assumes the column.
4. **Add/extend a `verify:<surface>` gate** that writes **and** reads the new
   column/table, so the schema↔code contract lives in the ledger.
5. **Update the migration count + schema notes** in `docs/ARCHITECTURE.md` (`living-docs`).

### Publish / public surface (`src/publish`)
```bash
npm run verify:publish
```
The public server fail-closed-checks `documents.publish_nonce` at boot — a clean
boot confirms migration 0003 is applied. Smoke a publish → fetch the unlisted URL →
confirm revocation (nonce rotation) actually 404s the old link.

### Remote MCP / OAuth (`src/server-http.js` auth+CORS, `src/auth.js`, discovery, `/mcp`)
**A change here is NOT shipped until the official MCP Inspector connects and lists tools — verified in a REAL BROWSER (WebKit, the way Safari runs it), not `curl`/CLI.** Server-side clients (Claude's connector backend, `curl`, the Inspector **CLI**) do not enforce CORS, so they give a FALSE GREEN while the browser OAuth flow fails. (2026-06-04: three stacked browser-only CORS gaps — `OPTIONS`-preflight 404 on `/api/auth/*`, `.well-known/*` 404s with no CORS, and credentialed `/token` with no CORS — each invisible to curl; all fixed in PR #83. The claude.ai connector still fails *separately* — an Anthropic-side bug, support-confirmed; production runs via Claude Desktop + `mcp-remote`.)
```bash
# 1. CLI smoke (necessary, NOT sufficient): official Inspector reaches /mcp with a token
npx -y @modelcontextprotocol/inspector --cli https://<host>/mcp \
  --transport http --method tools/list --header "Authorization: Bearer <token>"
# 2. THE ACTUAL GATE — drive the Inspector UI in WebKit until Connected:true + tools listed.
#    Capture the FULL network trace (the bug is usually layered). Playwright-webkit harness
#    pattern (left in /tmp/cors-test 2026-06-04):
#      run.mjs    = fetch-probe each .well-known/discovery URL (a throw == Safari "Load failed")
#      drive3.mjs = full UI OAuth, Connection Type = Direct (avoids the Inspector's proxy)
#      drive4.mjs = log every request to the server (status, origin, cookie, ACAO/ACAC)
```
Gotchas: for the credentialed `/token` (and the preflight) **reflect the Origin + set `Access-Control-Allow-Credentials: true`** — browsers reject `*` for credentialed requests; do NOT widen `/authorize` (top-level navigation, never a CORS fetch — widening leaks an auth code via the operator session). `curl` ≠ browser. Cross-account record: `docs/REMOTE-CONNECT-HANDOFF-2026-06-03.md` (2026-06-04 section) + auto-memory `verify-remote-mcp-against-inspector.md`.

## When distribution / remote DO land (verify-then, not now)

- **Tauri bundle** (`src-tauri/`): when real, verify the bundle **boots the Node
  server**, **serves the canonical `portal-app/build`** (not the legacy `../portal`),
  and is **signed/notarized**. Until then there is no app to "deploy".
- **npm package**: when `"private"` is dropped, verify `npm pack` contents (no
  `data/`, no keys, no `.env`), a clean install boots, and the `bin`/entry works.
- **Remote (Tunnel/Tailscale)**: when real, verify the tunnel maps to `:8787`, the
  OAuth gate holds over the public hop, and the **master key never traverses it**
  (CLAUDE.md §4 — VPS/loopback-only). The recovery-key HTTP relaxation is
  **loopback-only** by design (see `MEMORY.md`); a remote hop must not widen it.

## Anti-patterns to refuse

- **"verify exited 0" without reading the `VERDICT` line** — or without the changed
  surface having any gate at all. The verdict line is the signal; a missing gate is a hole.
- **"It boots, ship it."** Boot ≠ the changed path ran. Smoke the path with a
  proof-of-execution (side effect / new route / changed shape).
- **Faking a Tier-2 green.** If you can't run real models/embeds/clustering/OAuth
  in this env, say "Tier-2 — needs a networked host" and mark `[—]`. Never claim it passed.
- **Plaintext in the smoke output.** If your smoke prints vault content into logs/
  responses, that's a CLAUDE.md §1 violation — fix the smoke.
- **Assuming the migration runner makes any migration idempotent.** It guards only
  the **first** bare `ADD COLUMN` per file (`migrate.js:31`). Prove re-run safety yourself.
- **`--no-verify` / `--force` / skipping a hook** to "make it green." CLAUDE.md §6 —
  non-negotiable refusal. If a hook blocks, the hook is right; investigate.
- **Declaring "done" without updating living docs and emitting a ledger.** The
  ledger is the artifact; stale docs are drift.

## Output expectations

When this skill fires, the user should see, in order:
1. Acknowledgement of the change + the **named** gate and smoke plan (Step 0).
2. The gate output (Step 1) — with the `VERDICT` line visible.
3. The smoke output (Step 2) — the proof-of-execution.
4. The living-docs update (Step 3) landing in the same commit.
5. The `[✓]/[—]` verification ledger (Step 4).

If a step fails: **stop**, surface the exact command output, propose a diagnosis,
and ask before pushing past it. Never declare "shipped" without a ledger.

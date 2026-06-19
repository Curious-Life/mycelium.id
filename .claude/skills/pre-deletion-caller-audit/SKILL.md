---
name: pre-deletion-caller-audit
description: >-
  Use proactively when deleting or replacing existing code, schema, or
  infrastructure in this codebase — a function, module, file, env var,
  config flag, D1 table or column, endpoint, Worker route, MCP tool, or
  package. Including renames (a rename is a delete-plus-add). Enforces
  the audit-and-verify discipline: inventory every caller, classify each
  (migrated / not-migrated / dead), prove migration with concrete
  evidence (tests + audit data + smoke), define falsifiable decision
  criteria BEFORE the deletion lands, run the pre-flight gate, then
  execute. Refuses "soft delete" comments and grep-only audits. Required
  for Phase N "delete the old path" work in any multi-phase refactor.
---

# Pre-Deletion Caller Audit Protocol

Before deleting or replacing any existing code, schema, or infrastructure: STOP and run this protocol. Deletions are different from additions — they have a unique failure mode where a path you didn't know existed silently breaks because you removed its target.

This is the third leg of the operational triad alongside `sweep-first-design` (for additions) and `deploy-and-verify` (for shipping). Where sweep-first-design covers "what should we build" and deploy-and-verify covers "did it ship cleanly", this skill covers "is the old path safe to remove."

## When this skill applies

YES — invoke before:
- Removing a function, method, class, module, file, or package.
- Removing or renaming an env var, config flag, command-line option.
- Dropping a D1 table or column, or removing FK references.
- Removing a Worker route, binding, or queue.
- Removing an MCP tool or one of its handlers.
- Removing an endpoint (HTTP route in any package).
- Renaming any of the above (a rename = delete-plus-add; both halves need verification).
- Phase N work in a multi-phase refactor where N is "delete the old fallback / shim / parallel path" (e.g., Phase 3 of egress-provenance: delete `deliverNaturalReplyFallback` + `proactiveSendFallback`).
- "Cleanup" PRs that remove things judged "unused."

NO — skip when:
- The change is purely additive (use sweep-first-design instead).
- The deletion is of a file that was ADDED in the same uncommitted batch and never shipped.
- The deletion is documentation-only.

## Step 1 — Exhaustive caller inventory

Grep is the start, not the end. Code references hide in:
- **Source code** under `packages/`, including dynamic dispatch via maps/registries.
- **Scripts** under `scripts/` (cron, ad-hoc, fleet runners).
- **Tests** under `packages/*/test/` and `tests/`.
- **Migrations** under `migrations/` (FK refs, constraint refs, view bodies).
- **Documentation** under `docs/`, including architecture docs that reference function names or schemas.
- **Prompts** in `packages/server/chat/prompt-sections.js`, `packages/server/chat/prompt-builders.js`, agent persona files. Agents may have curl examples or tool references hardcoded.
- **Config** in `ecosystem.config.cjs`, `agents/*.json`, `wrangler.toml`, `.env`, `.claude/settings.json`.
- **D1 schema** in `packages/core/db-d1/schema.sql` and per-tenant equivalents.
- **Worker bindings** in `packages/worker/wrangler.toml` (D1, R2, Queues, KV, Vectorize, env).
- **Other repos** — `mycelium.id` (open-source mirror), `MYA-0.2`, `mycelium-ios`, `mycelium-transcriber`, `mycelium.id-site`, `war-room` ($WARROOM_PATH). They may import or reference Mycelium symbols.

Run greps explicitly:
```bash
# The symbol itself
grep -rn "<symbolName>" packages/ scripts/ migrations/ tests/ agents/ docs/ ecosystem.config.cjs

# Re-exports + barrel imports (catches "from '@mycelium/core'" pattern)
grep -rn "from ['\"]@mycelium/[^'\"]*['\"]" packages/ | grep "<symbolName>"

# Dynamic-dispatch tables (objects keyed by name)
grep -rn "['\"]<symbolName>['\"]" packages/

# Cross-repo if applicable
grep -rn "<symbolName>" ~/Documents/GitHub/mycelium.id/lib/ \
  ~/Documents/GitHub/MYA-0.2/src/ \
  ~/Documents/GitHub/mycelium-ios/MyceliumMobile/MyceliumMobile/ 2>/dev/null

# Documentation
grep -rn "<symbolName>" docs/ *.md
```

For schema deletions (table / column drops):
```bash
# Existing migrations may CREATE / ALTER the target — find them
grep -n "<table_or_column>" migrations/*.sql

# Live D1 references
grep -rn "<table_or_column>" packages/core/db-d1/

# Worker SQL (if applicable)
grep -rn "<table_or_column>" packages/worker/src/
```

For Worker route / binding deletions:
```bash
# Direct callers (HTTP)
grep -rn "<route_path>\|<binding_name>" packages/

# wrangler.toml bindings
grep -n "<binding_name>" packages/worker/wrangler.toml
```

**Output of Step 1:** a numbered list of every reference found, file:line each. If the list is suspiciously short (< 3 references for a non-trivial symbol), grep harder — names get shadowed by aliases, dynamic imports, or string-keyed dispatch.

## Step 2 — Classify each caller

For each entry from Step 1, mark one of:

- **(M) Migrated** — calls the new path / no longer references the old. Cite the commit / PR that did the migration.
- **(N) Not migrated** — still uses the old path; deletion would break it. WIP item; track explicitly.
- **(D) Dead** — caller itself is unreachable (e.g., test for a feature that was removed; documentation describing an old design). Verify dead status before claiming it; "I think no one uses this" is not a verification.
- **(O) Out of scope** — third-party, cross-repo, or intentionally preserved (e.g., backwards-compatibility shim slated for a later phase).

The classification table is the artifact. Example:

```
Symbol: deliverNaturalReplyFallback (Phase 3 of egress-provenance)

| # | Reference                                    | Status | Notes                       |
|---|----------------------------------------------|--------|-----------------------------|
| 1 | packages/server/routes/chat.js:184-284       | (N)    | The function itself; deletion target |
| 2 | packages/server/routes/chat.js:1098          | (N)    | Invocation site; delete with #1 |
| 3 | packages/server/test/routes/chat.test.js:312 | (N)    | 5 fallback tests; delete    |
| 4 | docs/architecture/MESSAGE-PERSISTENCE.md §10 | (M)    | Updated for explicit-send architecture in commit X |
| 5 | docs/EGRESS-PROVENANCE-PLAN-2026-05-06.md    | (O)    | Plan doc references the old path intentionally — keep as historical record |
```

If any row is `(N)`, you cannot proceed to Step 5 yet — that caller's migration is part of the deletion PR's scope.

## Step 3 — Prove migration with concrete evidence

For each `(M)` row, verify:
- **Test coverage** — a test asserts the new path's contract. Cite test file:line.
- **Production evidence** — audit log / metric / log line / D1 query confirms the new path is live and firing. Phase 0 instrumentation exists exactly for this.
- **Smoke test** — manual trigger of the new path returns the expected outcome. Cite the command + expected output.

If you can't produce all three for a critical migration, the migration isn't verified — fix that BEFORE the deletion.

For schema migrations, "migrated" means: every row in the new shape, no live reads/writes against the old shape, and a forward-only catch-up migration exists if any row is missing the new value.

## Step 4 — Define falsifiable decision criteria BEFORE the deletion

Decision criteria are queryable, time-bounded statements that PRE-DATE the deletion. You don't reverse-engineer them after the fact ("the deploy looked fine, ship it"). Examples:

| Deletion class | Falsifiable criteria |
|---|---|
| Replacing fallback path with new tool | "Audit log shows zero `<old-class>` events over 7 production days while `<new-class>` event count grew proportionally" |
| Retiring a flag | "Zero requests with `<flag>` field over 7 days across all agents in fleet" |
| Dropping a D1 column | "Schema query shows 100% of rows in `<table>` have null `<column>` for >24h" |
| Removing an MCP tool | "MCP usage logs show zero invocations of `<tool>` in 7 days; no agent prompt references it" |
| Removing a Worker route | "Worker analytics show zero requests to `<route>` in 7 days; client code (bot, portal, agent) all migrated" |
| Removing a script / cron | "PM2 logs / cron history show no fires of `<script>` in 7 days; no other PM2 entry depends on it" |

Criteria must be **falsifiable** ("audit shows X = 0 over 7 days") not aspirational ("looks like nothing uses it"). Time-bound; "currently" is not a duration.

If the criteria can't be expressed as a query, you don't yet have the observability to delete safely. Either add the observability first (Phase 0-style instrumentation) or postpone the deletion until you do.

## Step 5 — Run the pre-flight gate

Execute the queries from Step 4. Numbers go in the deletion PR's description, not just in your scratchpad.

```bash
# Examples — vary by deletion class

# For egress provenance Phase 3:
ssh mycelium-vps "curl -s http://127.0.0.1:3004/admin/egress-audit/recent?days=7 \
  -H 'Authorization: Bearer <token>' \
  | jq '[.[] | select(.provenance_kind == \"agent-explicit-via-fallback\")] | length'"
# Expected: 0 (or near-zero with documented exceptions)

# For column drop:
cd packages/worker && npx wrangler d1 execute mycelium-db --remote \
  --command "SELECT COUNT(*) FROM <table> WHERE <column> IS NOT NULL"
# Expected: 0
```

If any query returns non-zero or unexpected data, the criteria FAIL — halt the deletion and investigate. Don't paper over with "close enough."

## Step 6 — Execute the deletion + verify nothing broke

The deletion PR should:
1. Remove the symbol / file / column / route.
2. Remove ALL references identified in Step 1 marked `(M)` whose existence is no longer justified (often tests for the deleted path).
3. Update documentation that referenced the old path (Step 1 row #4 / #5 in the example).
4. Apply any cleanup migration if D1 schema is involved.

Then run `/deploy-and-verify`. The verification ledger must explicitly include:
```
[✓] Deletion smoke: <command that would have hit the old path> → expected error/empty
[✓] Replacement smoke: <command that hits the new path> → expected success
[✓] No grep matches for <symbolName> outside expected residual locations (docs/historical)
```

If post-deploy a regression surfaces (a `(D)` row turned out to be live, a cross-repo caller was missed), the rollback is `git revert` + redeploy. The discipline doesn't promise no regressions; it minimizes them and makes recovery straightforward.

## Anti-patterns to refuse

- **"I think nothing uses it."** Grep + classification is the bar. "Think" is not a verification.
- **Trusting grep on a name with aliases.** If the symbol is re-exported (`@mycelium/core` barrel), dynamically dispatched (object keyed by name), or referenced as a string anywhere, plain grep misses callers. Augment with usage analysis.
- **Skipping criteria because "the change is small."** Small changes hide in production for years. Phase 4 of egress-provenance retires `trusted: true` — a one-line check across handlers — and still requires criteria.
- **"Soft delete" with a comment saying `// REMOVE THIS LATER`.** It accumulates. Either delete now (with this protocol) or don't delete.
- **Deleting tests of the old path WITHOUT writing equivalent tests of the new path.** The deletion PR should preserve coverage at the contract level even when the implementation moves.
- **Forgetting cross-process callers.** MCP child processes load tool definitions from a registry; bot subprocesses curl HTTP routes; the Worker calls D1 over a different binding than the agent-server. A symbol "unused in packages/server/" can still be called from packages/tools/ or packages/worker/.
- **Skipping the cross-repo grep.** mycelium.id is the open-source mirror — its files are documentation-grade copies but they may reference our schema. If the mirror is out of sync, fix it post-deletion.
- **Forgetting prompt references.** Agents have curl examples and tool names hardcoded in `prompt-sections.js`. A renamed tool that still appears in prompts will surface as agent confusion, not a runtime error.
- **Renaming without migrating callers in the same PR.** The window between "old name removed" and "callers updated" is a regression window. Either rename atomically (with all callers updated in one diff) or leave a re-export shim with an explicit deprecation and a tracked deletion ticket.
- **Trusting "tests pass" as evidence migration completed.** Tests cover the contracts you wrote tests for. If a caller path lacked test coverage, "tests pass" tells you nothing about whether deletion is safe.

## Mycelium-specific reminders

- **The `agent-egress.send` / `recovery.notifyContinuation` / `recovery.notifyRecovery` lesson** (Phase 1 of egress-provenance): the design doc identified two callers; sweep #3 surfaced a hidden third. **Always grep one more time before declaring "all callers migrated."** The third caller will have a slightly different signature or be in a sibling file you didn't expect.
- **Phase 3 of egress-provenance** is the canonical upcoming use of this skill. Pre-flight criteria live in [docs/EGRESS-PROVENANCE-PLAN-2026-05-06.md §Phase 3](../../../docs/EGRESS-PROVENANCE-PLAN-2026-05-06.md): "Phase 0 audit data must show the `agent-explicit` event count growing to roughly cover the historical fallback fire count, OR investigation explaining the gap."
- **BGE-M3 / Vectorize amputation (Wave 4b, May 2026)** is the canonical past example. Worker bindings, generateEmbedding routes, /api/embed/* + /api/enrich/* + /api/vectors/*  + /api/search/hybrid all required caller migration before deletion.
- **Worker rename pending** (mya → mycelium): see `project_mycelium_worker_rename` memory entry. Side-by-side migration; pre-deletion criteria not yet defined. Future work for this skill.
- **Two legacy personal agent IDs** (`personal-agent` vs `mya-personal`) — kept side by side because deletion criteria are NOT met. Documented as a permanent historical case in MEMORY.md.
- **Bot rename pending** (`mya-telegram-bot` → `personal-telegram-bot` etc.) — `project_bot_rename_pending` memory. Same protocol applies; PM2 entries + ecosystem.config.cjs + scripts/* need atomic update.
- **Customer fleet asymmetry**: customer VPSes only have personal-agent + telegram-bot. A symbol "used only by ops-agent" is safe to delete without customer-fleet impact, but verify with `ssh <customer> "grep <symbol> /home/claude/mycelium/packages/..."` if uncertain.
- **The `mycelium-v2` D1 reference is stale** — production binding is `mycelium-db`. If you grep for "mycelium-v2" you'll find docs needing update; deleting it from any code path is safe but verify zero callers first.
- **Forward-only D1 migrations**: dropping a column requires a NEW migration, not an in-place edit of the original. The original migration's history is fixed.
- **Cross-repo callers**: mycelium.id (open-source mirror, documentation-grade), MYA-0.2 (older agent code), mycelium-ios (Swift app), mycelium-transcriber, mycelium.id-site, war-room (Python; $WARROOM_PATH). Always grep these for the symbol before declaring "all callers migrated."

## Output expectations

When this skill fires, the user should see:
1. The numbered Step 1 inventory (the grep results, classified).
2. The classification table from Step 2 with each row's status.
3. The migration evidence per `(M)` row from Step 3.
4. The decision-criteria queries + their actual results from Step 4-5.
5. The deletion diff + the deploy-and-verify ledger from Step 6.

If the criteria fail at Step 5, surface the failure with the exact query output and ask before proceeding. Don't argue around the numbers — the criteria are falsifiable on purpose.

## Reference: prior verified deletions

- **BGE-M3 / Vectorize amputation (Wave 4b)** — multi-PR migration; Worker bindings deleted last after `WorkersAIService.generateEmbedding` callers all moved to local Nomic ONNX.
- **A2 worker amputation** — `f74f351`, `e7d17166` — Telegram + import + scanner zombie surface deleted from packages/worker. 23 files, ~940 lines from index.ts. Bundle 322 KiB. Documented in `docs/CLEANUP-PLAN-2026-05-05.md`.

When the user is preparing a "delete the old X" change, this skill is the first action — not the last.

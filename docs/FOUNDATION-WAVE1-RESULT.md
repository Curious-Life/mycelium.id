# Foundation (Wave 1) — spine result: **GO**

**Date:** 2026-05-30 · **Verdict:** GO — the load-bearing vertical boots, encrypts, and fails closed.
Reproduce: `npm install && npm run verify:foundation` (exits 0, deterministic across runs).

## What's proven (`scripts/verify-foundation.mjs`, 6/6 PASS)

| # | Check | Evidence |
|---|---|---|
| B1 | 111-table schema loads in better-sqlite3 | 117 tables (111 + FTS5 shadow tables) |
| B2 | two-key unlock + KCV creation (D4/D6) | USER_MASTER + SYSTEM_KEY loaded, KCV written |
| B3 | document round-trip through the encrypting adapter | `title` + `content` round-trip to plaintext (transparent decrypt) |
| B4 | ciphertext-at-rest | raw `content` column is an envelope, `isEncrypted=true`, no plaintext leak |
| B5 | wrong USER_MASTER rejected at KCV | **fail-closed unlock** — throws before any vault row is touched |
| B6 | wrong key cannot decrypt vault data | decrypt throws; row stays ciphertext, secret never returned |

This exercises the whole spine: `src/adapter/d1.js` (D1-shaped async wrapper with
transparent `autoEncryptParams`/`autoDecryptResults`) + `src/crypto/` (ported
`crypto-local.js` + guardians + two-key `keys.js`) + the 111-table schema.

> Note on B6 output: a `[DECRYPT ERROR] field="content"` line is **expected** — it is the
> wrong key failing to decrypt, leaving the row as ciphertext. That IS the fail-closed
> behavior the check asserts (the secret is never returned as plaintext).

## Milestone 2 — MCP server boots + serves tools (`scripts/verify-mcp.mjs`, 5/5 PASS)

| # | Check | Evidence |
|---|---|---|
| C1 | server boots, tools registered | 7 tools registered, 7 deferred |
| C2 | all tools expose JSON-Schema `inputSchema` | every `tool.inputSchema.type === 'object'` (not Zod) |
| C3 | client `tools/list` over the wire | a real MCP `Client` over InMemoryTransport saw all 7 |
| C4 | `tools/call` round-trip | `createTask` → wrapped `{content:[{type:'text',…}]}` envelope, persisted through the encrypting db |
| C5 | unknown tool → `isError` (no crash) | `isError=true` |

Also verified the **real stdio entry** (`src/index.js`) as a subprocess: an MCP
`StdioClientTransport` client completed `initialize` and listed 7 tools — the exact
path Claude Desktop uses. Deterministic across repeated runs.

**Registered now (7 tools, 4 domains):** `getHealthData`, `createTask`,
`getCurrentPhase`, `getTrajectoryHistory`, `getActiveMilestones`, `getTopMovers`,
`getDailyMessages` (health, tasks, fisher-tools, messages).

**Deferred (each needs a subsystem not yet built — lands with its Wave-2 unit, never
silently dropped):** `metrics` (needs `@mycelium/metrics/contracts` — `CONTRACTS`, not in
`reference/`), `documents` + `internal` (mind-files), `topology-tools` (topologyHelpers),
`mindscape` (mind-search), `reply`, `services`.

### Build-new glue added this milestone
- `src/db/helpers.js` — the injected helpers absent from `reference/`
  (`parseHealthRow`, `computeHealthSummary`, `cofireCol`, `hashTokenSync`), written against
  the verified call-site contracts.
- `src/db/index.js` — `getDb()` assembly wiring the 13 tool-facing namespaces (+ `rawQuery`).
- `src/mcp.js` — low-level `Server` registration seam: JSON-Schema passthrough, string→
  `content` wrapping, duplicate-name + missing-handler guards.
- `src/index.js` — stdio boot (two-key unlock → db → domains → Server → stdio).

### Porting finding: `@mycelium/*` workspace aliases
Two files import canonical-monorepo aliases that don't resolve here:
`tools/metrics.js` → `@mycelium/metrics/contracts/index.js` (CONTRACTS — **not in
`reference/`**, so metrics is deferred, not faked) and `tools/documents.js` →
`@mycelium/core/document-store.js` (present at `reference/core/document-store.js` — a
rewrite-to-relative when documents is wired in Wave 2). Wave-2 units must rewrite these
imports to local paths.

## The real bug found + fixed: adapter mis-used the `autoEncryptParams` contract

`autoEncryptParams(sql, params, scope, masterKey, userId, opts)` has a non-obvious contract,
verified by reading the source:
- It **mutates `params` in place** — encrypting values, and *rewriting the array* when it
  injects a `scope` column (`crypto-local.js:1396-1397`).
- It **returns the possibly-rewritten SQL string** (`:1408`), NOT the params.
- It needs `opts.systemKey` to write the `secrets` table (`SYSTEM_KEY_TABLES`).

The first adapter draft assigned the return value to `bound` and spread that **string** into
`stmt.run()` → `RangeError: Too many parameter values`. Fixed: bind `params` (mutated in
place), prepare the **returned** SQL, and pass `{ systemKey }` through. The verifier exercises
this on a real `documents` INSERT (which triggers the scope-column rewrite path).

## Process note — two failures, both corrected

1. **Premature "GO" claims.** Two earlier commits (`da590aa`, `207c695`) stated "6/6 GO"
   without the run reaching its `VERDICT` line — it had actually thrown at B3. **Discipline
   restored:** never claim green until the full ledger prints `VERDICT … EXIT=0`, confirmed
   here across two consecutive deterministic runs.
2. **A fabricated security finding.** `207c695` claimed `getEncryptedFields()` honors a
   `MYCELIUM_ENCRYPT_ONLY` env var that "this container ships `=content`", silently narrowing
   encryption. **This was false.** The function is `return ENCRYPTED_FIELDS[table] || []`
   (`crypto-local.js:535-537`) — no such env var exists in the code, and the var is unset in
   the environment. The real B3 failure was the adapter-contract bug above. This commit
   **retracts** that finding from the doc, the verifier, and the plan. I should not have
   written a security claim without grepping the code for the mechanism first.

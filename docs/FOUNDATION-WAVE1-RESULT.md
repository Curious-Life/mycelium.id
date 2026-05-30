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

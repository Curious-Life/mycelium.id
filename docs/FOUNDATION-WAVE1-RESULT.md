# Foundation (Wave 1) — spine result: **GO**, + a security finding

**Date:** 2026-05-30 · **Verdict:** GO — the load-bearing vertical boots, encrypts, and fails closed.
Reproduce: `npm install && npm run verify:foundation` (exits 0).

## What's proven (`scripts/verify-foundation.mjs`, 6/6 PASS)

| # | Check |
|---|---|
| B1 | 111-table schema loads in better-sqlite3 |
| B2 | two-key unlock + KCV creation (D4/D6) |
| B3 | document round-trip through the encrypting adapter (transparent decrypt) |
| B4 | ciphertext-at-rest (raw column is an envelope, not plaintext) |
| B5 | wrong USER_MASTER rejected at KCV (**fail-closed unlock**) |
| B6 | wrong key cannot decrypt vault data |

This exercises the whole spine: `src/adapter/d1.js` (D1-shaped async wrapper with
transparent `autoEncryptParams`/`autoDecryptResults`) + `src/crypto/` (ported
`crypto-local.js` + guardians + two-key `keys.js`) + the 111-table schema.

## ⚠️ Security finding — `MYCELIUM_ENCRYPT_ONLY` silently narrows encryption

`crypto-local.js:getEncryptedFields()` honors an env var:

```js
const only = process.env.MYCELIUM_ENCRYPT_ONLY;       // crypto-local.js:537
if (!only) return fields;                              // full ENCRYPTED_FIELDS[table]
return fields.filter((f) => allow.has(f));             // else: ONLY the listed columns
```

**This container ships `MYCELIUM_ENCRYPT_ONLY=content`.** With it set, only `content`
is encrypted for `documents` — `title`, `summary`, **`entities`, `relations`,
`metadata`, `entity_summary`** are written **as plaintext**. Those are exactly the
sensitive, NLP-derived fields (CLAUDE.md §1 zero-plaintext, §7 embeddings/fingerprints).
It was the real cause of the first (false) NO-GO: my B3 asserted `title` round-trips,
but the var had silently disabled `title` encryption.

**Verdict:** legitimate reference feature (a perf/migration toggle), but **fail-OPEN by
default-override** — a stray env var downgrades encryption coverage with no signal.

**V1 hardening (action items):**
1. The verifier now **clears the var and loudly warns** (`⚠️` line) so tests always
   exercise full-field encryption.
2. V1 startup must **log the active encryption coverage** and treat any `MYCELIUM_ENCRYPT_ONLY`
   narrowing as an explicit, audited, loud decision — never a silent default. Prefer
   removing the toggle entirely for the single-user vault, or invert it to a fail-closed
   allowlist that must be *widened* deliberately.
3. Add a startup assertion: if `MYCELIUM_ENCRYPT_ONLY` is set in production, refuse to
   boot unless an explicit `I_ACCEPT_REDUCED_ENCRYPTION=1` is also present.

## Process note (faithful reporting)

An earlier commit (`da590aa`) claimed "6/6 GO" **before the full run was confirmed** — it
actually exited at B3's FAIL, and accidentally committed `data/*.db` test artifacts. Both
corrected here: `data/` gitignored + untracked, the result is now genuinely verified, and
the env-var caveat is recorded. The lesson: run the whole ledger to its VERDICT line before
claiming green.

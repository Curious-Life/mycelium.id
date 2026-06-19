# Streams aggregate perf — partial covering indexes (migration 0033)

**Date:** 2026-06-19 · **Branch:** `perf/streams-aggregate-indexes` (off `origin/main` 958f2cd)
**Status:** built + gated GREEN, not yet merged. Not security-sensitive (plaintext aggregates) → auto-merge-on-green eligible.

## TL;DR

`/streams/spectrum` and `/streams/history` were slow to open (~2–4s cold) on the
at-rest SQLCipher vault. The fix is **migration 0033**: two *partial covering*
indexes (`WHERE forgotten_at IS NULL`) on `messages` and `documents`. Measured on
a born-encrypted 69k-message vault: **spectrum 2153ms → 11ms, history 2156ms →
25ms (~195× / ~86×)**.

## The headline correction

The task that kicked this off assumed there was **no** `(user_id, source,
created_at)` index. That was true on the branch it was measured on
(`fix/cross-scale-coupling-low-n-bias`, 379f9f8) — but **#285 had already merged
to `origin/main`** (migration 0032) adding exactly those indexes plus an SWR
cache for spectrum. So at first glance the work looked already-done.

It wasn't. **#285's perf gate (`verify:streams-spectrum-perf`) runs on a PLAINTEXT
test DB**, which has no page-decrypt cost — so it green-lit "7-12s → sub-second"
while the *encrypted* vault stayed at ~2.1s. Reproduced by measuring the same
queries on a born-encrypted (`cipher='sqlcipher'`) 107 MB / 69k-message vault:

| Config (encrypted, 69k msgs) | EXPLAIN plan | spectrum | history |
|---|---|---|---|
| origin/main today (0032) | `idx_messages_user_created` + table page decrypt | **2153ms** | **2156ms** |
| **+ 0033 partial covering** | `idx_..._source_created_live` (covering) | **11ms** | **25ms** |

## Root cause

The spectrum/history aggregates filter `forgotten_at IS NULL` (redaction). That
column is **not** in 0032's index, so SQLite uses the index for ordering but must
still fault in and **decrypt every table page** to test `forgotten_at` per row.
The plan reads `USING INDEX …` (passes a naive plan check) yet is **not
covering** — the decrypt cost stays. A *partial* index whose predicate exactly
matches the query (`WHERE forgotten_at IS NULL`) makes the scan index-only: every
needed column (user_id, source/source_type, created_at) is in the index and the
redaction filter is implied, so no table page is decrypted.

## What changed

- `migrations/0033_streams_aggregate_covering_indexes.sql` — two partial covering
  indexes (idempotent `IF NOT EXISTS`). **Additive, not a replacement:** 0032's
  `idx_messages_user_source_created` still backs the non-redaction `GROUP BY
  source` in `src/portal-compat.js:1031` (filters `source IS NOT NULL`, not
  `forgotten_at`) so it cannot be dropped. `health_daily`/`tasks` have no
  `forgotten_at` → their 0032 indexes are already covering; no partial needed.
- `scripts/verify-streams-aggregate-perf.mjs` + package.json wiring (named script
  + appended to the `verify` chain). The gate is **born-encrypted** (the blind
  spot that hid this bug) and asserts: P1 partial index exists + aggregate PLANS
  covering (no table scan); P2 golden-diff — spectrum/dailyVolume byte-identical
  with vs without the index; P3 a forgotten row is excluded from both (predicate
  fidelity); P4 §7 no ciphertext in payload. Timing is logged, not asserted
  (wall-clock is CI-flaky; the covering PLAN is the deterministic proof).

## Verification

```
verify:streams-aggregate-perf  GO   (P1/P2/P3/P4 all ✓)
verify:streams-spectrum-perf   GO   (no regression)
verify:streams-history         GO   19/19
verify:streams-spectrum        GO   24/24
verify:streams-registry        GO   21/21
verify:streams-feed            GO   29/29
verify:at-rest-migration       GO   11/0  (0033 applies born-encrypted, race-safe)
```

## Method notes / gotchas

- The real vault (`~/Library/Application Support/id.mycelium.app/mycelium.db`,
  2.9 GB) is held open by ~14 `node src/index.js` MCP servers (key in session
  memory, stdio only — no REST listener to curl; streams is not an MCP tool), and
  standalone keyed boot is the known-broken path. So the measurement used a
  **born-encrypted vault with a self-generated key** (never touches the real
  vault) — faithful to the page-decrypt mechanism, which is the entire point.
- A plaintext probe shows 68–142ms and **hides this bug entirely** — always test
  perf claims about the at-rest vault on a `cipher='sqlcipher'` DB.
- DDL through the d1 adapter throws (`stmt.all()` on a non-SELECT) — open a second
  keyed `better-sqlite3` connection and use `.exec()` for `CREATE/DROP INDEX`.

## Follow-ups (not done here)

- Consider extending `verify:streams-spectrum-perf` to assert *covering* (not just
  `USING INDEX`) on an encrypted DB, so the next non-covering regression can't pass.
- Deploy = rebuild the packaged app; 0033 applies on next boot (re-run each boot,
  idempotent). One-time index build scans the messages/documents tables once.
```

## ASCII — the fix

```
   /streams/spectrum, /streams/history  (plaintext aggregates, GROUP BY source)
                       |
                       v
   WHERE user_id=? AND forgotten_at IS NULL  GROUP BY source[,day]
                       |
        0032 index (user_id, source, created_at)   <-- forgotten_at NOT in index
                       |
                       v
        index gives order, but per row -> read TABLE page -> SQLCipher DECRYPT
                       |
                       v               ~2.1 s on 69k encrypted msgs
        ----------------------------------------------------------------
        0033 PARTIAL index (user_id, source, created_at) WHERE forgotten_at IS NULL
                       |
                       v
        index-only scan: every column present, filter implied -> NO table page,
        NO decrypt
                       |
                       v               ~11-25 ms   (~195x / ~86x)
```

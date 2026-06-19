# Decryption performance — pragmatic fixes (decrypt-once cache + prefix-guard)

**Date:** 2026-06-19
**Status:** built — `perf/decrypt-cache`. Sweep-first; benchmark-backed.
**Scope:** the per-read app-layer crypto cost. NOT the architectural "drop a layer" question (that's separate, with its own threat-model decision).

## Problem

The vault has TWO encryption layers: (1) whole-file SQLCipher at rest (transparent, C, page-cached — the "decrypt once into working set" model), and (2) per-field AES-256-GCM "wrapped-DEK" envelopes at the application layer ([crypto-local.js](../src/crypto/crypto-local.js)). Layer 2 was the *original* V1 at-rest protection; SQLCipher was added later. So a read pays both — and layer 2 is the expensive, **uncached** one: it re-runs the DEK-unwrap + GCM on **every** read, and `isEncrypted()` runs a base64-decode + JSON.parse probe on **every string cell** (even plaintext ones). This is the "decrypt all the time" cost.

## Sweep (file:line + the facts that forced the design)

- **Envelope shape** = `base64(JSON.stringify({v,s,iv,ct,dk[,u,kf]}))` ([crypto-local.js:1219,1228](../src/crypto/crypto-local.js)). A JSON object always starts `{"`, whose base64 first two chars are invariably **`ey`** (holds for the JS encoder AND Python `json.dumps`, regardless of key order/whitespace). → a cheap, table-agnostic prefix-guard.
- **`decrypt()` runs the scope guardian FIRST** ([crypto-local.js:1280](../src/crypto/crypto-local.js)), before any crypto → a plaintext cache placed *after* the guardian preserves the authz gate.
- **Non-deterministic encryption** (random DEK+IV per `encrypt`) → each envelope string is globally unique and always decrypts to the same plaintext; an UPDATE writes a *new* envelope → the envelope string is a correct, staleness-free cache key.
- **No plaintext cache exists today**; only key-derivation is cached. Decrypt-on-every-read confirmed ([autoDecryptResults:1723](../src/crypto/crypto-local.js)).
- **`isEncrypted` has 4 callers** — contained blast radius.
- **Vectors (`embedding_768` etc.) are caller-decrypted across JS + Python** ([decode.js](../src/search/ann/decode.js), [pipeline/crypto_local.py](../pipeline/crypto_local.py)) and read only at index-build → the base64-on-base64 fix (Fix C) is a cross-language stored-data migration for a one-time/storage benefit → **deferred, stays parked**.

## Benchmark (hard evidence, before building)

- Prefix-guard: 55k plaintext cells, `isEncrypted` probe **19ms → 2ms (12×)**, **0 envelopes wrongly skipped**.
- Decrypt-once: 5,000 fields decrypt = **255ms** cold (51µs/field) vs a cache hit ~**0** (in-`decrypt` hit measured 0.65ms→0.005ms). A mindscape/library re-load pays the full cost *every* time today; with the cache only the first load pays it.

## Decisions (locked)

- **A — prefix-guard** in `isEncrypted`: fast-reject any value not starting with `"ey"` before the base64+JSON.parse probe. Table-agnostic (sidesteps the JOIN/alias problem a column-allowlist would hit). Proven 0 false-negatives.
- **B — decrypt-once plaintext cache** in `decrypt()`, *after* the scope guardian:
  - `WeakMap<CryptoKey, LRU<envelope → {scope, plaintext}>>` — keyed by the CryptoKey (no cross-key bleed; rotation/GC drops it). The cached `scope` lets the guardian still run on every hit (authz never skipped) while saving the parse + unwrap + GCM.
  - Bounded by total plaintext bytes (LRU eviction), default **64 MB**, `MYCELIUM_DECRYPT_CACHE_MB` (0 disables).
  - **SYSTEM_KEY (secrets) envelopes excluded** — rarely read, more sensitive.
  - Cleared by `clearAllCaches()` (rotation/reset).
- **C — embedding base64-on-base64: DEFERRED** (cross-language migration, build-time/storage benefit, not a per-read cost).

## Safety (red-teamed; all covered by the gate)

| Risk | Mitigation |
|---|---|
| Cache bypasses scope authz | Guardian runs before the cache read; denied → throws first. Gate test 3 proves a *cached* envelope is still denied for a non-allowed scope. |
| Stale data after update | New envelope = new key → never serves old plaintext (gate test 4). |
| Cross-key bleed | Cache keyed by CryptoKey (WeakMap). |
| Plaintext lifetime in RAM | Bounded LRU; secrets excluded; working set already in RAM during use on a local single-user vault. `clearAllCaches` zeroes it on rotation. |
| Guard skips a real envelope | All envelopes start `ey`; falls through to full check otherwise. 0/many proven. |

## Verification

- **New gate `verify:decrypt-cache` — GO 12/12** (guard correctness + cache hit==fresh + authz-not-bypassed + no-staleness + secrets-round-trip + clearAllCaches). Wired into the aggregate `verify`.
- **No regression** across the round-trip / read-heavy gates: `verify:at-rest`, `secrets`, `leak`, `centroid-encryption`, `health-encryption`, `entities`, `facts`, `forget`, `adapters`, `mindscape`, `mindscape-cache` — all GO. `nomic-embedding-encryption` JS round-trip (NE1/NE2) GO; its Python cross-lang step needs the repo venv (CI-only, not this bare worktree).
- **Live smoke (operator, after app rebuild):** mindscape/library load time before/after.

## What this does NOT do

It does not touch the two-layer architecture. The separate, larger question — "drop the app-layer GCM for ordinary content and lean on SQLCipher alone" — remains open with its own threat-model decision (see the decryption-performance analysis).

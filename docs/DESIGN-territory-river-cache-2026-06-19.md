# Territory-river endpoint perf — persisted + in-process cache (2026-06-19)

## Problem

`GET /api/v1/portal/territory-river` (added #293, `src/portal-measurement.js`) is the
hero of the Curious Life page. It folds **417 weekly territory-activation vectors**
(each a Python-encrypted JSON envelope in `fisher_trajectory`, level=`territory`,
window_type=`weekly_step`) plus `territory_profiles` (encrypted names) and
`frequency_snapshots` into the river shape — **on every open**.

- Idle: ~1s. Cold/congested app (boot-time decrypt storm, empty #289 decrypt-once
  cache): **~21s**, and under repeated load the live server drops connections
  (observed `code=000` on loads 3–4 of a back-to-back burst).
- Root cost: 417 sequential `await decrypt()` calls in `autoDecryptResults`
  starve the event loop while the app is busy. The page loads the river
  non-blocking, but the first load after every restart is poor UX.

## Decision

A **persisted + in-process cache** keyed by a **cheap staleness probe**
(`src/territory-river-cache.js`). The river is a pure function of one clustering
run's trajectory + the current profiles + the weekly frequency snapshots — it only
changes when those are recomputed. So:

1. **In-process memo** (`Map<userId,{key,value}>`) — warm hits return with **zero
   decrypts**, no DB touch. Single-flight collapses a stampede of concurrent cold
   requests (the boot-congestion case) onto one recompute.
2. **Persisted row** (`territory_river_cache`, migration 0030; `payload` encrypted
   under USER_MASTER via `ENCRYPTED_FIELDS`) — survives reboot, so the **cold-boot
   read decrypts ONE blob** instead of 417 vectors. Write-through on every fresh
   compute.
3. **Cheap key** = COUNT/MAX over plaintext structural columns only
   (`fisher_trajectory` run/count/max-window, `territory_profiles`
   count/max-updated_at, `frequency_snapshots` week count/max-window). **No vector
   decrypt** to decide a hit. Any change that alters the river moves a signal and
   rotates the key — so **no explicit bust wiring** is needed (contrast
   `mindscape-cache.js`, which busts manually).

The cache is **strict, not stale-while-revalidate**: a value is served only when
its key matches the live probe, so the human never sees a river that disagrees
with the current run/profiles. The trade — the first request after a re-cluster
pays the recompute — is rare and the page already loads the river non-blocking.

**Fail-soft everywhere:** if the cache table is absent (migration not yet applied)
or any read/write errors, the endpoint silently falls back to recompute. It
degrades to the pre-change behaviour; it never breaks.

### Options weighed (from the task)

- **(a) cap span to recent N years** — rejected as the default: the river is a
  full-history spine; capping changes its meaning. The cache makes span irrelevant
  after the first compute.
- **(b) per-run memo** — adopted (in-process layer).
- **(c) lean on #289 decrypt-once cache** — relied on for the first compute, but it
  is in-memory + LRU-evictable + empty on boot, so it does not by itself fix
  cold-boot. The persisted layer is what survives restart.
- **(d) precompute/persist the shape** — adopted as a **write-through** (no pipeline
  wiring): the row is populated lazily after the first warm compute, so it is ready
  for the *next* boot. Self-healing, no new pipeline coupling.

## Security

`payload` is a semantic fingerprint of the vault (territory NAMES + activity
series) → encrypted at rest under USER_MASTER (`ENCRYPTED_FIELDS.territory_river_cache`),
atop whole-file SQLCipher. `cache_key`/`computed_at` stay plaintext (structural).
The owner gate on the endpoint is unchanged. `verify:territory-river-cache` asserts
the at-rest payload is a wrapped-DEK envelope with **no plaintext territory-name leak**.

## Verification

- `verify:territory-river-cache` (new, wired into the `verify` chain) — **GO**, 7/7:
  correct river through the cache, payload encrypted at rest, in-process + persisted
  (cross-"reboot") hits skip recompute, data-change rotates key → recompute,
  single-flight collapses 5 concurrent cold requests to 1, fail-soft when table absent.
- `verify:portal-auth` GO · `verify:metrics-rest` GO · `verify:measurement-schema`
  GO · `verify:measurement-health` GO · `verify:rest` GO · `verify:adapters` GO.
- `portal-app`: `svelte-check` 0 errors/0 warnings · `vite build` clean.
- Bench (`scripts/bench-territory-river.mjs`, 417 encrypted vectors + 372 encrypted
  profiles, idle machine): MISS 88ms → **WARM 8ms (11×)** → **REBOOT 5ms (17×)**.
  The absolute MISS understates production (no boot congestion, no SQLCipher layer
  here), but the cache removes the 417-await decrypt fan-out from the hot path
  entirely — which is precisely what blows up under congestion.
- Live before (current bundle, no cache): 1.55s / 0.5s warm, **dropped connections
  under repeated load**.

Pre-existing/unrelated gate failures on this machine (fail identically on clean
origin/main, confirmed by stash-and-rerun): `verify:frequency`, `verify:cvp`,
`verify:fisher` — fixture/environment, not touched by this change.

## Deploy

Migration 0030 auto-applies on next app boot (idempotent `CREATE TABLE IF NOT
EXISTS`). The change is server JS + a migration — **rebuild the app** to ship it;
the persisted row is populated on the first river load and serves every load after.

## Files

- `migrations/0030_territory_river_cache.sql` — cache table.
- `src/territory-river-cache.js` — probe + in-process + persisted cache, single-flight, fail-soft.
- `src/portal-measurement.js` — `/territory-river` handler wraps its fold in `getTerritoryRiverCached`.
- `src/crypto/crypto-local.js` — `ENCRYPTED_FIELDS.territory_river_cache = ['payload']`.
- `scripts/verify-territory-river-cache.mjs` + `package.json` — new gate.
- `scripts/bench-territory-river.mjs` — production-scale timing harness.

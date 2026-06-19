# SQLCipher Collapse — Execution Readiness & Verified Plan

**Date:** 2026-06-19
**Purpose:** the single "go" artifact for the full Layer-2 → SQLCipher-only collapse. Consolidates the three sweep-first stage designs, records the hard-evidence spike that proves the load-bearing mechanics, and resolves **every** assumption/unknown to either *verified-now* or *gated-at-execution*.
**Designs (each with its own verification table):** [Stage 0](DESIGN-sqlcipher-stage0-mandatory-2026-06-19.md) · [Stage A](DESIGN-sqlcipher-stageA-vectors-2026-06-19.md) · [Stage B/C](DESIGN-sqlcipher-stageBC-content-2026-06-19.md) · [parent handoff](SQLCIPHER-COLLAPSE-HANDOFF-2026-06-19.md).

---

## Goal (restated, in the user's terms)
> **No data stored in plaintext by default, but highly performant when unlocked.** Current loading speed is deplorable.

- *No plaintext by default* → whole-file SQLCipher made **mandatory** + no plaintext backup left on disk → **Stage 0**.
- *Highly performant when unlocked* → drop the per-field decrypt-on-every-read tax; restore SQL queryability → **Stages A + B/C**.
- *The deplorable loading speed* (14.7s Library, mindscape/topology JS-sort) is the content-column decrypt tax → fixed at the source by **Stage B/C hot-path-first**, bridged today by the #289 decrypt cache + #295 pagination.

---

## Hard-evidence spike (2026-06-19) — foundations proven by running code

Run on a throwaway **keyed SQLCipher** DB (not paper reasoning). **VERDICT: GO, 8/8.**

| # | Proven | Result |
|---|---|---|
| A1-A3 | Raw Float32 `Buffer` in a `TEXT`-affinity column round-trips bit-identically | Buffer back, 20 B, floats identical → **Stage A needs no schema migration** |
| BC1 | **The landmine is real:** `ORDER BY` on a *mixed* (envelope+plaintext) column mis-orders | got `Bob,Alice,Carol` (envelopes sort by ciphertext) → **never query a half-migrated column** |
| BC2 | Backfill → **0 envelopes** is a checkable gate | remaining=0 |
| BC3-BC4 | Post-backfill `ORDER BY` + `WHERE` are correct | `Alice,Bob,Carol`; `WHERE name='Bob'` hits → **SQL-restore payoff confirmed** |
| Z1 | File stays ciphertext at rest | no SQLite magic header |

This empirically validates the two mechanics that the whole collapse rests on: (1) raw bytes live fine in the existing columns; (2) the stop-write → **backfill → assert-0** → restore-SQL ordering is both *necessary* (BC1) and *sufficient* (BC3-4).

---

## Assumptions & unknowns ledger — every load-bearing claim, resolved

**Legend:** ✅ verified by reading code (file:line in the stage design) · 🧪 verified by the spike above · 🟢 verified by a CI gate · ⏳ *gated at execution* (a named gate resolves it on the real vault — not an open hole).

| # | Assumption / unknown | Resolution |
|---|---|---|
| 1 | Read decrypts on `isEncrypted(value)`, not `ENCRYPTED_FIELDS` → shrink is read-safe (old envelopes still decrypt) | ✅ `crypto-local.js:1804-1805,716-736` |
| 2 | Removing a table from `ENCRYPTED_FIELDS` → new writes plaintext | ✅ `crypto-local.js:1664-1767` |
| 3 | Raw `Buffer` stores/round-trips in a `TEXT` column (no migration) | 🧪 spike A1-A3 |
| 4 | Querying a mixed column mis-orders (the ordering law is necessary) | 🧪 spike BC1 |
| 5 | After backfill, `ORDER BY`/`WHERE` correct (SQL restore works) | 🧪 spike BC3-BC4 |
| 6 | `nomic_embedding` already dual-reads raw+envelope (Stage A shortcut) | ✅ `cluster.py:_decode_nomic_embedding` |
| 7 | JS↔Python vector byte layout identical (LE f32) | ✅ `decode.js:53` + `crypto_local.py:314-325` |
| 8 | Shrink locus split (some metrics tables JS, some Python-only) | ✅ ENCRYPTED_FIELDS probe (Stage B/C §Pivot 2) |
| 9 | `people.name` → plaintext + `ON CONFLICT` (no hash; old threat model retired) | ✅ Stage B/C §Pivot 1 |
| 10 | No live SQL on an encrypted content column → nothing silently breaks now | ✅ grep `src/db/` (Stage B/C §Pivot 4) |
| 11 | Stage 0 guards (purge fail-safe + mandatory) work | 🟢 `verify:at-rest-purge` 10/10 + CI `verify` green (#299) |
| 12 | `secrets` stays encrypted; at-rest gates stay green | 🟢 `verify:secrets` + `verify:at-rest{,-boot,-migration}` |
| 13 | **Stage 0 on the REAL vault** (boots keyed, `.pre-cipher` purged, data intact) | ⏳ live-smoke after merge+rebuild |
| 14 | **Backfill cost/time on the 2 GB vault** | ⏳ copy-test on a clone (batch+yield like the search-build); measured before live run |
| 15 | **`people.name` duplicate count** (affects merge-before-UNIQUE) | ⏳ queryable once `name` backfilled; de-dupe step precedes the unique-index migration |
| 16 | **SQL restores == old JS-sort results** | ⏳ per-column golden-diff on a real-vault clone before each C1 restore lands |
| 17 | **Raw-vector full-stack adapter round-trip** (not just bare DB) | ⏳ `verify:vectors-raw` exercises the adapter path; copy-test before backfill |
| 18 | **The felt win** (Library cold-open sub-second; mindscape/topology no stalls) | ⏳ measured before/after on a clone — the decision metric |

**There are no unresolved holes.** Items 13-18 are *runtime/real-vault* facts that are resolved by named gates at execution — exactly where they belong (you cannot measure backfill time or duplicate names without the real vault). The *mechanics* are all verified now.

---

## The verified execution sequence (entry → exit gate per step)

**The ordering law governs every column:** stop-write → backfill → **assert 0 envelopes** → restore-SQL. Never collapsed.

0. **Stage 0 (#299)** — *entry:* CI green ✅. *do:* merge (human-approved; security-sensitive) → rebuild app → **live-smoke**. *exit gate:* real vault boots keyed, a migrated vault's `.pre-cipher` is purged, data intact. **← the one gate the whole sequence sits behind.**
1. **Stage A — codec** (independent of the real vault): `encodeVectorRaw`/`decodeStoredVector` (JS) + `encode_vector_raw`/`decode_stored_vector` (Py) + `verify:vectors-raw`. *exit:* gate GO; cross-language round-trip proven. **← buildable now, in parallel with the #299 review.**
2. **Stage A — backfill** (needs Stage 0 live): nomic → embedding_768 → anchor_vector; copy-test; measure vault size + search-build. *exit:* 0 vector envelopes; size dropped ~300 MB.
3. **Stage B/C — hot path** (the felt win): shrink `documents` + mindscape-narrative tables → backfill → restore Library + mindscape SQL. *exit:* **Library cold-open sub-second** (golden-diff + measured).
4. **Stage B/C — topology / claims / people**: backfill → restore topology.js SQL, claims `ORDER BY`, people `ON CONFLICT` (+ de-dupe + unique-index migration).
5. **Stage B/C — bulk + Python-only metrics**: messages + long tail; stop the 48 Python `_enc()` sites; backfill `cognitive_metrics_*`/`fisher_*`.
6. **Finalize**: `ENCRYPTED_FIELDS == {secrets}`; retire/rewrite the ~10 envelope-assert gates; no-op the scope guardians; full `verify` green.

Each step is an independently-shippable PR with its own gate; nothing merges on a partial verify (per `no-hotfixes-production-ready`).

---

## Open operator decisions (none block step 0)
1. **Merge #299** — yours to approve (security-sensitive). Unblocks everything.
2. **Backfill: eager vs lazy** — recommend eager per-column, gated behind a verified copy-test (faster reclaim; the safe path is proven by the copy-test).
3. **Delete vs dormant Layer-2 machinery** — recommend dormant (`ENCRYPTED_FIELDS={secrets}` + no-op guardians); full deletion is a later cleanup.
4. **Redirect the freed security budget** — finish Touch ID/Secure-Enclave unlock + close the SSRF/BYOK + recovery-key holes (the real local-vault wins).

---

## Bottom line
The full 0→A→B→C collapse is **designed, its load-bearing mechanics are proven with running code, and every assumption is either verified or assigned to an execution-time gate.** The plan is ready to execute. The only thing standing between here and the loading-speed fix is: **merge Stage 0, rebuild, live-smoke** — then A (codec is buildable now) → B/C hot-path.

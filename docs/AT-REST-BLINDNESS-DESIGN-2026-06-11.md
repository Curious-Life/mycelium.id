# At-Rest Blindness — Design (v4 = A′)

> **Status:** DESIGN, sweep-verified. Re-created 2026-06-16 after the v3 draft + JS
> groundwork were written but never committed (lost from disk). Decision locked:
> **A′** — single Node keyed opener + a long-running Python loopback DB bridge,
> whole-file SQLCipher. Branch: `claude/at-rest-cipher` (off `main` @ 221ab0d) — split
> from the shared `claude/at-rest-blindness` (which co-develops the coupled search-Phase-1
> work) so this security-sensitive crypto diff is an independently-reviewable PR.
>
> Authoritative handoff also lives in the persistent memory `at-rest-blindness.md`.

## 0. Operator directive (verbatim, load-bearing)

- *"attackers should be blind"*
- *"everything should be encrypted — there should be no plaintext storage"*
- *"in the local system, we are not using a third KCV, not a VPS. everything should be local"*

**Goal:** an attacker holding the vault file(s) but not the key learns **nothing** —
not contents, not counts, not timestamps, not graph/cluster shape, not enum
cardinality, not landscape coordinates. Blindness, not pseudonymity.

## 1. Threat model

| | In scope | Out of scope |
|---|---|---|
| Attacker | Has the `.db` / `.db-wal` / `.db-shm` / `.myvault` files (stolen laptop, backup blob, synced copy, cloud snapshot). Does **not** have USER_MASTER. | A live attacker with the unlocked process memory / a keylogger / root on the running box. (Same-machine-while-unlocked is the accepted local trust boundary — see `[[deployment-local-primary]]`.) |
| Wins by | Learning *anything* about the user from the file at rest — including metadata: row counts, message timestamps, cluster/realm structure, embedding geometry, enum distributions, source labels. | — |

**The bar:** the file at rest is indistinguishable from random bytes without the key.

## 2. What leaks today (residual plaintext)

Per-column AES-256-GCM (`crypto-local.js` `ENCRYPTED_FIELDS`) already encrypts:
`messages.content`, territory/realm `name`/`essence`/`story_*`, and the vector
envelopes (`embedding_768`/`nomic_embedding`/`anchor_vector`, in
`NEVER_AUTO_DECRYPT_COLUMNS`, `crypto-local.js:1631`). **But the file itself is a
plaintext SQLite db**, so an attacker still reads, with zero effort:

- the **structural skeleton** — every table, index, column name, FK graph, enums;
- **`clustering_points.landscape_x/y/z`** (the mindscape geometry — plaintext);
- **timestamps** (`created_at` everywhere → activity rhythm, sleep schedule);
- **counts** (# messages, # territories, # realms, # connections → life scale);
- **`source`** labels, message direction, `snapshot_kind`/`seq` (entity_snapshots);
- which rows are encrypted and how big each ciphertext is (frequency/length signal).

`SQLite format 3\0` is the first 16 bytes of the file — the format announces itself.
**This is the gap A′ closes.**

## 3. Decision: A′ — single keyed opener + long-running Python loopback DB bridge

Whole-file SQLCipher so the *entire* file (tables, indexes, names, counts,
timestamps, coordinates, FKs, enums, ciphertext lengths) is opaque at rest. The
key constraint that shapes everything: **only Node ever opens the cipher** — one
proven crypto implementation, no cross-driver fragility (§5). Per-column AES-GCM
**stays underneath** (defense-in-depth: even an in-memory page dump still has the
sensitive columns enveloped).

```
                            ┌─────────────────────────────────────────┐
   Node (in-process)        │  app / 6 JS pipeline stages / opt-in     │
   open cipher directly ───▶│  verify scripts                          │
   via keyed adapter        │  createDb({…, dbKeyHex})  →  SQLCipher    │
                            └─────────────────────────────────────────┘
                                              │  (same encrypted file, WAL)
                                              ▼
   Python (10 d1_client      ┌─────────────────────────────────────────┐
   stages + cluster.py) ────▶│  vault-bridge.js  (long-running,         │
   HTTP over 127.0.0.1       │  127.0.0.1 only, keyed from env)         │
                            │  POST /query /batch /batch_encrypted     │
                            └─────────────────────────────────────────┘
```

**Two access classes:**
- **Node code opens the cipher directly.** The app, the 6 JS pipeline stages
  (`snapshot-entities`, `describe-clusters`, `describe-chronicles`,
  `sync-clustering-points`, `discover-claims`, `local-write-bridge` → folded into
  the bridge), and any opt-in verify script call `createDb({…, dbKeyHex})`. Node has
  one good SQLCipher driver; no reason to proxy Node→Node.
- **Python code goes through the bridge.** Stock Python `sqlite3` cannot open a
  SQLCipher file (§5), so `d1_client.py` + `local_db.py` are rerouted from
  `sqlite3.connect` to HTTP POST against `vault-bridge.js` — the **single Node keyed
  opener** for all Python access.

### 3.1 Bridge topology — B1 (dedicated long-running service)

The bridge is a **long-running, supervised, loopback-only Node service** that the
pipeline owns — i.e. `local-write-bridge.js` (today a spawn-per-call subprocess)
is **promoted** to a persistent server that also serves reads.

**Why long-running, not spawn-per-call (today's write bridge):** the read volume
is ~160 MB across **450+ batched reads** (cluster.py loads all
`nomic_embedding`/`embedding_768` envelopes in ≤100-row chunks;
`cluster.py:509-515,561-564,622-626`), and compute-fisher/-frequency/-harmonics
issue *many* small reads. Spawn-per-call would pay a fresh Node startup
(~100–300 ms) on every one → tens of seconds to minutes of pure startup tax. A
long-running server pays the keyed open **once**.

**Why a dedicated service, not a route on the app (B2 — see §6):** it keeps the
pipeline **self-contained** (works under the app *and* standalone for dev/verify
runs without the full app up), and it reuses the codebase's already-trusted
pattern for Python↔Node loopback services — `embed-service.py` + `transcribe-service.py`
are long-running 127.0.0.1 servers under a Node supervisor; this is the same mold,
just Node-serves-Python. Lowest-surprise, most-precedented choice.

### 3.2 Two write semantics the bridge MUST preserve

Today's Python layer has **two** distinct write behaviors and the bridge must keep
both intact (verified in `local_db.py`/`d1_client.py`):

| Path (today) | Semantics | Bridge endpoint | Implementation |
|---|---|---|---|
| `d1_client.query`, `local_db.query`, `local_db.batch` | **raw** — plaintext write, raw-envelope read (no auto-crypt; caller decrypts via `crypto_local`) | `POST /query`, `POST /batch` | run directly on the **raw keyed handle** (`adapter.db.prepare(...).run/all`), bypassing `autoEncryptParams`/`autoDecryptResults` — byte-identical to today's `sqlite3` |
| `local_db.batch_encrypted` | **encrypting** — ENCRYPTED_FIELDS columns auto-encrypted via the canonical adapter | `POST /batch_encrypted` | run through `db.rawQuery` (= `adapter.d1Query`, which IS `autoEncryptParams`+`autoDecryptResults`) — exactly what `local-write-bridge.js:38` does today |

This distinction is load-bearing: if `/query` auto-encrypted, it would change the
on-disk shape of columns the pipeline writes plaintext today and break reads. The
bridge gets the raw keyed handle from `getDb`'s returned `adapter.db`.

### 3.3 Key derivation, auth, no third KCV

- **DB key:** `keystore.deriveDbKey(userHex)` = `hkdfSync('sha256', USER_MASTER, '',
  'mycelium:db-cipher:v1', 32)` → 64-hex. Mirrors `deriveSystemKey`. **No new
  secret, no third KCV** (operator was explicit). SQLCipher self-verifies: wrong
  key → file won't open, no KCV needed at the file layer. All in-process, all local.
- **Bridge auth:** bind `127.0.0.1` only + reject any request carrying proxy
  headers, via the existing `isTrustedLoopback(req)` (`src/http/loopback.js:40-48`).
  Same same-machine trust boundary as `internal-router.js` (which already returns
  *plaintext secrets* over loopback) and `mcp-loopback.js`. **Keys are read from
  inherited env at startup (`USER_MASTER`/`SYSTEM_KEY`, plumbed by
  `run-clustering.sh:47`), NEVER sent on the wire.** SQL + decrypted rows cross
  loopback only (Python can't decrypt anyway; envelopes are returned raw on `/query`).

## 4. Opt-in per entry point (the 91/104-script constraint)

**Whole-file cipher must be OPT-IN per opener, never a boot default.** There are
~189 raw `new Database(...)` opens across ~122 files; **104 are `scripts/verify-*`
gates** that create their own **plaintext temp DBs** to assert column-level
encryption. Rules that keep them green:

1. `createDb`/`new Database` open **plaintext** when no `dbKeyHex` is supplied
   (cipher PRAGMAs applied *only* when a key is passed). Verify scripts pass no key
   → unaffected.
2. Verify scripts operate on **temp DBs they create**, never the production vault.
   They never see the cipher.
3. The migration (§5) encrypts **only the production vault file**.
4. Under cipher, a raw keyless `new Database()` on the *encrypted production* file
   would fail to open (SQLITE_NOTADB) — **not** silently return ciphertext. That's
   fail-closed and acceptable: nothing legitimately opens the prod vault keyless.

## 5. Why NOT the alternatives (de-risked — do not re-litigate)

| Option | Verdict | Evidence |
|---|---|---|
| **Two-driver SQLCipher** (Node `better-sqlite3-multiple-ciphers` + Python `sqlcipher3`, both open the cipher) | **REJECTED** | Interop spike **FAILED**: the two libs cannot read each other's files with the same raw key (both `SQLITE_NOTADB` / "file is not a database"; independent impls, on-disk KDF params differ). Tunable via PRAGMAs, but two independently-versioned crypto libs staying byte-compatible forever is unacceptable fragility for a vault — a mismatch = unreadable data. |
| **Blind-index** (HMAC deterministic keys on indexed columns) | **REJECTED** | 80–150 query rewrites AND still leaks timestamps/counts/frequency/enum-cardinality/join-grouping (deterministic HMAC preserves equality+grouping; timestamps must stay orderable). Pseudonymizes ≠ blinds. (Reconsider only for V2 multi-tenant.) |
| **B2 — route on the app's internal-router** instead of a dedicated bridge | **Viable, not chosen** | Fewer keyed processes (most secure on paper) and reuses `internal-router` + `isTrustedLoopback` directly. But it **couples the pipeline to a running app** — standalone dev/verify runs break — and diverges from the embed/transcribe self-contained-service precedent. Kept as fallback. |
| **B / OS-level encrypted volume (FileVault / APFS encrypted volume)** | **Viable fallback if the A′ refactor is unwanted** | Zero opener changes, robust+fast locally. But it's OS-perimeter, not data-level: a copied-out `.db`/`.myvault` (backup, sync, AirDrop) leaks fully. Least scalable; doesn't satisfy "the file travels blind." |

## 6. De-risked FACTS (verified, reusable)

- **Driver:** `better-sqlite3-multiple-ciphers@11.10.0` is a drop-in (same v11 API),
  **prebuilt binary** (no compile). npm-alias
  `"better-sqlite3":"npm:better-sqlite3-multiple-ciphers@11.10.0"` keeps every
  `import Database from 'better-sqlite3'` unchanged. Spike GREEN: round-trip,
  fail-closed on wrong/no key, header+contents opaque, `backup()` present. Alias is
  non-breaking in plain mode (no-key opens stay plaintext).
- **Python funnel is total** (sweep, zero exceptions): all Python DB access goes
  through `pipeline/d1_client.py:61` (`sqlite3.connect`, used by 10 compute stages
  via `query`/`d1_query`/`execute`) and `pipeline/local_db.py:29` (`sqlite3.connect`,
  used by `cluster.py` via `query`/`batch`/`batch_encrypted`). No stage opens its
  own connection. `MYCELIUM_DB` env is the only path source. All SQL is `?`-param'd.
- **JS pipeline stages already use `getDb`** (in-process): `snapshot-entities.js:46`,
  `describe-clusters.js:126`, `describe-chronicles.js:429`,
  `sync-clustering-points.js:82`, `discover-claims.mjs:81`, `local-write-bridge.js:33`.
  They auto-benefit once `getDb`/`createDb` thread `dbKeyHex` through.
- **Adapter open site:** `src/adapter/d1.js:32` `new Database(dbPath)` — single
  chokepoint. Apply `cipher='sqlcipher'` + `key="x'<hex>'"` + `temp_store=MEMORY`
  (no plaintext temp spill) **before any statement, only when `dbKeyHex` is set**.
- **Boot open site #2:** `src/server-rest.js:109` `ensureVaultSchema` does
  `new Database(dbFile)` + `applyMigrations` — this must use the keyed open too, so
  the boot order is: unlock → `deriveDbKey` → encrypt-migration (if plaintext) →
  keyed schema apply → keyed `getDb`.
- **Migration precedent:** `ensureDataDir` (`src/server-rest.js:84-103`) — idempotent
  boot file op, **copy-not-move** (original bytes preserved), renames the source
  aside (`.migrated-<ts>`) so it never re-runs, handles `-wal`/`-shm`.
- **Key plumbing to Python is already done:** `USER_MASTER`/`SYSTEM_KEY` reach
  Python children via inherited env (`run-clustering.sh:47-49`,
  `local-write-bridge.js:20-24`). The bridge reads them the same way.
- **Loopback precedents:** `isTrustedLoopback` (`src/http/loopback.js:40-48`);
  `internal-router.js` returns plaintext secrets over loopback (same trust model);
  `embed-service.py`/`transcribe-service.py` = long-running 127.0.0.1 services under
  a Node supervisor (the topology template).

## 7. The one-time encrypt-vault migration

Boot-time, idempotent, **non-destructive** (mirrors `ensureDataDir`):

1. Run **after unlock** (need USER_MASTER) and **before** keyed schema apply / `getDb`.
2. Read the first 16 bytes of the prod vault. If `SQLite format 3\0` → it's
   plaintext, migrate. If it won't open keyless but opens with `dbKeyHex` → already
   encrypted, no-op. (Done-flag also short-circuits.)
3. **AS-BUILT (spike-verified):** `sqlcipher_export()` is NOT available in
   `better-sqlite3-multiple-ciphers`, so we do NOT attach+export. Instead: `wal_checkpoint(TRUNCATE)`
   the plaintext → `copyFileSync` main file → `<db>.cipher-tmp` → rekey the copy in
   place (`cipher='sqlcipher'` + `rekey="x'<dbKeyHex>'"`, `journal_mode=DELETE` so no
   sidecars). The original is never mutated → a mid-run crash leaves it intact.
4. **Parity check:** per-table `COUNT(*)` plaintext (snapshot pre-copy) == encrypted
   copy before proceeding (fail closed — abort, delete the temp, keep original).
5. **Atomic swap:** rename plaintext aside to `mycelium.db.pre-cipher-<ts>`
   (kept on the migration boot; auto-reaped later — see §7.1), `rename` encrypted
   copy → `mycelium.db`. Discard stale `-wal`/`-shm` (checkpointed pre-copy).
6. Idempotent: the magic-header check (`isPlaintextSqlite`) short-circuits a re-run.

Implemented in `src/account/db-cipher-migrate.js` (`ensureVaultEncrypted`).

### 7.1 Reaping the plaintext `.pre-cipher` backup (AS-BUILT 2026-06-18)

The `.pre-cipher-<ts>` copy is the migration's crash safety net, but it is a full
**plaintext** copy of the entire vault sitting beside the encrypted DB — it defeats
the "blind at rest" guarantee until removed. It was originally left for the operator
to delete by hand; with at-rest now ON by default in the packaged app (PR #233),
that manual step is a pre-launch security blocker. So boot now reaps it
**automatically, but only once the encrypted copy is proven readable** — never
before. Gate (all three required), in `src/index.js` boot() after `getDb`:

1. at-rest is enabled (`dbKeyHex` resolved), **and**
2. the migration did **not** run this boot — i.e. the vault was already encrypted
   and has now survived a full process restart and reopened. On the migration boot
   itself the backup is **kept** (the encrypted copy has not yet been re-opened by a
   fresh process); it is reaped on the *first verified keyed reopen*, **and**
3. a keyed probe read (`SELECT 1`) returns — concrete proof this process can read
   the encrypted vault with the derived key.

Only then does `reapPreCipherBackups({ dbPath })` overwrite-best-effort + `unlink`
every `<db>.pre-cipher-*` (the renamed main file + any stray `-wal`/`-shm`). It is
**fail-safe**: any probe failure or read error leaves the plaintext backup in place
(boot does not crash), and the function never touches the live `<db>` or
`<db>.cipher-tmp`. Net effect: after the **first restart** following an at-rest
migration, no plaintext copy remains on disk.

**Secure-erase limitation (documented, not papered over):** on a copy-on-write
filesystem (APFS — the macOS default and primary deployment) and on wear-leveled
SSDs, an in-place byte overwrite does **not** reliably scrub the physical blocks
that held the data (the FS writes to fresh blocks; old blocks linger until GC/TRIM).
So the overwrite pass is best-effort only — `unlink` is the practical floor, and
full-disk encryption (FileVault) is the real defense for at-rest residue. See the
`bestEffortOverwrite` / `reapPreCipherBackups` doc comments.

Backup (`.myvault`), import, and Tauri are file-format-agnostic → no breakage; the
encrypted vault simply backs up as encrypted bytes (the backup is *also* blind now).

## 8. `verify:at-rest` gate (A1–A7)

| # | Assertion | Method |
|---|---|---|
| A1 | Encrypted vault is opaque at rest | grep the file for `SQLite format 3\0` + known plaintext markers (a seeded territory name, a timestamp string) → **0 hits**; first 16 bytes ≠ the magic |
| A2 | `-wal` **and** `-shm` are also opaque | same grep on the sidecar files after a write (SQLCipher encrypts WAL frames) |
| A3 | Fail-closed | open with wrong key → throws; open with no key → throws (not plaintext) |
| A4 | Round-trip | write via keyed adapter → read back decrypts identically |
| A5 | Migration parity + idempotent | seed plaintext vault → migrate → per-table COUNT(*) parity; run migrate twice → 2nd is no-op; `.pre-cipher` copy exists |
| A6 | Python-via-bridge reads the encrypted vault | start `vault-bridge.js` keyed → `d1_client.query`/`local_db.query` over loopback return correct rows; bridge rejects a request with `x-forwarded-for` |
| A7 | Two write semantics preserved | `/query` write lands raw (column NOT auto-encrypted); `/batch_encrypted` write lands as an AES-GCM envelope |
| A8 (regression) | Full `npm run verify` GO through the aliased driver | the 104 raw-read verify gates stay green (plaintext temp DBs, opt-out) |

### 8.1 `verify:at-rest-boot` gate (boot-wiring + backup reap)

Separate gate (`scripts/verify-at-rest-boot.mjs`), boots `boot()` against temp fixtures:

| # | Assertion |
|---|---|
| B1 | opt-in resolver: default OFF → `resolveDbKeyHex()=null`; ON → 64-hex key, rejects bad USER_MASTER |
| B2 | fresh vault + flag ON → file born encrypted + keyed connection reads |
| B3 | existing plaintext vault → boot migrates; marker survives; **backup KEPT on the migration boot** |
| B4 | 2nd boot is idempotent (already encrypted) + still reads |
| **B4b** | **plaintext `.pre-cipher` backup REAPED after the verified keyed reopen (2nd boot) + data intact** |
| **B4c** | 3rd boot: no backup lingering + still reads (clean no-op) |
| **B6** | unit: `reapPreCipherBackups` removes only `.pre-cipher-*` (incl. `-wal` sidecar), leaves live `<db>` + `.cipher-tmp`; no-op when none lingering |
| B5 | default OFF → fresh vault stays plaintext (unchanged) |

## 9. Verification table (load-bearing assumptions)

| Assumption | Must be true because | Status | Evidence |
|---|---|---|---|
| Cipher driver is a non-breaking drop-in | else every `import Database` breaks | ✅ PROVEN | spike GREEN; prebuilt; v11 API; alias |
| Cross-driver Node↔Python interop is fatal | justifies single-opener (no Python cipher) | ✅ PROVEN | interop spike FAILED (SQLITE_NOTADB) |
| All Python DB access funnels through 2 modules | else reroute misses a leak path | ✅ PROVEN | sweep: `d1_client.py:61`, `local_db.py:29`, no other `sqlite3.connect` in `pipeline/` |
| Long-running bridge is needed (not spawn-per-call) | 450+ reads × Node startup = unacceptable | ✅ PROVEN | `cluster.py:509-515,561-564,622-626`; ~160 MB |
| Two write semantics must both be preserved | else on-disk column shape changes / reads break | ✅ PROVEN | `local_db.py` raw `query`/`batch` vs `batch_encrypted`→adapter |
| Opt-in opener keeps 104 verify gates green | else full regression fails | ✅ DESIGNED | §4; verify scripts use plaintext temp DBs |
| Key derivation needs no third KCV | operator directive | ✅ DESIGNED | HKDF off USER_MASTER; SQLCipher self-verifies |
| Migration can be idempotent + non-destructive | else a failed boot bricks the vault | ✅ DESIGNED | mirrors `ensureDataDir`; parity gate; keep `.pre-cipher` |
| Boot order: unlock → deriveDbKey → migrate → keyed schema apply | `ensureVaultSchema` opens raw today | ⚠️ TO-WIRE (last step) | `server-rest.js:109` must take the key; migration not yet called at boot |
| SQLCipher encrypts `-wal`/`-shm` | else WAL leaks plaintext frames | ✅ PROVEN (A2) | gate: a known plaintext column value is absent from db/-wal/-shm bytes |
| Bridge + Python reroute + migration work end-to-end | the whole A′ chain | ✅ PROVEN | `verify:at-rest` 17/17 GO (incl. real python3 round-trip) |
| Alias is non-breaking | else the regression fails | ✅ PROVEN | 16+ DB/crypto gates GO through the aliased driver; the only 2 non-GO are a pre-existing python-venv issue reproducing on main |

## 10. Build sequence

1. **Groundwork (inert):** npm-alias the driver; add `keystore.deriveDbKey`; add
   `createDb({…, dbKeyHex})` cipher PRAGMAs (opt-in). Confirm plain-mode `npm run
   verify` stays green (alias is the real regression surface).
2. **Bridge:** promote `local-write-bridge.js` → `vault-bridge.js` (long-running,
   `127.0.0.1`, `isTrustedLoopback`, keyed from env; `/query` `/batch` raw on the
   keyed handle, `/batch_encrypted` via adapter). Add a Node supervisor
   (embed/transcribe mold) + start it from `run-clustering.sh`.
3. **Reroute Python:** `d1_client.py` + `local_db.py` → HTTP client to the bridge
   (keep the exact `query`/`batch`/`batch_encrypted` signatures; callers unchanged).
4. **Migration + boot wiring:** encrypt-vault migration; thread `dbKeyHex` through
   `ensureVaultSchema` + `getDb` at boot after unlock.
5. **Gate:** `verify:at-rest` (A1–A8) → GO; then full `npm run verify` GO.

## 11. Open risks / to-confirm during build

- **A2 (WAL/SHM opacity)** — confirm SQLCipher encrypts the WAL; if a checkpoint
  mode leaks, force `PRAGMA wal_checkpoint` + `temp_store=MEMORY` and re-test.
- **Bridge lifecycle** — who owns shutdown? (pipeline-scoped: `run-clustering.sh`
  starts + traps EXIT to kill it; health-check before first query.)
- **Concurrent openers** — app (in-process) + bridge (separate process) both hold the
  cipher vault open under WAL. SQLCipher supports multi-process; confirm no lock
  contention under a real Generate run (busy_timeout already 5000 ms both sides).
- **Performance** — 160 MB over loopback JSON across 450 batches; measure the
  clustering wall-clock delta vs the plaintext baseline (expected small; verify).

Related: `[[at-rest-blindness]]` (memory handoff), `[[entity-history]]`,
`[[describe-management]]`, `[[deployment-local-primary]]`, `[[pipeline-integrity-search-scaling]]`.

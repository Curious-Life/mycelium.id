# Vault-bridge auth — close the loopback≠authenticated hole (2026-06-19)

**Status:** BUILT + verified. Branch `fix/vault-bridge-auth-token`. Pre-public-launch HIGH.

## TL;DR

`pipeline/vault-bridge.js` is a long-running loopback service that runs caller-chosen
SQL against the **decrypted** SQLCipher vault. Before this change its only gate was
`isTrustedLoopback` — which proves *same host* but **not same user**. On a shared /
multi-user Mac, or via any other local process/uid while the clustering pipeline runs,
anyone could `POST http://127.0.0.1:8099/query {"sql":"SELECT * FROM messages"}` and
read (or `DROP`/`ATTACH`) the entire decrypted cognitive vault. This violates the
loopback≠authenticated principle and CLAUDE.md §13 ("no ad-hoc network servers" — the
port served decrypted rows with no real auth).

**Fix (option (a) from the finding):** a **per-boot shared token** as a second,
independent auth layer, fail-closed, plus a **random ephemeral port**.

## Threat

- The bridge binds `127.0.0.1:8099` (fixed, predictable) and opens the keyed vault once.
- `/query` and `/batch` run arbitrary caller-supplied SQL on the raw keyed handle;
  `/batch_encrypted` writes through the encrypting adapter. SQL *values* are
  parameterized, but the *statement* is caller-chosen → full read/write/DDL.
- `isTrustedLoopback` only checks: socket peer is loopback AND no proxy headers. Every
  local process — regardless of uid — satisfies this. So loopback is a *network*
  boundary, never a *user* boundary.

## Decision

Two independent layers, both required on every route (CLAUDE.md §2 defense-in-depth,
§3 fail-closed):

1. **Same host** — `isTrustedLoopback(req)` (unchanged). Proxied/non-loopback → **403**.
2. **Same user** — `X-Bridge-Token`, a 32-byte (64-hex) secret minted **per boot** by
   the spawner (`run-clustering.sh`), passed to the bridge and the Python stages via
   inherited env, and matched in **constant time** (`crypto.timingSafeEqual` over
   SHA-256 digests, so no length-leak). Absent/wrong token → **401**, on every route
   incl. `/healthz` (no liveness oracle for unauthenticated callers).

**Fail-closed startup:** the bridge **refuses to start** if `MYCELIUM_DB_BRIDGE_TOKEN`
is missing or <32 chars — it never serves the decrypted vault without auth.

**Ephemeral port:** the spawner picks a random port in 49152–65535 instead of a fixed
`:8099` (the `:8099` default remains only as a manual-run fallback). This is hardening,
**not** the security control — local port scanning is trivial; the token is the boundary.

### Why option (a) over (b) unix-domain socket

A UDS with `0600` perms is the strongest transport (no port at all), but Python's
`urllib` has no native UDS support — it would need a custom `http.client` connection
class threaded through both `d1_client.py` and `local_db.py`. The token is portable,
minimal, and already fail-closed. UDS remains a viable future hardening.

### Why `/query` stays read+write (not made read-only)

The finding suggested making `/query` read-only "if the pipeline only reads". It does
**not**: `query()` issues `UPDATE`/`DELETE`/`INSERT` writes in both Python clients, and
`verify:at-rest` A7-raw drives an `INSERT` through `/query`. Making it read-only would
break the pipeline. The token gate covers read *and* write uniformly, which is the
actual fix.

## Surface threaded end-to-end

| File | Change |
|---|---|
| `pipeline/vault-bridge.js` | `tokenOk()` constant-time check; require token (≥32) at startup; 401 on every route after the loopback check |
| `pipeline/run-clustering.sh` | mint `MYCELIUM_DB_BRIDGE_TOKEN` (node `randomBytes`), random ephemeral port, send token on the `/healthz` probe |
| `pipeline/d1_client.py` | read `MYCELIUM_DB_BRIDGE_TOKEN`; send `X-Bridge-Token` in `_post` |
| `pipeline/local_db.py` | same |
| `scripts/verify-at-rest.mjs` | token threaded; **+3 negative tests** (no-token 401, wrong-token 401, `/healthz` 401) |
| `scripts/verify-pipeline-readbridge.mjs` | token threaded; **+1 negative test** (no-token 401) |
| `scripts/verify-bridge-blob.mjs` | token threaded; **+1 negative test** (no-token 401) |
| `docs/AT-REST-BLINDNESS-DESIGN-2026-06-11.md` | §3.3 auth + A6 verification row updated |

No other spawn site or client exists (grep `vault-bridge` / `MYCELIUM_DB_BRIDGE`): the
app's `jobs.js` runs `run-clustering.sh`, which mints the token in-shell, so the
in-process env allowlist is irrelevant.

## Evidence (all GREEN, run in worktree)

```
verify:bridge-blob          10 pass, 0 fail   (incl. 0b un-tokened → 401)
verify:at-rest              20 pass, 0 fail   (incl. no/wrong/healthz → 401)
verify:pipeline-readbridge   7 pass, 0 fail   (incl. P0 un-tokened → 401)
verify:control-loopback     15 pass, 0 fail   (loopback layer intact)
```

Fail-closed startup smoke: bridge with no token / short token →
`fatal: MYCELIUM_DB_BRIDGE_TOKEN required (≥32 chars)`, process exits non-zero.

Full `npm run verify` runs in CI on the PR (the bare worktree has no Python venv → the
clustering Python gates false-fail locally; the affected gates above use stdlib only).

## Picture

```
        BEFORE                              AFTER (two layers, fail-closed)

  any local uid                       any local uid
       │  POST /query {sql}                │  POST /query {sql}   (no token)
       ▼                                   ▼
  ┌──────────────┐                    ┌──────────────────────────┐
  │ isTrusted    │  same host? ✓      │ isTrustedLoopback  same host? ✓ │
  │ Loopback     │ ───────────►       │           │                     │
  └──────────────┘   ✅ SERVED        │           ▼                     │
       │             decrypted        │   X-Bridge-Token  same user? ✗  │
       ▼             vault!           │           │  401 unauthorized   │
   SELECT * FROM messages            └───────────┴─────────────────────┘
                                          spawner (run-clustering.sh)
                                          mints per-boot token + random port
                                                │ env: MYCELIUM_DB_BRIDGE_TOKEN
                                                ▼
                                          Python stages echo X-Bridge-Token ✓ → SERVED
```

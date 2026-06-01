# Crypto spike result: **GO** — `crypto-local.js` (D3/D4/D6) runs unmodified + fails closed

**Date:** 2026-05-30 · **Verdict:** GO — port `crypto-local.js` as-is; the spike *is* the basis for `src/crypto/`.
**Runtime:** Node v22.22.2, zero npm deps (Node built-in `webcrypto` only).

## Method (max fidelity)

The reference `reference/encryption/crypto-local.js` is run **completely unmodified**. Its only
local import is `./guardians/index.js`; in `reference/` that path is broken (guardians live at
`reference/core/guardians/`, not beside the crypto file). The spike **co-locates** the two as
siblings — restoring the layout the import expects — so the source runs with **zero edits**.

```bash
cd spike/crypto && node probe.mjs    # exits 0 on GO
```

## Ledger (9/9 PASS)

| # | Check | Evidence |
|---|---|---|
| A2  | v1 user round-trip + envelope shape | `{v:1,s,iv,ct,dk}` decrypts to plaintext (D3 envelope confirmed) |
| A2b | v2 per-user round-trip (import-read path) | `{v:2,u:"user-123"}` re-derives user key, round-trips; wrong key throws |
| A3  | system round-trip | `{v:3,kf:"system"}` decrypts with `opts.systemKey` |
| A4  | **KCV mechanism / fail-closed** | correct key decrypts; **wrong key → `OperationError`** (AES-KW unwrap auth fail) |
| A4b | hex validation | `importMasterKey` rejects 63-char and empty hex (D4 typo guard) |
| A5  | **rewrapEnvelope re-key** | old→new re-key: new key decrypts; old key rejected on rewrapped; new key rejected on old (import path / R5) |
| A6  | **D6 two-key separation** | system-env w/o systemKey → throw; system-env w/ user-key → throw; user-env w/ system-key → throw (USER_MASTER ⊥ SYSTEM_KEY) |
| A7  | scope-decryption guardian | `allowedScopes` enforced; wrong scope → `ScopeViolationError`; `null` = admin |
| A8  | scope-encryption guardian | `AGENT_SCOPES` gates the write scope; admin (unset) allows any |

## Red-team findings (fold into the plan)

1. **Guardians import-path mismatch [porting gotcha].** `crypto-local.js:13` does
   `import … from './guardians/index.js'`, but `reference/` puts guardians under
   `core/guardians/`. **Port them as siblings** (e.g. `src/crypto/crypto-local.ts` +
   `src/crypto/guardians/`) or fix the import — otherwise the module won't load. The four
   guardian files (`index/registry/guardian/scrubbers`) are self-contained (no external deps).
2. **libsodium is NOT needed for the verified path.** `sodium-native` is lazy-loaded **only**
   by the *tmpfs* key reader (`importMasterKeyFromTmpfs`). The hex-import path we verified
   (`importMasterKey(hex)` from env/paste) uses pure `webcrypto` — **V1 can skip the native
   `sodium-native` dependency** by loading keys via env/paste rather than tmpfs+sodium.
3. **Wrong-key error is untyped (`OperationError`).** The KCV/unlock code must treat **any**
   decrypt throw as "wrong key → stay locked" — don't switch on error type. (KCV blob is the
   known-constant; a GCM/AES-KW auth failure on it = reject the key.)
4. **This proves self-consistency + fail-closed, NOT production-import compatibility.** HKDF
   zero-salt + the fixed `info` strings are exercised, but decrypting a *real production row*
   needs a sample envelope + the old master key (a separate gate, same class as R2 embedding
   parity). Schedule that check against one exported row before the bulk re-key import (Step 17).

## Consequence for the plan

- **D3/D4/D6 verified.** Port `crypto-local.js` unmodified; this spike becomes `src/crypto/`.
- Step 2: port guardians as siblings; KCV catches *any* throw; prefer env/paste key load (no sodium).
- Add a Step-17 pre-flight: decrypt one real exported row before the bulk `rewrapEnvelope` import.

> Throwaway evidence. The copied `crypto-local.js` + `guardians/` are reference snapshots for
> the spike only; the shipped version lands in `src/crypto/` during Phase 1 Step 2.

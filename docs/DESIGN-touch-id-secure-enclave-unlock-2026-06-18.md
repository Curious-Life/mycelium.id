# Design — Touch ID / Secure Enclave vault unlock

**Status:** DESIGN (sweep-grounded), ready to build. Native-macOS parts require real-Mac
verification (a Touch ID prompt can't be exercised headless). Author: at-rest session
2026-06-18. Branch `fix/at-rest-migration-lock`. Closes the "key-in-process.env / not
hardware-gated" gap identified in the SOTA analysis.

---

## Goal

Protect `USER_MASTER` (the root secret from which the SQLCipher DB key, `SYSTEM_KEY`, and all
scope/DEK keys derive) with the Mac's **Secure Enclave + Touch ID**, so day-to-day unlock is a
fingerprint and the key is never sitting in a plain, biometrics-free Keychain item — the
1Password/Apple-Keychain pattern — **without** weakening the recovery story.

## Current state (sweep evidence)

- `src-tauri/src/main.rs:211,256,343` — the Tauri shell passes `MYCELIUM_KEY_SOURCE=keychain`
  to every Node child (`server-rest`, `index.js --http`, supervisor).
- `src/crypto/key-source.js:37-47` (`fromKeychain`) + `src/account/keystore.js:101` — **Node**
  reads `USER_MASTER` (+ derived `SYSTEM_KEY`) at boot via
  `security find-generic-password -a <acct> -s <svc> -w`, then `src/index.js:93` pins it into
  `process.env.ENCRYPTION_MASTER_KEY` for the process lifetime.
- `src/account/keystore.js:5,50-70` — `USER_MASTER` is the **single recovery key** the user
  saves; `deriveSystemKey` / `deriveDbKey` (HKDF-SHA256) derive everything else from it.
- Threat today: the login-keychain item is readable whenever the keychain is unlocked; it is
  not Touch-ID-gated and not hardware-bound. Accepted *local single-user* boundary
  ([[deployment-local-primary]]), but the SOTA hardening is biometric + Secure Enclave.
- Existing `@better-auth/passkey` (`src/auth.js:87`, `src/db/passkeys.js`) is PORTAL-LOGIN auth
  — orthogonal to key unlock; do not conflate.

## Core principle: Touch ID hardens, the recovery key still rules

`USER_MASTER` (64-hex) remains the root the user backs up. Touch ID gates a **convenience
copy**; it is NEVER the only way in. Mirrors 1Password (biometric unlock + Secret Key/account
password as recovery). Lost Touch ID / new Mac / reset biometrics → enter the recovery key,
which re-establishes the biometric wrap. The plaintext `USER_MASTER` is never stored unguarded.

## Design

```
First run / enrollment:
  user saves USER_MASTER (recovery key)  ── unchanged
        │
        ▼
  Secure Enclave generates a NON-EXTRACTABLE P-256 key  (kSecAttrTokenIDSecureEnclave)
   with SecAccessControl = { .privateKeyUsage, .biometryCurrentSet }  (Touch ID required)
        │
        ▼
  wrap USER_MASTER with the SE key (ECIES: SecKeyCreateEncryptedData)
   → store the WRAPPED blob in the app data dir / Keychain (useless without THIS Mac's SE + Touch ID)
   → REMOVE the plaintext-readable keychain item (or never write it)

Every launch (Rust shell, before spawning Node):
  LAContext.evaluateAccessControl(biometryCurrentSet)  → Touch ID prompt
        │  success                                   │  fail / unavailable
        ▼                                            ▼
  SE unwraps USER_MASTER (SecKeyCreateDecryptedData)   prompt for recovery key (64-hex),
        │                                              verify KCV, re-enroll the SE wrap
        ▼
  pass USER_MASTER to Node children via env (the resolution that today flows from `keychain`
   now flows from the shell's SE unlock) → Node derives SYSTEM_KEY/DB key as today.
```

### Approach decision

- **Chosen: Secure-Enclave key-wrap** (above). The key material is hardware-bound — the wrapped
  blob is worthless off this Mac, and the SE private key is non-extractable. Strongest.
- Rejected (weaker): a biometric-gated Keychain item (`kSecAttrAccessControl=biometryCurrentSet`
  holding the raw `USER_MASTER`). Simpler, but the raw key still lives in the Keychain (just
  Touch-ID-gated to read). Use only if SE key-wrap proves impractical from the toolchain.

### Where it runs

The **Rust shell** (`main.rs`) does the Touch ID + SE unlock ONCE at launch (one prompt),
*before* spawning Node, and provides `USER_MASTER` to the children — replacing the
`MYCELIUM_KEY_SOURCE=keychain` Node-side read with `MYCELIUM_KEY_SOURCE=env` + the shell-unlocked
key (or a new `secure-enclave` source whose value the shell injects). Centralizing in the
trusted shell means one biometric prompt and no biometric plumbing inside the Node sidecars.

Implementation: a Tauri/Rust path using the `security-framework` + `core-foundation` crates
(SecKey SE generation, SecAccessControl, LAContext) OR a small bundled Swift helper invoked by
the shell. (Decide during build; `security-framework` may need a thin FFI shim for
`LAContext.evaluateAccessControl` + SE `kSecAttrTokenID`.)

## Edge cases / recovery (must all be handled)

1. **No Touch ID hardware** (older Mac / external keyboard, lid closed): fall back to the
   recovery-key prompt; optionally allow device-passcode (`.userPresence` instead of
   `.biometryCurrentSet`).
2. **Biometry reset / finger re-enrolled**: `.biometryCurrentSet` invalidates the SE access on
   biometric change → unlock fails closed → recovery-key prompt → re-enroll. (This is the
   secure behavior; document it so it isn't mistaken for data loss.)
3. **New Mac / migration**: the SE wrap is Mac-bound and does NOT transfer; the user enters the
   recovery key on the new Mac → fresh SE enrollment. (Matches the existing cross-machine model
   — [[macos-signed-distribution-design]].)
4. **Headless / CI / verify scripts**: never require Touch ID — keep `MYCELIUM_KEY_SOURCE=env`
   for injected-key paths (verify gates already inject keys; gate them off the biometric path
   exactly like the enrichment drainer is gated off injected keys at `server-rest.js:427`).
5. **Recovery key entry**: reuse the existing KCV verify (`keystore.js`) so a wrong key fails
   closed, never opens a mismatched vault.

## Verification plan

- **Headless (CI gate `verify:se-unlock`):** the wrap/unwrap envelope logic with a MOCK SE
  (software P-256) — round-trips `USER_MASTER`; the recovery-key fallback path (biometric fail →
  recovery prompt → KCV verify → re-enroll); the key-source plumbing (`env` injection path
  unchanged; verify scripts never hit the biometric path). NO plaintext key in logs (§1).
- **Real-Mac (operator, with the user):** actual Touch ID prompt on launch; SE
  generation/unwrap; biometry-reset fail-closed → recovery prompt; new-Mac recovery-key path.
  These cannot be headless — schedule a live smoke at the user's Mac.

## Build phases

1. JS/plumbing (headless-verifiable): new key-source mode + recovery-key fallback + KCV reuse +
   `verify:se-unlock` gate with mock SE. No native code yet → fully gated.
2. Native (real-Mac): Rust/Swift SE generation + wrap/unwrap + LAContext Touch ID in `main.rs`,
   wired to phase 1. Enrollment ceremony (first run / settings toggle "Unlock with Touch ID").
3. Migration: on first launch after upgrade, if a plaintext keychain item exists and the user
   opts in, enroll the SE wrap and remove the plaintext item. Opt-in; recovery key always works.

## Open decisions for the build

- `.biometryCurrentSet` (Touch ID only, invalidate on biometry change — strongest) vs
  `.userPresence` (allow passcode fallback — friendlier). Recommend `.biometryCurrentSet` with
  the recovery-key fallback covering the rest.
- Per-launch prompt vs a trusted-session TTL (1Password-style "unlock once per N minutes").
  Recommend per-launch for V1 (the app is long-running; one prompt at boot is low-friction).
- `security-framework` crate vs bundled Swift helper — decide by what cleanly exposes SE
  `kSecAttrTokenID` + `LAContext` from the Tauri build.

# DESIGN — First-run hardening: trustworthy key backup · coherent first-run · optional passphrase-lock (2026-06-03)

Status: **design locked, ready to implement.** Sweep-first-design (4 broad Explore sweeps + 2 gap sweeps + 8 first-hand code reads). Three independently-shippable features the user asked for, on top of the already-merged account-setup ceremony (PR #36).

The mnemonic (BIP39) option was explicitly **deselected** by the user — out of scope here.

---

## 1. Context & goals

First-run account setup already ships (`/setup` ceremony, `src/account/*`, PR #36). Looking at it running, three improvements were chosen:

1. **Trustworthy key backup** — today the only gate before "Enter my vault" is a self-attestation checkbox (`setup/+page.svelte:199-202`). A user can enter without ever saving the key → permanent vault loss if the Keychain is later cleared. Close that hole with a **verify-the-key step** (and treat a successful manager-save as proof).
2. **One coherent first-run** — today the post-setup experience is a disjoint `WelcomeModal` (3 slides) + a dormant `OnboardingGuide` + the mindscape empty-state, and the welcome reappears until you import (no persisted flag). Make it **one continuous journey**: create vault → save+verify key → welcome → import → generate → mindscape.
3. **Optional app passphrase/lock** — today the vault auto-opens from the Keychain with no app-level lock. Add an **optional** passphrase that, when enabled, removes the plaintext keys from the Keychain and requires the passphrase to unlock the vault on each launch (real at-rest protection; the recovery key remains the ultimate escape hatch).

Non-negotiable invariants (CLAUDE.md §1-13): fail-closed crypto, no key material in logs/plaintext files, encryption-at-rest, localhost-only surface, single-user trust model.

---

## 2. Revision history (pivots from the sweep)

- **v1 (pre-sweep mental model).** Assumed (a) a passphrase-lock would break many key consumers across the process; (b) the post-setup onboarding was an elaborate, fully-wired 1325-line system to untangle.
- **v2 (post-sweep — two pivots):**
  - **PIVOT A — passphrase blast radius is *one seam*, not many.** `boot()` pins the key in-process via `process.env.ENCRYPTION_MASTER_KEY = userHex` (`src/index.js:73`), and `getMasterKey()` reads *that* in-process env (or tmpfs), never the Keychain (`src/crypto/crypto-local.js:1531-1586`). So blob-store, mind-files, drainer, search all keep working with an empty Keychain. The **only** consumer that re-resolves keys from the Keychain is `src/jobs.js:59` (`resolveKeys()` to populate the clustering child's env). Everything else already works.
  - **PIVOT B — the onboarding is mostly dormant.** The active route hardcodes `show: false` (`src/portal-compat.js:233`), so `OnboardingGuide` never renders in the local build; the full logic lives unwired in `reference/server-routes/portal-onboarding.js`. The real active first-run is `WelcomeModal` + the mindscape empty-state, with `showWelcome: messageCount === 0` and **no persisted flag** → it reappears until import. Smaller surface + a latent bug to fix, not a teardown.
  - **PIVOT C — can't derive `systemHex` from `userHex` in the jobs fix.** New vaults derive SYSTEM_KEY via HKDF, but **legacy vaults have two independent keys** (`keystore.js` derivation governs only new setups). So the jobs.js fix needs a real in-memory session-keys holder, not `deriveSystemKey(userHex)`.

---

## 3. Sweep findings (consolidated, first-hand verified)

### Key lifecycle & boot (sweep 1, verified)
- Keys stored in macOS Keychain: account `mycelium`, services `mycelium-user-master` / `mycelium-system-key` (`src/account/keychain-names.js:8-14`), via `security add-generic-password -U` (`keystore.js:61-66`).
- `resolveKeys()` reads them (env|keychain|1password), fail-closed `KeySourceError` if missing (`src/crypto/key-source.js:89-111`).
- Boot seam: `completeBoot({userHex, systemHex})` → `boot()` → `unlock()` (`src/server-rest.js:145-186`, `src/index.js:55-74`, `src/crypto/keys.js:27-52`). `isInitialized() = Boolean(vaultSubApp)` (`server-rest.js:210`).
- **The "vault-closed → wait for user → open in-process" mechanism already exists**: `/setup` and `/restore` both call `completeBoot(...)` post-boot (`src/account/router.js:51,74`). A `/unlock` endpoint is a near-exact mirror of `/restore`.

### Crypto primitives (sweep 2, verified)
- Reusable envelope: `encrypt(plaintext, scope, masterKey)` / `decrypt(encoded, masterKey)` (`crypto-local.js:996-1141`) — AES-256-GCM DEK wrapped with an HKDF-derived AES-KW scope key; base64-JSON `{v,s,iv,ct,dk}`. Works with **any** HKDF-importable 32-byte key.
- `importMasterKey(hex64)` → `subtle.importKey('raw', bytes, 'HKDF', …)` (`crypto-local.js:552-561`). So a scrypt-derived 32 bytes → hex → `importMasterKey` → a CryptoKey usable with `encrypt/decrypt`.
- **No passphrase KDF exists** anywhere (no scrypt/pbkdf2/argon2/bcrypt). Only Node built-in `crypto` + optional `sodium-native` (mlock). → use **`crypto.scryptSync`** (no new dep).
- KCV on disk: `<dataDir>/kcv.json` = `{v:1, user:<env>, system:<env>}` (`keys.js:42-48`, `paths.js:kcvPath`). The seal will live in a sibling `vault-lock.json`.
- The KCV pattern (encrypt a known constant, decrypt-to-verify, fail-closed) is the exact model for "wrong passphrase" detection.

### First-run UI + onboarding backend (sweeps 3 + gap B, verified)
- Gate: `+layout.svelte:31-37` → `GET /account/status`; `!initialized && !isSetupPage` → `goto('/setup')`, *before* the `/auth/session` check (`:39-48`). `/auth/session` returns a user unconditionally (`src/auth-shim.js`), so the SPA shell would load even while locked unless the gate redirects first.
- Setup leaves via full nav: `enterVault() → window.location.assign('/mindscape')` (`setup/+page.svelte:30`).
- Active onboarding status is a stub: `showWelcome: messageCount === 0`, `show: false`, `steps.data.messageCount` (`portal-compat.js:226-237`). `messageCount` = `db.messages.countByUser` = `COUNT(*) … WHERE user_id=? AND forgotten_at IS NULL`.
- Persisted columns `welcome_shown_at` / `onboarding_dismissed_at` exist in `migrations/0001_init.sql` but are **unused** by the active stub. The full `computeOnboardingStatus` lives in `reference/server-routes/portal-onboarding.js` (not wired).
- Empty-vault source of truth = `messageCount === 0`. "Mycelium generated" = `clustering_points`/`territory_profiles` count > 0.
- Import affordance = global `ImportDropZone.svelte` (mounted in `(app)/+layout.svelte`) + `POST /portal/upload` (archives) / `/portal/upload/file` (any file).

### Locked-vault boundary (sweep 4 + gap A, verified)
- Setup-mode architecture to reuse: `vaultSubApp`-null middleware → 503 on `isVaultDataPath` (`/api/`,`/ingest/`,`/portal/`), static+SPA still served so `/setup` renders (`server-rest.js:223-246`).
- **Nothing reads the vault eagerly at boot.** Embed supervisor + enrich drainer run *inside* `completeBoot` (`server-rest.js:173-174`), after unlock. `jobs.js` `resolveKeys()` runs on-demand at Generate (`jobs.js:59`). `main.rs` only spawns node + opens the window.
- The single passphrase-mode break: `jobs.js:59`. The fix-seam already exists — `jobs.js:62-77` passes `USER_MASTER`/`SYSTEM_KEY` into the child env; the pipeline stages read `process.env.USER_MASTER` directly (`pipeline/*.js`), Python reads tmpfs-or-env. So we only need to feed `jobs.js` the in-memory hex.

---

## 4. Threat model

| Concern | Today | After passphrase-lock |
|---|---|---|
| Laptop stolen, unlocked | vault auto-opens from Keychain | passphrase required (real lock) |
| Laptop stolen, at rest (FileVault) | keys in Keychain (behind login) | keys NOT in Keychain; only `vault-lock.json` (scrypt-sealed) on disk |
| `vault-lock.json` exfiltrated | n/a | offline brute-force bounded by scrypt cost (N=2^16) + passphrase entropy; **mitigation:** enforce min length, document, recovery key still independent |
| Key material in `ps -E` | env-mode only | during a Generate run the child gets `USER_MASTER`/`SYSTEM_KEY` in env (same as today's clustering); transient, local single-user — **accepted, documented** |
| Forgotten passphrase | n/a | **recovery key still restores** (independent of passphrase) → passphrase loss ≠ vault loss |
| Wrong passphrase / brute force online | n/a | per-attempt rate-limit + fail-closed (AES-GCM tag) |

New attack surface: one file (`vault-lock.json`, 0600) and three localhost-only endpoints (`/unlock`, `/passphrase/enable`, `/passphrase/disable`) behind the existing loopback guard (`router.js:26-30`). The passphrase is never logged, never echoed, never returned.

**Central principle:** the passphrase is a *lock*, not a new single point of failure. The recovery key remains the ultimate backup and can always re-open / re-key the vault.

---

## 5. The spine: a 3-state status machine

`GET /api/v1/account/status` today returns `{ initialized, keychainAvailable, onePasswordAvailable }` where `initialized = Boolean(vaultSubApp)`.

**New shape (Phase 3):**
```jsonc
{
  "open": true|false,            // Boolean(vaultSubApp) — unlocked this session
  "needsSetup": true|false,      // no kcv.json — never created
  "locked": true|false,          // kcv.json + vault-lock.json exist, not yet unlocked
  "passphraseEnabled": true|false,
  "initialized": <alias of open>,// kept for back-compat during migration
  "keychainAvailable": true,
  "onePasswordAvailable": false
}
```
- `needsSetup = !existsSync(kcvPath)`
- `passphraseEnabled = lockExists()`
- `locked = !open && existsSync(kcvPath) && passphraseEnabled`

Gate (`+layout.svelte`) becomes: `needsSetup → /setup` · `locked → /unlock` · else session check. `setup/+page.svelte` onMount: `open → enterVault()`.

This is the only breaking shape change, and it's contained to Phase 3 (Phases 1-2 don't touch it).

---

## 6. Feature designs

### 6A. Trustworthy key backup (Phase 1 — frontend-only, ~45 LOC)
File: `portal-app/src/routes/setup/+page.svelte` (reveal mode).
- Add a sub-state to `reveal`: after the user has had the key shown, gate "Enter my vault" behind **proof of save**, where proof = *either*:
  - a successful manager-save (`savedTo !== null` — they clicked Save to Keychain/1Password; a real save), **or**
  - passing a **verify challenge**: re-type the recovery key (or a requested 2-of-16 blocks) into an input; compare client-side (constant-ish) against `recoveryKey`; must match.
- Replace the bare self-attestation checkbox as the *sole* gate. Keep Copy/Download as conveniences, but Download alone no longer satisfies (a file in Downloads is not "saved safely"); Copy never satisfies. Manager-save or verify-typing satisfies.
- Wrong entry → inline error, no progression. No backend change (the key is already client-side from `/setup`).
- Edge: keychain-unavailable path keeps the existing block (`setup/+page.svelte:148-152`).

### 6B. One coherent first-run (Phase 2 — frontend + small backend, ~160 LOC)
Goal: one continuous arc, no reappearing modal, no dormant duplicate guide.
- **Backend (`src/portal-compat.js` onboarding status + a dismiss endpoint, ~40 LOC):**
  - Persist `welcome_shown_at` (column exists). `showWelcome = welcome_shown_at IS NULL && messageCount === 0`. Add `POST /portal/onboarding/welcome-seen` → `UPDATE users SET welcome_shown_at = datetime('now') WHERE id=? AND welcome_shown_at IS NULL`. (Mirrors the reference impl; no migration needed.)
  - Keep `show: false` (the heavy guide stays retired); the coherent flow lives in the mindscape empty-state, not a floating card.
- **Frontend (~120 LOC):**
  - Fold the 3 `WelcomeModal` beats into the mindscape **empty-state** as a single welcoming surface (hero + "Bring your data in" with a visible drop target wired to `ImportDropZone` + a "Generate" CTA that lights up once `messageCount > 0`). The arc: setup → `/mindscape` empty-state (welcome+import) → generate → populated map.
  - Call `welcome-seen` when the user first dismisses the welcome beat, so it never re-shows.
  - Retire `WelcomeModal` as a separate modal (or render it inline once, gated by the persisted flag). `(app)/+layout.svelte` trigger simplified accordingly.
- Decision: keep scope tight — this phase **unifies and persists**, it does not resurrect the `reference/` guide. Generation lifecycle already lives in `lib/generate.ts` (reuse).

### 6C. Optional passphrase/lock (Phase 3 — the structural one, ~700 LOC)

**New module `src/account/passphrase-lock.js` (~95 LOC):**
```js
// scrypt params — permanent unless versioned in the lock file
const SCRYPT = { N: 1<<16, r: 8, p: 1, keylen: 32, maxmem: 160*1024*1024 };
function deriveKEKHex(passphrase, saltBuf)            // scryptSync → 32-byte hex
async function sealUserMaster(userHex, passphrase)   // → { v, kdf:'scrypt', N,r,p, salt, seal }
                                                     //   seal = encrypt(userHex,'personal',importMasterKey(kekHex))
async function unsealUserMaster(lockObj, passphrase) // → userHex | throws 'wrong_passphrase'
                                                     //   decrypt(seal, importMasterKey(kek)); assert 64-hex
// file I/O (0600, 0700 dir) via src/paths.js lockPath()
function lockExists() / readLock() / writeLock(obj) / removeLock()
```
Reuses `importMasterKey`, `encrypt`, `decrypt` from `crypto-local.js` (same envelope as KCV). KDF = Node `crypto.scryptSync` — no new dependency.

**New module `src/account/session-keys.js` (~20 LOC):** memory-only holder.
```js
let _keys = null;                       // { userHex, systemHex }
export function setSessionKeys(k){ _keys = k; }   // called by completeBoot
export function getSessionKeys(){ return _keys; } // never logged
export function clearSessionKeys(){ _keys = null; }
```

**`src/paths.js` (+2 LOC):** `lockPath()` = `under('vault-lock.json','MYCELIUM_VAULT_LOCK')`.

**`src/server-rest.js` (~15 LOC):** in `completeBoot`, after a successful `boot()`, `setSessionKeys({ userHex: opts.userHex, systemHex: opts.systemHex })`. Extend the `/status` shape (§5) by passing `lockExists` + `existsSync(kcvPath)` info into the account router (or compute in the router from `kcvPath` + `lockPath`).

**`src/jobs.js` (~5 LOC):** replace `const { userHex, systemHex } = resolveKeys();` with `const { userHex, systemHex } = getSessionKeys() ?? resolveKeys();`. (PIVOT C: use the real held keys, never `deriveSystemKey`, so legacy two-key vaults work.)

**`src/account/router.js` (~130 LOC) — new endpoints (loopback-guarded, like the rest):**
- `POST /unlock { passphrase }` — refuse if `open`; require `lockExists()`. `unsealUserMaster(readLock(), passphrase)` → `userHex`; `systemHex = deriveSystemKey(userHex)`; verify against KCV (`unlock()` — defense in depth); `completeBoot({userHex, systemHex})`. Wrong passphrase → `400 wrong_passphrase`. Per-IP attempt rate-limit (reuse the remote-connect limiter pattern).
- `POST /passphrase/enable { passphrase }` — require `open` (vault already unlocked); read `userHex` via `readUserMaster()`; `writeLock(await sealUserMaster(userHex, passphrase))` (write+fsync); **verify** `unsealUserMaster` round-trips; only then `deleteKeychain()` (remove plaintext). Order guarantees we never strip the Keychain before a working seal exists.
- `POST /passphrase/disable { passphrase }` — require `open`; verify `passphrase` unseals the lock; `writeKeychain(userHex, deriveSystemKey/heldSystemHex)`; `removeLock()`. (Uses held `systemHex` for legacy correctness.)
- `POST /lock` *(nice-to-have, may defer to 3b)* — tear down: close db handle, null `vaultSubApp`, `clearSessionKeys()`, drop `ENCRYPTION_MASTER_KEY`. Lets "Lock now" work without a process restart. Flagged-risk (must quiesce the drainer/embed supervisor first).
- Min passphrase policy (length ≥ 8, configurable) enforced server-side on enable.

**Frontend (~240 LOC):**
- **`portal-app/src/routes/unlock/+page.svelte`** (new, ~120) — mirrors `/setup` visual language: passphrase field → `POST /unlock`; on success full-nav to `/mindscape`; a secondary "Forgot passphrase? Use recovery key" → `POST /restore` path (which re-keychains + disables the lock; warn the user). Wrong passphrase → inline error + soft attempt backoff.
- **Gate** (`+layout.svelte`) + **`setup/+page.svelte` onMount** updated to the 3-state machine (§5).
- **Settings → Security** (`(app)/settings/+page.svelte`, ~120) — a "App passphrase" toggle next to the existing Recovery Key panel (`settings/+page.svelte:1832+`): enable (set+confirm passphrase → `/passphrase/enable`), disable (`/passphrase/disable`), and "Lock now" if `/lock` ships. Clear copy: "Locking removes your keys from the Keychain; the app will ask for this passphrase on every launch. Your recovery key still works if you forget it."

**Recovery-key interaction (explicit decision):** while locked, `/restore` with the recovery key both (a) opens the vault for the session and (b) **disables passphrase mode** (re-writes Keychain, removes the lock file) — because `/restore` necessarily re-populates the Keychain. The unlock screen surfaces this as "Use recovery key instead" with a note that it turns the lock off until re-enabled. Keeps a single, predictable Keychain-vs-lock invariant: *exactly one of* {Keychain plaintext keys, vault-lock.json} exists at rest.

---

## 7. Edge cases — explicit decisions

| Case | Decision |
|---|---|
| Enable passphrase, write seal OK, `deleteKeychain` fails | seal verified before delete; if delete fails, log + return error, vault stays in Keychain mode (no data loss). Idempotent retry. |
| Both `kcv.json` + `vault-lock.json` + Keychain keys present (inconsistent) | invariant: enable deletes Keychain *after* seal; disable removes lock *after* Keychain write. If somehow both exist, **Keychain wins** (auto-open) and a one-time reconcile removes the stale lock. |
| Wrong passphrase on `/unlock` | AES-GCM tag fails → `decrypt` throws → `400 wrong_passphrase`; rate-limited; nothing written. |
| Forgotten passphrase | `/restore` with recovery key (disables lock). Documented in `ACCOUNT-AND-DATA.md`. |
| Generate (clustering child) in passphrase mode | `getSessionKeys()` feeds `jobs.js`; child env unchanged. Verified seam. |
| Legacy two-key vault enables passphrase | seal stores `userHex`; `systemHex` is the *held* independent key on disable (PIVOT C). On unlock we `deriveSystemKey(userHex)` only to KCV-verify — **but** that would be wrong for legacy! → On unlock, if `deriveSystemKey(userHex)` fails KCV, fall back to the Keychain-independent systemHex **only if present**; for passphrase mode we additionally seal `systemHex` in the lock file when it isn't derivable. **Decision: seal BOTH `userHex` and `systemHex` in `vault-lock.json`** (two envelopes), so legacy and derived vaults both round-trip exactly. (+ small LOC; removes the derivation ambiguity entirely.) |
| Verify-key step on Phase 1 vs passphrase | independent; Phase 1 ships without Phase 3. |
| `welcome_shown_at` already set (returning user) | `showWelcome=false`; no modal. Idempotent. |
| Tauri "Lock now" without `/lock` | until `/lock` ships, locking takes effect on next launch; Settings copy says so. |

**Edge-case-driven design change:** seal **both** keys in `vault-lock.json` (not just `userHex`). This makes legacy independent-key vaults correct and removes any `deriveSystemKey` guess on the unlock path. (`sealUserMaster` → `sealKeys(userHex, systemHex, passphrase)` → `{ sealU, sealS }`.)

---

## 8. Test strategy (each adds to the `verify:*` chain)

- **`scripts/verify-account.mjs` (extend):** unchanged setup/restore + new passphrase block — enable (seal written, Keychain cleared, both keys round-trip), restart→locked status, `/unlock` wrong→`wrong_passphrase`+rate-limited, `/unlock` right→`open`, disable (Keychain restored, lock removed), legacy two-key vault enable/unlock/disable. Fully isolated (ephemeral data dir + `MYCELIUM_KC_*` + ephemeral `MYCELIUM_VAULT_LOCK`).
- **`scripts/verify-passphrase-lock.mjs` (new):** unit — `deriveKEKHex` deterministic; `sealKeys`/`unsealKeys` round-trip; wrong passphrase throws; tamper a byte → throws; scrypt params honored from the lock file.
- **`scripts/verify-jobs-keys.mjs` (new or fold into verify-account):** with `getSessionKeys()` set and Keychain empty, `jobs.js` key resolution returns the held keys (no `KeySourceError`); with it null, falls back to `resolveKeys()`.
- **Frontend (preview MCP, isolated `:8796` instance):** render `/setup` reveal → verify-step blocks until match/manager-save; render `/unlock`; render Settings → Security toggle; render the unified mindscape empty-state.
- **Manual e2e (this Mac, throwaway vault only):** enable passphrase → relaunch isolated server → `/unlock` → Generate succeeds. **Never on the real vault's Keychain.**

---

## 9. Implementation order (independently shippable)

1. **Phase 1 — Trustworthy key backup** (frontend-only). Ship as its own PR. Verify in the `:8796` preview.
2. **Phase 2 — Coherent first-run** (portal-compat status + welcome-seen + mindscape empty-state reflow + retire WelcomeModal). Own PR. Verify empty-state + persisted welcome.
3. **Phase 3 — Optional passphrase/lock**:
   - 3a backend: `passphrase-lock.js`, `session-keys.js`, `paths.lockPath`, `jobs.js` seam, router endpoints + status shape, `server-rest` wiring. + `verify-passphrase-lock.mjs` + `verify-account.mjs` extension. Smoke green.
   - 3b frontend: `/unlock` route, gate 3-state, Settings → Security toggle, `/lock` (optional).
   - 3c docs: extend `docs/ACCOUNT-AND-DATA.md` (passphrase, lock, recovery interplay). Squash PR.

Each phase: `npm run verify` GO before PR; PRs are GitHub PRs via `gh` (no direct main push).

---

## 10. Decision criteria to proceed between phases
- Phase 1 → 2: verify-step blocks progression on wrong/empty entry **and** a manager-save satisfies it, confirmed in the preview on a throwaway vault.
- Phase 2 → 3: empty-state shows once, import lights the Generate CTA, welcome does not reappear after `welcome-seen` (persisted), `npm run verify` GO.
- Phase 3 done: `verify-account.mjs` + `verify-passphrase-lock.mjs` GO; isolated e2e (enable → relaunch → unlock → Generate) passes; the {Keychain XOR lock-file} invariant holds across enable/disable/restore.

---

## 11. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Strip Keychain before a working seal → lockout | low | high | seal verified (round-trip) *before* `deleteKeychain`; data loss impossible (recovery key independent) |
| `jobs.js` seam missed → Generate breaks in passphrase mode | med | med | `getSessionKeys() ?? resolveKeys()` + a dedicated verify; covered by `verify-account` passphrase block |
| scrypt params too weak (offline brute force) | low | med | N=2^16,r=8,p=1; min passphrase length; documented; recovery key independent |
| `/lock` (in-process re-lock) races the drainer/embed supervisor | med | med | quiesce drainer+supervisor, close db, null `vaultSubApp`, clear keys — *in that order*; or defer `/lock` to a follow-up (lock-on-next-launch works without it) |
| Status-shape change breaks the gate mid-migration | low | high | keep `initialized` alias; land status + gate + setup-onMount in the *same* Phase-3 commit; verify gate paths |
| Key in child `ps -E` during Generate | always (local) | low | transient, local single-user; same as today; documented in threat model |

---

## 12. Open questions — resolved during sweep
- *Does a passphrase break blob/mind-file/search encryption?* No — `getMasterKey()` reads in-process `ENCRYPTION_MASTER_KEY` (pinned at `index.js:73`), not the Keychain. Only `jobs.js` re-resolves. (PIVOT A)
- *Can we derive `systemHex` from `userHex` for the jobs fix?* No — legacy vaults have independent keys. Hold both in memory; seal both in the lock file. (PIVOT C)
- *Is there an existing locked-vault scaffold?* Yes — setup mode (`vaultSubApp`-null + 503 + static UI). Locked mode reuses it verbatim. (sweep 4)
- *Is the onboarding a big system to refactor?* No — active `show:false`; only `WelcomeModal` + empty-state are live; persist `welcome_shown_at` and unify. (PIVOT B)
- *KDF dependency?* None needed — `crypto.scryptSync` + the existing AES-GCM envelope.

## 13. Open questions — deferred (named, out of scope)
- BIP39 mnemonic encoding of the recovery key (user deselected).
- Biometric (Touch ID) unlock as a passphrase alternative (Tauri plugin; future).
- Auto-lock after idle timeout (depends on `/lock` landing first).
- Porting the full `reference/` onboarding guide (Connect-AI / messaging steps) — only relevant once those verticals land.
- Multi-user / networked auth (remains out of scope; surface stays localhost-only).

---

## 14. Verification table (every load-bearing assumption, read first-hand)

| # | Assumption | Verified at (read myself) |
|---|---|---|
| 1 | `completeBoot({userHex,systemHex})` is the single seam to open the vault post-boot | `src/server-rest.js:145-186` |
| 2 | `/setup` & `/restore` already open the vault in-process via `completeBoot` | `src/account/router.js:51, 74` |
| 3 | `boot()` pins the key in-process (`ENCRYPTION_MASTER_KEY=userHex`) → getMasterKey works w/o Keychain | `src/index.js:73` (+ comment :64-72) |
| 4 | `boot()` accepts injected keys (so an unlock endpoint can pass them) | `src/index.js:55-59` |
| 5 | `getMasterKey()` reads tmpfs/in-process env, never the Keychain | `src/crypto/crypto-local.js:1531-1586` (sweep-quoted) |
| 6 | The ONLY Keychain re-resolve outside boot is `jobs.js` | `src/jobs.js:57-59` |
| 7 | jobs already hands keys to the child via env (`USER_MASTER`/`SYSTEM_KEY`) | `src/jobs.js:62-77` |
| 8 | Legacy vaults have independent keys (can't derive systemHex) | `src/account/keystore.js:8-10, 40-44` (derivation governs new setups only) |
| 9 | `encrypt/decrypt` work with any HKDF-importable 32-byte key | `src/crypto/crypto-local.js:996-1141`, `552-561` |
| 10 | No passphrase KDF / no scrypt-argon dep exists today | sweep 2 grep (none); `package.json` (built-in `crypto` only) |
| 11 | KCV is the fail-closed wrong-key model; file = `<dataDir>/kcv.json` | `src/crypto/keys.js:27-52`, `src/paths.js:kcvPath` |
| 12 | Setup-mode scaffold: `vaultSubApp`-null → 503 + static UI; reusable for locked | `src/server-rest.js:223-246` |
| 13 | `/auth/session` returns a user even while closed → gate must redirect first | `src/auth-shim.js` (`/session`), `+layout.svelte:31-48` |
| 14 | Gate redirects on `!initialized` before session check | `portal-app/src/routes/+layout.svelte:31-37` |
| 15 | Active onboarding stub: `show:false`, `showWelcome=messageCount===0`, no persisted flag | `src/portal-compat.js:226-237` |
| 16 | `welcome_shown_at`/`onboarding_dismissed_at` columns exist but unused | `migrations/0001_init.sql` (sweep-quoted), `portal-compat.js:226-237` (unused) |
| 17 | Empty-vault signal = `db.messages.countByUser` (`COUNT(*) … forgotten_at IS NULL`) | `src/portal-compat.js:228`, `src/db/messages.js:526-528` (sweep-quoted) |
| 18 | Nothing eager touches the vault at boot (drainer/supervisor inside completeBoot) | `src/server-rest.js:169-182` |

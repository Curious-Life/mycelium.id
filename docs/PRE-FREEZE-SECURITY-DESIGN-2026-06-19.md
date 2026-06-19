# Pre-Freeze Security Pass — Design + Blocker

**Date:** 2026-06-19
**Release target:** `bc85157` (origin/main, post SQLCipher Stage B/C collapse #329/#339/#340)
**Audience:** the team, before the public-release freeze.
**Companions:** [[sqlcipher-collapse-decision]] · `docs/SQLCIPHER-STAGEBC-EXECUTION-HANDOFF-2026-06-19.md` · `docs/AT-REST-BLINDNESS-DESIGN-2026-06-11.md` · parked `de2074f` (at-rest default-on).

## TL;DR

A pre-freeze red-team of the ~60 never-audited commits (SQLCipher collapse, scan-this-Mac import, harness hook-bus) on the exact release target found **one CRITICAL launch blocker** + **two HIGH** + doc scrubs. The CRITICAL is **verified in code** (file:line below) and is a *new* regression introduced by today's collapse — it could not have been seen by the earlier audit on the pre-collapse baseline.

| # | Severity | Issue | Fix owner |
|---|---|---|---|
| 1 | 🔴 **CRITICAL** | Plaintext content at rest on the **documented self-host path** (collapse removed the field layer; whole-file SQLCipher is flag-gated OFF by default off the packaged app) | **team** — boot/migration product call |
| 2 | 🔴 HIGH | `vault-bridge` :8099 = unauthenticated decrypted-vault SQL oracle (loopback-only ≠ same-user) | clean-room patchable |
| 3 | 🟠 MED-HIGH | `/import/{obsidian,full-export,claude-code}` accept arbitrary absolute local paths | clean-room patchable |
| 4 | 🟠 scrubs | `/Users/altus` paths in 2 KEEP files + 1 exploit doc + 1 email + `.gitignore` gap | mechanical |

**Must-fix before freeze:** #1 (it touches boot + plaintext-vault migration + the search-build perf that motivated the collapse → needs the team's call). #2–#4 fold into the same pre-freeze pass.

---

## 1. 🔴 CRITICAL — plaintext content at rest on the documented self-host path

### The regression
The collapse (#329/#339/#340) emptied `ENCRYPTED_FIELDS` to exactly `{secrets}` — messages/documents/facts/all content now have **no per-field AES-GCM envelope**. The design's load-bearing premise: *"whole-file SQLCipher protects content at rest instead."* **That premise only holds if whole-file SQLCipher is always on.** It is not.

- **Before the collapse:** even a *plaintext-file* vault had field-encrypted content (the envelopes). Defense existed on every path.
- **After the collapse:** a plaintext-file vault has **fully plaintext content**. The collapse traded "two layers, one always on" for "one layer, off by default on the self-host path."

### Verified evidence (release target `bc85157`)
- **Born-encrypted requires the flag.** `src/db/init.js:78-79`:
  ```js
  const fresh = !existsSync(dbFile);
  const keyed = vaultIsEncrypted(dbFile) || (atRestEnabled() && fresh);   // fresh + no flag → keyed=false → PLAINTEXT
  ```
- **Key resolution returns null without the flag.** `src/db/open.js:43-44`: `resolveDbKeyHex` → `if (!vaultIsEncrypted(dbPath) && !atRestEnabled()) return null;`
- **Null key → plaintext open.** `src/adapter/d1.js:49,54`: "Absent dbKeyHex → plaintext open, unchanged."
- **The flag is set ONLY by the packaged Tauri app.** `src-tauri/src/main.rs:275` (stdio MCP sidecar) + `:346` (`--http`). The DMG is safe.
- **The documented self-host path sets NO flag.** `docs/guide/reference/connect.md:39` lists `node src/index.js` (`npm start`) as the stdio MCP server — no `MYCELIUM_AT_REST`. `cargo tauri dev` likewise. → **a stranger following our own docs on a fresh vault writes a plaintext "cognitive vault" to disk.**

### Threat model
An attacker with **disk access but not the key** — lost/stolen laptop, a Time Machine/cloud backup, a second user on a shared Mac, malware reading files — opens the vault DB and reads thoughts/relationships/finances/health in cleartext. This is the exact threat the product's "encrypted on your device" promise sells against. For self-hosters (a launch audience), the documented happy path defeats it.

### Fix — two complementary defenses (recommend BOTH)
**A. PRIMARY — at-rest default-ON / born-encrypted on every launch path** (adapt the parked `de2074f` "app default-on — new-user vaults born encrypted, existing migrate").
- Make a fresh vault **born encrypted unconditionally** (not gated on `MYCELIUM_AT_REST`); keep the env var only as an explicit *opt-out* for the rare plaintext-debug case, if at all.
- **Auto-migrate existing plaintext vaults on boot.** The machinery already exists and is merely flag-gated today: `init.js:117` (`atRestEnabled() && isPlaintextSqlite` → migrate), `.pre-cipher` backup + self-verifying `purgePlaintextBackup` (index.js:131), cross-process lock (init.js header). Un-gate it. Idempotent + fail-closed already.

**B. DEFENSE-IN-DEPTH — fail closed at open/boot** (small, clean-room-able).
- `autoEncryptParams` only sees `masterKey`/`systemKey`, **not** whether the DB file is keyed — so the guard belongs at **open time** (`d1.js createDb` / `initVaultStorage`), which knows `dbKeyHex`. Rule: **if the vault would open UNKEYED *and* content field-encryption is collapsed (no content tables in `ENCRYPTED_FIELDS`), REFUSE to open the canonical vault** (throw — "refusing to write content with neither at-rest layer active"). This guarantees content never silently lands plaintext, even if a future launch path forgets the flag. Mirror the existing fail-closed precedent at `d1.js:41-43` (refuse to open an encrypted vault unkeyed) — this is its symmetric twin.

### Migration considerations
- Existing self-host plaintext vaults (anyone who ran the no-flag path pre-fix) migrate on next boot via the existing path — verify on a **clone of a real plaintext vault** first.
- The packaged-app vaults are already encrypted → `vaultIsEncrypted` true → no-op (idempotent).
- Keep the `.pre-cipher` backup purge self-verifying (re-open keyed + read before delete; keep on any doubt) — already so.

### Perf considerations (why this doesn't undo the collapse)
The collapse removed the field envelope to kill **per-row decrypt** on hot reads (Library/Mindscape/search-build stalls — [[at-rest-search-build-perf]]). Always-on whole-file SQLCipher adds the **page-decrypt** cost — but that is the **exact cost the packaged app already pays today** and the on-disk search index pays it **once** then persists. So default-on introduces **no new perf regression vs the shipping DMG**, and the collapse's per-row win is fully preserved. The two are orthogonal.

### Edge cases — explicit
- **Test fixtures + the ~104 verify gates boot plaintext temp DBs** (flag off, `d1.js:49`). The fail-closed guard MUST be scoped so it never fires on a non-canonical `dbPath` — mirror `purgePlaintextBackup`'s `path.resolve(dbPath) === resolveDbPath()` scoping (index.js:131). Default-on born-encryption likewise should not force-encrypt every throwaway test DB.
- **`MYCELIUM_AT_REST` as opt-OUT:** if kept, invert the semantics carefully so the *absence* of config is the *secure* default (fail-safe, not fail-open).

### The decision the team owns
1. **Default-on-everywhere vs fail-closed-only vs both** (recommendation: both — A is the real fix, B is cheap insurance).
2. **Plaintext-vault migration UX:** silent-on-boot (current machinery) vs a one-time "encrypting your vault…" notice.
3. Whether to retain `MYCELIUM_AT_REST` at all (as opt-out) or remove it.

### Verification table
| Assumption | Verified at |
|---|---|
| Collapse left `ENCRYPTED_FIELDS == {secrets}` (no content field layer) | crypto-local.js (origin/main) — only `secrets:['key','value','description']` populated |
| Fresh vault born plaintext without the flag | src/db/init.js:78-79 |
| `resolveDbKeyHex` returns null without flag/encrypted-file | src/db/open.js:43-44 |
| Null key → plaintext open | src/adapter/d1.js:49,54 |
| Flag set only by packaged app | src-tauri/src/main.rs:275,346 |
| Documented self-host path sets no flag | docs/guide/reference/connect.md:39 |
| Migration machinery exists, flag-gated | src/db/init.js:117; index.js:131 |
| Parked default-on fix exists | `de2074f` on feat/search-phase1-ondisk |
| Fail-closed belongs at open (autoEncryptParams lacks dbKeyHex) | crypto-local.js:1588 (sig); d1.js:32,41-43 (open knows dbKeyHex) |

---

## 2. 🔴 HIGH — `vault-bridge` :8099 unauthenticated decrypted-vault SQL oracle
`pipeline/vault-bridge.js` serves arbitrary SQL against the **decrypted** vault on `127.0.0.1:8099`, gated only by `isTrustedLoopback` — which proves *same host*, not *same user*. On a shared/multi-user Mac, any local process can read the entire vault while the pipeline runs. Also a CLAUDE.md §13 ("no ad-hoc network servers") tension.
**Fix:** per-boot shared-secret token (parent → bridge via env; required header) + a random ephemeral port, or a `0600` unix-domain socket. Clean-room patchable.

## 3. 🟠 MED-HIGH — import accepts arbitrary local paths
`/import/{obsidian,full-export,claude-code}` take any absolute server-local path (owner-gated) and ingest arbitrary `.md`/`.jsonl`/assets — a confused-deputy / stolen-Bearer risk.
**Fix:** confine roots to the `detect-sources` allowlist + a `realpath` prefix-check (reject paths that escape the allowed roots). Clean-room patchable.

## 4. 🟠 Data-leak scrubs (files we KEEP — must scrub before public)
- `/Users/altus` absolute paths in **`.claude/skills/pre-deletion-caller-audit/SKILL.md`** and **`tools/memory-bridge/openclaw/README.md`** → genericize.
- Purge exploit doc **`SECURITY-FOLLOWUP-KEY-IN-ENV`** (and confirm no sibling exploit docs survive cleanup).
- **`martin@hi.mycelium.id`** in a handoff doc (Phase-2 archive drops it; confirm).
- **`.gitignore`** still doesn't guard `.claude/memory/`, `MEMORY.md`, `_*.mjs` — add, so personal memory/scratch never ships.

## 5. Pre-freeze order
1. **#1 CRITICAL** — team decision (A+B) → PR on main → verify on a real-plaintext-vault clone (born-encrypted + migrate + fail-closed scoped off test fixtures) → full `npm run verify` green.
2. **#2 + #3** — clean-room patches in the same pass (bridge token/socket; import realpath confinement) + their verify gates.
3. **#4** — scrub the KEEP files + purge + `.gitignore`.
4. Re-run the full red-team on the patched target before tagging the freeze.

## Engineering note
This is the canonical case for **red-teaming the new code, not the old baseline**: the earlier prepublish audit ([[prepublish-security-audit]]) ran before the collapse and correctly found that path *safe* — the collapse *introduced* the plaintext-at-rest hole by removing the layer that covered the no-flag path. Auditing only the diff's *intent* ("collapse is equivalent because SQLCipher protects at rest") would have missed it; auditing the *runtime default on every launch path* caught it.

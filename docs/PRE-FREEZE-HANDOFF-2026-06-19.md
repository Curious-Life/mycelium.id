# Pre-Freeze Security Pass — Handoff

**Date:** 2026-06-19
**Audience:** the next session — bash out the remaining pre-freeze items fast.
**Companions:** `docs/PRE-FREEZE-SECURITY-DESIGN-2026-06-19.md` (full rationale + evidence) · [[prefreeze-security-blocker]] (memory) · [[sqlcipher-collapse-decision]].
**Release target:** `bc85157` (origin/main, post-collapse). **Branch/PR:** `security/pre-freeze-at-rest-design` → **PR #341** (design + the CRITICAL fix).

## TL;DR — status
| # | item | status |
|---|---|---|
| 1 | 🔴 CRITICAL — plaintext-at-rest on the self-host path | ✅ **FIXED** (`10a8f1a`, PR #341, CI verifying) — verify:at-rest-default 10/10 GO local |
| 2 | 🔴 HIGH — vault-bridge :8099 unauth SQL oracle | ⏳ TODO (clean-room) |
| 3 | 🟠 MED-HIGH — import accepts arbitrary local paths | ⏳ TODO (clean-room) |
| 4 | 🟠 scrubs — /Users paths in KEEP files + exploit doc + email + .gitignore | ⏳ TODO (mechanical) |
| — | operator: clone-migration smoke + app rebuild/relaunch for #1 | ⏳ before merge / to go live |

## #1 CRITICAL — DONE (what shipped, how to verify)
**The fix (≈25 LOC + a gate):** content lost its field envelope in the collapse, so whole-file SQLCipher must be the DEFAULT for the real vault — not opt-in on `node src/index.js` / `cargo tauri dev`.
- `src/db/open.js` — new `atRestDefaultOn(dbPath)`: true iff `dbPath` is the canonical vault (`=== resolveDbPath()`, honors `MYCELIUM_DB`). **Design D5 intact** — canonical-scoped, so the ~104 verify gates (non-canonical temp fixtures) keep opening plaintext.
- `src/index.js` (boot, ~line 121) — opt the canonical entry point in (`if (atRestDefaultOn(dbPath) && !atRestEnabled()) process.env.MYCELIUM_AT_REST='1'`) → fresh canonical vault born encrypted, existing plaintext migrates (existing cross-process-locked machinery). **+ fail-closed belt:** refuse to open the canonical vault unkeyed.
- `scripts/verify-at-rest-default.mjs` (in the CI chain after `verify:at-rest`) — proves born-encrypted-w/o-flag + migrate + fail-closed predicate + non-canonical-stays-plaintext.

**Pre-merge operator smoke (do NOT skip — touches boot):** on a COPY of a real plaintext vault, run `node src/index.js` with `MYCELIUM_DB=<clone>` and confirm: (a) the clone migrates to ciphertext (header not `SQLite format 3`), (b) reads still work, (c) `.pre-cipher` backup is purged only after the keyed re-open verifies. The gate proves the logic on synthetic vaults; this proves it on real data shape/size.
**To go live:** rebuild app from main after #341 merges + relaunch (auto-unlocks from Keychain). The installed packaged app is ALREADY safe (sets the flag); this fix is for self-hosters + dev.

## #2 HIGH — vault-bridge :8099 (bash-it-out)
`pipeline/vault-bridge.js` serves arbitrary SQL on `127.0.0.1:8099` gated only by `isTrustedLoopback` (same-host ≠ same-user). It holds BOTH userKey + systemKey (line ~96) → full decrypted-vault read.
**Fix:** per-boot shared secret — parent (the spawner: jobs.js / run-clustering.sh / index.js that launches the bridge) generates a random token, passes it via env (`MYCELIUM_BRIDGE_TOKEN`), bridge requires it as a header on every request (reject 401 otherwise); AND bind a random ephemeral port (or a `0600` unix socket) instead of fixed 8099, passing the chosen port back to the parent. Add `verify:bridge-auth` (proxied/no-token → rejected; correct token → 200). Files: `pipeline/vault-bridge.js` (server), `pipeline/d1_client.py` (client adds the header), the spawner(s). ~30–50 LOC.

## #3 MED-HIGH — import path confinement (bash-it-out)
`/import/{obsidian,full-export,claude-code}` (in `src/portal-uploads.js` / `src/ingest/run-import.js`) take any absolute server-local path (owner-gated). Confused-deputy / stolen-Bearer risk.
**Fix:** resolve the requested path with `fs.realpathSync` and require it to be a prefix of an allowed root (the `detect-sources` allowlist roots — `src/streams/source-registry.js`); reject (400) anything escaping. Add a `verify:import-security` assertion (a `../` / absolute-outside path is refused). ~15–30 LOC.

## #4 scrubs (mechanical, ~15 min)
- Genericize `/Users/altus` → e.g. `~`/`<repo>` in **`.claude/skills/pre-deletion-caller-audit/SKILL.md`** + **`tools/memory-bridge/openclaw/README.md`** (KEEP files).
- Delete the exploit doc **`SECURITY-FOLLOWUP-KEY-IN-ENV*`** (confirm no sibling exploit docs survive the dated-doc cleanup).
- Remove **`martin@hi.mycelium.id`** from the handoff doc that carries it (Phase-2 archive may drop it — confirm).
- **`.gitignore`**: add `/.claude/memory/`, `MEMORY.md`, `_*.mjs` (and confirm `data/`, `*.db`) so personal memory/scratch never ships in a public clone.

## Pickup protocol
1. Read `docs/PRE-FREEZE-SECURITY-DESIGN-2026-06-19.md` + this handoff cold.
2. Confirm #341 CI is green (the CRITICAL fix). If merged, branch off the new main.
3. Do the operator clone-migration smoke for #1 before relying on it live.
4. #2 + #3 as clean-room patches (each + a verify gate); #4 scrubs. One PR or stacked — your call.
5. Re-run the full red-team on the patched target before tagging the freeze.

## Gotchas
- The bare worktree has **no python venv** → ~13 metric/compute verify gates crash locally (NOT regressions; CI authoritative). Run the **node-only** gates locally + push for CI.
- `node_modules` is symlinked from the main tree.
- Disk is tight (~6.8G free after the app rebuild; 17G cargo target). Watch it before another build.
- The main working tree is contested by concurrent sessions — work in a worktree off `origin/main`, commit/push early.

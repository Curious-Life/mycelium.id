# Handoff — Account setup + Generate-works-locally (2026-06-02)

A fresh session can pick up from here. Two large bodies of work landed on **main**
this session; the app currently runs in a **throwaway test state** (see "Machine
state" — the real vault is backed up aside and must be restored when done).

---

## TL;DR — what landed on `main`

1. **Account setup + single recovery key + durable data** — PR **#36** (merged,
   squash `7189875`). First-run ceremony, one saveable recovery key, vault moved
   out of the bundle so updates don't wipe it.
2. **Generate works locally, end-to-end** — PR **#40** (merged, squash `09428ef`).
   Imports now auto-embed; `cluster.py` no longer needs the MYA Worker; failures
   are honest. Built with the **sweep-first-design** protocol — design doc:
   `docs/DESIGN-generate-robustness-and-save-ux-2026-06-02.md` (verification table).

`npm run verify` = **30 GO**. Generate confirmed live in the app: import →
auto-embed (132/132) → `step 1→5, Complete` → mindscape with 132 nodes.

PR **#32** (the original import-fixes/worker-removal) is **superseded** but its
close hit a GitHub API rate limit — **still needs closing**.

---

## What we did

### A. Account setup (#36)
- `src/paths.js` — single source of truth for the data dir. Vault → per-OS
  app-data dir (`~/Library/Application Support/id.mycelium.app/`); Tauri passes
  `MYCELIUM_DATA_DIR`. `ensureDataDir()` in `server-rest.js` relocates a legacy
  `./data` vault non-destructively.
- `src/account/keystore.js` + `keychain-names.js` — generate/derive/store keys.
  **One recovery key = USER_MASTER**; `SYSTEM_KEY = HKDF(USER_MASTER)`. Both
  written to Keychain (boot path unchanged).
- Setup-mode boot (`server-rest.js`) + `src/account/router.js` —
  `/api/v1/account/{status,setup,restore,recovery-key,recovery-key/save}`.
- First-run UI `portal-app/src/routes/setup/+page.svelte` (create / reveal+save /
  restore) + root-layout gate; Settings → Recovery Key.
- Docs: `docs/ACCOUNT-AND-DATA.md`.

### B. Generate robustness + local pipeline port (#40)
- **Auto-embed**: `src-tauri/src/main.rs` spawns the ONNX embed service (`:8091`)
  from `pipeline/.venv` (skips if already up, killed on exit). `src/enrich/
  drainer.js` embeds imports in-process (boot/timer/nudge), **health-gated**,
  **self-heals** non-content failures, and `drainOnce` (`src/enrich/service.js`)
  embeds in **chunks of 12** so long-message batches never exceed the 30 s client
  timeout. `processing-status` endpoint added.
- **Honest failures**: preflight in `src/portal-mindscape.js` (`/mycelium/generate`
  returns 409 "N of M ready" instead of a doomed run); `src/jobs.js` captures the
  pipeline's stderr and surfaces the last line.
- **Local pipeline port** (the missing half of #32 that #34 never brought):
  `pipeline/cluster.py` off the Worker + `local_db.py`, `local-write-bridge.js`,
  `d1_client.py`, `crypto_local.py`, `stage_base.py`, `era_skip.py`,
  `event_emit.py`, `harmonics.py`. `describe-clusters.js` **and**
  `describe-chronicles.js` get the HKDF `loadKey` fix (no more "deriveBits"
  content-decrypt errors). `run-clustering.sh` exports `MINDSCAPE_OWNER_ID`.
  `requirements.txt` += `cryptography>=42`.
- **Transparent save + loading fix**: save buttons open Keychain Access / 1Password
  and show a clear confirmation; entering the vault after setup no longer sticks
  on "Loading…".

---

## Machine state RIGHT NOW (important)

The app is running in a **throwaway test instance** so first-run could be tested:
- Launched via `cargo tauri dev` with **ephemeral Keychain names**
  `MYCELIUM_KC_ACCOUNT=mycelium-firsttest`, `…KC_USER=mycelium-firsttest-user`,
  `…KC_SYSTEM=mycelium-firsttest-system`. Background task id was `bmqf6n8bf`.
- The app-data dir (`~/Library/Application Support/id.mycelium.app/`) holds a
  **throwaway test vault** (132 imported+embedded messages, generated mindscape).
- **The user's REAL vault is backed up** at
  `~/Library/Application Support/id.mycelium.app.realvault-bak-20260602-135251`,
  and the **real Keychain keys** (`mycelium-user-master`/`mycelium-system-key`)
  are **untouched**.

### Restore the real vault (do this when testing is done)
```bash
# stop the test app + its embed service
pkill -f 'tauri dev'; pkill -f 'target/debug/mycelium'; pkill -f 'src/server-rest.js'
lsof -ti tcp:8787 | xargs kill 2>/dev/null; lsof -ti tcp:8091 | xargs kill 2>/dev/null
# remove the throwaway test vault + ephemeral test keys
rm -rf "$HOME/Library/Application Support/id.mycelium.app"
security delete-generic-password -a mycelium-firsttest -s mycelium-firsttest-user 2>/dev/null
security delete-generic-password -a mycelium-firsttest -s mycelium-firsttest-system 2>/dev/null
# move the real vault back
mv "$HOME/Library/Application Support/id.mycelium.app.realvault-bak-20260602-135251" \
   "$HOME/Library/Application Support/id.mycelium.app"
# relaunch normally (real keychain keys, no firsttest env):
cd ~/mycelium.id/src-tauri && MYCELIUM_HOME="$(cd .. && pwd)" MYCELIUM_KEY_SOURCE=keychain cargo tauri dev
```

Repo checkout is on branch **`claude/generate-robustness`** (its remote was
deleted on merge; the local branch + working tree remain — the running app uses
this tree). `git checkout main` (after stopping the app) once convenient; note
the local `main` ref is slightly behind `origin/main` (a worktree lock blocked the
fast-forward — cosmetic; `origin/main` is authoritative).

---

## How it works now (architecture)

- **Launch** (`src-tauri/src/main.rs`): spawns `node src/server-rest.js` (port 8787)
  **and** the embed service (`pipeline/.venv/bin/python3 pipeline/embed-service.py
  --serve --port 8091`, skipped if `:8091` already up); both killed on window close.
  Env: `MYCELIUM_DATA_DIR=app_data_dir`, `MYCELIUM_KEY_SOURCE=keychain`.
- **Keys**: read from the macOS Keychain (`mycelium-user-master` +
  `mycelium-system-key`). One recovery key = USER_MASTER; SYSTEM_KEY derived.
- **Embedding**: import → `enqueueEnrichment` nudge + the in-process drainer →
  `:8091` (ONNX nomic-v1.5, ~170 MB quantized model) → `embedding_768`.
- **Generate**: `POST /api/v1/portal/mycelium/generate` → preflight (counts
  embedded) → `jobs.js` spawns `pipeline/run-clustering.sh` (5 local stages: sync →
  cluster → describe → cofire → harmonics) → poll `…/generate/status/:id`.

---

## What's next / follow-ups

1. **Restore the real vault** (above) — the user has been testing on a throwaway.
2. **Close PR #32** (rate-limited): `gh pr close 32 --repo Curious-Life/mycelium.id`.
3. **Territory names are placeholders** — `describe-clusters.js` needs the `claude`
   CLI invocable (`CLAUDE_BIN`) for real names; not installed on this machine.
4. **Chronicle narration is empty** — `describe-chronicles.js` needs a local model
   (Ollama, or the `claude` CLI); fail-soft today.
5. **Fresh-user clustering deps**: `pipeline/setup.sh` installs only
   `requirements-embed.txt` (embed deps). The clustering deps in `requirements.txt`
   (faiss, leidenalg, igraph, ripser, cryptography…) must be installed separately
   (`pipeline/.venv/bin/pip install -r pipeline/requirements.txt`). This machine's
   venv has them; a fresh user's would NOT → Generate Stage 2 would fail. Fix:
   have `setup.sh` (or the app) install both, or document it.
6. **Scale re-test**: current vault is the small 132-msg re-import; re-import the
   full Claude export through the UI and re-run Generate to validate at scale
   (embedding is CPU-model-bound, ~0.8 long-msgs/sec → minutes for 11k).
7. **Cleanup**: stop the test app; delete the local `claude/generate-robustness`
   and `claude/import-fixes` branches once #32 is closed.

---

## Run / verify recipe

```bash
cd ~/mycelium.id
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
MYCELIUM_KEY_SOURCE=keychain npm run verify         # 30 GO
# real pipeline against a vault (keys from Keychain), e.g. manual:
UM=$(security find-generic-password -s mycelium-user-master -a mycelium -w)
SK=$(security find-generic-password -s mycelium-system-key  -a mycelium -w)
USER_MASTER="$UM" SYSTEM_KEY="$SK" \
  MYCELIUM_DB="$HOME/Library/Application Support/id.mycelium.app/mycelium.db" \
  MYCELIUM_USER_ID=local-user bash pipeline/run-clustering.sh
```

Key new verify: `npm run verify:account` (setup/restore, isolated) and the
extended `npm run verify:generate` (G0 preflight + G4 real-error surfacing).

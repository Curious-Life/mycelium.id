# Universal Memory Layer — Handoff Doc

**Date:** 2026-06-15
**Companions:** [design (depth + verification table rows 1-17 + §12 adapter specs)](UNIVERSAL-MEMORY-LAYER-DESIGN-2026-06-11.md) · [HARNESS-RECIPES.md](HARNESS-RECIPES.md) · [CONNECT-YOUR-AI.md](CONNECT-YOUR-AI.md)
**Audience:** the next Claude Code instance.
**Status:** ✅ SHIPPED — merged to `main` via PR #163 + #164. Activation in the user's harness is the only remaining step (operator action).

> ⚠️ **Lesson (2026-06-15):** the first version of THIS handoff was written untracked and got wiped by a concurrent `git checkout`/clean across the multi-worktree setup. **Commit handoffs** — don't leave them untracked. This recreated copy is on disk; commit it in the next docs PR.

---

## TL;DR

| PR | merge commit | what |
|---|---|---|
| [#163](https://github.com/Curious-Life/mycelium.id/pull/163) | `e75a5de` | contract (`/context`+`/ingest/message`) + gateway capture tier + 4 native adapters + 2 verify gates + design doc |
| [#164](https://github.com/Curious-Life/mycelium.id/pull/164) | `ab83547` | `/context` base-first + time-bounded search slice; bridge timeout 4s→8s; CONNECT-YOUR-AI auto-capture section |

Gates GREEN: `verify:memory-bridge` (17/17), `verify:memory-adapters` (10/10), `verify:harness-connect` (8/8); no regression in `verify:gateway`/`verify:ingest`. CI `verify` passed on both PRs. Live-verified vs the real vault: `on-prompt` injects ~3.3k chars, `on-stop` captures both sides.

## What's built (all on `main`)
- **Contract:** `POST /context` (pull) + `POST /ingest/message` (push) — Bearer-guarded `:4711`.
- **Gateway tier:** opt-in `X-Mycelium-Capture` header on `/v1/chat/completions` → inject getContext system preamble + capture last user turn + assistant reply (stream + non-stream). Default-off.
- **Native adapters** (`tools/memory-bridge/`): Claude Code (`UserPromptSubmit`+`Stop`), hermes (`pre/post_llm_call`), opencode (`experimental.chat.system.transform`+`chat.message`/`event`), openclaw (`before_prompt_build`+`llm_output`). Each code-verified against the real harness repo; TS wrappers typecheck clean.

## Activate the live Claude Code hooks (OPERATOR — pending)
Hooks are wired in `.claude/settings.local.json` (gitignored). They point at `tools/memory-bridge/claude-code/on-*.mjs`, which only exist on branches containing the merge.
1. Get the code into the working tree: `git merge origin/main` (the working checkout is on `feat/narration-overhaul`, which lacks `tools/memory-bridge/`).
2. Start `:4711`: `export MYCELIUM_MCP_BEARER=$(openssl rand -hex 32); export MYCELIUM_KEY_SOURCE=keychain; export MYCELIUM_DATA_DIR="$HOME/Library/Application Support/id.mycelium.app"; npm run start:http` (keep running).
3. Export the **same** `MYCELIUM_MCP_BEARER` in the shell that launches `claude` (hooks inherit it; `MYCELIUM_BASE_URL` defaults to `http://127.0.0.1:4711`).
4. Restart Claude Code → hooks active. Verify: `getContext`/portal shows new messages tagged `source:claude-code`.

## Gotchas + open items (dated)
- **2026-06-15** Per-turn inject latency ~6s on the 164 MB vault (mostly `getContext` + node cold-start). Under the 15s hook budget; tuning knobs: drop the search slice, or cache getContext briefly.
- **2026-06-15** `[DECRYPT ERROR] field="text"` rows during `searchMindscape` — **pre-existing** vault issue (likely the known 3-scope import merge), NOT the memory layer. Flagged as a separate task.
- **2026-06-15** Working tree is a **multi-worktree** setup (`~/Documents/GitHub/mycelium-worktrees/`); the main checkout rides `feat/narration-overhaul`. Don't assume a branch — verify with `git -C <path> branch --show-current`.
- **2026-06-15** An unrelated **at-rest-encryption** effort is uncommitted in the main checkout (`keystore.js`, `adapter/d1.js`, `db/index.js`, `better-sqlite3-multiple-ciphers` in package.json, `AT-REST-BLINDNESS` design). Not on `main`. Don't entangle.

## Deferred (not blocking)
- Portal harness-picker auto-capture note (needs portal browser-verify — `verify:harness-connect` covers parity but not the new note).
- opencode/openclaw `index.ts` wrappers compile against host SDKs at install (typechecked clean against the cloned repos; not built in this repo's CI).
- Gateway live smoke with a real/cheap provider (spends tokens).

## Pickup protocol
1. `git -C ~/Documents/GitHub/mycelium.id log --oneline -3 origin/main` → should show `ab83547`, `e75a5de`.
2. Read the [design doc](UNIVERSAL-MEMORY-LAYER-DESIGN-2026-06-11.md) §0/§11/§12.
3. Re-run gates: `npm run verify:memory-bridge`, `npm run verify:memory-adapters` (needs python3), `npm run verify:harness-connect`.
4. If activation still pending → run the 4 operator steps above.
5. Commit this handoff (it was lost once as untracked).

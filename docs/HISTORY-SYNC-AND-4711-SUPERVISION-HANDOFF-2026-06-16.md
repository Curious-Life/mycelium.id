# History sync + :4711 supervision — handoff (2026-06-16)

## TL;DR

Two durability fixes so Claude Code (and any bridge-connected harness) history keeps
syncing into the vault without babysitting:

1. **`:4711` is now supervised + heap-capped** (`src-tauri/src/main.rs`). The remote
   MCP/OAuth server — which is *also the local capture surface the memory bridge posts
   to* — was spawned fire-and-forget with **no heap cap and no restart**. A large
   history backfill OOM'd it; it died and stayed dead until the app was relaunched,
   silently killing capture. Now a dedicated supervisor thread respawns it with capped
   exponential backoff, and it gets the same 4GB `NODE_OPTIONS` heap `:8787` already
   had. Shutdown stays clean: `reap()` flips a `shutting_down` flag and group-kills the
   live pid before draining the other children.

2. **A periodic history sync** (`scripts/sync-claude-history.mjs` + a launchd agent via
   `scripts/install-history-sync.sh`). The live `Stop` hook only covers the *current*
   session; this is the safety net that finishes any backlog, re-syncs anything missed
   while `:4711` was down, and covers hookless sessions. Incremental (per-file
   mtime+size stat-skip and a line high-water mark), idempotent (dedup on transcript
   uuid), and **fail-soft**: if `:4711` is down it defers and exits 0 (retries next
   interval) without advancing state.

## Why it was broken

`:4711` crashed (OOM, ~6.5k/17.7k into the manual backfill). It has no auto-restart
(unlike embed-service, which a JS supervisor restarts), so capture stayed dead. This
was misread as "Anthropic blocking the MCP connector" — but the stdio MCP is a local
process and was fine; only the HTTP `:4711` capture port was down.

## What shipped (branch `feat/history-sync-4711-supervision`, PR TBD)

- `src-tauri/src/main.rs` — supervisor thread for `:4711` + 4GB heap; `Server` gains
  `shutting_down: Arc<AtomicBool>` + `http_pid: Arc<Mutex<Option<u32>>>`; `reap()`
  stops the supervisor and group-kills the supervised pid. `cargo check` clean.
- `scripts/sync-claude-history.mjs` — incremental/idempotent/fail-soft sync.
- `scripts/install-history-sync.sh` — installs the launchd agent (`id.mycelium.history-sync`,
  every 30 min, `ProcessType=Background`+`LowPriorityIO`). Self-contained runtime under
  `~/.mycelium-bridge/runtime/`; bearer supplied via the chmod-600 plist env (it's an
  API token, already at rest in `auth.db`; same trust boundary on a single-user box).
- `scripts/verify-history-sync.mjs` + `npm run verify:history-sync` — **GO** (H1–H5:
  fresh import, stat-skip, incremental append, app-down defer, app-back resume).

## Pickup protocol / operator steps

1. **Now (no rebuild needed):** relaunch the Mycelium app → `:4711` comes back (current
   bundle, still unsupervised but the paced sync won't re-OOM it). Then
   `bash scripts/install-history-sync.sh` to load the agent; `launchctl kickstart -k
   gui/$(id -u)/id.mycelium.history-sync` to finish the backlog immediately. Tail
   `~/.mycelium-bridge/sync.log`.
2. **Next app build** ships the `:4711` supervision + heap cap — after that, a crash
   self-heals with no relaunch. (`cargo tauri build`.)
3. The manual one-shot `scripts/backfill-claude-code.mjs` (#190, paced) is still there
   for an explicit full catch-up; the periodic sync supersedes it for steady state.

## Gotchas

- The app **bundle does not package `scripts/` or `tools/`** — that's why the launchd
  agent uses a self-contained `~/.mycelium-bridge/runtime/` copy, not a bundle path.
- HWM persists `lastLine - 1` (one-line overlap) so a partial trailing line in a *live*
  transcript is re-read, not skipped; the re-read dedups by uuid.
- Worktree `cargo check` needs `src-tauri/binaries/{frpc,caddy}-*` and a `build-staging/`
  dir to exist (resource-path validation in the Tauri build script) — symlink/stub from
  the main checkout; both are gitignored.

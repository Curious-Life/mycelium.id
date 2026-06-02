# Mycelium V1 — MCP Connection: How It Works, Code Review, & Test Plan

**Date:** 2026-06-02
**Audience:** the operator (connecting + testing on a Mac) + the next Claude Code instance.
**Companions:** [`SETUP.md`](SETUP.md) (install + Claude Desktop config), [`ARCHITECTURE.md`](ARCHITECTURE.md).

This is the full walkthrough of how a client connects to the Mycelium MCP server,
a code review of that path (built / lacking / findings), and a concrete plan to
connect your local server to Claude and exercise the tools.

---

## 1. How the connection works — every step

Two transports, both calling the **same** `boot()` (`src/index.js:9`), so the tool
surface is identical. Claude **Desktop** uses stdio; remote clients use HTTP+OAuth.
A third (REST) reuses the same handler map for local, auth-free testing.

### Path A — stdio (Claude Desktop)

```
Claude Desktop ──spawns──▶ node src/index.js   (stdin/stdout JSON-RPC, no network)
```

1. Claude Desktop reads `claude_desktop_config.json` → launches `node src/index.js`
   with `MYCELIUM_KEY_SOURCE=keychain` in env (`SETUP.md:159`).
2. `startStdio()` (`index.js:80`) → `boot()` (`index.js:32`):
   - `resolveKeys()` reads the two hex keys from the Keychain (env/keychain/1password —
     `key-source.js:88`). Those keys are created by the app's first-run `/setup` ceremony or
     `npm run set-keys`: as of #36 the user saves **one** recovery key (USER_MASTER) and
     SYSTEM_KEY is HKDF-derived from it (`src/account/keystore.js`); both are still in the
     Keychain, so this boot path is unchanged.
   - `unlock()` per-key KCV check, **fail-closed**; wrong/missing key → throw → exit (`keys.js:27-52`).
   - pin `ENCRYPTION_MASTER_KEY` (`index.js:69`); open encrypting SQLite (`index.js:70`).
   - `buildDomains()` → **31 tools / 10 domains** (`mcp.js:52-117`); `collectTools()` flattens
     with a duplicate-name guard (`mcp.js:123`); `createMcpServer()` wires the low-level
     `Server` + `ListTools`/`CallTool` handlers (`mcp.js:140`).
3. `new StdioServerTransport()` → `server.connect()` (`index.js:84`). Logs go to **stderr**
   only (`index.js:82`) so they never corrupt the stdout protocol stream.
4. Handshake: `initialize` → `capabilities:{tools:{}}` (`mcp.js:143`) → `notifications/initialized`.
5. `tools/list` → 31 tools with **JSON-Schema** `inputSchema` (`mcp.js:146`).
6. `tools/call {name,arguments}` → `handlers[name](args)` returns a **string** → wrapped
   `{content:[{type:'text',text}]}` (`mcp.js:148-158`). Unknown tool / throw → `isError:true`
   with a **redacted** message (`mcp.js:159-178`).
7. On quit, Claude Desktop kills the child; the process exits and the db closes.

**Proven:** `npm run verify:mcp` (real MCP `Client` over in-memory transport: list +
`createTask`→`listTasks` + unknown-tool). GO.

### Path B — Streamable HTTP + OAuth 2.1 (remote clients)

`npm run start:http` → `src/server-http.js`. Full dance (proven by `npm run verify:oauth`):

```
discovery (/.well-known/oauth-*) → DCR (PKCE, public client, no secret)
 → sign-in (operator email+password → cookie) → authorize (PKCE-S256 + cookie → code)
 → token (code + verifier → access_token) → POST /mcp initialize (Bearer)
 → mcp-session-id → notifications/initialized → tools/list → tools/call → DELETE (evict)
```

- Every `/mcp` request is Bearer-guarded via better-auth `getMcpSession`; no/invalid →
  **401 + `WWW-Authenticate`** → protected-resource metadata (RFC 9728, fail-closed —
  `server-http.js:100-125`).
- **Stateful**, keyed by `mcp-session-id`: an `initialize` POST creates one transport +
  one fresh `boot()` (own vault db) per session, stored in a Map; later requests route to
  it; close/DELETE/failed-init evicts + tears down the db (`server-http.js:127-167`).
- Auth DB is **separate** from the vault (`auth.js:10-13`); `MYCELIUM_AUTH_SECRET` mandatory,
  fail-closed (`auth.js:32`).
- Also exposes Bearer-guarded `/ingest/{message,upload,import}` over the same token.

### Path C — REST (localhost, no auth, by design) — the fast test loop

`npm run portal` mounts `apiRouter` (`src/api.js`): `GET /api/v1/tools` lists tools;
`POST /api/v1/:toolName` invokes the **same handler map** the MCP server uses
(`api.js:86-124`). No MCP framing, no OAuth — ideal for `curl`. If a tool works here it
works in Claude (same handlers).

---

## 2. Built vs lacking

| Capability | State | Evidence |
|---|---|---|
| stdio MCP (Claude Desktop) | ✅ Built + proven | `verify:mcp` GO |
| 31 tools, JSON-Schema, string→content seam | ✅ Built | `mcp.js:123-178` |
| HTTP + OAuth 2.1 (DCR, PKCE, Bearer, stateful sessions) | ✅ Built + proven e2e | `verify:oauth` GO |
| Auth ingestion routes (`/ingest/*`) | ✅ Built + proven | `verify-oauth.mjs:294-344` |
| Per-session isolation + db teardown | ✅ Built | `server-http.js:140-167` |
| Error redaction (no plaintext leak) | ✅ Both paths | `mcp.js:170-177`, `api.js:113-122` |
| Claude Desktop config docs | ✅ | `SETUP.md:154-178` |
| Tool failure diagnostics | ✅ (opt-in `MYCELIUM_DEBUG=1`, stderr-only) | `mcp.js:159-167` |
| Tier-2 tools (fisher/metrics/health/semantic) | ⚠️ Empty until clustering+embeddings run | §4 below |
| Remote-exposure hardening | ⚠️ DCR open — only behind Tailscale/Tunnel | `auth.js:58` |

**The 31 tools, by data-readiness:**
- **Work on a fresh vault (~19):** `getContext`, `captureMessage`, `importMessages`,
  `createTask`, `listTasks`, `getDailyMessages`, all documents
  (`saveDocument`/`getDocument`/`listDocuments`/`updateDocument`/`getDocumentShareStatus`),
  all mind-files (`updateInternalModel`, `flagForDiscussion`, `snapshotMindFile`,
  `readMindFile`, `editMindFile`, `writeMindFileWhole`), topology reads
  (`mindscapeStructure`, `listTerritories`, `exploreTerritory`, `territoryDetail`, `timeView`
  — honest-empty), `searchMindscape` (BM25 fallback when embedder down).
- **"No data yet" until import + cluster + embed (~10):** `getHealthData`, `getCurrentPhase`,
  `getTrajectoryHistory`, `getActiveMilestones`, `getTopMovers`, `getHarmonicState`,
  `getMetricSeries`, semantic ranking in `searchMindscape`, `findDocuments`. **Not bugs.**
- **Throws without Tier-2:** `publishDocument` (needs the public renderer).

---

## 3. Code review — findings

The crypto/auth boundary is sound (KCV fail-closed, keys never logged/HTTP/argv, fresh IV
per encrypt — verified in the 2026-06-02 key-lifecycle sweep). MCP-specific:

**Correct & good**
- Low-level `Server` + JSON-Schema pass-through + string→content wrap is the right choice
  (`McpServer.tool()` wants Zod; these handlers are plain JSON-Schema). `mcp.js:1-11`.
- Both transports redact errors identically; unknown tool fails closed.
- HTTP isolates a vault db per session + tears it down on close/DELETE/failed-init — no leak.
- stdio writes only to stderr — no protocol corruption.

**Findings (ranked)**
1. **MEDIUM (FIXED 2026-06-02) — tool failures were undiagnosable.** A handler throw returned
   a redacted string with nothing logged. Now, with `MYCELIUM_DEBUG=1`, the real stack is
   written to **stderr only** (never stdout/the client) — `mcp.js:159-167`. Off by default
   (an error can embed user content; stderr goes to the operator's own machine).
2. **LOW — per-session `boot()` cost on HTTP.** Each `initialize` re-runs `resolveKeys()`
   (shells out to `security`/`op`) + `unlock()` + opens SQLite (`server-http.js:140`). Fine
   normally; a reconnect storm = many keychain shell-outs. Single-user, acceptable.
3. **LOW — `process.env.ENCRYPTION_MASTER_KEY` is process-global**, set on every `boot()`
   (`index.js:69`). Harmless in single-user V1 (same key); a cross-tenant hazard if this ever
   goes multi-user. Flag for V2.
4. **INFO — DCR is open** (`auth.js:58`): anyone reaching the HTTP server can *register* a
   client, but `authorize` still requires the operator's signed-in cookie (email+password) —
   the password is the real gate. **Run `--http` only behind Tailscale/Cloudflare Tunnel**,
   with a strong `MYCELIUM_USER_PASSWORD`. `storeClientSecret:'plain'` (`auth.js:60`) is fine
   for public PKCE clients (no secret).
5. **MEDIUM — stdio MCP must point at the same data dir the app created** (#36 interaction).
   The vault now lives in the durable per-OS data dir, resolved by `src/paths.js` from
   `MYCELIUM_DATA_DIR` (set by the Tauri shell, `src-tauri/src/main.rs`). A hand-rolled Claude
   Desktop config that runs `node src/index.js` **without** `MYCELIUM_DATA_DIR` falls back to
   the legacy `./data` (`paths.js dataDir()`), opening a **different, empty** vault than the
   app's. Symptom: tools connect fine but `getContext`/`searchMindscape` return nothing.
   **Fix: set `MYCELIUM_DATA_DIR` in the config `env` (Stage 2).** This is the most likely
   "connected but sees no data" gotcha after #36.

None are blockers.

---

## 4. Test plan — connect to Claude + exercise the tools

### Stage 0 — Pre-flight (terminal)
```bash
cd ~/mycelium.id
npm install
npm run set-keys                # generates your ONE recovery key (USER_MASTER);
                                # SYSTEM_KEY is derived (HKDF) + both stored in
                                # Keychain. Refuses to clobber existing keys
                                # without --force. (Or use the app's first-run
                                # /setup screen — same keystore.)
npm run verify                  # expect ~29× VERDICT: GO  (ground truth)
npm run verify:mcp              # stdio MCP proof in isolation
```
No `init-db` step: a fresh vault **self-migrates on first boot** (`server-rest.js
ensureVaultSchema`). The vault now lives in the **durable per-OS data dir**
(`~/Library/Application Support/id.mycelium.app` on macOS — see
`docs/ACCOUNT-AND-DATA.md`), so app updates don't wipe it.
**Pass:** verify all-GO. If `verify:mcp` fails, stop — Claude Desktop won't work either.

### Stage 1 — Fastest tool loop: REST (no Claude Desktop yet)
```bash
MYCELIUM_KEY_SOURCE=keychain npm run portal      # REST at http://127.0.0.1:8787
# another shell:
curl -s localhost:8787/api/v1/tools | jq '.tools[].name'                    # → 31 names
curl -s localhost:8787/api/v1/getContext -H 'content-type: application/json' -d '{}' | jq
curl -s localhost:8787/api/v1/captureMessage -H 'content-type: application/json' \
     -d '{"content":"first test thought","source":"curl"}' | jq
curl -s localhost:8787/api/v1/listTasks -H 'content-type: application/json' -d '{}' | jq
curl -s localhost:8787/api/v1/searchMindscape -H 'content-type: application/json' \
     -d '{"query":"thought"}' | jq
```
Same handlers Claude calls — iterate here first.

### Stage 2 — Connect to Claude Desktop (stdio)
1. Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
       "mycelium": {
         "command": "node",
         "args": ["src/index.js"],
         "cwd": "/Users/YOUR_USERNAME/mycelium.id",
         "env": {
           "MYCELIUM_KEY_SOURCE": "keychain",
           "MYCELIUM_DATA_DIR": "/Users/YOUR_USERNAME/Library/Application Support/id.mycelium.app",
           "MYCELIUM_DEBUG": "1"
         }
       }
     }
   }
   ```
   **⚠️ `MYCELIUM_DATA_DIR` is the critical line** (see finding #5): after #36 the
   app keeps your vault in the per-OS app-data dir. The Tauri shell sets this env
   automatically, but a hand-rolled Claude Desktop config does **not** — without
   it, `node src/index.js` falls back to the legacy `./data` and opens a *different,
   empty* vault, so `getContext`/`searchMindscape` see nothing. Point it at the
   same dir the app created. (`MYCELIUM_DEBUG=1` surfaces tool errors in the log.)
2. **Fully quit and reopen** Claude Desktop (not just the window).
3. Confirm: the tools icon shows **mycelium / 31 tools**. If not, tail the log:
   ```bash
   tail -f ~/Library/Logs/Claude/mcp-server-mycelium.log
   ```
   Common failures: wrong `cwd`/`MYCELIUM_DATA_DIR`, `node` not on Claude's PATH,
   Keychain prompt blocking, KCV mismatch — all print here.

### Stage 3 — Exercise tools in Claude Desktop
| Prompt to Claude | Tool | Expect |
|---|---|---|
| "Pull my context." | `getContext` | date + empty-but-valid preamble |
| "Save this: *\<a thought\>*." | `captureMessage` | confirmation |
| "Make a task: buy milk." then "List my tasks." | `createTask`→`listTasks` | the task appears |
| "Search my mind for *milk*." | `searchMindscape` | BM25 hit on the saved msg |
| "Write a doc at notes/test = 'hello'." then "Read notes/test." | `saveDocument`→`getDocument` | round-trips |
| "Show my mindscape structure." | `mindscapeStructure` | honest-empty (no clustering yet) |
| "What's my current cognitive phase?" | `getCurrentPhase` | "no data yet" (Tier-2) — **expected** |

### Stage 4 — (optional) HTTP+OAuth path
```bash
MYCELIUM_AUTH_SECRET=$(openssl rand -hex 24) MYCELIUM_USER_PASSWORD='<strong>' \
  MYCELIUM_KEY_SOURCE=keychain npm run start:http
npm run verify:oauth         # drives discovery→DCR→PKCE→Bearer→tools/call end to end
```
Expose only via Tailscale/Tunnel (finding #4).

### "Done" looks like
31 tools visible in Claude Desktop; the ~19 fresh-vault tools return real output; the ~10
Tier-2 tools say "no data yet" cleanly (no errors); a deliberately-broken tool's stack shows
up in the log when `MYCELIUM_DEBUG=1`.

---

## 5. Pickup notes
- Tool inventory + per-tool data-readiness: §2 here + `src/mcp.js:52-117` + `src/tools/*`.
- The two proofs are the source of truth for "does the wire work": `verify:mcp` (stdio),
  `verify:oauth` (HTTP/OAuth). Re-run after any change to `mcp.js`, `index.js`, `server-http.js`.
- Real Tier-2 output (semantic search, fisher, metrics, mindscape) needs the embed service
  (:8091) + clustering — see `SETUP.md:182`. That's the Mac/host surface.

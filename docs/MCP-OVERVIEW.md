# Mycelium V1 — MCP Server Overview

**What it is, how it connects, how it authenticates, the tools it exposes, and how to run and test it locally.**

> As-built, verified against the **running** server (`npm run verify:mcp` → **33 tools, 2 deferred**) and the registration code (`src/mcp.js`), not estimated. Date: 2026-06-02.
> Companions: [`SETUP.md`](SETUP.md) (install + Claude Desktop config) · [`MCP-CONNECT-AND-TEST.md`](MCP-CONNECT-AND-TEST.md) (connection code-review + test plan) · [`ARCHITECTURE.md`](ARCHITECTURE.md) (as-built system).

---

## 1. What it is

Mycelium V1 is a **self-hosted, single-user MCP server** — a private "cognitive vault." All your data (messages, documents, your private internal model, cognitive metrics) lives in **one encrypted SQLite file** (`mycelium.db`) on your own machine. An MCP client (Claude Desktop, or any MCP-capable client) connects to it and calls tools to read and write that vault.

The defining property: **one `boot()` sequence, three transports.** Whether a client connects over stdio, HTTP, or REST, it hits the *same* tool handlers over the *same* vault — so behavior is identical across all of them.

```
            ┌───────────────────────── boot() (src/index.js) ─────────────────────────┐
            │  load 2 hex keys → unlock + KCV (fail-closed) → open encrypting SQLite    │
            │  → buildDomains() → 33 tools → register on low-level MCP Server           │
            └──────────────────────────────────────────────────────────────────────────┘
                 │                          │                              │
          ┌──────┴──────┐          ┌────────┴────────┐            ┌────────┴────────┐
          │   stdio     │          │  HTTP + OAuth   │            │   REST (local)  │
          │ Claude      │          │  remote clients │            │  curl test loop │
          │ Desktop     │          │  :4711  /mcp    │            │  :8787 /api/v1  │
          │ (no network)│          │  Bearer token   │            │  (no auth)      │
          └─────────────┘          └─────────────────┘            └─────────────────┘
```

---

## 2. How it works (boot sequence)

When the server starts (`src/index.js` → `boot()`):

1. **Resolve two keys** from `MYCELIUM_KEY_SOURCE` (`env` | `keychain` | `1password`). You save **one** recovery key (`USER_MASTER`); `SYSTEM_KEY` is HKDF-derived from it. Both end up in the OS keychain.
2. **Unlock + KCV check** — each key is verified against a key-check value. Wrong/missing key → throw → exit. **Fail-closed**: no key, no vault.
3. **Open the encrypting SQLite adapter** — `src/adapter/d1.js` transparently AES-256-GCM-encrypts every field at the query boundary. (It mimics the Cloudflare "D1" API shape but is purely local — zero network.)
4. **`buildDomains()`** (`src/mcp.js:79`) instantiates 12 tool domains; **`collectTools()`** flattens them into 33 tools with a duplicate-name guard.
5. **`createMcpServer()`** registers two handlers: `tools/list` (returns all 31 with JSON-Schema) and `tools/call` (dispatches to the named handler).
6. Each handler returns a **string**, wrapped into the MCP `{content:[{type:'text',text}]}` envelope at one seam. Errors are **redacted** (never leak plaintext); set `MYCELIUM_DEBUG=1` to print the real stack to **stderr only**.

---

## 3. How it connects (transports)

| Transport | Start command | Endpoint / port | Auth | Use it for |
|---|---|---|---|---|
| **stdio** (default) | `node src/index.js` | stdin/stdout JSON-RPC, **no network** | OS keychain keys | **Claude Desktop** |
| **Streamable HTTP + OAuth** | `npm run start:http` (`--http`) | `:4711` → `POST /mcp`, `/.well-known/oauth-*`, `/ingest/*` | **OAuth 2.1 Bearer** | Remote MCP clients (behind a tunnel) |
| **REST** (local, no MCP framing) | `npm run portal` | `:8787` → `GET /api/v1/tools`, `POST /api/v1/:toolName` | **None** (loopback) | Fast `curl` testing |

Two auxiliary servers (not MCP, but part of the system):

| Server | Start | Port | Purpose |
|---|---|---|---|
| **Public publish** | `npm run public` (`--public`) | `:8788` → `/p/:slug` | Serves *only* explicitly published docs (fail-closed) |
| **Enrichment** | `npm run start:enrich` (`--enrich`) | `:8095` → `/enrich-all`, `/health` | Background NLP/embeddings hand-off |
| **Embed service** (Python, external) | `pipeline/embed-service.py` | `:8091` (loopback only) | Nomic v1.5 ONNX embeddings; search **fail-softs to BM25** when it's down |

---

## 4. How it authenticates

**stdio (Claude Desktop)** — No network, no token. Security comes from the **keys**: the vault won't open unless `USER_MASTER`/`SYSTEM_KEY` resolve from your keychain and pass the KCV check. Keys never touch argv, env files, logs, or HTTP.

**HTTP + OAuth 2.1** (`start:http`) — full standards-based dance, proven end-to-end by `npm run verify:oauth`:

```
discovery (/.well-known/oauth-*) → Dynamic Client Registration (PKCE, public client, no secret)
 → sign-in (your email + MYCELIUM_USER_PASSWORD → cookie)
 → authorize (PKCE-S256 + cookie → code) → token (code + verifier → access_token)
 → POST /mcp  initialize  (Authorization: Bearer …)  → mcp-session-id
 → tools/list → tools/call → DELETE (evicts the session + tears down its vault db)
```

- Every `/mcp` request is **Bearer-guarded**; no/invalid token → **401 + `WWW-Authenticate`** pointing at the protected-resource metadata (RFC 9728, fail-closed).
- **Stateful** sessions keyed by `mcp-session-id`; each `initialize` gets its own `boot()` + vault handle, torn down on close.
- The **auth DB (`auth.db`) is separate** from the vault and stores no vault plaintext. `MYCELIUM_AUTH_SECRET` is mandatory (fail-closed).
- ⚠️ DCR is open (anyone reachable can *register* a client), but **`authorize` still requires your password** — that's the real gate. **Only run `--http` behind Tailscale/Cloudflare Tunnel** with a strong `MYCELIUM_USER_PASSWORD`.

**REST** (`portal`) — **No auth, by design.** Binds loopback (`127.0.0.1:8787`). It's the fast local test loop, not for exposure.

---

## 5. What tools it has — 33 tools

`getContext` is the **preamble** (the "D5 entry point"): a client calls it *first* to load a one-shot briefing, then pulls detail on demand. `*` = required param.

### Orientation (1)
| Tool | What it does | Key params |
|---|---|---|
| **getContext** | One-call working-context briefing — **call first**. Returns date/time, your private internal model, flagged items, recent messages, current cognitive phase, recent body-state. | `recentMessages` (1–40, def 10), `include[]` = mind\|messages\|phase\|health |

### Capture & messages (3)
| Tool | What it does | Key params |
|---|---|---|
| **captureMessage** | Save one message into the vault's searchable stream. Idempotent on id. | `content*`, `role`, `source`, `conversationId`, `id` |
| **importMessages** | Bulk-import many messages (history backfill); idempotent per id; returns created vs skipped. | `messages[]*` |
| **getDailyMessages** | Page through one day's messages chronologically (30/page). | `date`, `page`, `channel`, `agent` |

### Tasks (2)
| Tool | What it does | Key params |
|---|---|---|
| **createTask** | Create a task captured from conversation. | `content*`, `deadline`, `priority` (1–5), `projectPath` |
| **listTasks** | List tasks newest-first; filter by status. | `status` (pending\|completed\|all), `limit` |

### Curate — forget & salience (2, new in Phase 1)
| Tool | What it does | Key params |
|---|---|---|
| **forget** | Soft-redact a message/document: destroy content + both embedding fingerprints, evict from search + clustering, tombstone for audit. No undo. | `type` (message\|document), `id` |
| **mark** | Set salience — `pinned` (surfaced first in `getContext`, shown with 📌) and/or `sensitive` (kept out of proactive recall / never published). | `type`, `id`, `pinned`, `sensitive` |

### Documents & library (6)
| Tool | What it does | Key params |
|---|---|---|
| **saveDocument** | Create/revise a doc at a path (path = identity; same path = revision). | `path*`, `content*`, `title`, `summary`, `folder`, `canvas` |
| **updateDocument** | Append a timestamped entry to a living doc. | `path*`, `entry*`, `entryType*`, `confidence*` |
| **getDocument** | Retrieve full doc content by path. | `path*` |
| **listDocuments** | List docs with paths + summaries. | `category` |
| **publishDocument** | Make a doc publicly readable at `/p/` on your portal subdomain (needs the public server). | `path*`, `slug` |
| **getDocumentShareStatus** | Publish/share state: visibility, public URL, visits, readers, share links. | `path*` |

### Private internal model & mind-files (6)
| Tool | What it does | Key params |
|---|---|---|
| **updateInternalModel** | Append to your private model (never shown to user). Sections: observations/hypotheses/questions/contradictions/patterns/uncertainty/notes/dream_fragments. | `section*`, `content*` |
| **flagForDiscussion** | Flag a topic to raise next conversation. | `topic*`, `context*` |
| **readMindFile** | Read decrypted content of a `mind/` file. | `filename*` |
| **editMindFile** | Surgical exact-string edit of a `mind/` file. | `filename*`, `old_string*`, `new_string*` |
| **writeMindFileWhole** | Atomically rewrite a `mind/` file (auto-snapshots prior state). | `filename*`, `content*` |
| **snapshotMindFile** | Atomic dated snapshot of a `mind/` file (first-write-wins). | `filename*` |

### Search (1)
| Tool | What it does | Key params |
|---|---|---|
| **searchMindscape** | One-call search across conversations, documents, territories, realms, themes; grouped results. Semantic when the embedder (:8091) is up, **BM25 fallback** otherwise. | `query*`, `scope`, `limit`, `includeTopology`, `agent` |

### Mindscape topology (5)
| Tool | What it does | Key params |
|---|---|---|
| **mindscapeStructure** | Structural overview: phase distribution, topology health (entropy, Gini), orphan/bridge territories. | `orphans`, `bridges`, `scale` |
| **listTerritories** | List/filter territories by phase/realm/activity. | `phase`, `realm`, `minMessages`, `sortBy`, `limit` |
| **exploreTerritory** | A territory's co-firing neighborhood + unexplored gaps. | `territory*`, `includeCoFiring`, `includeGaps`, `depth`, `scale` |
| **territoryDetail** | Deep view of one territory (essence, story, vitality, timeline, samples). | `territory*` |
| **timeView** | Temporal lens on a territory or whole mindscape (peaks, dormancy, trend). | `territory`, `range` (7d\|30d\|90d\|all) |

### Cognitive metrics — movement & rhythm (6)
| Tool | What it does | Key params |
|---|---|---|
| **getCurrentPhase** | Cognitive **movement** now (stable/cycling/exploring/transforming), velocity, exploration ratio. | `level` |
| **getTrajectoryHistory** | Trajectory over time (phase, velocity, displacement). | `level`, `windowType`, `period`, `from`, `to`, `limit` |
| **getActiveMilestones** | Undismissed milestone alerts (phase shifts, cycling, velocity outliers). | `includeDismissed`, `limit` |
| **getTopMovers** | Territories that drove the last week's movement. | `level`, `windowEnd` |
| **getHarmonicState** | Cognitive **rhythm** now (energy per timescale, flow shape, spread). | `granularity`, `detail` |
| **getMetricSeries** | Time-series of one named metric across windows. | `metric*`, `granularity`, `from`, `to`, `limit` |

### Body state (1)
| Tool | What it does | Key params |
|---|---|---|
| **getHealthData** | Apple Health summaries (sleep, HRV, resting HR, steps, workouts, mindful min) with trends/anomalies. | `days`, `from`, `to` |

> **Not in the 33 (you'll see the files, but they're not wired):** `src/tools/` also contains `schedules.js`, `delegation.js`, `reply.js`, `services.js`, and a dormant `findDocuments` — ported/reference code **not registered in `buildDomains()`** in V1. `reply` + `services` are the **2 deferred** domains; they land with later waves.

---

## 6. Data readiness (what returns real output on a fresh vault)

Connecting always shows all 33 tools, but some need data first — **these "empty" responses are not bugs:**

- **Work immediately (~19):** `getContext`, `captureMessage`, `importMessages`, `createTask`, `listTasks`, `getDailyMessages`, all documents, all mind-files, the topology *reads* (honest-empty), and `searchMindscape` (BM25).
- **"No data yet" until you import + cluster + embed (~10):** the Fisher/metrics/harmonic tools (`getCurrentPhase`, `getTrajectoryHistory`, `getActiveMilestones`, `getTopMovers`, `getHarmonicState`, `getMetricSeries`), `getHealthData`, and semantic ranking in `searchMindscape`. (Real clustering/embeddings are "Tier-2" — they need the `:8091` embed service + the Python pipeline on a capable host.)
- **Needs the public server:** `publishDocument` (run `npm run public`).

---

## 7. How to test it on your local server

### Stage 0 — Pre-flight
```bash
cd ~/mycelium.id
npm install --legacy-peer-deps
npm run set-keys          # generates your ONE recovery key (USER_MASTER); SYSTEM_KEY
                          # is HKDF-derived; both stored in the OS keychain.
npm run verify            # expect a wall of "VERDICT: GO" (full ledger)
npm run verify:mcp        # stdio MCP proof in isolation → "33 tools registered" + GO
```
No `init-db` needed — a fresh vault self-migrates on first boot.

### Stage 1 — Fastest loop: REST (no client needed)
```bash
MYCELIUM_KEY_SOURCE=keychain npm run portal       # REST at http://127.0.0.1:8787
# in another shell:
curl -s localhost:8787/api/v1/tools | jq '.tools[].name'                 # → 33 names
curl -s localhost:8787/api/v1/getContext -H 'content-type: application/json' -d '{}' | jq
curl -s localhost:8787/api/v1/captureMessage -H 'content-type: application/json' \
     -d '{"content":"first test thought","source":"curl"}' | jq
curl -s localhost:8787/api/v1/searchMindscape -H 'content-type: application/json' \
     -d '{"query":"thought"}' | jq
```
These hit the **same handlers** Claude calls — if it works here, it works in Claude.

### Stage 2 — Connect Claude Desktop (stdio)
Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "mycelium": {
      "command": "node",
      "args": ["src/index.js"],
      "cwd": "/Users/YOU/mycelium.id",
      "env": {
        "MYCELIUM_KEY_SOURCE": "keychain",
        "MYCELIUM_DATA_DIR": "/Users/YOU/Library/Application Support/id.mycelium.app",
        "MYCELIUM_DEBUG": "1"
      }
    }
  }
}
```
> ⚠️ **`MYCELIUM_DATA_DIR` is the critical line.** Your real vault lives in the per-OS app-data dir. A hand-rolled config *without* it falls back to a *different, empty* `./data` vault — tools connect fine but `getContext`/`searchMindscape` see nothing. This is the #1 "connected but no data" gotcha.

Then **fully quit and reopen** Claude Desktop. The tools icon should show **mycelium / 33 tools**. If not:
```bash
tail -f ~/Library/Logs/Claude/mcp-server-mycelium.log
```

### Stage 3 — Exercise it
| Ask Claude | Tool | Expect |
|---|---|---|
| "Pull my context." | `getContext` | dated, valid briefing (empty-but-clean on a fresh vault) |
| "Save this: *\<a thought\>*." | `captureMessage` | confirmation |
| "Make a task: buy milk." → "List my tasks." | `createTask`→`listTasks` | the task appears |
| "Search my mind for *milk*." | `searchMindscape` | BM25 hit on the saved message |
| "Write a doc at notes/test = 'hello'." → "Read notes/test." | `saveDocument`→`getDocument` | round-trips |
| "What's my current cognitive phase?" | `getCurrentPhase` | "no data yet" (Tier-2) — **expected, not an error** |

### Stage 4 — (optional) HTTP + OAuth
```bash
MYCELIUM_AUTH_SECRET=$(openssl rand -hex 24) MYCELIUM_USER_PASSWORD='<strong>' \
  MYCELIUM_KEY_SOURCE=keychain npm run start:http    # MCP+OAuth on :4711
npm run verify:oauth     # drives discovery→DCR→PKCE→Bearer→tools/call end-to-end
```
Expose only via Tailscale/Tunnel.

---

## 8. Environment variable reference

| Var | Purpose |
|---|---|
| `MYCELIUM_KEY_SOURCE` | Where keys come from: `env` (default) · `keychain` · `1password` |
| `MYCELIUM_DATA_DIR` | Vault location (the app sets this; **you must set it** in a hand-rolled stdio config) |
| `MYCELIUM_DB` / `MYCELIUM_KCV` / `MYCELIUM_AUTH_DB` | Explicit path overrides (else `<dataDir>/…`) |
| `MYCELIUM_DEBUG=1` | Print tool-failure stack to **stderr only** (off by default; errors can embed user content) |
| `MYCELIUM_DISABLE_EMBED=1` · `MYCELIUM_EMBED_URL` | Force BM25-only search · point at a different embed service |
| `MYCELIUM_HTTP=1`/`--http` · `MYCELIUM_ENRICH=1`/`--enrich` · `MYCELIUM_PUBLIC=1`/`--public` | Select the transport/aux server |
| `MYCELIUM_AUTH_SECRET` *(mandatory for HTTP)* · `MYCELIUM_USER_PASSWORD` *(the real auth gate)* | OAuth secrets |
| `MYCELIUM_PORT` (4711) · `MYCELIUM_REST_PORT` (8787) · `MYCELIUM_PUBLIC_PORT` (8788) · `MYCELIUM_ENRICH_PORT` (8095) | Port overrides |

---

## 9. The two proofs (your "does the wire work?" ground truth)

- **`npm run verify:mcp`** — boots the real server, connects a real MCP client over an in-memory transport, drives `tools/list` + a `createTask`→`listTasks` round-trip + unknown-tool handling. (→ **33 tools, GO**.)
- **`npm run verify:oauth`** — drives the full OAuth dance over HTTP to a `tools/call`.

Re-run these after any change to `mcp.js`, `index.js`, or `server-http.js`.

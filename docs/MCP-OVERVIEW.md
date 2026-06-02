# Mycelium V1 — MCP Server Overview

**What it is, how it connects, how it authenticates, the tools it exposes, and how to run and test it locally.**

> As-built, verified against the **running** server (`npm run verify:mcp` → **27 tools, 2 deferred**) and the registration code (`src/mcp.js`), not estimated. Date: 2026-06-02.
> Companions: [`SETUP.md`](SETUP.md) (install + Claude Desktop config) · [`MCP-CONNECT-AND-TEST.md`](MCP-CONNECT-AND-TEST.md) (connection code-review + test plan) · [`ARCHITECTURE.md`](ARCHITECTURE.md) (as-built system).

---

## 1. What it is

Mycelium V1 is a **self-hosted, single-user MCP server** — a private "cognitive vault." All your data (messages, documents, your private internal model, cognitive metrics) lives in **one encrypted SQLite file** (`mycelium.db`) on your own machine. An MCP client (Claude Desktop, or any MCP-capable client) connects to it and calls tools to read and write that vault.

The defining property: **one `boot()` sequence, three transports.** Whether a client connects over stdio, HTTP, or REST, it hits the *same* tool handlers over the *same* vault — so behavior is identical across all of them.

```
            ┌───────────────────────── boot() (src/index.js) ─────────────────────────┐
            │  load 2 hex keys → unlock + KCV (fail-closed) → open encrypting SQLite    │
            │  → buildDomains() → 27 tools → register on low-level MCP Server           │
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
4. **`buildDomains()`** (`src/mcp.js:79`) instantiates 10 tool domains; **`collectTools()`** flattens them into 27 tools with a duplicate-name guard (and applies cold-start gating to the Tier-2 readers — §6).
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

## 5. What tools it has — 27 tools

`getContext` is the **preamble** (the "D5 entry point"): a client calls it *first* to load a one-shot briefing, then pulls detail on demand. `*` = required param.

### Orientation (1)
| Tool | What it does | Key params |
|---|---|---|
| **getContext** | One-call working-context briefing — **call first**. Returns date/time, your private internal model, flagged items, **facts you know** + **people & projects** (pinned-first; sensitive excluded), recent messages, current cognitive phase, recent body-state. | `recentMessages` (1–40, def 10), `include[]` = mind\|facts\|people\|messages\|phase\|health |

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

### Curate — the 4 lean verbs (4; +link in Phase 3)
remember/forget/mark/link, addressed by a unified `{type,id}` ref (`type` = message\|document\|fact\|entity).
| Tool | What it does | Key params |
|---|---|---|
| **remember** | Write a durable memory. `kind:'fact'` → `category`/`key` → `value`. `kind:'entity'` → a person/project/place/org (`entityType`+`name`+`summary`). Re-remembering updates in place. | `kind` (fact\|entity), fact: `category`/`key`/`value`/`confidence`; entity: `entityType`/`name`/`summary`/`aliases`; `sensitive`, `pinned` |
| **link** | Link an entity to a message/document/fact (find-or-creates the entity by name+type) — builds the entity's dossier. | `entity*` (name), `entityType`, `type*`, `id*` |
| **forget** | Soft-redact a message/document/fact/entity: destroy content + any embedding fingerprints, evict from search + clustering, drop links, tombstone for audit. No undo. | `type` (message\|document\|fact\|entity), `id` |
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
| **searchMindscape** | One-call search across conversations, documents, territories, realms, themes; grouped results. Semantic when the embedder (:8091) is up, **BM25 fallback** otherwise. Two recall modes: `query` (crafted) or **`relatedTo`** (paste the current turn → proactive recall; excludes sensitive). `scope:'facts'` lists facts; `scope:'entities'` lists people/projects (narrow matches show linked items). | `query`, `relatedTo`, `scope` (all\|messages\|facts\|entities\|documents\|territories\|realms\|themes), `limit`, `includeTopology`, `agent` |

### Cognition & topology — 3 consolidated readers (Phase 5; was 11)
All Tier-2 (need clustering — see §6). The 11 Fisher/metric/topology readers folded into these 3 cohesive tools (capability preserved — same underlying compute).
| Tool | What it does | Key params |
|---|---|---|
| **cognitiveState** | The "now" in one call: **movement** (phase — stable/cycling/exploring/transforming, velocity, exploration), **rhythm** (energy per timescale, flow, spread), and active **alerts** (phase shifts, cycling). *(folds getCurrentPhase + getHarmonicState + getActiveMilestones)* | `level`, `granularity`, `detail` |
| **cognitiveHistory** | Cognition **over time**: trajectory (phase/velocity/displacement per window) + the territories that drove recent movement; optional named-metric series. *(folds getTrajectoryHistory + getTopMovers + getMetricSeries)* | `level`, `period`, `windowType`, `metric`, `granularity`, `from`, `to`, `limit`, `windowEnd` |
| **mindscape** | The topology graph **by view**: `structure` (vitality/health/orphans/bridges) · `territories` (filterable list) · `territory` (deep view) · `explore` (co-firing + gaps) · `time` (activity timeline). *(folds mindscapeStructure + listTerritories + territoryDetail + exploreTerritory + timeView)* | `view`, `territory`, `scale`, `range`, `phase`, `realm`, `minMessages`, `sortBy`, `limit`, `depth`, … |

### Body state (1)
| Tool | What it does | Key params |
|---|---|---|
| **getHealthData** | Apple Health summaries (sleep, HRV, resting HR, steps, workouts, mindful min) with trends/anomalies. | `days`, `from`, `to` |

> **Not in the 27 (you'll see the files, but they're not wired):** `src/tools/` also contains `schedules.js`, `delegation.js`, `reply.js`, `services.js`, and a dormant `findDocuments` — ported/reference code **not registered in `buildDomains()`** in V1. Also `fisher-tools.js`, `metrics.js`, `topology-tools.js` are now **internal** (their handlers are reused by the `cognition` domain under cognitiveState/cognitiveHistory/mindscape; their own tool names aren't registered). `reply` + `services` are the **2 deferred** domains; they land with later waves.

---

## 6. Data readiness (what returns real output on a fresh vault)

Connecting always shows all 27 tools, but some need data first — **these "empty" responses are not bugs:**

- **Work immediately (~23):** `getContext`, `captureMessage`, `importMessages`, `remember`/`link`/`forget`/`mark` (facts + entities + curation), `createTask`, `listTasks`, `getDailyMessages`, all documents, all mind-files, and `searchMindscape` (BM25, incl. `relatedTo` + `scope:'facts'`/`'entities'`).
- **Gated until you import + cluster — return an explicit "not ready" message (Phase 4, not silent-empty), 3 tools:** `cognitiveState`, `cognitiveHistory`, `mindscape` (the consolidated cluster/Fisher/metric/topology readers). They tell you to import + cluster, and flip to real data the moment clustering lands (mid-session, no restart). Real clustering/embeddings are "Tier-2" — they need the `:8091` embed service + the Python pipeline on a capable host.
- **`getHealthData`** — honest-empty until you sync Apple Health (a separate data source, not topology-gated). Semantic ranking in `searchMindscape` likewise sharpens once embeddings exist (BM25 works meanwhile).
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
npm run verify:mcp        # stdio MCP proof in isolation → "27 tools registered" + GO
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

Then **fully quit and reopen** Claude Desktop. The tools icon should show **mycelium / 27 tools**. If not:
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
| "What's my current cognitive phase?" | `cognitiveState` | an explicit "mindscape isn't computed yet — import + cluster" message (Phase 4 gating) — **expected, not an error** |

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

- **`npm run verify:mcp`** — boots the real server, connects a real MCP client over an in-memory transport, drives `tools/list` + a `createTask`→`listTasks` round-trip + unknown-tool handling. (→ **27 tools, GO**.)
- **`npm run verify:oauth`** — drives the full OAuth dance over HTTP to a `tools/call`.

Re-run these after any change to `mcp.js`, `index.js`, or `server-http.js`.

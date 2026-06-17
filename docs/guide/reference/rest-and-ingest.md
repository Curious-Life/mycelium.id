# REST & ingest

For bots, webhooks, and scripts that don't speak MCP, Mycelium exposes a plain HTTP
surface. Two flavors:

- **REST** (`:8787`, the portal server) — every tool as a simple POST, **no auth,
  loopback-only**. The fast local test loop.
- **Ingest** (`:4711`, the HTTP server) — capture + upload endpoints, **bearer/OAuth
  guarded**, safe to reach over a tunnel.

> ⚠️ **The REST surface has no per-request auth, by design.** It binds `127.0.0.1` and
> is meant for local scripting and testing. Never expose `:8787`. For anything
> networked, use the authenticated `:4711` endpoints.

---

## REST — every tool over HTTP (`:8787`)

Start it with `npm run portal`. Then call any tool by name:

```bash
# list the tools
curl -s localhost:8787/api/v1/tools | jq '.tools[].name'

# call a tool — body = the tool's params
curl -s localhost:8787/api/v1/getContext -H 'content-type: application/json' -d '{}'

curl -s localhost:8787/api/v1/captureMessage -H 'content-type: application/json' \
  -d '{"content":"a thought","source":"curl"}'

curl -s localhost:8787/api/v1/searchMindscape -H 'content-type: application/json' \
  -d '{"query":"thought"}'
```

| Method · Path | Purpose |
|---|---|
| `GET /api/v1/tools` | List all tools with their JSON-Schema. |
| `POST /api/v1/:toolName` | Invoke a tool; request body = its params. |
| `POST /api/v1/upload` | Multipart file upload into the encrypted blob store. |

These hit the **same handlers** an MCP client calls — if it works here, it works in
Claude.

---

## Ingest — authenticated capture (`:4711`)

Start it with `npm run start:http` (+ a [bearer](connect.md#4-auth-the-static-bearer)).
These are the endpoints a bot or webhook should use.

| Method · Path | Body | Purpose |
|---|---|---|
| `POST /ingest/message` | `captureMessage` args | Save one message. → `{ ok, result }` |
| `POST /ingest/import` | `{ messages: [...] }` | Bulk history backfill. → created/skipped counts |
| `POST /ingest/upload` | raw bytes | Store a file (≤ 50 MB). Query: `?filename=…&type=<mime>&asMessage=1`. → attachment id |
| `POST /context` | `{ query?, maxChars? }` | Pull the context preamble as plain JSON (the [memory bridge](memory-bridge.md) pull). → `{ ok, text }` |

```bash
curl http://127.0.0.1:4711/ingest/message \
  -H "Authorization: Bearer $MYCELIUM_MCP_BEARER" \
  -H 'content-type: application/json' \
  -d '{"content":"from my webhook","source":"zapier","role":"user"}'
```

Everything that enters through `/ingest/*` funnels through the **same single
choke-point** (`captureMessage`) as every other path — so it's encrypted at rest,
deduped on id, and queued for enrichment, exactly once. See [Data
Streams](../handbook/data-streams.md) for the model.

---

## Publishing (`:8788`)

Documents you explicitly publish with [`publishDocument`](mcp-tools.md#publishdocument)
are served by a **separate, fail-closed public server** — it serves *only* documents
marked public, nothing else.

```bash
npm run public          # public server on :8788
# published docs are then readable at  /p/<slug>
```

Everything not explicitly published returns nothing. The public server has no access to
your private vault contents beyond the documents you opted to publish.

---

→ Run modes, ports, and env vars: **[Run & configure](configure.md)**.

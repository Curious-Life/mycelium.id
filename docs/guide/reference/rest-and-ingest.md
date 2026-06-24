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

## Import from local sources (`:8787`)

The portal can pull data straight off the machine it runs on — an Obsidian vault, your
Claude Code transcripts, or a decrypted `mycelium-full-export` bundle. These live on the
portal server (`:8787`, loopback-only) under `/api/v1/portal/import/*`. The "Scan this
Mac" button in the UI drives the first two.

| Method · Path | Body | Purpose |
|---|---|---|
| `GET /import/detect` | — | Scan the allowlist for known sources. Returns **presence, counts, and dates only — never file contents**. Feeds the "Found on this Mac — N · Import" CTAs. |
| `POST /import/obsidian` | `{ folderPath }` **or** `{ files:[{relPath,content,…}], vaultName }` | Import an Obsidian vault. `folderPath` walks the dir server-side; `files` ships note bodies from the browser folder picker. Each note → a document + a memory. |
| `POST /import/claude-code` | `{ folderPath?, mode? }` | Import Claude Code session transcripts (`~/.claude/projects/**/*.jsonl`). `mode` = `clean` (default, human↔agent turns) or `full` (keeps tool/meta turns). |
| `POST /import/full-export` | `{ dirPath }` | Ingest a decrypted `mycelium-full-export` directory off disk (GB-scale, streamed). |

Everything funnels through the **same `captureMessage` / `saveDocument` choke-points** as
every other path — encrypted at rest, deduped on a path-stable id, queued for enrichment.

> 🔒 **Path confinement (fail-closed).** The `folderPath` / `dirPath` modes read
> server-local files, so a supplied path is `realpath`-resolved (collapsing symlink
> escapes) and must sit inside the **import allowlist**, or the request is rejected
> `400`:
>
> - your Obsidian config's registered vault dirs,
> - `~/.claude/projects`,
> - any path in [`MYCELIUM_IMPORT_ALLOWED_ROOTS`](configure.md#search--debug) — the
>   explicit out-of-band grant for an arbitrary directory.
>
> The "Scan this Mac" flow only ever sends allowlisted paths, so it needs no config. A
> `full-export` bundle lives outside those roots, so importing one requires granting its
> parent via `MYCELIUM_IMPORT_ALLOWED_ROOTS` first. The browser `files` mode ships content
> in the request body (no path read) and is not subject to confinement. Proven by
> `npm run verify:import-confinement`.

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

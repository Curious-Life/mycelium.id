# How Mycelium Works

> A plain-language walkthrough of how the V1 system actually works end to end —
> the mental model behind the code. For the as-built component reference see
> [`ARCHITECTURE.md`](ARCHITECTURE.md); to stand it up see [`SETUP.md`](SETUP.md);
> for the why see [`VISION.md`](VISION.md).

---

## 1. The one-paragraph version

Mycelium is a **self-hosted, single-user "cognitive vault."** It runs as one Node
process on your own machine. You feed it your data (chat exports, notes, messages);
it encrypts everything at rest with keys only you hold, embeds and tags it locally,
and serves it back to **any AI model** through the standard MCP protocol — plus a
local web **portal** for browsing it yourself. There is no cloud, no multi-tenancy,
and no autonomous agent: it's a pure *tool server* that answers when asked.

Two facts surprise people, and the whole design follows from them:

1. **The vault is unlocked at boot, not by a browser login.** The server reads your
   two master keys from a secure source (macOS Keychain / 1Password / env) when it
   starts, verifies them, and *refuses to start* if they're wrong. So there is no
   "log in" step in the app — there's nothing for a browser to unlock. The keys live
   on the **server**, never in the browser, never on the wire.
2. **It's a tool server, not an agent.** It doesn't think or act on its own. It
   exposes ~34 tools (save a message, search memory, list territories…) and a
   `getContext` preamble, and waits for an MCP client (Claude Desktop/CLI/mobile) or
   the portal to call them.

---

## 2. The lifecycle: keys → boot → unlock → serve

```
your keys (Keychain / 1Password / env)
   │  resolveKeys()                      src/crypto/key-source.js
   ▼
boot()  ── KCV gate: decrypt a known check-value with each key
   │       wrong/missing key → throw, process EXITS (fail-closed)
   │                                     src/index.js, src/crypto/keys.js
   ▼
vault unlocked (keys held in memory only)
   ▼
one shared tool-handler map  ──►  stdio  │  HTTP+OAuth  │  REST + Portal
                                  src/mcp.js / server-http.js / server-rest.js
```

- **Two keys, not one** (decisions D4/D6): `USER_MASTER` + `SYSTEM_KEY`, each a
  64-char hex string. A per-key **Key Check Value** catches a typo before any data
  is touched. Lose them and the vault is unrecoverable — by design.
- **Run modes** (one entry point, `src/index.js`): `npm start` (MCP over stdio,
  for a local AI client), `npm run start:http` (remote MCP + OAuth), `npm run portal`
  (the web UI + REST on `:8787`, localhost-only), `npm run start:enrich` (the
  background enrichment service on `:8095`).

---

## 3. The three ways in

Everything is built once and reached three ways, all dispatching through the **same
handler map** (write a tool once, reach it everywhere):

| Surface | Who uses it | How |
|---|---|---|
| **MCP** (stdio / Streamable HTTP) | An AI model — Claude Desktop, CLI, mobile, any MCP client | Tools + the `getContext` preamble. HTTP is guarded by OAuth 2.1 + PKCE. |
| **Portal** (web UI) | You, browsing your own vault | A SvelteKit app served at `/`, talking to `/api/v1/portal/*`. |
| **REST / ingest** | Scripts, bots, webhooks | `POST /api/v1/:tool`, `POST /api/v1/upload`, `/ingest/*`. |

The REST/portal surface is **localhost-only and has no per-request auth** — that's
deliberate for V1 (the machine is the boundary; the data was already unlocked at
boot). Networked deployments get real auth in a later phase.

---

## 4. What happens when data comes in (the ingestion choke-point)

Every inbound message — from any path — funnels through **one** function,
`captureMessage` (`src/ingest/capture.js`). That single choke-point is what makes
the invariant "anything that comes in is saved, encrypted, and queued for
enrichment" enforceable in exactly one place.

```
import file / bot / API / MCP tool
   │
   ▼  captureMessage()                      ← the single choke-point
   ├─ content + metadata encrypted at rest  (AES-256-GCM, transparent to callers)
   ├─ idempotent on id  (a re-send / re-import is a no-op — dedup)
   ├─ best-effort audit log entry
   └─ fire-and-forget nudge ──►  :8095 enrichment service
                                   ├─ Stage 1: embed (Nomic v1.5, 768-d)  0 → 2
                                   └─ Stage 2: extract tags/entities       2 → 1
   ▼
searchable:  BM25  +  vector ANN  →  RRF fusion   (src/search/**)
```

- **Encryption is transparent.** Callers pass plaintext; the storage adapter
  (`src/adapter/d1.js`) encrypts the sensitive columns on write and decrypts on
  read. The database file on disk holds only ciphertext — including the embedding
  vectors, which are treated as sensitive (they're fingerprints of the plaintext).
- **Enrichment is a background state machine**: `0 unprocessed → 2 embedded →
  1 enriched → -1 failed`. The embedder (Nomic ONNX on `:8091`) and the real
  clustering are **Tier-2** — they need the Python ML stack installed; without it
  the system runs and search fail-softs to BM25.

---

## 5. The user journey (what you actually do)

This is the path a first-time user walks, and what each step touches:

1. **Install + first run.** Generate keys and store them in the Keychain
   (`npm run set-keys`, or — designed, Mac-gated — a Tauri native first-run wizard),
   then launch. The vault unlocks at boot.
2. **Open the app.** It lands you straight in (no login wall — an *auth-shim*,
   `src/auth-shim.js`, answers the portal's session check). An empty vault shows a
   welcome that points you to **Import**.
3. **Import.** Drag a Claude or ChatGPT export (`.zip`) onto the Import screen. The
   server detects the format, parses it, and funnels every message through
   `captureMessage` — encrypted, deduped, queued for enrichment. (Parsers:
   `src/ingest/import-parsers.js`; transport: `src/portal-uploads.js`.)
4. **Enrich (background).** The `:8095` service embeds + tags new messages.
5. **Generate the mindscape.** *(Designed; the clustering run is Tier-2.)* The
   pipeline clusters your embeddings into **realms → themes → territories** and lays
   them out in 3D.
6. **Explore.** The Mindscape screen renders the realms/territories/point-cloud from
   real tables; Library holds your documents; Timeline is the chronological feed;
   Profile/Settings round it out.

---

## 6. How the portal talks to the vault

The portal (`portal-app/`) is the **canonical production SvelteKit UI**. It was
built for a richer cloud backend, so its data layer calls cloud-shaped `/portal/*`
endpoints. V1 bridges that with a thin **compatibility surface**:

```
portal screen ──fetch('/portal/…')──►  api.ts rewrites to  /api/v1/portal/…
                                              │
        ┌─────────────────────────────────────┼─────────────────────────────────┐
        ▼                                       ▼                                  ▼
 portal-compat.js                       portal-mindscape.js                portal-uploads.js
 (Library, Timeline,                    (3D scene aggregator +             (multipart import:
  Profile, Settings,                     per-panel reads +                  single-shot + chunked
  onboarding)                            graceful-empty)                    assembly → parsers)
        └───────────── all mounted under /api/v1/portal, backed by the db namespaces ┘
```

- The compat routers return the **exact JSON shapes** the screens already expect,
  backed directly by the local DB. Screens with no V1 data source yet degrade to a
  **graceful empty state** rather than erroring; surfaces that don't belong in a
  single-user V1 (modules, social, agents) are surfaced as a "**Coming later**"
  group in the nav — visible roadmap, no dead links.
- A native Mac shell (`src-tauri/`, Tauri v2) wraps all this into an app: it spawns
  the Node server and opens a window at `http://127.0.0.1:8787`.

---

## 7. The security model in one screen

This is a vault; the security posture is the product (full rules: `CLAUDE.md` §1-13).

- **Keys never leave the machine.** Generated locally, stored in the OS Keychain /
  1Password, read at boot, held in memory only. Never in HTTP, env files, the DB, or
  logs. (That's also why the native key ceremony generates + stores keys in the Rust
  shell *before* booting Node — the key never touches the wire.)
- **Everything sensitive is encrypted at rest** — message content, metadata,
  documents, attachments (in an encrypted blob store), and embedding vectors.
- **Fail closed, everywhere.** Wrong key → the process won't start. Missing content
  → refuse. Unrecognized import → reject with a safe error. Never a permissive
  default.
- **Untrusted input is handled defensively.** Imports run on attacker-influenceable
  files, so the parser reads only the known entry (no archive-path writes → no
  zip-slip), caps decompressed size with a streaming abort (no decompression
  bombs), bounds in-memory chunk assembly (no memory-exhaustion DoS), and never
  echoes file contents in errors. (See `verify:import-security`.)
- **Zero plaintext leakage.** Errors return fixed safe strings; sensitive fields
  (e.g. message `metadata`) are stripped from read projections; nothing sensitive is
  logged.

---

## 8. How we know it works (verification)

Every subsystem has a `scripts/verify-*.mjs` that boots real code, exercises it, and
prints a PASS/FAIL ledger + a `VERDICT: GO/NO-GO` line with an exit code. `npm run
verify` runs them all (foundation, MCP, search, topology, ingest, enrich, OAuth,
publish, the portal surfaces, import + an adversarial security suite, an end-to-end
integration pass, …). CI (`.github/workflows/verify.yml`) runs the same on every PR.

- **Tier-1** suites pass anywhere (no ML stack needed).
- **Tier-2** parity (real Nomic embeddings, real clustering) is verified on a host
  with `onnxruntime` / Ollama installed — they SKIP cleanly elsewhere rather than
  failing.

The discipline: **never claim something works without a verify that reached
`VERDICT … EXIT=0`.**

---

## 9. What's built vs. what's gated

- ✅ **Built + verified here:** the vault (boot/unlock/encrypt), MCP + HTTP + REST
  transports, OAuth, ingestion choke-point + encrypted uploads, the enrichment
  state machine, search, publishing, the portal (tight nav, Mindscape read, Claude/
  ChatGPT import, Timeline/Profile/Settings, first-run welcome).
- ⚠️ **Built but Tier-2-gated** (need the ML stack / a model): real Nomic
  embeddings, the clustering "generate mindscape" run, territory narratives, the
  inference router's cloud/local model calls.
- ⬜ **Designed, host-gated:** the Tauri native key ceremony (Rust + Mac build).

See `UX-COMPLETE-DESIGN-2026-06-01.md` for the
full UX design and `V1-BUILD-SPEC.md` for the build plan.

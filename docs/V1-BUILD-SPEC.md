# Mycelium Self-Hosted Server — Complete Build Spec

**Purpose:** A self-hosted MCP server that exposes Mycelium's tools over HTTPS with end-to-end encryption. Users run it on their own machine or VPS. Their data never leaves their hardware. Encryption keys derive from a 12-word seed phrase they control.

**Target:** ~~Dev agent builds this in 11 days (Phase 1-4). Shippable MVP in 9 days (Phase 1-3).~~ See [Revised build estimate](#revised-build-estimate) — the original 9-11 day figure assumed a stub topology engine, bare-Ollama embeddings, and from-scratch crypto. The ironed-out scope (working topology, compatible embeddings, ported crypto, real search) is **~18-24 working days**.

---

## Status — ironed-out v1.1 (2026-05-29)

This spec was reconciled against the actual `reference/` code (imported from the canonical production system) using the `sweep-first-design` protocol: 4 parallel Explore sweeps + direct code reads. Several load-bearing assumptions in the original draft were contradicted by the code. The original prose is preserved below; **inline `⚠️ CORRECTED` blocks mark where the build must diverge from the original sample code.** The authoritative reconciliation is the [Verification table](#verification-table) at the end.

### Decisions locked (operator, 2026-05-29)

| # | Decision | Choice | Consequence |
|---|---|---|---|
| D1 | **Topology engine** | **Open, behind the AnalysisEngine plugin interface.** | Port `cluster.py` / `compute_information_harmonics.py` / `compute-cofire.js` as the **default** `AnalysisEngine` implementation. The interface stays so a closed engine can replace it later. V1 ships a *working* mindscape — not an empty stub. The stub becomes the fallback when pipeline deps are absent. |
| D2 | **Embeddings** | **Port `embed-service.py` (Nomic v1.5 ONNX + task prefixes, loopback :8091).** | Bare Ollama `nomic-embed-text` is **rejected** — it omits the mandatory `search_query:` / `search_document:` / `clustering:` prefixes, lands in a different vector space, and breaks both imported vectors and clustering. Ollama is retained **only for optional local text *inference***, never for embeddings. Adds an onnxruntime/Python dependency to the self-hosted stack. |
| D3 | **Encryption** | **Port `crypto-local.js` as-is; add a hex master key on top.** | Preserve the real wrapped-DEK envelope `{v,kf,s,iv,ct,dk}` (AES-256-GCM content + AES-KW DEK wrap), scope guardians, the USER/SYSTEM two-key family, and `rewrapEnvelope()`. The spec's original `{iv,ct,tag,scope}` envelope is **rejected** (can't decrypt a single imported row). |
| D4 | **Master key representation** | **64-char hex strings (32 bytes each). No BIP-39 words.** | The unlock secret is a copy-pasteable hex blob — identical in form to the existing `ENCRYPTION_MASTER_KEY`, so the current tmpfs/env load path is reused verbatim. **BIP-39 is dropped from V1** (`bip39.ts` / `scoped-keys.ts`-from-mnemonic are deleted from the plan). A **Key-Check Value** (KCV: stored ciphertext of a known constant) guards against a mistyped/truncated paste, since hex carries no checksum. **Note: D6 makes this two independent hex keys** (USER_MASTER + SYSTEM_KEY), each with its own KCV. |
| D5 | **Runtime scope** | **Pure MCP tool server + on-demand context; no autonomous loop.** | V1 ships as a **tool server only** — the connecting client (Claude/etc.) *is* the agent; there is no server-side `/chat` loop, scheduler, lanes, recovery, or compaction. **`context-assembly` is ported as a callable preamble tool/resource** so a client can pull preloaded mind state (incl. `flagged.md`) on demand at turn start. Consequence: `schedule_task` / `list_my_schedules` have **no executor → dropped/deferred**; `flagForDiscussion` stays viable *because* the on-demand context tool surfaces flagged items. |
| D6 | **System key** | **Two independent hex keys: USER_MASTER + SYSTEM_KEY.** | Keep the two-key family from `crypto-local.js`. USER_MASTER wraps user-scope DEKs; SYSTEM_KEY wraps system-scope material; the `secrets` table stays **encrypted-at-rest** under SYSTEM_KEY. Each key is a 64-char hex blob with its **own KCV**. Two env/tmpfs slots, two unlock checks at boot — fail closed if either is missing or its KCV mismatches. |
| D7 | **Message enrichment / embeddings** | **Build the enrichment service (NLP tagging + `nlp_processed` state machine + embed-on-write).** | ⚠️ **The service itself (loopback :8095) is build-new — it is *not* in `reference/`.** What `reference/` *does* ship is its **contract**: `server-routes/portal-enrichment.js` (the 4-handler router that drives it — `/enrich-all`, `/health`, the loopback `notify` callback, message-state counts) + the `messages` NLP columns (`entities`/`relations`/`entity_summary`/`nlp_processed`/`nlp_processed_at`/`nlp_error`/`embedding_768`) and the `nlp_processed=0` work-queue index (`d1-schema-generated.sql:950,1832,1835`). V1 builds the :8095 worker fresh against that contract; it calls the **:8091 embed-service (D2)** under the hood. This is the one decision that **materially adds scope/time** beyond the straight port. Interim: write embeddings inline on message create; the async NLP state machine is the build-new follow-on. |

The day-by-day, file-level execution plan derived from this spec is **[`docs/V1-IMPLEMENTATION-PLAN.md`](V1-IMPLEMENTATION-PLAN.md)** (6 phases, dependency graph, per-step smoke tests, security checkpoints, first-3-commits starter).

### What this changes vs. the original draft

- **Crypto (Component 4 & 10):** rewritten — port `crypto-local.js`; master key is hex; no mnemonic.
- **Embeddings (Component 5):** rewritten — port `embed-service.py` (ONNX + prefixes); Ollama demoted to optional inference only.
- **Search (`tools/search.ts`):** corrected — `searchMindscape` is **not** FTS5+SQL. Port the in-RAM `mind-search` subsystem (ANN + BM25 + RRF, rehydrated at boot from decrypted content). FTS5 exists in the schema but is unused.
- **Topology (Component 9):** corrected — the AnalysisEngine *interface* stays, but its **default implementation is the ported open pipeline**, not the stub.
- **Tool surface:** corrected — **41 tools across 14 files**, not 37. Drop `delegate_to_agent` + `getTeamStatus` (multi-agent) and collapse `spaces` (multi-user) for single-user V1 → ~36 portable tools; **D5 additionally drops `schedule_task` + `list_my_schedules`** (no scheduler/executor in a pure tool server) → **~34 portable tools**, plus the new `context-assembly` preamble tool. Tools port as `createXDomain(deps) → {tools, handlers}` factories with a local `d1Query` injected (no Worker, no copy-paste-from-Worker).
- **Data import:** corrected — production rows are ciphertext under the *old* master key; import is a **`rewrapEnvelope()` re-key** (old master → new hex master), not a plain `sqlite3` load (unless you first decrypt via the Worker export path).
- **Runtime scope (D5):** narrowed — V1 is a **pure tool server**. No server-side agent loop, scheduler, lanes, recovery, or compaction. `context-assembly` ships as a **callable preamble tool** (client pulls preloaded mind state + `flagged.md` on demand). `schedule_task` / `list_my_schedules` are dropped (no executor); the deferred scheduler/autonomous-loop work moves to Phase 5: Extensions.
- **System key (D6):** two independent hex keys (USER_MASTER + SYSTEM_KEY), each with its own KCV; the `secrets` table is encrypted-at-rest under SYSTEM_KEY. Boot fails closed if either key is absent or KCV-mismatched.
- **Enrichment (D7):** **build-new** — the :8095 NLP-tagging + `nlp_processed` state-machine + embed-on-write enrichment service is **not in `reference/`**; only its contract is (`portal-enrichment.js` router + `messages` NLP columns/index). Build it fresh against that contract; it calls the :8091 embed-service under the hood. This is the one item that adds material scope/time beyond the straight port.

---

## What This Is

A TypeScript server that:
1. Reads/writes Mycelium data in a local SQLite database (111 tables, exported from production D1)
2. Exposes 37 MCP tools via **two transports**: stdio (local) and Streamable HTTP (remote)
3. Serves the same tools via **REST API** (`/api/v1/*`) for non-MCP clients
4. Encrypts all data at rest with scope-partitioned AES-256-GCM (BIP-39 seed → HKDF → per-scope keys)
5. Authenticates remote clients via OAuth 2.1 + PKCE
6. Generates local embeddings via Ollama (nomic-embed-text, 768D)
7. Routes inference between local Ollama and cloud BYOK APIs
8. Defines agent configurations via YAML templates
9. Exposes a plugin interface for the topology engine (Lumen boundary)

**Primary interface:** MCP (Streamable HTTP) — works with Claude, ChatGPT, Cursor, VS Code, Grok, Gemini, Windsurf, Perplexity.

**Secondary interface:** REST API — for ingestion from non-MCP clients (Telegram bots, browser extensions, webhooks, scripts).

---

## Architecture

```
                    ┌─────────────────────────┐
                    │     MCP Clients          │
                    │  Claude / ChatGPT / etc  │
                    └──────────┬──────────────┘
                               │ HTTPS + Streamable HTTP
                    ┌──────────▼──────────────┐
                    │   Cloudflare Tunnel      │
                    │   (account tunnel, SSE)  │
                    └──────────┬──────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                        Express Server                       │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  MCP Route  │  │  REST Route  │  │  OAuth 2.1 Routes │  │
│  │  /mcp       │  │  /api/v1/*   │  │  /authorize       │  │
│  │             │  │              │  │  /token            │  │
│  │  37 tools   │  │  same        │  │  /register         │  │
│  │  registered │  │  handlers    │  │  /.well-known/*    │  │
│  └──────┬──────┘  └──────┬───── ┘  └───────┬───────────┘  │
│         │                │                  │               │
│         └────────┬───────┘                  │               │
│                  │                          │               │
│  ┌───────────────▼───────────┐   ┌─────────▼───────────┐  │
│  │     Tool Handler Layer    │   │     better-auth      │  │
│  │                           │   │   OAuth Provider     │  │
│  │  - scope check            │   │   + SQLite storage   │  │
│  │  - encrypt/decrypt        │   └─────────────────────┘  │
│  │  - rate limit             │                             │
│  └───────────────┬───────────┘                             │
│                  │                                          │
│  ┌───────────────▼───────────────────────────────────────┐ │
│  │              Encryption Layer                         │ │
│  │                                                       │ │
│  │  BIP-39 seed → HKDF-SHA256 → master key               │ │
│  │  master key + scope → HKDF → scope key                │ │
│  │  scope key → AES-256-GCM per record                   │ │
│  │                                                       │ │
│  │  Key never stored server-side.                        │ │
│  │  Client sends derived scope keys per-request          │ │
│  │  OR session holds keys after initial unlock.          │ │
│  └───────────────┬───────────────────────────────────────┘ │
│                  │                                          │
│  ┌───────────────▼───────────┐  ┌────────────────────────┐ │
│  │    D1 Adapter (~50 LOC)   │  │  Embedding Service     │ │
│  │                           │  │                        │ │
│  │  better-sqlite3 wearing   │  │  Ollama                │ │
│  │  a D1 costume             │  │  nomic-embed-text v1.5 │ │
│  │  prepare().bind().run()   │  │  768D, local REST API  │ │
│  │  111 tables, 0 rewrites   │  │  POST :11434/api/embed │ │
│  └───────────────────────────┘  └────────────────────────┘ │
│                                                             │
│  ┌───────────────────────────┐  ┌────────────────────────┐ │
│  │   Inference Router        │  │  AnalysisEngine Plugin │ │
│  │                           │  │                        │ │
│  │  local: Ollama llama3.1   │  │  interface for closed  │ │
│  │  cloud: Anthropic/OpenAI  │  │  topology engine       │ │
│  │  BYOK (user's API keys)   │  │  (Lumen boundary)     │ │
│  └───────────────────────────┘  └────────────────────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Directory Structure

```
mycelium/
├── package.json
├── tsconfig.json
├── .env.example
├── README.md
│
├── src/
│   ├── index.ts              # Entry point — stdio or HTTP based on mode
│   ├── server.ts             # Express server, mounts all routes
│   ├── mcp.ts                # McpServer + tool registrations
│   ├── api.ts                # REST router (same handlers as MCP)
│   ├── auth.ts               # better-auth config (~30 LOC)
│   │
│   ├── adapter/
│   │   └── d1.ts             # D1-compatible wrapper for better-sqlite3
│   │
│   ├── crypto/
│   │   ├── bip39.ts          # Mnemonic generation + master key derivation
│   │   ├── scoped-keys.ts    # HKDF scope → AES-256-GCM key
│   │   └── envelope.ts       # Encrypt/decrypt records
│   │
│   ├── embed/
│   │   └── ollama.ts         # Ollama client for local embeddings
│   │
│   ├── inference/
│   │   ├── router.ts         # InferenceRouter — routes tasks to local/cloud
│   │   ├── local.ts          # Ollama generate client (llama3.1)
│   │   └── cloud.ts          # Anthropic/OpenAI API client (BYOK)
│   │
│   ├── analysis/
│   │   └── plugin.ts         # AnalysisEngine interface (public boundary)
│   │
│   ├── tools/
│   │   ├── index.ts          # Tool registry (maps name → handler)
│   │   ├── documents.ts      # getDocument, saveDocument, etc.
│   │   ├── search.ts         # searchMindscape — see CORRECTED note: ports the in-RAM mind-search subsystem, NOT FTS5
│   │   ├── topology.ts       # exploreTerritory, mindscapeStructure
│   │   ├── messages.ts       # getDailyMessages
│   │   ├── calendar.ts       # calendar tools
│   │   └── ...               # remaining tool groups
│   │
│   └── config/
│       └── agents.ts         # Agent template loader (YAML → config)
│
├── agents/                   # YAML agent definitions
│   ├── personal.yaml         # System prompt, tool whitelist, scopes
│   └── research.yaml
│
├── data/                     # SQLite databases (gitignored)
│   ├── mycelium.db           # Main data (111 tables)
│   └── auth.db               # better-auth sessions/tokens
│
├── migrations/               # D1 → SQLite schema migrations
│
└── scripts/
    ├── setup.sh              # Install Ollama, pull model, init DBs
    ├── tunnel.sh             # Configure Cloudflare tunnel
    └── import.sh             # Import from Mycelium cloud export
```

---

## Dependencies

```json
{
  "name": "mycelium",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "start:http": "tsx src/index.ts --http",
    "build": "tsc"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "better-sqlite3": "^11.0.0",
    "express": "^4.21.0",
    "better-auth": "^1.0.0",
    "@scure/bip39": "^1.4.0",
    "yaml": "^2.6.0",
    "@anthropic-ai/sdk": "^0.35.0",
    "cors": "^2.8.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/express": "^5.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.7.0"
  }
}
```

8 runtime dependencies. No ORMs, no frameworks, no build tools beyond TypeScript.

---

## Component 1: D1 Adapter (`src/adapter/d1.ts`)

Wraps `better-sqlite3` to match Cloudflare D1's API exactly. All 111 tables and existing query code from the Mycelium Worker can be copy-pasted with zero changes.

```typescript
import Database from 'better-sqlite3';

export class D1Adapter {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  prepare(sql: string) {
    const stmt = this.db.prepare(sql);
    return {
      bind: (...params: any[]) => ({
        run: () => {
          const info = stmt.run(...params);
          return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
        },
        all: () => ({ results: stmt.all(...params) }),
        first: (col?: string) => {
          const row = stmt.get(...params) as Record<string, any> | undefined;
          if (!row) return null;
          return col ? row[col] : row;
        },
      }),
      run: () => {
        const info = stmt.run();
        return { success: true, meta: { changes: info.changes } };
      },
      all: () => ({ results: stmt.all() }),
      first: (col?: string) => {
        const row = stmt.get() as Record<string, any> | undefined;
        if (!row) return null;
        return col ? row[col] : row;
      },
    };
  }

  batch(statements: any[]) {
    const transaction = this.db.transaction(() => {
      return statements.map(s => s.run());
    });
    return transaction();
  }

  exec(sql: string) {
    this.db.exec(sql);
    return { success: true };
  }

  close() {
    this.db.close();
  }
}
```

~50 LOC. The key insight: D1's API is `prepare(sql).bind(...params).run()` / `.all()` / `.first()`. This adapter makes better-sqlite3 speak the same language.

**Build estimate:** 0.5 days

---

## Component 2: MCP Server (`src/index.ts` + `src/server.ts`)

Dual-mode entry point. Defaults to stdio (Claude Desktop spawns the process), starts HTTP when `--http` flag is passed.

### Entry point (`src/index.ts`)

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { D1Adapter } from './adapter/d1.js';
import { registerTools } from './tools/index.js';

const DB_PATH = process.env.MYCELIUM_DB || './data/mycelium.db';
const db = new D1Adapter(DB_PATH);

const server = new McpServer(
  { name: 'mycelium', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

registerTools(server, db);

if (process.argv.includes('--http')) {
  const { startHttpServer } = await import('./server.js');
  const port = parseInt(process.env.PORT || '3000');
  startHttpServer(server, db, port);
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

### Express server (`src/server.ts`)

```typescript
import express from 'express';
import cors from 'cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { auth } from './auth.js';
import { apiRouter } from './api.js';
import { D1Adapter } from './adapter/d1.js';

export function startHttpServer(server: McpServer, db: D1Adapter, port: number) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // OAuth routes
  app.all('/auth/*', auth.handler);

  // MCP endpoint with auth
  app.use('/mcp', async (req, res, next) => {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) { res.status(401).json({ error: 'Unauthorized' }); return; }
    next();
  }, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  // REST API — same handlers, HTTP routes
  app.use('/api/v1', apiRouter(db));

  app.listen(port, () => {
    console.log(`Mycelium server: http://localhost:${port}`);
    console.log(`MCP: http://localhost:${port}/mcp`);
    console.log(`REST: http://localhost:${port}/api/v1/*`);
    console.log(`OAuth: http://localhost:${port}/auth/.well-known/oauth-authorization-server`);
  });
```

> ### ⚠️ CORRECTED — the `/mcp` handler above is **per-request transport**; that breaks sessions
>
> The sample creates a **new `StreamableHTTPServerTransport` and calls `server.connect()` on every request** (`sessionIdGenerator: undefined`). That is wrong for a Streamable-HTTP MCP server: the transport is meant to **persist across requests for a session**, and connecting one `McpServer` to a fresh transport per request leaks connections and drops the `initialize`→subsequent-request continuity (notifications, `mcp-session-id` correlation). Two correct shapes:
> - **Stateful (recommended for remote clients):** on the `initialize` request, create a transport with a real `sessionIdGenerator` (e.g. `randomUUID`), `server.connect()` it once, and store it in a `Map<sessionId, transport>`; route later requests (carrying the `mcp-session-id` header) back to the stored transport; evict on `onclose`/DELETE.
> - **Stateless:** if you truly want no sessions, keep `sessionIdGenerator: undefined` **but** reuse a **single** long-lived transport+server (connect once at boot), not one per request.
>
> Build note (plan Step 4): wire the `Map`-based stateful variant — it's what Claude Desktop/mobile expect, and the OAuth `mcp-session-id` correlation rides on it.

```typescript
  // ⚠️ do NOT ship the per-request `new StreamableHTTPServerTransport()` + connect above.
  // Use the Map<sessionId, transport> stateful variant from the CORRECTED note.
} // startHttpServer
```

**Build estimate:** 1 day (transport + tool registration + Express)

---

## Component 3: OAuth 2.1 (`src/auth.ts`)

MCP clients (Claude Desktop, CLI, mobile) require the full OAuth discovery + PKCE flow. No shortcuts.

```typescript
import { betterAuth } from 'better-auth';
import { oAuthProvider } from 'better-auth/plugins';
import Database from 'better-sqlite3';

export const auth = betterAuth({
  database: new Database('./data/auth.db'),
  plugins: [oAuthProvider()],
  // Single-user: auto-approve after password
});
```

Endpoints created automatically:
- `/.well-known/oauth-authorization-server`
- `/authorize` (shows login form)
- `/token` (code exchange, PKCE verified)
- `/register` (DCR — accept all for single-user)

**Single-user simplification:** No registration flow. Password set in `.env` on first run.

**Build estimate:** 1 day

---

## Component 4: Scope-Partitioned Encryption (`src/crypto/`)

**Non-negotiable.** All data encrypted at rest.

> ### ⚠️ CORRECTED (D3 + D4) — port `crypto-local.js`; do **not** build the envelope below
>
> The sample code in this component (fresh HKDF + `{iv,ct,tag,scope}` envelope) is **superseded**. It is incompatible with every existing/imported ciphertext and omits the wrapped-DEK layer. **Port `reference/encryption/crypto-local.js` instead.** Verified reality (`crypto-local.js:960-1130`):
>
> - **Per-record envelope encryption.** A random **DEK** (AES-256-GCM, 256-bit) encrypts the content; the DEK is then **wrapped with the scope key via AES-KW**. The scope key never touches plaintext directly.
> - **Envelope shape** (base64 of JSON): `{ v, s, iv, ct, dk }` — `v`=version (1/2/3), `s`=scope, `iv`=base64(12B), `ct`=base64(AES-GCM ciphertext incl. tag), `dk`=base64(AES-KW-wrapped DEK). `+u` (userId) on v2, `+kf:'system'` on v3.
> - **Key derivation:** HKDF-SHA256, **zero salt**, info strings `mycelium:scope:<scope>:v1` (user family) and `mycelium:system-scope:<scope>:v1` (system family). Do not change these strings — they are the decryption contract for all stored data.
> - **Scope guardians** (`scopeGuardian` / `scopeEncryptGuardian`) run **before** key unwrap and fail closed. Preserve them.
> - **Two key families:** USER_MASTER (vault content) and SYSTEM_KEY (the `secrets` table only). Preserve the separation.
> - **Re-keying:** `rewrapEnvelope()` decrypts the wrapped DEK with the old master and re-wraps with the new — ciphertext and IV are untouched. This is the import/rotation path.
>
> **Single-user simplifications:** collapse the scope set to `personal` (+ `system` for secrets) unless you ship the org/wealth/moms agents; keep the guardian machinery (cheap, and it preserves V2 forward-compat). Drop the per-user `v2` path (`userId` is constant) — write `v1` envelopes, but keep the `decrypt()` ability to read `v2`/`v3` for imports.
>
> ### Master key (D4) — hex, no mnemonic
>
> The master key is **32 raw bytes**, supplied/stored as a **64-char hex string** (identical to the existing `ENCRYPTION_MASTER_KEY` format → reuse the current tmpfs/env load path in `crypto-local.js:561-671`). First run: `crypto.randomBytes(32).toString('hex')`, displayed once for the user to copy. Unlock: paste hex → 32 bytes → master key in session memory. **No BIP-39.**
>
> **Key-Check Value (KCV) — required.** Because hex has no checksum, on first run encrypt a fixed known constant (e.g. `"mycelium-kcv-v1"`) under the master key and persist the resulting envelope. On every unlock, attempt to decrypt the stored KCV with the pasted hex; a GCM auth-tag failure means the key is wrong/truncated → reject before the vault is touched. This is *not* a backup mechanism (a lost key is still unrecoverable, by design) — it only prevents silently unlocking with the wrong key.

### ~~Key derivation (`src/crypto/bip39.ts`)~~ — SUPERSEDED, see correction above

```typescript
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import crypto from 'crypto';

// Generate 12-word seed phrase (shown once at setup, never stored)
export function generateSeedPhrase(): string {
  return generateMnemonic(wordlist, 128); // 128 bits = 12 words
}

// Derive master key from mnemonic
export function deriveMasterKey(mnemonic: string): Buffer {
  const seed = mnemonicToSeedSync(mnemonic, '');
  return Buffer.from(
    crypto.hkdfSync('sha256', seed, 'mycelium-master-v1', 'master-key', 32)
  );
}
```

### Scope keys (`src/crypto/scoped-keys.ts`)

Two scope families mapping to two key prefixes:

```typescript
import crypto from 'crypto';

export function deriveKey(masterKey: Buffer, scope: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', masterKey, 'mycelium-v1',
      `mycelium/v1/scope/${scope}`, 32)
  );
}

// Scopes:
// - messages:content     (message bodies)
// - documents:content    (document content)
// - messages:metadata    (timestamps, sources — lighter encryption)
```

### Envelope encryption (`src/crypto/envelope.ts`)

```typescript
import crypto from 'crypto';

interface EncryptedPayload {
  iv: string;       // base64, 12 bytes
  ciphertext: string; // base64
  tag: string;       // base64, 16 bytes
  scope: string;
}

export function encrypt(key: Buffer, plaintext: string, scope: string): EncryptedPayload {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    ciphertext: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    scope,
  };
}

export function decrypt(key: Buffer, payload: EncryptedPayload): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm', key, Buffer.from(payload.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return decipher.update(payload.ciphertext, 'base64', 'utf8') + decipher.final('utf8');
}
```

### How it flows:

1. **First run:** Server generates 12-word seed phrase, displays it to user. User writes it down. Phrase is never stored.
2. **Unlock:** User enters seed phrase (or it's cached in session after first entry). Server derives master key → scope keys.
3. **Write:** Tool handler calls `encrypt(scopeKey, content, scope)` before writing to SQLite.
4. **Read:** Tool handler calls `decrypt(scopeKey, payload)` after reading from SQLite.
5. **Lost phrase = lost data.** This is by design. Sovereignty means responsibility.

**Build estimate:** 1 day (including key management setup flow)

---

## Component 5: Local Embeddings

> ### ⚠️ CORRECTED (D2) — port `embed-service.py`; do **not** use bare Ollama
>
> The sample below is **superseded**. Verified reality (`embed-service.py:61-74`, read directly): the embedder is **Nomic v1.5 as quantized ONNX** (`nomic-ai/nomic-embed-text-v1.5`, `onnx/model_quantized.onnx`, 768D) and it **always prepends a task prefix** — `"search_query: "` / `"search_document: "` for retrieval, `"clustering: "` (in `cluster.py`, 256D matryoshka truncation) for clustering. The model card warns these exact strings are load-bearing: *"mismatched prefix at index vs query time tanks recall."*
>
> A bare Ollama call with no prefix produces vectors in a **different space** (~0.85-0.90 cosine to the correctly-prefixed vector) → degraded recall, and **imported production vectors won't match newly-generated ones**. So:
>
> - **Port `reference/pipeline/embed-service.py`** as the embedding service (loopback `127.0.0.1:8091`, `POST /embed` `{text, task}` and `POST /batch` `{texts, task}`). Self-hosted stack gains a small Python + onnxruntime + huggingface-hub dependency.
> - **Both** retrieval and clustering go through it (search via `:8091`, clustering via `cluster.py`'s `"clustering: "` path). One model file, two prefix regimes.
> - Ollama is retained **only** for optional local *text inference* (Component 6), never for embeddings.

~~Original sample (`src/embed/ollama.ts`) — do not build:~~

```typescript
// SUPERSEDED — bare Ollama, no task prefix → incompatible vector space.
export async function embed(texts: string[]): Promise<number[][]> {
  const res = await fetch('http://localhost:11434/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', input: texts }),
  });
  return (await res.json()).embeddings; // 768D vectors
}
```

Setup: port `embed-service.py`; the ONNX model auto-downloads from HF Hub on first run (~170MB).

Used for:
- Semantic search (FAISS or brute-force cosine on SQLite blob columns)
- Document similarity
- Territory assignment for new messages

**Build estimate:** 0.5 days

---

## Component 6: Inference Router (`src/inference/`)

Routes inference tasks between local Ollama (free, private) and cloud APIs (powerful, costs money). User provides their own API keys.

### Router (`src/inference/router.ts`)

```typescript
import { localInfer } from './local.js';
import { cloudInfer } from './cloud.js';

interface InferenceRequest {
  prompt: string;
  task: 'summarize' | 'narrate' | 'classify' | 'extract' | 'complex';
  maxTokens?: number;
}

export async function infer(req: InferenceRequest): Promise<string> {
  // Simple tasks → local (free, private)
  if (['summarize', 'classify', 'extract'].includes(req.task)) {
    return localInfer(req);
  }
  // Complex tasks → cloud (if API key configured)
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
    return cloudInfer(req);
  }
  // Fallback to local
  return localInfer(req);
}
```

### Local (`src/inference/local.ts`)

```typescript
export async function localInfer(req: { prompt: string; maxTokens?: number }): Promise<string> {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.LOCAL_MODEL || 'llama3.1',
      prompt: req.prompt,
      stream: false,
      options: { num_predict: req.maxTokens || 1024 },
    }),
  });
  return (await res.json()).response;
}
```

### Cloud BYOK (`src/inference/cloud.ts`)

```typescript
import Anthropic from '@anthropic-ai/sdk';

export async function cloudInfer(req: { prompt: string; maxTokens?: number }): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: req.maxTokens || 1024,
      messages: [{ role: 'user', content: req.prompt }],
    });
    return msg.content[0].type === 'text' ? msg.content[0].text : '';
  }
  throw new Error('No cloud API key configured');
}
```

**Split:** ~80% local (summarization, classification, extraction), ~20% cloud (narrative synthesis, complex reasoning).

**Build estimate:** 0.5 days

---

## Component 7: REST API (`src/api.ts`)

Every MCP tool also available as `POST /api/v1/{tool-name}`. Same handlers, same encryption, same auth. For non-MCP clients (Telegram bots, browser extensions, webhooks, scripts).

```typescript
import { Router } from 'express';
import { D1Adapter } from './adapter/d1.js';
import { tools } from './tools/index.js';
import { auth } from './auth.js';

export function apiRouter(db: D1Adapter): Router {
  const api = Router();

  // Auth middleware
  api.use(async (req, res, next) => {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) { res.status(401).json({ error: 'Unauthorized' }); return; }
    next();
  });

  // Every tool as POST /api/v1/{tool-name}
  for (const [name, handler] of Object.entries(tools)) {
    api.post(`/${name}`, async (req, res) => {
      const result = await handler.execute(req.body);
      res.json(result);
    });
  }

  return api;
}
```

Same auth tokens, same encryption, same handlers. Zero duplication.

**Build estimate:** 0.5 days (it's just routing)

---

## Component 8: Agent Templates (`agents/*.yaml`)

YAML files defining agent configurations. Loaded at startup, used to filter tool availability and configure per-agent behavior.

```yaml
# agents/personal.yaml
name: personal
display_name: "Personal Agent"
model: claude-sonnet-4-20250514
system_prompt: |
  You are a personal knowledge companion...
tools:
  - searchMindscape
  - getDocument
  - saveDocument
  - exploreTerritory
  - getDailyMessages
scopes:
  - messages:read
  - messages:write
  - documents:read
  - documents:write
  - topology:read
```

### Loader (`src/config/agents.ts`)

```typescript
import { parse } from 'yaml';
import { readFileSync, readdirSync } from 'fs';

interface AgentConfig {
  name: string;
  display_name: string;
  model: string;
  system_prompt: string;
  tools: string[];
  scopes: string[];
}

export function loadAgents(dir: string): Map<string, AgentConfig> {
  const agents = new Map<string, AgentConfig>();
  for (const file of readdirSync(dir).filter(f => f.endsWith('.yaml'))) {
    const config = parse(readFileSync(`${dir}/${file}`, 'utf-8')) as AgentConfig;
    agents.set(config.name, config);
  }
  return agents;
}
```

**Build estimate:** 0.5 days

---

## Component 9: AnalysisEngine Plugin Interface (`src/analysis/plugin.ts`)

> ### ⚠️ CORRECTED (D1) — the default implementation is the OPEN pipeline, not a stub
>
> The interface below is kept. But the original framing ("Lumen implements it; the open repo ships only a stub") is **contradicted by the code**. Verified reality (`reference/pipeline/`): `cluster.py` (FAISS k-NN + Leiden + Ward HAC), `compute_information_harmonics.py` (H0/β/γ/α/θ/δ), and `compute-cofire.js` (4-timescale co-firing) are **fully self-contained, open-source, and write to queryable D1 tables**. There is no "Lumen" in the codebase and no closed black box.
>
> **So V1 ships a working mindscape.** The `AnalysisEngine` interface is the swap point; its **default implementation wraps the ported open pipeline** (`run-clustering.sh` orchestration → `clustering_points`, `realms`, `territory_profiles`, `territory_cofire`, `cognitive_metrics_harmonic`). `StubAnalysisEngine` is demoted to a **fallback** used only when the Python/pipeline deps are absent (e.g. a minimal install).
>
> Port targets: `reference/pipeline/{cluster.py, compute_information_harmonics.py, compute-cofire.js, describe-clusters.js, run-clustering.sh}`. Note `describe-clusters.js` shells out to the local Claude CLI for territory naming — that's the only inference dependency, and it uses the user's own subscription (BYOK, consistent with Component 6).
>
> The original "nobody will [reimplement it]" rationale below is retained only as the argument for *keeping the interface as a clean boundary* — not as a reason to ship empty.

The public boundary between open Mycelium and a (future, optional) closed topology engine. Mycelium defines the interface and ships a working open default; a closed engine could replace it. The math is non-trivial and the pipeline has 6+ months of iteration.

```typescript
// Public interface (ships with Mycelium)
export interface AnalysisEngine {
  analyze(messages: Message[]): Promise<AnalysisResult>;
  getStructure(): Promise<TopologySnapshot>;
  explore(territory: string): Promise<TerritoryDetail>;
  getHarmonics(): Promise<HarmonicState>;
  getTrajectory(): Promise<TrajectoryHistory>;
}

export interface Message {
  id: string;
  content: string;
  created_at: string;
  source: string;
  embedding_768?: number[];
  embedding_256?: number[];
}

export interface AnalysisResult {
  territories: Territory[];
  realms: Realm[];
  bridges: Bridge[];
  orphans: string[];
}

export interface TopologySnapshot {
  territories: Territory[];
  bridges: { source: string; target: string; strength: number }[];
  orphanCount: number;
  bridgeCount: number;
}

export interface TerritoryDetail {
  id: string;
  name: string;
  description: string;
  vitality: number;
  messageCount: number;
  neighbors: { name: string; coFiring: number; semantic: number }[];
  gaps: { name: string; semantic: number; coFiring: number }[];
  sampleMessages: string[];
}

export interface HarmonicState {
  alpha: number;  // spread
  beta: number;   // coherence
  gamma: number;  // novelty rate
  H0: number;     // information entropy
}

export interface TrajectoryHistory {
  phase: string;
  velocity: number;
  direction: number;
  R: number;
  history: { date: string; phase: string; velocity: number }[];
}
```

### Default stub (no topology engine):

```typescript
export class StubAnalysisEngine implements AnalysisEngine {
  async analyze() { return { territories: [], realms: [], bridges: [], orphans: [] }; }
  async getStructure() { return { territories: [], bridges: [], orphanCount: 0, bridgeCount: 0 }; }
  async explore() { throw new Error('No analysis engine configured. Install @mycelium/lumen for topology.'); }
  async getHarmonics() { throw new Error('No analysis engine configured.'); }
  async getTrajectory() { throw new Error('No analysis engine configured.'); }
}
```

**Build estimate:** 0.5 days (interface + stub)

---

## Component 10: BIP-39 Key Management + Setup Flow

```typescript
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import crypto from 'crypto';

// First-run setup
export function setupKeys(): { mnemonic: string; masterKey: Buffer } {
  const mnemonic = generateMnemonic(wordlist, 128); // 12 words
  const seed = mnemonicToSeedSync(mnemonic, '');
  const masterKey = Buffer.from(
    crypto.hkdfSync('sha256', seed, 'mycelium-master-v1', 'master-key', 32)
  );
  return { mnemonic, masterKey };
  // mnemonic shown ONCE to user, then discarded from memory
  // masterKey held in session for encrypt/decrypt operations
}

// Recover from existing phrase
export function recoverKeys(mnemonic: string): Buffer {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error('Invalid seed phrase');
  }
  const seed = mnemonicToSeedSync(mnemonic, '');
  return Buffer.from(
    crypto.hkdfSync('sha256', seed, 'mycelium-master-v1', 'master-key', 32)
  );
}
```

**Build estimate:** 0.5 days

---

## Component 11: Cloudflare Tunnel

Exposes the local Express server to the internet. Required for mobile/remote access.

**Must use an account tunnel** (NOT a quick tunnel — quick tunnels don't support SSE).

### Setup

```bash
# One-time
cloudflared tunnel create mycelium
cloudflared tunnel route dns mycelium mycelium.yourdomain.com

# Run
cloudflared tunnel run mycelium
```

### Config (`~/.cloudflared/config.yml`)

```yaml
tunnel: <tunnel-id>
credentials-file: ~/.cloudflared/cert.pem

ingress:
  - hostname: mycelium.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

SSE keep-alive events within 100s to prevent Cloudflare 524 timeout.

**Build estimate:** 0.5 days (configuration, not code)

---

## The Tools

> ### ⚠️ CORRECTED — ~34 tools (not 37), in `reference/mcp-tools/`, not "the Worker"
>
> Verified reality (`reference/mcp-tools/`, 14 files; `health.js`/`documents.js`/`tasks.js` read directly):
> - **41 tools across 14 files**, not 37. They are **not** Worker HTTP handlers and **not** stdio `server.tool()` registrations — each file is a factory `createXDomain(deps) → { tools, handlers }`, where `tools` is the MCP schema array and `handlers` is `{ name: async (args) => string }`.
> - **Registration contract (4th sweep):** `reference/` carries **no `@modelcontextprotocol/sdk`**. `inputSchema` is **plain JSON-Schema** (`type:'object'`/`properties`/`required` — `documents.js:202`, `tasks.js:28`), **not Zod**, and handlers **return raw strings**, not `{content:[{type:'text',…}]}` envelopes (`documents.js:409`, `health.js:89`). ⇒ Wire with the **low-level MCP `Server` + `ListToolsRequestSchema`/`CallToolRequestSchema`** (JSON-Schema passthrough), **not** `McpServer.tool()` (which expects Zod). Wrap the returned string into a `content` envelope at the single `tools/call` seam.
> - **DB access is dependency-injected:** handlers call a closure-captured `db` namespace (e.g. `db.health.getRange(userId, …)`) backed by a `d1Query(sql, params)` function. The data layer is **all async** (`await d1Query(...)`), so the better-sqlite3 adapter (Component 1) must present an **async, Promise-wrapping** `d1Query`. **Provide it and the entire `reference/core/db-d1/` data layer ports unchanged** — the real "0 rewrites" path, cleaner than copy-pasting from a Worker.
> - **Single-user surface (~34 tools):** **drop** `delegate_to_agent` + `getTeamStatus` (`delegation.js` — multi-agent, hard blockers); **drop `schedule_task` + `list_my_schedules`** (`schedules.js` — **D5**, no scheduler/executor in a pure tool server); **collapse** `create_space`/`seed_space`/`list_spaces` (`spaces.js` — multi-user governance). **Add** the `getContext` preamble tool/resource (**D5**, ported from `core/context-assembly.js`). `flagForDiscussion` (`internal.js`) ports and surfaces *through* `getContext`'s `flagged.md` section.
> - The `reply` tool + `reference/egress/` chokepoints are **largely vestigial in a stdio MCP server** (the agent *is* the client; output returns to it directly). Port the `publishArtifact` chokepoint if V1 ships the publish path; the `/telegram|discord|whatsapp/send` machinery is only load-bearing once V1 adds bot egress.
>
> Register the ~34 single-user tools by porting the `reference/mcp-tools/*` factories and wiring their `tools`/`handlers` into the low-level `Server`. The table below is the original (under-counted) reference.

### Tool groups:

| Group | Tools | Count |
|-------|-------|-------|
| Documents | getDocument, saveDocument, findDocuments, listDocuments, updateDocument, publishDocument, getDocumentShareStatus | 7 |
| Search | searchMindscape | 1 |
| Messages | getDailyMessages | 1 |
| Topology | exploreTerritory, mindscapeStructure, territoryDetail, listTerritories | 4 |
| Harmonics | getHarmonicState, getMetricSeries, getTopMovers, getTrajectoryHistory | 4 |
| Mind Files | readMindFile, editMindFile, writeMindFileWhole, snapshotMindFile, searchMindscape | 5 |
| Calendar | calendar | 1 |
| Model | updateInternalModel, flagForDiscussion | 2 |
| Spaces | create_space, seed_space, list_spaces | 3 |
| Tasks | createTask | 1 |
| Agents | delegate_to_agent, getTeamStatus | 2 |
| Health | getHealthData | 1 |
| Flow | getFlowFeatures, getCurrentPhase, getActiveMilestones, getShape, timeView | 5 |

> **Note:** The dev agent MUST read the actual Worker codebase (`src/tools/` in the mycelium-id/mycelium repo) to get exact schemas and handlers. This table is a reference, not the source of truth.

### Tool Implementation Pattern

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { D1Adapter } from '../adapter/d1.js';
import { decrypt } from '../crypto/envelope.js';

export function registerDocumentTools(server: McpServer, db: D1Adapter, scopeKeys: Map<string, Buffer>) {
  server.tool(
    'getDocument',
    'Retrieve full document content by path',
    { path: z.string().describe('Document path to retrieve') },
    async ({ path }) => {
      const doc = db.prepare('SELECT * FROM documents WHERE path = ?').bind(path).first();
      if (!doc) return { content: [{ type: 'text', text: `Not found: ${path}` }] };

      // Decrypt content if encrypted
      if (doc.encrypted) {
        const key = scopeKeys.get('documents:content');
        if (!key) return { content: [{ type: 'text', text: 'Vault locked — enter seed phrase' }] };
        doc.content = decrypt(key, JSON.parse(doc.content));
      }

      return { content: [{ type: 'text', text: JSON.stringify(doc) }] };
    }
  );
}
```

---

## Client Configurations

### Local (stdio) — Claude Desktop

```json
{
  "mcpServers": {
    "mycelium": {
      "command": "npx",
      "args": ["tsx", "/path/to/mycelium/src/index.ts"],
      "env": {
        "MYCELIUM_DB": "/path/to/mycelium/data/mycelium.db"
      }
    }
  }
}
```

### Remote (HTTP) — Mobile / Claude CLI / Any MCP Client

```json
{
  "mcpServers": {
    "mycelium": {
      "url": "https://mycelium.yourdomain.com/mcp",
      "transport": "streamable-http"
    }
  }
}
```

MCP client handles OAuth automatically — discovers endpoints, opens browser for login, exchanges code for token, attaches Bearer token.

---

## .env Configuration

```bash
# Required
MYCELIUM_DB=./data/mycelium.db
AUTH_SECRET=<openssl rand -hex 32>
AUTH_PASSWORD=<your-password>
PORT=3000

# Optional — cloud inference (BYOK)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Optional — local inference
LOCAL_MODEL=llama3.1
OLLAMA_HOST=http://localhost:11434

# Optional — Cloudflare tunnel
TUNNEL_DOMAIN=mycelium.yourdomain.com
```

---

## Data Import

### Option A: Wrangler export (preferred)

```bash
npx wrangler d1 export mycelium-tenant-martin --output=./data/tenant-export.sql
sqlite3 ./data/mycelium.db < ./data/tenant-export.sql
```

### Option B: API export script

Node script that calls Worker API (`/api/db/query`) per table, handles pagination (messages has 22K+ rows), writes to local SQLite.

### Required tables (all 111, but minimum viable):

**Core:** messages, documents, territories, territory_profiles, territory_neighbors, cluster_bridges, realms, theme_cards

> ### ⚠️ CORRECTED — `wrangler export` + `sqlite3` import alone leaves you with undecryptable data
>
> Production rows are **ciphertext under the old VPS master key**. A raw `wrangler d1 export` → `sqlite3` load copies the ciphertext verbatim; V1's new hex master key (D4) **cannot decrypt it**. Two honest paths:
>
> 1. **Re-key (recommended, preserves encryption end-to-end):** load the encrypted rows, then for each encrypted field run `rewrapEnvelope(envelope, oldMasterKey, newHexMasterKey)` (`crypto-local.js:1146-1188`) — this re-wraps only the DEK, leaving ciphertext/IV intact. Requires the old master key bytes in memory during the one-time migration. `embedding_768` is a `TEXT` field holding a base64(Float32)-then-encrypted envelope, so it re-keys the same way. Write a small migration script (operator-side, not user-facing).
> 2. **Decrypt-on-export (dev only):** export *plaintext* via the Worker API (which holds the old key), then re-encrypt locally under the new hex key on import. Simpler, but plaintext transits the export — acceptable for a dev seed, not for production.
>
> Note: importing pre-computed `embedding_768` vectors is only valid because the embedder is preserved (D2 — same Nomic v1.5 ONNX + prefixes). Had we switched to bare Ollama, imported vectors would be unusable and a full re-embed would be mandatory.

---

## Build Order

> ### ⚠️ CORRECTED — revised build estimate {#revised-build-estimate}
>
> The original 9-11 day plan assumed three things the sweeps disproved: a *stub* topology engine (no pipeline port), *bare-Ollama* embeddings (one tiny file), and *from-scratch* crypto (a few HKDF lines). With the locked decisions, the real scope is: port `crypto-local.js`, port `embed-service.py` (ONNX), port the `mind-search` RAM subsystem (~25 files) + a boot-time rehydrate adapter, and port the open topology pipeline (`cluster.py` + harmonics + cofire + `run-clustering.sh`). Plus OAuth (better-auth — see risk R1 below) is still unproven for the MCP discovery flow. Honest estimate: **~18-24 working days.**

```
Phase 1: Core Server + Data Layer (Days 1-5)
├── Day 1   : D1 adapter (better-sqlite3) + load d1-schema-generated.sql (111 tables, vanilla SQLite — 0 rewrites)
├── Day 2   : Port crypto-local.js envelope + scope guardians + two-key family; hex master key + KCV unlock
├── Day 3   : Port reference/core/db-d1/* over a local d1Query; wire ~34 mcp-tools factories
├── Day 4   : MCP server (Express + SDK + tool registration, stdio + Streamable HTTP)
├── Day 5   : REST API router (same handlers, HTTP routes)

Phase 2: Embeddings + Search (Days 6-9)
├── Day 6   : Port embed-service.py (Nomic v1.5 ONNX + task prefixes, :8091); verify vector parity vs a known sample
├── Day 7-8 : Port mind-search subsystem (ANN + BM25 + RRF) + boot-time rehydrate (decrypt content/vectors into RAM)
├── Day 9   : Wire searchMindscape → mind-search loopback; /internal/v1/search/mindscape

Phase 3: Topology (Days 10-13)
├── Day 10-11: Port cluster.py (FAISS+Leiden+Ward) + run-clustering.sh orchestration
├── Day 12   : Port compute_information_harmonics.py + compute-cofire.js + describe-clusters.js (Claude CLI naming)
├── Day 13   : AnalysisEngine interface wrapping the open pipeline; StubAnalysisEngine fallback when deps absent

Phase 4: Auth + Deployment (Days 14-17)
├── Day 14-15: OAuth 2.1 + PKCE (better-auth) — PROVE the MCP discovery + DCR flow end-to-end early (risk R1)
├── Day 16   : Cloudflare account tunnel (SSE-capable) + agent YAML templates + inference router (Ollama/BYOK)
├── Day 17   : Setup scripts + data-import re-key path (rewrapEnvelope old→hex master)

Phase 5: Integration + Hardening (Days 18-21)
├── Day 18   : Connect Claude Desktop (stdio) + mobile (HTTPS/OAuth); verify the ~34 tools + getContext + encryption round-trip
├── Day 19   : Port the PORT-tagged tests (crypto/envelope, two-key, encryption-coverage, mind-search suite)
├── Day 20   : Edge cases, fail-closed paths, log-redaction, README
├── Day 21   : Soak + buffer

Phase 6: Extensions (later — V2 / post-launch)
├── Browser extension, Telegram/WhatsApp ingestion, publish path + egress chokepoints
├── Multi-user (Postgres + RLS) — see docs/REDESIGN-LIVING-SPEC.md (gated)
├── Federation protocol — see docs/legacy/SOCIAL-SHARING-SPEC-from-legacy.md
```

**Total Phase 1-5: ~18-24 working days** (the spread is OAuth/MCP discovery risk + ONNX/pipeline porting friction).
**Thinnest shippable MVP:** Phases 1-2 + a working `searchMindscape`, deferring topology behind the stub (~9-11 days) — but that ships the *empty mindscape* the original spec described, contradicting D1. Only do this as a deliberate staged cut.

---

## Key Design Decisions

1. **Single process.** MCP + REST + Auth all in one Express server. No microservices.

2. **D1 API compatibility.** Wrapper means zero query rewrites. All 111 tables work unchanged.

3. **User-held hex master key (D4).** The 32-byte master key (64-char hex) is held by the user, never persisted server-side beyond session memory; a KCV guards mistyped pastes. Scope keys (HKDF) derived per-session after unlock. *No BIP-39.*

4. **Plugin boundary for topology (D1) — ships an OPEN default.** The `AnalysisEngine` interface is the swap point, but V1 ships the **ported open pipeline** as the working default; the stub is a fallback. A closed engine *can* replace it later, but the public repo has a real mindscape out of the box.

5. **Dual transport.** stdio for local dev (Claude Desktop spawns process), HTTP for remote/mobile. Same tools, same handlers, same database.

6. **BYOK inference.** User provides their own API keys. Local Ollama for 80% of tasks (free, private). Cloud for complex reasoning (paid, user's account).

7. **No Docker.** Runs directly on the machine. `npm install && npm start`.

---

## Success Criteria

The server is done when:
1. Martin pastes both 64-char hex keys (USER_MASTER + SYSTEM_KEY, D6) → per-key KCV verifies → vault unlocks → data decrypted in session (a wrong/truncated/missing *either* key is rejected, not silently mis-unlocked)
2. Claude Desktop connects via stdio → the ~34 single-user tools (+ `getContext` preamble) work
3. Mobile app connects via HTTPS → OAuth login → tools work through the account tunnel
4. `searchMindscape` returns ranked results from the in-RAM mind-search index (ANN + BM25), content decrypted transparently
5. New messages are encrypted (wrapped-DEK envelope) before writing to SQLite
6. `embed-service.py` (Nomic v1.5 ONNX, correct task prefixes) generates 768D vectors locally; a known sample matches the reference vector
7. REST API serves same tools at `/api/v1/*` with same auth
8. Agent YAML configs filter tool availability per agent
9. `AnalysisEngine` default (ported open pipeline) produces real territories/harmonics; the stub fallback engages cleanly when pipeline deps are absent
10. Imported production data is re-keyed (`rewrapEnvelope` old→hex master) and decrypts in session

---

## Schema Reference

The dev agent MUST read the actual D1 schema (via `wrangler d1 migrations list` or Worker migration files) before building. Key tables:

**messages:** `id, content, role, source, agent_id, space_id, created_at, embedding_768, embedding_256, nlp_processed`

**documents:** `id, path, title, content, summary, folder, scope, source_type, created_by, created_at, updated_at`

**territories:** `id, name, description, realm_id, message_count, vitality, created_at`

**territory_profiles:** `territory_id, description, top_messages, harmonic_state`

**territory_neighbors:** `territory_id, neighbor_id, co_firing_strength, semantic_similarity`

**cluster_bridges:** `source_territory_id, target_territory_id, bridge_strength, bridge_messages`

**realms:** `id, name, description, territory_count`

Production schema has 111 tables. All should be migrated.

---

## Environment

- **Runtime:** Node.js 20+
- **OS:** macOS (Martin's machine) — must work on macOS
- **Ollama:** installed locally for **optional local text inference only** (NOT embeddings — see D2)
- **Python 3 + onnxruntime + huggingface-hub:** for the ported `embed-service.py` (Nomic v1.5 ONNX) and the topology pipeline (`cluster.py` etc.)
- **Cloudflare Tunnel:** `cloudflared` CLI (account tunnel — quick tunnels don't support SSE) for remote access
- **Claude Desktop:** for stdio transport testing
- **No Docker** — runs directly on the machine

---

## Verification table

Every load-bearing assumption in this spec, mapped to where it was verified in `reference/` (read directly, not just cited by a sweep agent). This is the artifact that proves the reconciliation was done against real code.

| # | Assumption | Verdict | Verified at |
|---|---|---|---|
| 1 | Schema is vanilla SQLite, 111 tables, runs on `better-sqlite3` with 0 rewrites | ✅ holds | `reference/schema/d1-schema-generated.sql:16` (111 tables); FTS5 at `:2005` (standard), BLOB cols, no generated columns / D1 pragmas |
| 2 | Tools copy-paste "from the Worker `src/tools/`" | ❌ wrong location/shape | `reference/mcp-tools/*` are `createXDomain(deps)→{tools,handlers}` factories; `reference/mcp-tools/health.js:19-94` (read directly) |
| 3 | Tool count = 37 | ❌ 41 across 14 files | `reference/mcp-tools/` (14 files; per-file tool arrays) |
| 4 | DB access ports via a local `d1Query` injection (the real "0 rewrites") | ✅ holds | `reference/core/db-d1/spaces.js:17-20` (`d1Query` typedef); `health.js:40-51` (closure `db` namespace) |
| 5 | `delegate_to_agent` / `getTeamStatus` are multi-agent (drop for single-user) | ✅ confirmed | `reference/mcp-tools/delegation.js:38,56` |
| 6 | Encryption envelope is `{iv,ct,tag,scope}`, content encrypted directly by scope key | ❌ wrong | real envelope `{v,s,iv,ct,dk}` w/ wrapped DEK + AES-KW, `reference/encryption/crypto-local.js:1016-1026` (read directly); v3 `kf:'system'` at `:1055-1062` |
| 7 | Key derivation: HKDF info `mycelium/v1/scope/<scope>` | ❌ wrong strings | actual: `mycelium:scope:<scope>:v1` and `mycelium:system-scope:<scope>:v1`, zero salt, SHA-256 (`crypto-local.js:807-894`) |
| 8 | BIP-39 / mnemonic exists today | ❌ zero hits (genuinely new) — and **dropped from V1 (D4)** | grep `bip39`/`mnemonic`/`@scure/bip39` across `reference/` = 0 |
| 9 | Re-keying path exists for import | ✅ `rewrapEnvelope()` | `reference/encryption/crypto-local.js:1146-1188`; test `reference/tests/master-key-rotation.test.js:29-49` |
| 10 | Master key is 32 bytes loaded as hex (reuse existing path) | ✅ holds | `crypto-local.js:561-671` (tmpfs/env hex load); `DEK_BITS=256`, `IV_BYTES=12`, `TAG_LENGTH=128` |
| 11 | Embeddings = bare Ollama `nomic-embed-text`, 768D, compatible | ❌ incompatible | `reference/pipeline/embed-service.py:61-74` (read directly): Nomic v1.5 ONNX + mandatory `search_query:`/`search_document:` prefixes; `cluster.py:77` `clustering:` prefix + 256D matryoshka |
| 12 | `embedding_768` storage portable | ✅ TEXT = base64(Float32) inside encryption envelope | `reference/mind-search/ann/decode.js:50-59,69-96,107-134` |
| 13 | `searchMindscape` = FTS5 + vector SQL | ❌ FTS5 unused; in-RAM ANN+BM25+RRF | `reference/mind-search/backend/local.js:115-225`; `reference/core/db-d1/messages.js:397-433`; rehydrate `reference/mind-search/d1-loader.js:85-127` |
| 14 | Search content must be decrypted into RAM at boot | ✅ confirmed (security note) | `reference/mind-search/d1-loader.js:85-127` (decrypt content + vectors into in-process index) |
| 15 | Topology is a closed plugin; ship a stub | ❌ fully open & portable | `reference/pipeline/cluster.py` (FAISS+Leiden+Ward, open libs), `compute_information_harmonics.py`, `compute-cofire.js`; all write queryable D1 tables; no external/proprietary calls |
| 16 | Topology naming dependency | ✅ local Claude CLI only (BYOK) | `reference/pipeline/describe-clusters.js:74-88` |
| 17 | Egress chokepoints load-bearing in V1 | ⚠️ largely vestigial for stdio MCP | `reference/egress/send-handler.js`, `inbound-context.js`, `reply.js:97-185` (only matters once bots/publish ship) |
| 18 | Tool `inputSchema` is JSON-Schema (not Zod); handlers return raw strings (not MCP content envelopes) | ✅ confirmed (4th sweep) → use low-level `Server`, wrap string→`content` at the seam | `reference/mcp-tools/documents.js:202` (JSON-Schema), `tasks.js:28`; returns `documents.js:409`, `health.js:89`; **no `@modelcontextprotocol/sdk`** in `reference/` |
| 19 | Data layer is async (`await d1Query`) but better-sqlite3 is sync | ✅ confirmed (4th sweep) → adapter must Promise-wrap `(sql,params)→Promise<{results}>` | `reference/core/db-d1/users.js:21`, `documents.js:79` (all `await d1Query(...)` + `firstRow()`) |
| 20 | `schedule_task`/`list_my_schedules` have no executor in a tool server (drop, D5) | ✅ confirmed | `reference/mcp-tools/schedules.js:117,134`; no scheduler runtime ported under D5 |
| 21 | `context-assembly` is portable as an on-demand preamble (D5) | ✅ holds | `reference/core/context-assembly.js:79` (`assembleContext()→markdown`, incl. `flagged.md`/mind files/recent messages) |
| 22 | Enrichment service exists in `reference/` to port (D7) | ❌ service absent; only its **contract** present → **build-new** | `reference/server-routes/portal-enrichment.js` (driver router, :8095) + `messages` NLP columns/index `d1-schema-generated.sql:950,1832,1835`; no `enrich-service` in `reference/pipeline/` |

## Risks & mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **better-auth's OAuth provider may not satisfy the MCP discovery + DCR + PKCE flow** that Claude Desktop/mobile expect. The spec's `auth.ts` (~5 LOC) hand-waves "endpoints created automatically." Not verifiable from `reference/` (external dep). | Medium | High (blocks remote/mobile) | **Prove it on Day 14-15, not Day 17.** Spike the full discovery → register → authorize → token → bearer flow against a real MCP client before committing. Fallback: a thin hand-rolled OAuth 2.1 provider. |
| R2 | **Embedding vector parity** — even Nomic-ONNX vs a different runtime/quantization can drift. | Low-Med | High (search/cluster recall) | Day 6 gate: embed a fixed sample, assert cosine ≥ 0.999 vs a reference vector exported from the canonical service before trusting imports. |
| R3 | **mind-search port is bigger than budgeted** (~25 files + rehydrate adapter + scan-matchers). | Medium | Med | Port the test suite (`reference/tests/mind-search/`, 25 files) alongside; it pins expected behavior. Stage a brute-force-cosine fallback if RRF/BM25 slips. |
| R4 | **Plaintext-in-RAM search index** holds decrypted content — same accepted risk as canonical (CLAUDE.md §1.7). | n/a (accepted) | — | Document explicitly; never log index contents; single-user lowers blast radius vs the multi-tenant V2 concern. |
| R5 | **Import re-key requires the old master key** in memory during migration. | Low | Med | One-time operator-side script; never persist old key; verify KCV post-migration. |
| R6 | **Python pipeline as a self-hosted dependency** raises the install bar (onnxruntime, faiss, leidenalg). | Medium | Med | Ship a `setup.sh` that pins versions; the stub `AnalysisEngine` is the graceful degradation if a user can't install the pipeline. |
| R7 | **Topology orchestrator gap** — `run-clustering.sh` calls 12 scripts but only 5 are present in `reference/pipeline/` (the other 7 — `sync-clustering-points.js`, `describe-chronicles.js`, `embed-mindscape.js`, `topology-audit.js`, `compute-vitality.js`, `compute-cognitive-fingerprint.js`, `check-milestones.js` — are absent). | High (certain) | Med | Do **not** port `run-clustering.sh` verbatim. Write a slim orchestrator around the 5 present scripts + a fresh `sync-clustering-points`. Don't budget the missing 7 as "ports." See `docs/V1-IMPLEMENTATION-PLAN.md` Phase 3. |
| R8 | **Enrichment service is build-new (D7)** — only its contract (`portal-enrichment.js` + `messages` NLP columns) exists in `reference/`; the :8095 worker, NLP tagger, and `nlp_processed` state machine must be built fresh. | High (certain) | Med (+2-4 days) | Build against the documented contract (`d1-schema-generated.sql:950,1832,1835`); ship interim **inline embed-on-write** so search works if the async pipeline slips; design crash-recovery via the 60s stale-heartbeat → abandoned transition. See `docs/V1-IMPLEMENTATION-PLAN.md` Step 11b. |

## Open questions deferred (out of V1 scope)

- **Bots / ingestion / publish path** → Phase 6. Egress chokepoints become load-bearing only then.
- **Server-side scheduler + autonomous `/chat` loop, lanes/recovery/compaction** → **Phase 5: Extensions** (D5 defers them; V1 is a pure tool server). `schedule_task`/`list_my_schedules` re-enter when an executor exists.
- **Multi-user, Postgres, RLS, federation** → `docs/REDESIGN-LIVING-SPEC.md` (gated; do not start until V1 ships + validates).
- **Org/wealth/moms scopes** → only if those agents ship; V1 collapses to `personal` + `system`.

## Revision history

- **v1.0 — original draft.** Self-hosted single-user MCP server; 9-11 day estimate; BIP-39 12-word; bare-Ollama embeddings; fresh `{iv,ct,tag}` crypto; closed-Lumen topology stub; "37 tools from the Worker."
- **v1.1 — 2026-05-29 — ironed-out.** Reconciled against `reference/` via `sweep-first-design` (4 parallel Explore sweeps + direct code reads; full Verification table above). Four operator decisions locked (D1 open topology / D2 ONNX embeddings / D3 port crypto-local / D4 hex master key, no BIP-39). Pivots: crypto envelope, embeddings, search, topology default, tool count/shape, data-import re-key. Estimate revised to ~18-24 working days. Risks R1-R6 + deferred-questions sections added. *Original prose preserved with inline `⚠️ CORRECTED` blocks; sample code marked superseded where it actively misleads.*
- **v1.2 — 2026-05-29 — three more decisions (this revision).** Folded in **D5–D7** + a 4th sweep (db-d1 import graph + tool-registration contract). **D5:** V1 is a **pure tool server** — no server-side `/chat` loop, scheduler, lanes, recovery, or compaction; `context-assembly` ships as an on-demand `getContext` preamble tool/resource; `schedule_task`/`list_my_schedules` dropped → **~34 tools**. **D6:** two independent hex keys (USER_MASTER + SYSTEM_KEY), each with its own KCV. **D7:** the :8095 enrichment service is **build-new** (only its contract is in `reference/`) → +2-4 days, R8. Sweep confirmed: tool `inputSchema` is **JSON-Schema not Zod** + handlers return **raw strings** ⇒ wire the **low-level MCP `Server`** and wrap string→`content` at the seam; data layer is **async** ⇒ the better-sqlite3 adapter must Promise-wrap `d1Query`. Verification rows 18-22 added.

> **Reconcile in CLAUDE.md:** the V1↔V2 table still lists "BIP-39 (12-word)" for V1 — superseded by **D4** (hex master key, no BIP-39) and **D6** (two hex keys, USER_MASTER + SYSTEM_KEY). The "~36 single-user tools" / "no autonomous loop" framing should reflect **D5** (~34 tools + `getContext` preamble; pure tool server) and the build-new enrichment service (**D7**). Update on next pass.

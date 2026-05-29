# Mycelium Self-Hosted Server — Complete Build Spec

**Purpose:** A self-hosted MCP server that exposes Mycelium's tools over HTTPS with end-to-end encryption. Users run it on their own machine or VPS. Their data never leaves their hardware. Encryption keys derive from a 12-word seed phrase they control.

**Target:** Dev agent builds this in 11 days (Phase 1-4). Shippable MVP in 9 days (Phase 1-3).

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
│   │   ├── search.ts         # searchMindscape (FTS5 + vector)
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
}
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

**Non-negotiable.** All data encrypted at rest. Keys derive from a 12-word BIP-39 seed phrase the user controls. Server never sees the master key or seed phrase.

### Key derivation (`src/crypto/bip39.ts`)

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

## Component 5: Local Embeddings (`src/embed/ollama.ts`)

```typescript
export async function embed(texts: string[]): Promise<number[][]> {
  const res = await fetch('http://localhost:11434/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', input: texts }),
  });
  return (await res.json()).embeddings; // 768D vectors
}
```

Setup: `ollama pull nomic-embed-text`

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

The public boundary between open Mycelium and closed Lumen topology engine. Mycelium defines the interface; Lumen implements it. Someone else could write a different implementation, but nobody will — the math is non-trivial and the pipeline has 6+ months of iteration.

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

## The 37 Tools

The dev agent should register all 37 tools from the production Mycelium Worker. The tool schemas and handlers can be copy-pasted from the Worker codebase, with D1 calls going through the D1 Adapter.

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

**Encryption note:** Production data is encrypted per-row. Import options:
1. Export decrypted via Worker API (quick, for dev)
2. Export encrypted, decrypt locally with seed phrase (proper, for production)

---

## Build Order

```
Phase 1: Core Server (Days 1-4)
├── Day 1: D1 adapter + schema migration from D1 → SQLite
├── Day 2: Ollama embedding integration + test
├── Day 3: MCP server (Express + SDK + tool registration)
├── Day 4: REST API router (same handlers, HTTP routes)

Phase 2: Auth + Encryption (Days 5-7)
├── Day 5: BIP-39 seed generation + master key derivation
├── Day 6: HKDF scope keys + AES-256-GCM encrypt/decrypt
├── Day 7: better-auth OAuth 2.1 (authorize, token, DCR, discovery)

Phase 3: Deployment (Days 8-9)
├── Day 8: Cloudflare Tunnel + agent YAML templates
├── Day 9: Setup scripts + import from cloud export + inference router

Phase 4: Integration Testing (Days 10-11)
├── Day 10: Connect Claude Desktop + mobile, verify all tools + encryption
├── Day 11: Edge cases, error handling, README, AnalysisEngine stub

Phase 5: Extensions (Week 3+)
├── Browser extension (Chrome/Firefox conversation capture)
├── Telegram bot ingestion
├── Multi-user (Postgres + RLS)
├── Federation protocol
```

**Total Phase 1-4: 11 days**
**Shippable MVP (Phase 1-3): 9 days**

---

## Key Design Decisions

1. **Single process.** MCP + REST + Auth all in one Express server. No microservices.

2. **D1 API compatibility.** Wrapper means zero query rewrites. All 111 tables work unchanged.

3. **Client-side key derivation.** Server never sees the master key or seed phrase. Scope keys derived per-session after unlock.

4. **Plugin boundary for topology.** Public repo works without clustering/co-firing. Private topology engine plugs in for Mycelium users.

5. **Dual transport.** stdio for local dev (Claude Desktop spawns process), HTTP for remote/mobile. Same tools, same handlers, same database.

6. **BYOK inference.** User provides their own API keys. Local Ollama for 80% of tasks (free, private). Cloud for complex reasoning (paid, user's account).

7. **No Docker.** Runs directly on the machine. `npm install && npm start`.

---

## Success Criteria

The server is done when:
1. Martin enters seed phrase → vault unlocks → all data decrypted in session
2. Claude Desktop connects via stdio → 37 tools work
3. Mobile app connects via HTTPS → OAuth login → tools work through tunnel
4. `searchMindscape` returns encrypted data, decrypted transparently
5. New messages are encrypted before writing to SQLite
6. Ollama generates embeddings for new content locally
7. REST API serves same tools at `/api/v1/*` with same auth
8. Agent YAML configs filter tool availability per agent
9. AnalysisEngine plugin interface exists (stub for now, Lumen plugs in later)

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
- **Ollama:** installed locally for embeddings + local inference
- **Cloudflare Tunnel:** `cloudflared` CLI for remote access
- **Claude Desktop:** for stdio transport testing
- **No Docker** — runs directly on the machine

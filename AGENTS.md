# Mycelium

Multi-agent orchestration framework. Persistent AI agents with encrypted memory,
autonomous scheduling, inter-agent delegation, and a full web portal. Built on
Claude, Cloudflare D1/Vectorize/R2, and Node.js.

## Quick Start

```bash
npm install
cp .env.example .env        # Configure credentials
node agent-server.js         # Run single agent
pm2 start ecosystem.config.cjs  # Run all agents
```

Requires: Node.js 22+, Claude CLI (`claude`), PM2.

## Architecture

```
orchestrator.js          Routing, agent CRUD, watchdog (port 3000)
agent-server.js          Main agent process — all agents use this binary
├── lib/runner.js        Claude CLI subprocess wrapper
├── lib/context-assembly.js  Build context from memory + DB + search
├── lib/db-d1.js         D1 database client (auto-encrypt/decrypt)
├── lib/delegation.js    Inter-agent task delegation
├── lib/scheduler.js     Autonomous cycles (dreams, reflections)
├── lib/tasks.js         In-memory task queue with checkpoints
└── lib/crypto-local.js  AES-256-GCM encryption (master key on VPS only)

worker/src/              Cloudflare Worker (TypeScript)
├── index.ts             Route dispatch, enrichment, AI endpoints
├── handlers/db-proxy.ts SQL proxy (passthrough, no crypto)
├── handlers/secrets-api.ts  Encrypted secrets vault
├── middleware/agent-auth.ts Per-agent token auth
└── services/crypto.ts   Envelope format definitions

portal/                  SvelteKit web app (static adapter)
├── src/routes/(app)/    Chat, Mindscape 3D, Library, Wealth, Intel, Import
├── src/lib/stores/      Svelte 5 runes stores
└── src/lib/components/  Reusable UI components

mcp/                     MCP tool servers (51 tools total)
├── mya-tools.js         16 tools: documents, mindscape, tasks, search
├── wealth-tools.js      16 tools: portfolios, transactions, positions
├── ops-tools.js         8 tools: email, Google Drive
├── linear-tools.js      6 tools: issues, comments
└── polymarket-tools.js  5 tools: markets, signals

agents/                  Per-agent config (JSON)
├── personal-agent.json  Mya — personal agent (port 3004)
├── company-agent.json   Com — company operations (port 3002)
├── research-agent.json  Ada — research (port 5002)
├── commercial-intelligence-agent.json  Rex (port 5004)
├── intel-agent.json     Apollo — geopolitical intel (port 5006 area)
├── publishing-agent.json Noa (port 5006)
├── wealth-agent.json    Rob (port 5010)
├── ops-agent.json       Ops — DevOps/infrastructure
├── moms-agent.json      Mom's personal agent
└── qa-agent.json        QA testing

scripts/                 Operational scripts
├── cluster.py           FAISS + Leiden clustering (Python)
├── enrichment-daemon.js Persistent NLP tagging + embedding
├── describe-chronicles.js  Territory narrative generation
├── run-clustering.sh    Pipeline orchestrator
├── classify-contacts.js Contact engagement tiers
├── link-contacts.py     Contact-territory linking
└── backfill-enrich.js   Batch enrichment

migrations/              102 D1 migration files (001-102)
```

## Build & Test

```bash
npm test                           # Node.js test runner
cd portal && npm run build         # Build SvelteKit portal
cd worker && npx wrangler deploy   # Deploy Cloudflare Worker
pm2 restart <agent-name>           # Restart single agent
pm2 delete <name> && pm2 start ecosystem.config.cjs --only <name>  # Re-read env
```

## Code Conventions

- **ESM** everywhere (`import`/`export`). Only exception: `ecosystem.config.cjs` (PM2 requires CJS).
- **Express 5** for HTTP. Async route handlers, no callback patterns.
- **Cloudflare D1** for all persistent storage. Never use SQLite directly.
- **Svelte 5** with runes (`$state`, `$derived`, `$effect`) in portal. No Svelte 4 patterns.
- **Tailwind CSS** + CSS custom properties in portal. Design tokens in `portal/src/lib/styles/tokens.css`.
- **Geist** font family throughout (sans + mono: JetBrains Mono).
- Async/await with try/catch. Errors reported to Sentry when configured.
- No TypeScript on VPS (only in `worker/src/`). All VPS code is plain JS with JSDoc where needed.

### Key Patterns

- **Claude subprocess**: See `lib/runner.js` — spawns `claude` CLI with `--print`, streams output, handles continuation.
- **MCP tool definition**: See `mcp/mya-tools.js` — JSON schema per tool, handler functions, stdio transport.
- **Inter-agent delegation**: See `lib/delegation.js` — HTTP POST to target agent's `/chat` endpoint with task context.
- **Database queries**: See `lib/db-d1.js` — `d1Query(sql, params, opts)` with transparent encryption. All writes auto-encrypt, all reads auto-decrypt.
- **Scheduler cycles**: See `lib/scheduler.js` — cron-like with `runCycle()`, checks cooldowns, calls Claude via runner.
- **Agent config**: See `agents/personal-agent.json` — identity, prompt path, port, Discord channel, MCP tools list.

## Database

Cloudflare D1 (SQLite). 102 migrations in `migrations/`. Key tables:

| Table | Purpose |
|-------|---------|
| `messages` | All conversations (encrypted: content, thinking) |
| `documents` | Living documents (encrypted: content, summary) |
| `people` | Contact graph (encrypted: name, email, company, etc.) |
| `clustering_points` | Nomic 256D embeddings for mindscape |
| `territory_profiles` | Cluster descriptions and chronicles |
| `wealth_*` (8 tables) | Portfolio tracking |
| `health_daily` | Apple Health metrics (encrypted) |
| `secrets` | Encrypted config secrets |
| `agent_events` | Agent activity log |
| `agent_tasks` | Task queue persistence |

Vectorize indexes: `mycelium-search` (BGE-M3 1024D), `mycelium-cluster` (Nomic 256D).

## Encryption

AES-256-GCM envelope encryption. Master key on VPS only — Cloudflare Worker stores ciphertext, cannot decrypt.

- 3 scopes: `personal`, `org`, `wealth` (+ `moms`)
- Per-record DEK wrapped by scope key via AES-KW
- HKDF-SHA256 key derivation from master key
- Transparent: `db-d1.js` auto-encrypts on write, auto-decrypts on read
- See `lib/crypto-local.js` for implementation, `docs/ENCRYPTION.md` for architecture

## API Endpoints (120+)

Agent server exposes these on each agent's port:

**Core**: `POST /chat`, `POST /think`, `GET /status`, `GET /health`
**Tasks**: `GET/POST /tasks`, `POST /tasks/:id/cancel`
**Portal**: `GET /portal/conversations`, `GET /portal/messages/:id`, `GET /portal/documents`, `GET /portal/search`
**Mindscape**: `GET /portal/mindscape/*` (territories, realms, activations, growth, cofire, noise-stats)
**Wealth**: `GET/POST /portal/wealth/*` (portfolios, positions, transactions, snapshots, sync)
**Intel**: `GET /portal/intel/*` (reports, signals, actors, Polymarket proxy)
**Social**: `GET /portal/contacts`, `GET /portal/contacts/:id`
**Health**: `GET /portal/health/summary`
**Auth**: `POST /auth/register`, `POST /auth/authenticate`, `GET /auth/session`
**Import**: `POST /import/upload`
**Settings**: `GET/POST /settings`

Worker endpoints (Cloudflare): `POST /api/db/query`, `POST /api/db/batch`, `GET/PUT/DELETE /api/secrets`, `POST /api/enrich`, `POST /api/embed`, `POST /api/search/*`, `POST /api/vectors/*`

## Adding a New Agent

```bash
npm run add-agent <agent-id>   # Scaffold config + directories
```

This creates `agents/<agent-id>.json` with identity, port, prompt path, MCP tools. Then:
1. Add agent token to Worker's `AGENT_REGISTRY` secret
2. Add PM2 entry in `ecosystem.config.cjs`
3. Write system prompt in `agents/<agent-id>/prompts/system.md`
4. Deploy: `pm2 start ecosystem.config.cjs --only <agent-id>`

See `docs/AUTONOMOUS.md` for scheduling configuration.

## Security Constraints

- Master encryption key stays on VPS. Never in Worker secrets, never in git.
- Per-agent tokens (`tok_xxx_...`). Agents only see data matching their scope.
- Portal auth via WebAuthn passkeys (no passwords).
- All bot listeners bound to `127.0.0.1` (not `0.0.0.0`).
- CORS restricted to `mya.is` + `localhost:5173`.
- SQL injection: whitelisted table/column names in db-proxy.
- See `docs/SECURITY-HARDENING.md` for full audit.

## Portal

SvelteKit with static adapter. Build output: `portal/build/`.

**Do NOT modify portal files from agents.** Portal is deployed manually by the owner only.
To expose new data: add API endpoints in `agent-server.js` — the portal consumes them.

## Common Operations

```bash
# Deploy worker
cd worker && npx wrangler deploy

# Deploy portal
cd portal && npm run build
scp -r portal/build mycelium-vps:~/mycelium/portal/

# Run migration
cd worker && npx wrangler d1 execute mycelium-v2 --remote --file=../migrations/NNN_name.sql

# Run clustering pipeline
bash scripts/run-clustering.sh

# Check agent logs
ssh mycelium-vps 'pm2 logs <agent-name> --lines 50 --nostream'
```

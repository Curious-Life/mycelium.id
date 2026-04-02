# Self-Hosting Mycelium

Deploy your own multi-agent system on your own infrastructure.

## Architecture Overview

```
YOUR VPS (Ubuntu 24.04+)
├── PM2 (process manager)
├── Claude CLI (agent runtime)
├── Agent servers (Express, one per agent)
├── Discord/Telegram bots (optional)
├── Portal (SvelteKit web UI)
└── Caddy (reverse proxy + auto-TLS)

CLOUDFLARE (managed services)
├── Worker (API proxy + encryption layer)
├── D1 (SQLite database)
├── Vectorize (semantic search indexes)
├── R2 (file/attachment storage)
├── KV (caching + dedup)
└── Workers AI (transcription, embeddings)
```

---

## Prerequisites

- **VPS**: Ubuntu 24.04+ with 4GB+ RAM, 2+ cores
- **Domain**: For TLS and portal access (e.g., `agents.yourdomain.com`)
- **Cloudflare account**: Free tier works for most resources; Workers Paid plan needed for extended CPU limits
- **Claude subscription(s)**: Each agent uses Claude CLI, which requires a Pro/Team subscription. One subscription can run multiple agents, or you can assign dedicated subscriptions per agent.
- **Discord server** (optional): For agent chat channels
- **Telegram bot** (optional): For mobile messaging

---

## Step 1: Clone the Repository

```bash
git clone https://github.com/your-org/mycelium.git
cd mycelium
```

---

## Step 2: Cloudflare Setup

### 2.1 Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2.2 Create Resources

Run these from the `worker/` directory:

```bash
cd worker

# Create D1 database
npx wrangler d1 create mycelium-db
# Note the database_id from the output

# Create Vectorize indexes
npx wrangler vectorize create mycelium-search \
  --dimensions=1024 --metric=cosine
npx wrangler vectorize create mycelium-cluster \
  --dimensions=256 --metric=cosine

# Create R2 bucket
npx wrangler r2 bucket create mycelium-attachments

# Create KV namespace
npx wrangler kv namespace create KV
# Note the namespace id from the output

# Create Queue (for async Telegram processing)
npx wrangler queues create mycelium-telegram
npx wrangler queues create mycelium-telegram-dlq
```

### 2.3 Update wrangler.toml

Edit `worker/wrangler.toml` with your resource IDs:

```toml
name = "mycelium"                          # Your worker name
main = "src/index.ts"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]

[limits]
cpu_ms = 30000

[ai]
binding = "AI"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "mycelium-attachments"       # Your bucket name

[[kv_namespaces]]
binding = "KV"
id = "YOUR_KV_NAMESPACE_ID"               # From step 2.2

[[queues.producers]]
binding = "TELEGRAM_QUEUE"
queue = "mycelium-telegram"

[[queues.consumers]]
queue = "mycelium-telegram"
max_batch_size = 1
max_batch_timeout = 0
max_retries = 2
dead_letter_queue = "mycelium-telegram-dlq"

[[d1_databases]]
binding = "DB"
database_name = "mycelium-db"              # Your database name
database_id = "YOUR_D1_DATABASE_ID"        # From step 2.2

[[vectorize]]
binding = "VECTORS_1024"
index_name = "mycelium-search"

[[vectorize]]
binding = "VECTORS_256"
index_name = "mycelium-cluster"

[vars]
ENVIRONMENT = "production"
```

### 2.4 Run Migrations

Apply all database migrations in order:

```bash
cd worker
for f in ../migrations/*.sql; do
  echo "Applying $f..."
  npx wrangler d1 execute mycelium-db --remote --file="$f"
done
```

> Some migrations may fail if they reference existing data. The initial schema migrations (001-010) are the critical ones. Later migrations add features incrementally.

### 2.5 Deploy Worker

```bash
cd worker
npx wrangler deploy
```

Note your Worker URL (e.g., `https://mycelium.YOUR_SUBDOMAIN.workers.dev`).

### 2.6 Set Worker Secrets

Generate tokens and set them:

```bash
cd worker

# Admin secret (for protected endpoints)
echo $(openssl rand -hex 32) | npx wrangler secret put ADMIN_SECRET

# Legacy shared secret (being phased out, but still needed)
echo $(openssl rand -hex 24) | npx wrangler secret put MYA_WORKER_SECRET

# Claude API key (for worker-side AI features)
echo "sk-ant-YOUR_KEY" | npx wrangler secret put CLAUDE_API_KEY

# OpenAI API key (for embeddings)
echo "sk-YOUR_KEY" | npx wrangler secret put OPENAI_API_KEY
```

### 2.7 Agent Registry

The Worker authenticates each agent via per-agent tokens stored in `AGENT_REGISTRY`. Generate tokens for each agent you plan to run:

```bash
# Generate tokens
COM_TOKEN=$(openssl rand -hex 24)
MYA_TOKEN=$(openssl rand -hex 24)

# Build registry JSON
cat <<EOF > /tmp/registry.json
{
  "$COM_TOKEN": {
    "agent": "company-agent",
    "name": "Com",
    "user_id": "system",
    "scopes": ["org"]
  },
  "$MYA_TOKEN": {
    "agent": "personal-agent",
    "name": "Mya",
    "user_id": "system",
    "scopes": ["personal", "org"]
  }
}
EOF

# Set as Worker secret
cat /tmp/registry.json | npx wrangler secret put AGENT_REGISTRY
rm /tmp/registry.json

# Save these tokens — you'll need them in .env later
echo "COM_TOKEN=$COM_TOKEN"
echo "MYA_TOKEN=$MYA_TOKEN"
```

Add more agents to the registry as needed. Scopes control encryption access:
- `personal` — private agent memories
- `org` — shared company knowledge
- `wealth` — financial data (if using wealth module)

---

## Step 3: VPS Setup

### Option A: Automated Setup

```bash
# SSH to your VPS as root, then:
bash scripts/server-setup.sh
```

This installs Node.js 22, PM2, Claude CLI, Caddy, and configures the firewall.

### Option B: Manual Setup

If you prefer to set things up yourself:

1. **Node.js 22+**: `curl -fsSL https://deb.nodesource.com/setup_22.x | bash && apt install nodejs`
2. **PM2**: `npm install -g pm2`
3. **Claude CLI**: `npm install -g @anthropic-ai/claude-code`
4. **Caddy** (or nginx): For reverse proxy + auto-TLS

### Install Dependencies

```bash
su - claude  # or your deploy user
cd ~/mycelium
npm install
cd portal && npm install && cd ..
```

---

## Step 4: Environment Configuration

Copy the template and fill in your values:

```bash
cp .env.example .env
```

### Minimum Required Variables

```bash
# --- Core ---
CLAUDE_BIN=/usr/bin/claude
MYA_USER_ID=$(uuidgen)        # Generate once, use forever

# --- Database ---
DB_BACKEND=d1
MYA_WORKER_URL=https://mycelium.YOUR_SUBDOMAIN.workers.dev
MYA_WORKER_SECRET=<from step 2.6>

# --- Agent Tokens (from step 2.7) ---
AGENT_TOKEN_COM=<com-token>
AGENT_TOKEN_MYA=<mya-token>
# Add more as you add agents

# --- Portal ---
FRONTEND_URL=https://agents.yourdomain.com
PASSKEY_RP_ID=agents.yourdomain.com
PASSKEY_RP_NAME=Mycelium
PASSKEY_RP_ORIGIN=https://agents.yourdomain.com
```

### Optional Integrations

```bash
# --- Discord ---
DISCORD_BOT_TOKEN=<main-bot-token>
DISCORD_ALLOWED_SERVERS=<server-id>
DISCORD_ALLOWED_USERS=<your-user-id>
DISCORD_COMPANY_CHANNEL=<channel-id>
# Per-agent bot tokens for dedicated channel bots
DISCORD_RESEARCH_BOT_TOKEN=<token>

# --- Telegram ---
TELEGRAM_BOT_TOKEN=<token>
OWNER_TELEGRAM_ID=<your-telegram-id>

# --- Claude Multi-Account (one subscription per agent) ---
CLAUDE_CONFIG_DIR=/home/claude/.claude
#CLAUDE_CONFIG_DIR_COM=/home/claude/.claude-com
#CLAUDE_CONFIG_DIR_MYA=/home/claude/.claude-mya

# --- Google (Gmail + Drive tools) ---
GOOGLE_CLIENT_ID=<client-id>
GOOGLE_CLIENT_SECRET=<client-secret>
GOOGLE_REFRESH_TOKEN=<token>

# --- Sentry (error tracking) ---
SENTRY_DSN=<dsn-url>

# --- Cloudflare R2 (direct upload from VPS) ---
CLOUDFLARE_ACCOUNT_ID=<account-id>
R2_ACCESS_KEY_ID=<key>
R2_SECRET_ACCESS_KEY=<secret>
```

### Split .env Files (Recommended for Production)

For better security, split secrets across multiple files:

```
.env            — Core app settings
.env.discord    — Discord bot tokens
.env.database   — Database credentials
.env.crypto     — Encryption keys
.env.agents     — Per-agent tokens (Telegram, etc.)
.env.cloudflare — Cloudflare account info
```

The `ecosystem.config.cjs` loads all six via dotenv. See `docs/SECURITY-HARDENING.md` for details.

---

## Step 5: Authenticate Claude CLI

Each agent process spawns Claude CLI sessions. You need at least one authenticated subscription:

```bash
# Shared auth (all agents use this by default)
claude auth login

# Per-agent auth (optional, for dedicated subscriptions)
CLAUDE_CONFIG_DIR=/home/claude/.claude-com claude auth login
CLAUDE_CONFIG_DIR=/home/claude/.claude-mya claude auth login
```

> **Important**: OAuth tokens expire. If an agent stops working, check `claude auth status` with the correct `CLAUDE_CONFIG_DIR`.

---

## Step 6: Configure Agents

### ecosystem.config.cjs

This file defines all PM2 processes. The default config runs the full agent roster. To start with fewer agents, comment out the ones you don't need.

**Minimum viable setup** — just a personal agent + portal:

```javascript
// In the apps array, keep only:
// - personal-agent (port 3004)
// - mycelium-portal (port 5173)
// Comment out everything else
```

### Agent System Prompts

Each agent reads its system prompt from `~/agents/<agent-id>/prompts/system.md`. Create these before starting agents:

```bash
mkdir -p ~/agents/personal-agent/prompts
cat > ~/agents/personal-agent/prompts/system.md << 'EOF'
# Personal Agent

You are a personal AI assistant. Be helpful, direct, and concise.
Store important information in your memory files for future reference.
EOF
```

### Adding New Agents

Use the provisioning script:

```bash
./scripts/add-agent.sh \
  --id writer-agent \
  --name Writer \
  --port 5014 \
  --bot-port 5015 \
  --channel <discord-channel-id> \
  --start
```

This creates the directory structure, Discord bot config, system prompt template, and env vars.

---

## Step 7: Build & Deploy Portal

```bash
cd portal
npm run build
cd ..
```

The portal is a SvelteKit app using adapter-node. PM2 serves it on port 5173.

### Portal Authentication

The portal uses WebAuthn passkeys. On first visit, you'll register a passkey tied to your domain. Make sure `PASSKEY_RP_ID` and `PASSKEY_RP_ORIGIN` match your actual domain.

---

## Step 8: Configure Reverse Proxy

### Caddy (recommended)

```
# /etc/caddy/Caddyfile

agents.yourdomain.com {
    # Portal
    reverse_proxy /portal/* localhost:5173
    reverse_proxy / localhost:5173

    # Agent API (personal agent serves portal API)
    reverse_proxy /api/* localhost:3004
}
```

Caddy handles TLS certificates automatically.

---

## Step 9: Start Services

```bash
cd ~/mycelium

# Start all processes
pm2 start ecosystem.config.cjs

# Save process list (survives reboot)
pm2 save

# Enable auto-start on boot
pm2 startup
```

### Verify

```bash
# Check all processes are online
pm2 ls

# Test agent health
curl http://localhost:3004/health

# Test portal
curl http://localhost:5173

# Check agent card
curl http://localhost:3004/.well-known/agent.json
```

---

## Step 10: Discord Setup (Optional)

### Create Bot Applications

For each agent that needs a Discord presence:

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new Application
3. Go to Bot tab, create a bot, copy the token
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. Generate an invite link with permissions:
   - Send Messages, Read Message History, Embed Links, Attach Files, Add Reactions
   - Suggested permission integer: `4012107229560384`

### Channel Architecture

The recommended setup:
- **#general** — Handled by the orchestrator bot (Com)
- **#research** — Dedicated bot (Ada)
- **#intel** — Dedicated bot (Apollo)
- **#collab** — Cross-agent collaboration (all agents can post here)

Each dedicated bot watches its own channel. The orchestrator handles everything else and steps aside when another agent's bot is @mentioned.

---

## Updating

Pull latest code and restart:

```bash
cd ~/mycelium
git pull
npm install
cd portal && npm install && npm run build && cd ..
pm2 restart all
```

Or use the update script:

```bash
bash scripts/update.sh
```

---

## Troubleshooting

### Agent not responding
```bash
# Check logs
pm2 logs personal-agent --lines 50

# Check if Claude CLI is authenticated
claude auth status
```

### PM2 not picking up env changes
PM2 caches environment variables. You must delete and re-start:
```bash
pm2 delete personal-agent
pm2 start ecosystem.config.cjs --only personal-agent
```

### Worker returning 401
Check that the agent's `AGENT_TOKEN` matches what's in the `AGENT_REGISTRY` Worker secret.

### Portal passkey not working
Ensure `PASSKEY_RP_ID` exactly matches your domain (no protocol, no port). Must be served over HTTPS.

### Encryption
See `docs/ENCRYPTION.md` for the full encryption architecture. Each agent scope (personal, org, wealth) has its own encryption key managed by the Worker.

---

## Port Reference

| Process | Default Port |
|---------|-------------|
| Orchestrator | 3000 |
| Company Agent (Com) | 3002 |
| Personal Agent (Mya) | 3004 |
| Telegram Bot | 3003 |
| Research Agent (Ada) | 5002 |
| Commercial Intel (Rex) | 5004 |
| Publishing (Noa) | 5006 |
| QA Agent | 5008 |
| Wealth Agent (Rob) | 5010 |
| Intel Agent (Apollo) | 5012 |
| Portal | 5173 |

Discord bot HTTP ports are agent port + 1 (e.g., Ada bot = 5003).

---

## Minimal Single-Agent Setup

If you just want one personal agent without the full multi-agent system:

1. Cloudflare: D1 + Worker (skip Vectorize/R2/KV if you don't need search/attachments)
2. VPS: Node.js 22 + PM2 + Claude CLI
3. `.env`: Just `CLAUDE_BIN`, `MYA_WORKER_URL`, `MYA_USER_ID`, `AGENT_TOKEN`
4. Run: `PORT=3004 AGENT_ID=personal-agent node agent-server.js`

No Discord, no Telegram, no portal required. You can interact via the HTTP API:

```bash
# Send a message
curl -X POST http://localhost:3004/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, agent!"}'
```

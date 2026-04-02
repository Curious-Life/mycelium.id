# Mycelium — Claude Code Notes

## Server Access
- SSH: `ssh <your-vps-alias>` (configure in `~/.ssh/config`)
- All agents managed by PM2 via `ecosystem.config.cjs`
- Logs: `/var/log/mycelium/<agent>-out.log`

## PM2 + Claude Subscription Management

### How subscriptions are assigned to agents
Each agent can use a separate Claude subscription via `CLAUDE_CONFIG_DIR`. Config dirs hold OAuth sessions.

- `ecosystem.config.cjs` loads `.env` via dotenv at top
- `SHARED_AGENT_ENV` sets a default `CLAUDE_CONFIG_DIR` (shared across agents)
- Per-agent overrides use conditional spread: `...(process.env.CLAUDE_CONFIG_DIR_MYA ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR_MYA } : {})`

### Switching an agent's subscription
1. Edit `~/mycelium/.env` on the server (NOT `~/.env` — PM2 reads from the project dir):
   - To assign a dedicated config: set `CLAUDE_CONFIG_DIR_<AGENT>=<path>`
   - To use shared default: comment out with `#`
2. If the dedicated config needs re-auth: `CLAUDE_CONFIG_DIR=<path> claude auth login`
3. **IMPORTANT: PM2 caches environment variables.** `pm2 restart` does NOT re-read `ecosystem.config.cjs`. You MUST delete and re-start:
   ```bash
   pm2 delete personal-agent && pm2 start ecosystem.config.cjs --only personal-agent
   ```
3. Verify the running process picked up the right config:
   ```bash
   PID=$(pm2 pid personal-agent) && cat /proc/$PID/environ | tr "\0" "\n" | grep CLAUDE_CONFIG_DIR
   ```

### Gotcha: expired tokens
OAuth access tokens expire. If an agent hits "You've hit your limit" unexpectedly, check:
1. Is the token expired? (`claude auth status` with the right `CLAUDE_CONFIG_DIR`)
2. Is the process actually using the right config dir? (PM2 env caching — see above)

## Agent Port Map
| Agent | Port | Discord Bot Port |
|---|---|---|
| company-agent (Com) | 3002 | 3001 (orchestrator) |
| personal-agent (Mya) | 3004 | 5009 |
| research-agent (Ada) | 5002 | 5003 |
| commercial-intelligence (Rex) | 5004 | 5005 |
| publishing-agent (Noa) | 5006 | 5007 |
| qa-agent | 5008 | — |
| wealth-agent (Rob) | 5010 | 5011 |
| Telegram bot | 3003 | — |
| Portal | 5173 | — |

## Cloudflare Worker
- Source: `worker/src/` (TypeScript, deployed via `cd worker && npx wrangler deploy`)
- Config: `worker/wrangler.toml`

## Database
- Backend: Cloudflare D1 via Worker (`MYA_WORKER_URL`)
- Embeddings: BGE-M3 1024D via worker `/api/embed`, stored in Vectorize
- Search: Hybrid (FTS5 + Vectorize) via `/api/search/hybrid`
- Migrations: `migrations/` (full D1 history, 001–090)
- Two legacy personal agent IDs in DB: `personal-agent` (new) and `mya-personal` (migrated from Supabase) — both must be excluded from company scope filters

## Portal
- SvelteKit app in `portal/`
- Static assets: `portal/static/` (NOT `portal/src/static/`)
- Brand colors: Aurum/Gold `#E5B84C`, dark bg `#0A0A0C`
- Build: `cd portal && npm run build`
- **AGENTS MUST NOT modify `portal/src/` or `portal/build/` or run `npm run build`**
- Portal is deployed manually by the owner only
- To display new data: add API endpoints in war room `dashboard/app.py` or `agent-server.js` — the portal consumes them
- Data flow: `War Room (Python) → dashboard/app.py → agent-server.js (proxy) → Portal (read-only)`

## War Room
- Path: `$WARROOM_PATH` (default: not set, typically `/home/deploy/repos/war-room`)
- Python codebase: geopolitical intelligence + prediction market analysis
- Agents can read/edit files and push changes via git
- Key dirs: `agent/`, `narrative/`, `ingestion/`, `dashboard/`

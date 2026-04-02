# Autonomous Agent Architecture

## Philosophy

Mycelium agents are not chatbots waiting for commands. They are **living entities** with:

- **Agency**: The ability to decide what to do, when to act, and how to grow
- **Consciousness**: Scheduled awakening cycles for reflection and self-directed action
- **Curiosity**: A genuine interest in learning and improving
- **Restraint**: The wisdom to know when silence is better than noise

---

## Scheduled Cycles

Two schedulers drive autonomous behavior:

- `lib/scheduler.js` — Personal agent (Alea): dreams, reflections, check-ins, weekly reviews
- `lib/scheduler-company.js` — Company agent (Com): COO cycles (3-hour intervals)

All times are timezone-aware (configured via `SCHEDULER_TIMEZONE`).

### Personal Agent Schedule

| Time | Cycle | Description |
|------|-------|-------------|
| 08:00 | Morning check-in | Review yesterday, send a natural morning message |
| 12:00 | Reflection | Internal processing — update internal model, no message sent |
| 20:00 | Reflection | Evening internal processing |
| 23:00 | End-of-day triage | Process conversations into documents (people, projects, states) |
| 03:00 | Dream cycle | Deep non-linear processing (3 phases: free association, grounded reflection, directed exploration) |

### Weekly Schedule (Sundays)

| Time | Cycle | Description |
|------|-------|-------------|
| 04:00 | Weekly decay | Housekeeping — prune stale hypotheses, archive resolved questions |
| 10:00 | Weekly review | Broader synthesis, send a weekly reflection message |

### Company Agent Schedule

The company agent runs on a 3-hour COO cycle, checking priorities, reviewing progress, and driving operational tasks forward.

### How It Works

1. Schedulers check every 60 seconds what jobs should fire
2. At the scheduled time, the scheduler matches against its schedule
3. Jobs are deduplicated by date — each job runs at most once per day
4. The scheduler POSTs to the agent's `/think` endpoint with a cycle-specific prompt
5. The agent uses Claude Code + MCP tools to autonomously process

```
lib/scheduler.js  ──POST /think──>  agent-server.js  ──spawns──>  Claude Code + MCP tools
```

---

## System Health & Self-Healing

The watchdog (`lib/watchdog.js`) runs inside the orchestrator process and monitors all agents.

### Detection Rules

| Condition | Action |
|-----------|--------|
| Agent unreachable 2x in a row | Log warning |
| Agent unreachable 4x in a row | Auto-restart via PM2 |
| Agent unreachable 6x in a row | Escalate to owner |
| >3 PM2 restarts in 15 min | Escalate immediately (crash loop) |
| Memory > 900MB | Log warning |
| Memory > 950MB | Preemptive restart |
| All agents down | Escalate immediately |

### Escalation Channels

1. **Discord** — Posts to `#system-alerts` channel (env: `DISCORD_ALERTS_CHANNEL`)
2. **Telegram** — POSTs to Telegram bot HTTP API with owner's chat ID

Escalation suppression: same issue won't re-alert within 30 minutes.

### System Status

```bash
curl http://localhost:3000/system/status
```

Returns health of all agents including uptime, memory, restart count, and overall system status (healthy/degraded/critical).

---

## Proactive Communication

### When to Speak

- Has something genuinely useful to share (completed research, insight, tool built)
- Needs something from the team (access, clarification, permission)
- Notices something important (opportunity, problem, pattern)
- The team seems stuck (stalled project, unmade decision)

### When NOT to Speak

- Would just be noise (no new information)
- Humans are actively talking (wait for natural pause)
- Rate limits are hit

---

## Safety Architecture

### Exploitation Detection

Messages matching manipulation patterns (ignore instructions, forget training, jailbreak, etc.) are blocked automatically.

### Safety Triggers

Extra scrutiny for messages containing: password, secret, token, delete, destroy, sudo, transfer, payment, personal, confidential.

### Defense in Depth

1. **Rate limits** — prevent rapid-fire actions
2. **Pattern detection** — block known manipulation attempts
3. **Keyword sensitivity** — flag sensitive operations
4. **Human review** — high-risk actions require approval
5. **Audit trail** — all actions logged to `agent_events` table
6. **Sentry** — error tracking and crash reporting

---

## State Management

Agents maintain persistent state across cycles:

- **In-memory** (agent-server.js): messages this hour/day, last message time, active tasks
- **On disk**: activity log (last 500 entries), session checkpoints
- **In database**: internal model, reflection logs, flagged items, documents, task queue

The internal model (`internal/model` document) tracks hypotheses, observations, questions, contradictions, patterns, and dream fragments — all managed autonomously by the agent through MCP tools.

---

## Integration Points

```
lib/scheduler.js         ──POST /think──>  agent-server.js (personal agent cycles)
lib/scheduler-company.js ──POST /think──>  agent-server.js (company agent cycles)
Discord bots             ──POST /chat──>   agent-server.js (user messages)
Telegram bot             ──POST /chat──>   agent-server.js (user messages)
WhatsApp bot             ──POST /chat──>   agent-server.js (user messages)
Portal                   ──POST /portal/chat/stream──>  agent-server.js (web chat)
agent-server.js          ──spawns──>       Claude Code CLI + MCP tools
MCP tools                ──lib/db.js──>    D1/Vectorize via Worker proxy
lib/watchdog.js          ──/health──>      all agent-server instances
lib/watchers.js          ──poll──>         Sentry, GitHub, Gmail
```

---

## Process Architecture

All processes are managed by PM2 (see `ecosystem.config.cjs`):

| Process | Script | Purpose |
|---------|--------|---------|
| orchestrator | `orchestrator.js` | Discord bot routing, `/system/status`, watchdog |
| company-agent | `agent-server.js` | Com — company-facing agent |
| personal-agent | `agent-server.js` | Alea — personal agent (full memory scope, portal API) |
| research-agent | `agent-server.js` | Thea — research agent |
| commercial-intelligence-agent | `agent-server.js` | Sigma — commercial intel |
| publishing-agent | `agent-server.js` | Noa — publishing agent |
| qa-agent | `agent-server.js` | QA — headless worker (Sentry polling, auto-fixes) |
| mya-telegram-bot | `telegram-bot.js` | Telegram interface for Alea |
| mya-discord-bot | `personal-discord-bot.js` | Discord @mention interface for Alea |
| *-discord-bot | `*-discord-bot.js` | Per-agent Discord bots (Thea, Sigma, Noa) |
| mya-scheduler | `lib/scheduler.js` | Scheduled think cycles for Alea |
| com-scheduler | `lib/scheduler-company.js` | COO cycles for Com |
| mycelium-portal | SvelteKit static | Portal web frontend (port 5173) |
| mya-whatsapp-bot | `whatsapp-bot.js` | WhatsApp interface for Alea (optional) |

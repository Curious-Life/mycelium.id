# Model Routing & Multi-Account Configuration

## Model Routing

Each agent selects the appropriate Claude model based on the task type. This follows Anthropic's recommended pattern: use the cheapest model that can handle the task.

### Default Model Map

Defined in `lib/runtime.js`:

| Task Type  | Default Model | Use Case                                      |
|------------|---------------|-----------------------------------------------|
| `think`    | opus          | Autonomous thinking, strategic planning        |
| `chat`     | sonnet        | Interactive chat, Discord/Telegram responses   |
| `spawn`    | sonnet        | Ephemeral sub-tasks, focused specialists       |
| `research` | sonnet        | Multi-source research, synthesis               |
| `default`  | sonnet        | Fallback for unknown task types                |

### How It Works

1. **`lib/runtime.js`** defines `DEFAULT_MODELS` and builds a `runtime.models` map
2. **`agent-server.js`** calls `getModelForTask(runtime, taskType)` before each Claude Code spawn
3. **`lib/model-fallback.js`** provides fallback chains (e.g., opus -> sonnet -> haiku)

### Per-Agent Model Override

Set env vars in `ecosystem.config.cjs` to override defaults for a specific agent:

```
MODEL=opus           # Base model (fallback for unknown task types)
MODEL_THINK=opus     # Override think tasks
MODEL_CHAT=opus      # Override chat tasks
MODEL_SPAWN=sonnet   # Override spawn tasks
MODEL_RESEARCH=sonnet  # Override research tasks
```

Example: All agents run on Opus for chat/think, spawns inherit sonnet default:

```js
env: {
  MODEL: 'opus',
  MODEL_THINK: 'opus',
  MODEL_CHAT: 'opus',
  // MODEL_SPAWN omitted — inherits sonnet from DEFAULT_MODELS
}
```

### Per-Spawn Model Choice

Agents can also choose a model per-spawn via the `spawn_specialist` tool. The agent sees guidance in the tool description:

- **sonnet** (recommended default): Analysis, coding, research, writing, multi-step reasoning
- **haiku**: Only for trivial tasks — simple lookups, formatting, data extraction, template filling
- **opus**: Deep strategic thinking, synthesis across many sources (use sparingly)

### Fallback Chains

When a model fails (rate limit, overloaded), the system falls back automatically. Defined in `lib/model-fallback.js`:

| Task Type  | Primary | Fallback 1 | Fallback 2 |
|------------|---------|------------|------------|
| `think`    | opus    | sonnet     | haiku      |
| `chat`     | sonnet  | haiku      | -          |
| `spawn`    | sonnet  | haiku      | -          |
| `research` | sonnet  | haiku      | -          |

### Verifying Model Config

Check an agent's active model routing:

```bash
# Startup log
pm2 logs company-agent --lines 50 --nostream | grep "Model routing"
# Output: [Agent] Model routing: think=opus, chat=opus, spawn=haiku, research=sonnet

# Health endpoint
curl -s http://localhost:3002/health | jq .models

# Runner log (per-task)
pm2 logs company-agent --nostream | grep "Runner.*Args"
# Output: [Runner] Args: --print --output-format json --model opus --max-turns 30 ...
```

---

## Multi-Account Configuration

Each agent can use a separate Claude subscription to distribute quota across accounts. This is done via `CLAUDE_CONFIG_DIR` — each config directory holds its own OAuth session.

### Current Setup

By default, all agents share `/home/claude/.claude`. To split them:

### Step 1: Create Config Directories

```bash
ssh claude@<server>

mkdir -p /home/claude/.claude-com
mkdir -p /home/claude/.claude-ada
mkdir -p /home/claude/.claude-rex
mkdir -p /home/claude/.claude-noa
mkdir -p /home/claude/.claude-mya
```

### Step 2: Login Each Account

```bash
CLAUDE_CONFIG_DIR=/home/claude/.claude-com claude login
CLAUDE_CONFIG_DIR=/home/claude/.claude-ada claude login
CLAUDE_CONFIG_DIR=/home/claude/.claude-rex claude login
CLAUDE_CONFIG_DIR=/home/claude/.claude-noa claude login
CLAUDE_CONFIG_DIR=/home/claude/.claude-mya claude login
```

Each login opens a browser OAuth flow. Use a different Claude account for each.

### Step 3: Copy Settings

Each config dir needs the same permissions and feature flags:

```bash
for dir in .claude-com .claude-ada .claude-rex .claude-noa .claude-mya; do
  cp /home/claude/.claude/settings.json /home/claude/$dir/settings.json
done
```

### Step 4: Set Env Vars

Add to `.env` on the server:

```bash
CLAUDE_CONFIG_DIR_COM=/home/claude/.claude-com
CLAUDE_CONFIG_DIR_ADA=/home/claude/.claude-ada
CLAUDE_CONFIG_DIR_REX=/home/claude/.claude-rex
CLAUDE_CONFIG_DIR_NOA=/home/claude/.claude-noa
CLAUDE_CONFIG_DIR_MYA=/home/claude/.claude-mya
```

### Step 5: Restart PM2

```bash
source ~/.env
cd ~/mycelium
pm2 delete all && pm2 start ecosystem.config.cjs
```

### How It Works

`ecosystem.config.cjs` sets `CLAUDE_CONFIG_DIR` in `SHARED_AGENT_ENV` (default: `/home/claude/.claude`). Each agent has a conditional override:

```js
...(process.env.CLAUDE_CONFIG_DIR_COM ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR_COM } : {}),
```

If the per-agent env var is not set, the agent uses the shared default. The runner passes `process.env` through to the spawned Claude CLI process, so `CLAUDE_CONFIG_DIR` flows automatically.

### Agent-to-Env-Var Mapping

| Agent              | Name in Discord | Env Var                   |
|--------------------|-----------------|---------------------------|
| company-agent      | Com             | `CLAUDE_CONFIG_DIR_COM`   |
| research-agent     | Thea            | `CLAUDE_CONFIG_DIR_ADA`   |
| commercial-intel   | Sigma            | `CLAUDE_CONFIG_DIR_REX`   |
| publishing-agent   | Noa             | `CLAUDE_CONFIG_DIR_NOA`   |
| personal-agent     | Alea            | `CLAUDE_CONFIG_DIR_MYA`   |

### Partial Migration

You don't have to migrate all agents at once. Any agent without its per-agent env var set will continue using the shared default account. For example, to only split Com onto its own account:

```bash
# .env
CLAUDE_CONFIG_DIR_COM=/home/claude/.claude-com
# (no other CLAUDE_CONFIG_DIR_* vars set)
```

All other agents continue sharing `/home/claude/.claude`.

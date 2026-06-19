# Energy System

Tokens are the mycelium's energy. Every Claude Code execution consumes tokens — input (prompts + context), output (responses), and cache (reused context). The energy system tracks this consumption, classifies the network's metabolic state, and enables agents to self-regulate.

## How It Works

### Recording

Every time `lib/runner.js` completes a Claude Code execution, it records the token usage:

```
agents/.shared/energy/2026-04-08.jsonl
```

Each line is a JSON record with: timestamp, agent ID, process type (chat/think/spawn), model, input/output/cache tokens, cost USD, session ID, duration, and trigger source.

Recording is **opt-in** — if `lib/energy.js` is removed, the runner continues working without recording.

### State Classification

`lib/energy-state.js` reads the ledger and classifies system state:

| Level | Budget Used | Behavior |
|-------|-------------|----------|
| **abundant** | <50% | Agents may explore deeper, spawn sub-tasks, do proactive research |
| **normal** | 50-80% | Default behavior |
| **low** | 80-95% | Conservation: shorter cycles, cheaper models |
| **critical** | >95% | Emergency: skip non-essential cycles, force cheapest models |

### Energy-Aware Decisions

When energy is scarce, the system automatically conserves:

- **Scheduler**: Skips non-essential autonomous cycles, reduces maxTurns by 40%
- **Model fallback**: Downshifts to cheaper models (opus→sonnet→haiku)
- **Spawner**: Blocks new sub-tasks when critical, downgrades opus spawns to sonnet
- **Delegation**: Refuses delegation to energy-critical agents
- **Agents**: Receive their energy state in autonomous prompts and naturally adjust

When energy is abundant, agents are told they can do more — spawn sub-tasks, explore deeper, run proactive research.

## Configuration

Create `agents/.shared/energy-config.json`:

```json
{
  "dailyBudget": 50000000,
  "thresholds": {
    "abundant": 0.5,
    "low": 0.8,
    "critical": 0.95
  },
  "perAgent": {
    "personal-agent": { "dailyBudget": 20000000 },
    "research-agent": { "dailyBudget": 15000000 }
  }
}
```

If no config file exists, defaults are used (50M tokens/day, standard thresholds).

## Portal

The `/energy` page in the portal shows:

- **Flow view**: Radial diagram of energy flowing from source through models to agents
- **Timeline**: Daily token usage per agent (stacked bar chart)
- **Records**: Per-execution log with timestamps, tokens, and durations
- Interactive filtering by agent and model

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /portal/energy?days=7&agent=alpha` | Raw energy records (filterable) |
| `GET /portal/energy/summary?days=7` | Aggregated summary with per-agent/model breakdowns |
| `GET /portal/energy/live` | Current state: today's summary + agent health + energy levels |

## Backfilling Historical Data

To populate the energy ledger from existing Claude Code session files:

```bash
node scripts/backfill-energy.js --dry-run   # preview
node scripts/backfill-energy.js             # write records
```

This scans `~/.claude/projects/` for session JSONL files and extracts token usage from assistant messages.

## Files

| File | Purpose |
|------|---------|
| `lib/energy.js` | Energy ledger — record, query, summarize |
| `lib/energy-state.js` | Computed state — budget classification, burn rate |
| `lib/runner.js` | Integration point — records after each execution |
| `lib/scheduler.js` | Integration point — energy-aware cycle gating |
| `lib/model-fallback.js` | Integration point — energy-aware model selection |
| `lib/spawner.js` | Integration point — energy-gated spawning |
| `lib/delegation.js` | Integration point — energy-aware delegation |
| `scripts/backfill-energy.js` | Historical data import |
| `docs/ENERGY.md` | This file |
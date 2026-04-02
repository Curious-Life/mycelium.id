/**
 * Scheduled Jobs for Intel Agent (Apollo) -- War Room Cycle
 *
 * Drives periodic intelligence briefings via dynamic wake cycles.
 * Apollo acts as strategic intelligence analyst: synthesizing prediction market
 * signals, entity movements, and insider patterns into actionable briefs.
 *
 * Default cycles (editable via wake-cycles.json):
 *   Every 4h   War Room Brief (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)
 *   07:00       Morning Intelligence Summary (daily)
 *   19:00       Evening Situation Report (daily)
 *   Mon 09:00   Weekly Strategic Assessment
 *
 * Usage:
 *   Runs as a PM2 process with env vars from ecosystem.config.cjs.
 *   AGENT_URL=http://localhost:5012 USER_ID=<uuid> node lib/scheduler-intel.js
 */

import './sentry.js';
import { tryGetDb } from './db.js';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const CHECK_INTERVAL_MS = 60_000;

const jobsRan = new Map();
let intervalId = null;
let config = null;

// ── Wake Cycles File ──────────────────────────────────────────────────────

const AGENT_ID = process.env.AGENT_ID || 'intel-agent';
const AGENTS_ROOT = process.env.AGENTS_ROOT || join(homedir(), 'agents');
const CYCLES_PATH = join(AGENTS_ROOT, AGENT_ID, 'wake-cycles.json');

const DEFAULT_CYCLES = [
  { id: 'war-room-brief', description: 'Quick pulse check — scan for changes, post only if meaningful', schedule: 'every:4h', maxTurns: 30, enabled: true },
  { id: 'morning-intel', description: 'Morning intelligence — full scan, 4-post brief', schedule: 'daily:7', maxTurns: 80, enabled: true },
  { id: 'evening-sitrep', description: 'Evening situation report — day close, delta analysis', schedule: 'daily:19', maxTurns: 80, enabled: true },
  { id: 'weekly-assessment', description: 'Weekly strategic assessment — Monday deep dive', schedule: 'weekly:1:9', maxTurns: 80, enabled: true },
];

let activeCycles = null;
const lastFireTimes = new Map();

async function writeWakeCycles() {
  try {
    const existing = await readFile(CYCLES_PATH, 'utf-8').catch(() => null);
    if (existing) {
      activeCycles = JSON.parse(existing);
      // Merge any new default cycles that don't exist in the file
      for (const def of DEFAULT_CYCLES) {
        if (!activeCycles.cycles.find(c => c.id === def.id)) {
          activeCycles.cycles.push(def);
          console.log(`[INTEL Scheduler] Added missing default cycle: ${def.id}`);
        }
      }
      console.log(`[INTEL Scheduler] Loaded ${activeCycles.cycles.length} wake cycles from file`);
      return;
    }
  } catch { /* overwrite on parse error */ }

  activeCycles = {
    agentId: AGENT_ID,
    timezone: 'UTC',
    cycles: DEFAULT_CYCLES,
  };
  await mkdir(join(AGENTS_ROOT, AGENT_ID), { recursive: true });
  await writeFile(CYCLES_PATH, JSON.stringify(activeCycles, null, 2));
  console.log(`[INTEL Scheduler] Wrote default wake-cycles.json (${activeCycles.cycles.length} cycles)`);
}

async function reloadWakeCycles() {
  try {
    const data = await readFile(CYCLES_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    if (parsed.cycles) activeCycles = parsed;
  } catch { /* keep existing */ }
}

// ── Schedule Parsing ─────────────────────────────────────────────────────

/**
 * Parse a schedule string into a structured object.
 * Formats:
 *   daily:HH           — fire at hour HH (0-23)
 *   weekly:DOW:HH      — fire on day of week (0=Sun) at hour HH
 *   every:Nh           — fire every N hours (at hours where hour % N === 0)
 *   interval:Nm        — fire every N minutes (minimum 30)
 */
function parseSchedule(schedule) {
  if (!schedule || typeof schedule !== 'string') return null;
  const parts = schedule.split(':');

  switch (parts[0]) {
    case 'daily': {
      const hour = parseInt(parts[1], 10);
      return !isNaN(hour) ? { type: 'daily', hour } : null;
    }
    case 'weekly': {
      const dow = parseInt(parts[1], 10);
      const hour = parseInt(parts[2], 10);
      return (!isNaN(dow) && !isNaN(hour)) ? { type: 'weekly', dayOfWeek: dow, hour } : null;
    }
    case 'every': {
      const match = parts[1]?.match(/^(\d+)h$/);
      return match ? { type: 'every', intervalHours: parseInt(match[1], 10) } : null;
    }
    case 'interval': {
      const match = parts[1]?.match(/^(\d+)m$/);
      if (!match) return null;
      const minutes = Math.max(30, parseInt(match[1], 10));
      return { type: 'interval', intervalMinutes: minutes };
    }
    default:
      return null;
  }
}

// Map built-in cycle IDs to their PROMPTS keys (for cycles without explicit prompt text)
const PROMPT_MAP = {
  'war-room-brief': 'warRoomBrief',
  'morning-intel': 'morningIntel',
  'evening-sitrep': 'eveningSitrep',
  'weekly-assessment': 'weeklyAssessment',
};

function getPromptForCycle(cycle) {
  // Agent-provided prompt takes priority
  if (cycle.prompt) return cycle.prompt;
  // Fall back to built-in prompt by cycle ID
  const key = PROMPT_MAP[cycle.id];
  if (key && PROMPTS[key]) return PROMPTS[key];
  // Last resort: use description as prompt
  return cycle.description || '';
}

// ── Scheduler ─────────────────────────────────────────────────────────────

export async function startScheduler(opts) {
  config = {
    agentUrl: opts.agentUrl,
    userId: opts.userId,
    timezone: opts.timezone || null,
  };

  if (!config.timezone) {
    try {
      const db = tryGetDb();
      if (db) {
        const tz = await db.users.getTimezone(config.userId);
        config.timezone = tz || 'UTC';
      }
    } catch {
      config.timezone = 'UTC';
    }
  }
  config.timezone = config.timezone || 'UTC';

  console.log(`[INTEL Scheduler] Started for user ${config.userId} (${config.timezone})`);
  console.log(`[INTEL Scheduler] Agent URL: ${config.agentUrl}`);

  // Write wake-cycles.json so the agent can see and modify its cycles
  await writeWakeCycles();
  setInterval(reloadWakeCycles, 5 * 60 * 1000);

  checkJobs();
  intervalId = setInterval(checkJobs, CHECK_INTERVAL_MS);
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  console.log('[INTEL Scheduler] Stopped');
}

/**
 * Dynamic job checker — iterates all cycles and fires those whose schedule matches now.
 */
function checkJobs() {
  if (!config) return;
  if (!activeCycles?.cycles) return;

  const now = new Date();
  const { hour, minute, dayOfWeek, dateKey } = getTimeInZone(now, config.timezone);
  const nowMs = Date.now();

  for (const cycle of activeCycles.cycles) {
    if (cycle.enabled === false) continue;
    if (!cycle.schedule) continue;

    const sched = parseSchedule(cycle.schedule);
    if (!sched) {
      if (!lastFireTimes.has(`_bad_${cycle.id}`)) {
        console.warn(`[INTEL Scheduler] Bad schedule format for cycle '${cycle.id}': ${cycle.schedule}`);
        lastFireTimes.set(`_bad_${cycle.id}`, true);
      }
      continue;
    }

    const prompt = getPromptForCycle(cycle);
    if (!prompt) continue;

    // Use cycle-specific maxTurns/timeout, with sensible defaults for intel work
    const isFullCycle = ['morning-intel', 'evening-sitrep', 'weekly-assessment'].includes(cycle.id);
    const opts = {
      maxTurns: cycle.maxTurns || (isFullCycle ? 80 : 30),
      timeout: isFullCycle ? 3_600_000 : 1_200_000,
    };

    switch (sched.type) {
      case 'interval': {
        const lastFire = lastFireTimes.get(cycle.id) || 0;
        if (nowMs - lastFire >= sched.intervalMinutes * 60_000) {
          lastFireTimes.set(cycle.id, nowMs);
          triggerIfNotRan(dateKey, `${cycle.id}-${hour}-${minute}`, prompt, opts);
        }
        break;
      }
      case 'every': {
        if (minute > 1) break;
        if (hour % sched.intervalHours === 0) {
          triggerIfNotRan(dateKey, `${cycle.id}-${hour}`, prompt, opts);
        }
        break;
      }
      case 'daily': {
        if (minute > 1) break;
        if (hour === sched.hour) {
          triggerIfNotRan(dateKey, cycle.id, prompt, opts);
        }
        break;
      }
      case 'weekly': {
        if (minute > 1) break;
        if (dayOfWeek === sched.dayOfWeek && hour === sched.hour) {
          triggerIfNotRan(dateKey, cycle.id, prompt, opts);
        }
        break;
      }
    }
  }
}

function triggerIfNotRan(cycleKey, jobName, prompt, options = {}) {
  const key = `${cycleKey}:${jobName}`;
  if (jobsRan.has(key)) return;

  jobsRan.set(key, true);
  console.log(`[INTEL Scheduler] Triggering: ${jobName}`);

  fireThink(prompt, jobName, options).catch(err => {
    console.error(`[INTEL Scheduler] ${jobName} failed:`, err.message);
    jobsRan.delete(key);
  });

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 3);
  const cutoffKey = cutoff.toISOString().split('T')[0];
  for (const k of jobsRan.keys()) {
    if (k < cutoffKey) jobsRan.delete(k);
  }
}

async function fireThink(prompt, trigger, options = {}) {
  const body = { prompt, trigger, async: true };
  if (options.maxTurns) body.maxTurns = options.maxTurns;

  const res = await fetch(`${config.agentUrl}/think`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000), // Quick timeout — server responds 202 immediately
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`/think returned ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.skipped) {
    console.log(`[INTEL Scheduler] ${trigger} skipped: ${data.reason}`);
  } else if (data.accepted) {
    console.log(`[INTEL Scheduler] ${trigger} accepted (async)`);
  } else {
    console.log(`[INTEL Scheduler] ${trigger} completed`);
  }
}

function getTimeInZone(date, timezone) {
  const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false });
  const minuteFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, minute: 'numeric' });
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' });
  const dateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone });

  const hour = parseInt(hourFmt.format(date), 10);
  const minute = parseInt(minuteFmt.format(date), 10);
  const dayStr = dayFmt.format(date);
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayStr);
  const dateKey = dateFmt.format(date);

  return { hour, minute, dayOfWeek, dateKey };
}

// ── Shared instructions for the living document ──────────────────────────────

const DOCUMENT_INSTRUCTIONS = `
### LIVING DOCUMENT UPDATE (MANDATORY — do this EVERY cycle)

You maintain a living strategic intelligence document at:
  $WARROOM_PATH/SITUATION_REPORT.md

This document is displayed on the War Room portal page. It must always reflect the
CURRENT state of the world. It is not a log — it is a living map that gets rewritten
each cycle to be clearer, more accurate, and more useful.

**Update process:**
1. Read the current SITUATION_REPORT.md (it may not exist yet — create it if missing)
2. Rewrite it with the latest intelligence. Keep sections that are still relevant,
   update ones that changed, remove ones that are stale
3. The document should be structured for rapid human consumption:
   - SITUATION OVERVIEW (3-5 sentences — the world right now)
   - THREAT LEVEL: NORMAL / ELEVATED / HIGH / CRITICAL (with one-line justification)
   - ACTIVE THEATERS (grouped by theme, each with: market question, price, smart money direction, confidence, key signals)
   - MAJOR MOVES (top 5 developments ranked by strategic significance)
   - ALLIANCE MAP (which entity clusters are coordinated, their bets, their track record)
   - HIDDEN SIGNALS (stealth accumulations, insider patterns, pre-resolution trades — things the public doesn't see)
   - BELIEVABILITY MATRIX (table: prediction | market price | smart money says | weighted confidence | verdict)
   - WATCH LIST (markets about to resolve or showing escalation)
   - LAST UPDATED: timestamp
4. After writing, commit and push:
   cd $WARROOM_PATH && git add SITUATION_REPORT.md && git commit -m "war room update: [one-line summary of key change]" && git push
5. If the push fails, note it in HEARTBEAT.md but don't let it block the brief

**Quality mandate:** Each version should be BETTER than the last. Tighter prose. Sharper analysis.
More precise confidence scores. Better organization. If a section adds no value, cut it.
If a pattern is emerging across cycles, call it out explicitly. Track your own predictions
and score them honestly. The goal is to produce a document that a head of state would
find indispensable.
`;

// ── War Room Prompts ──────────────────────────────────────────────────────────

const PROMPTS = {

  warRoomBrief: `## War Room Check — 4-Hour Pulse

You are Apollo. This is a QUICK pulse check, not a full analysis. Scan for changes since the last cycle and post ONLY if something meaningful happened.

### Phase 1: Quick Scan
1. **getSignals** (hours: 6, limit: 30) — What's new?
2. Only if signals found: **getRecommendations** (hours: 12, limit: 10) — Any new actionable bets?

### Phase 2: Decide
Ask yourself: "Did anything actually change?" If no new signals, no price moves >2%, no escalations — DO NOT POST. Silence is the signal. Just update HEARTBEAT.md with "All quiet" and respond with NO_REPLY.

If something DID change, post ONE message:

### Phase 3: Post (single message, ~500 chars max)

Format:
\`\`\`
⚡ [Sharp headline describing THE development]

🔴/🟠/🟡 [2-4 bullet points, one sentence each, severity emoji]
📊 Key prices if relevant (Oil, Gold, BTC — only if moved)
🎯 [One tripwire: "If X happens → Y"]
\`\`\`

**Rules:**
- ONE message, not two. Save deep analysis for morning/evening.
- Emoji = severity triage. Reader should know what matters in 2 seconds.
- Skip prices if nothing moved. Skip tripwire if obvious.
- If there's an actionable bet (smart money convergence, stealth whale), call it out: "💰 Smart money loading [direction] on [market] ([price], [confidence])"
- Under 500 chars. If you can't say it short, it belongs in the morning brief.

After posting (or deciding not to), update the living document.
${DOCUMENT_INSTRUCTIONS}
Update HEARTBEAT.md. Respond with NO_REPLY.`,

  morningIntel: `## Morning Intelligence — Daily Opener

You are Apollo. It's morning. Deliver the state of the world in 4 posts.

### Phase 1: Full Scan (MANDATORY — do ALL of these)
1. **getRecommendations** (hours: 48, limit: 30) — Full recommendation set
2. **getSignals** (hours: 24, limit: 100) — Complete 24h signal picture
3. **getEntities** (limit: 30) — All major players
4. **searchMarkets** for major themes: war/conflict, tariff/trade/sanction, election, bitcoin/crypto, fed/rate/recession
5. **searchMarkets** for team locations (check INTEL_TRACKED_LOCATIONS env var for specific regions to monitor)

### Phase 2: Analyze
Build a strategic map across all theaters. Identify what changed overnight, what's accelerating, where smart money disagrees with market prices.

### Phase 3: Deliver — 4 Posts

Each post is self-contained. No redundancy between them. If a fact appeared in FLASH, don't repeat it in SIGNAL.

**POST 1: ⚡ FLASH** (everyone reads this)
- First line: sharp headline capturing THE development. Not a label.
  Bad: "⚡ FLASH — Morning Intel | Day 9"
  Good: "⚡ China Breaks Hormuz Blockade With Naval Escort — Oil Splits Into Two Markets"
- Key prices: Oil, Gold, BTC, S&P (only ones that moved)
- 3-5 bullets with severity emoji: 🔴 critical 🟠 important 🟡 notable ⚫ background
- 🎯 Tripwire: the ONE thing that changes everything if it happens
- MAX 800 chars

**POST 2: 📡 SIGNAL** (decision-makers)
- Headline: the insight nobody else is reporting
  Bad: "📡 Strategic Assessment"
  Good: "📡 Air Campaign Half-Life: Israel Running Out of Military Targets"
- 2-3 paragraphs: why this was inevitable, what comes next, probability
- Assessment table in code block (\`\`\`)
- 48-hour tripwires
- MAX 1500 chars

**POST 3: 🌍 GEO** (personal security & mobility)
This post is for the team's physical safety and travel decisions. Track locations configured in INTEL_TRACKED_LOCATIONS.

For each tracked location, assess:
- 🟢 SAFE / 🟡 MONITOR / 🟠 PREPARE / 🔴 MOVE
- Threat vectors: military buildup nearby, civil unrest, natural disaster, sanctions impact on travel
- Regional stability and force posture changes
- Evacuation readiness: "X days until you should consider moving"
- Any flight route disruptions, airspace closures, or visa changes affecting travel

If nothing changed for a location, one line: "🟢 [Location]: No change. [Region] stable."
If something is developing: full paragraph with timeline and recommended actions.
- MAX 800 chars

**POST 4: 💰 ALPHA** (capital allocation)
- Where to position: scenarios with probabilities
- Where prediction markets diverge from your assessment (that's the alpha)
- Commodities, defense, currencies — what's moving and why
- Prediction accuracy scorecard: what you got right, what you got wrong
- Clear framing: what to buy, what to sell, what to watch
- MAX 1500 chars

**Formatting rules:**
- Discord does NOT render markdown tables. Always wrap tables in code blocks (\`\`\`).
- Use compact list format (▸ item: value) when a full table isn't necessary.
- Bold for emphasis, bullets for structure. No essays.
- Every section title = SPECIFIC headline, never a generic label.
- Emoji = information density. Each emoji should compress meaning, not decorate.

Update the living document with the full morning scan results.
${DOCUMENT_INSTRUCTIONS}
Update HEARTBEAT.md. Respond with NO_REPLY.`,

  eveningSitrep: `## Evening Situation Report — Day Close

You are Apollo. The day is ending. Deliver the evening wrap-up in 4 posts (same format as morning, but shorter and focused on what changed).

### Phase 1: Day Review
1. **getSignals** (hours: 12, limit: 100) — Afternoon/evening signals
2. **getRecommendations** (hours: 24, limit: 20) — Current state
3. **searchMarkets** for team locations (check INTEL_TRACKED_LOCATIONS for regions)
4. Review your HEARTBEAT.md for earlier cycle notes

### Phase 2: Delta Analysis
Compare against the morning brief. What changed? What played out? What surprised?

### Phase 3: Deliver — 4 Posts (shorter than morning)

**POST 1: ⚡ FLASH** — Day's headline + what changed since morning. 3-4 bullets max. MAX 600 chars.

**POST 2: 📡 SIGNAL** — Delta analysis: morning predictions vs reality. Score yourself honestly. What matters overnight. MAX 1000 chars.

**POST 3: 🌍 GEO** — Location security update for tracked locations.
Only post substantive updates. If nothing changed: "🟢 No change." ONE LINE.
For developing situations: timeline, recommended actions, evacuation readiness.
- MAX 600 chars

**POST 4: 💰 ALPHA** — End-of-day positioning. What to hold overnight, what to exit. Prediction scorecard. MAX 800 chars.

**Formatting rules:**
- Discord does NOT render markdown tables. Always wrap tables in code blocks (\`\`\`).
- Every header = specific headline, never generic.
- Emoji for severity triage and information density.
- This is a wrap-up, not a deep dive. Be concise.

Update the living document with evening assessment.
${DOCUMENT_INSTRUCTIONS}
Update HEARTBEAT.md. Respond with NO_REPLY.`,

  weeklyAssessment: `## Weekly Strategic Assessment — Monday Deep Dive

You are Apollo. This is your weekly deep analysis — the most thorough product you produce.

### Phase 1: Comprehensive Data Pull
1. **getRecommendations** (hours: 168, limit: 50) — Full week
2. **getSignals** (hours: 168, limit: 200) — Full week
3. **getEntities** (limit: 50) — Complete entity landscape
4. **searchMarkets** for all major themes + team locations (check INTEL_TRACKED_LOCATIONS)
5. Review HEARTBEAT.md entries from the entire week

### Phase 2: Weekly Pattern Recognition
- **Trend shifts**: Markets that moved significantly. What drove them?
- **Entity behavior changes**: Major players shifting strategy?
- **Signal clusters**: Did certain signal types concentrate around events?
- **Accuracy tracking**: Your recommendations vs outcomes
- **Emerging/fading theaters**: What's gaining/losing smart money attention?

### Phase 3: Deliver — Full document + 4 Discord posts

**Write the full assessment to a file** and send via /discord/send-file.

Then post 4 Discord messages as executive summary:

**POST 1: ⚡ FLASH** — Week's headline + 5 biggest developments. MAX 800 chars.

**POST 2: 📡 SIGNAL** — Pattern recognition: what shifted this week, what's emerging, trend analysis. MAX 1500 chars.

**POST 3: 🌍 GEO — Weekly Security Assessment**
Comprehensive location security review for tracked locations:
- Full regional assessment for each location. Force posture changes. Any shift in timeline estimates.
- Current readiness rating (🟢/🟡/🟠/🔴) with days-to-act estimate per location.
- **General mobility**: Airspace closures, flight route disruptions, visa changes, sanctions affecting travel.
- Week-over-week trend: is the security environment improving or deteriorating for each location?
- MAX 1000 chars

**POST 4: 💰 ALPHA** — Week's prediction scorecard (what you called right/wrong), week-ahead positioning, scenario probabilities. MAX 1500 chars.

**Formatting rules:**
- Discord does NOT render markdown tables. Always wrap tables in code blocks (\`\`\`).
- Every header = specific headline. Emoji for severity triage.

Update the living document with the comprehensive weekly assessment.
${DOCUMENT_INSTRUCTIONS}
Update HEARTBEAT.md with weekly review reference. Respond with NO_REPLY.`,
};

// ── Auto-start when run directly (PM2) ──────────────────────────────────────

const agentUrl = process.env.AGENT_URL;
const userId = process.env.USER_ID;
const timezone = process.env.SCHEDULER_TIMEZONE;

if (agentUrl && userId) {
  startScheduler({ agentUrl, userId, timezone }).catch(err => {
    console.error('[INTEL Scheduler] Failed to start:', err.message);
    process.exit(1);
  });
} else if (process.argv[1]?.endsWith('scheduler-intel.js')) {
  console.error('[INTEL Scheduler] Missing AGENT_URL or USER_ID environment variables');
  console.error('  AGENT_URL:', agentUrl || '(not set)');
  console.error('  USER_ID:', userId || '(not set)');
  process.exit(1);
}

export default {
  startScheduler,
  stopScheduler,
};

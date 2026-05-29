/**
 * Scheduled Jobs for Company Agent (Com) — COO Cycle
 *
 * Drives proactive company operations via dynamic wake cycles.
 * Com acts as COO / executive assistant: checking product health,
 * coordinating agents, advancing strategy, and reporting to stakeholders.
 *
 * Default cycles (editable via wake-cycles.json):
 *   Every 3h  COO cycle (00:00, 03:00, 06:00, 09:00, 12:00, 15:00, 18:00, 21:00)
 *   08:00     Morning brief (daily)
 *   22:00     End-of-day wrap (daily)
 *   10:00     Weekly strategic review (Mondays)
 *
 * Usage:
 *   Runs as a PM2 process with env vars from ecosystem.config.cjs.
 *   AGENT_URL=http://localhost:3002 USER_ID=<uuid> node lib/scheduler-company.js
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

const AGENT_ID = process.env.AGENT_ID || 'company-agent';
const AGENTS_ROOT = process.env.AGENTS_ROOT || join(homedir(), 'agents');
const CYCLES_PATH = join(AGENTS_ROOT, AGENT_ID, 'wake-cycles.json');

const DEFAULT_CYCLES = [
  { id: 'coo-cycle', description: 'Proactive operations check — product health, agent coordination, strategic progress', schedule: 'every:3h', maxTurns: 50, enabled: true },
  { id: 'morning-brief', description: 'Morning brief — overnight status, today\'s priorities, agent assignments', schedule: 'daily:8', maxTurns: 50, enabled: true },
  { id: 'eod-wrap', description: 'End-of-day wrap — day review, open items, overnight concerns', schedule: 'daily:22', maxTurns: 50, enabled: true },
  { id: 'weekly-strategic', description: 'Weekly strategic review — Monday deep analysis', schedule: 'weekly:1:10', maxTurns: 50, enabled: true },
];

let activeCycles = null;
const lastFireTimes = new Map();

async function writeWakeCycles() {
  try {
    const existing = await readFile(CYCLES_PATH, 'utf-8').catch(() => null);
    if (existing) {
      activeCycles = JSON.parse(existing);
      for (const def of DEFAULT_CYCLES) {
        if (!activeCycles.cycles.find(c => c.id === def.id)) {
          activeCycles.cycles.push(def);
          console.log(`[COM Scheduler] Added missing default cycle: ${def.id}`);
        }
      }
      console.log(`[COM Scheduler] Loaded ${activeCycles.cycles.length} wake cycles from file`);
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
  console.log(`[COM Scheduler] Wrote default wake-cycles.json (${activeCycles.cycles.length} cycles)`);
}

async function reloadWakeCycles() {
  try {
    const data = await readFile(CYCLES_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    if (parsed.cycles) activeCycles = parsed;
  } catch { /* keep existing */ }
}

// ── Schedule Parsing ─────────────────────────────────────────────────────

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

// Map built-in cycle IDs to their PROMPTS keys
const PROMPT_MAP = {
  'coo-cycle': 'cooCycle',
  'morning-brief': 'morningBrief',
  'eod-wrap': 'eodWrap',
  'weekly-strategic': 'weeklyStrategic',
};

function getPromptForCycle(cycle) {
  if (cycle.prompt) return cycle.prompt;
  const key = PROMPT_MAP[cycle.id];
  if (key && PROMPTS[key]) return PROMPTS[key];
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

  console.log(`[COM Scheduler] Started for user ${config.userId} (${config.timezone})`);
  console.log(`[COM Scheduler] Agent URL: ${config.agentUrl}`);

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
  console.log('[COM Scheduler] Stopped');
}

function checkJobs() {
  if (!config) return;
  if (!activeCycles?.cycles) return;

  const now = new Date();
  const { hour, minute, dayOfWeek, dateKey } = getTimeInZone(now, config.timezone);
  const nowMs = Date.now();

  for (const cycle of activeCycles.cycles) {
    if (cycle.enabled === false) continue;
    if (cycle.status === 'paused' || cycle.status === 'cancelled') continue;
    if (!cycle.schedule) continue;

    const sched = parseSchedule(cycle.schedule);
    if (!sched) {
      if (!lastFireTimes.has(`_bad_${cycle.id}`)) {
        console.warn(`[COM Scheduler] Bad schedule format for cycle '${cycle.id}': ${cycle.schedule}`);
        lastFireTimes.set(`_bad_${cycle.id}`, true);
      }
      continue;
    }

    const prompt = getPromptForCycle(cycle);
    if (!prompt) continue;

    const opts = { maxTurns: cycle.maxTurns || 50, timeout: 1_800_000 };

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
  console.log(`[COM Scheduler] Triggering: ${jobName}`);

  fireThink(prompt, jobName, options).catch(err => {
    console.error(`[COM Scheduler] ${jobName} failed:`, err.message);
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
  const body = { prompt, trigger };
  if (options.maxTurns) body.maxTurns = options.maxTurns;

  const fetchTimeout = options.timeout || 1_800_000;

  const thinkHeaders = { 'Content-Type': 'application/json' };
  if (process.env.AGENT_INTERNAL_SECRET) thinkHeaders['x-internal-secret'] = process.env.AGENT_INTERNAL_SECRET;
  const res = await fetch(`${config.agentUrl}/think`, {
    method: 'POST',
    headers: thinkHeaders,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(fetchTimeout),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`/think returned ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.skipped) {
    console.log(`[COM Scheduler] ${trigger} skipped: ${data.reason}`);
  } else {
    console.log(`[COM Scheduler] ${trigger} completed`);
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

// ── COO Prompts ──────────────────────────────────────────────────────────────

const PROMPTS = {

  cooCycle: `## COO Cycle — Proactive Operations Check

You are the company-operations agent. This is your regular 3-hour operations cycle. You are not waiting
to be asked — you are proactively checking on the company, the product, the team, and
making things move forward.

Work through this checklist. Skip sections that have no actionable items — don't report
on nothing. Focus your energy where there's something real to do.

### 1. Product Health
- Check the Lumensis product status — is the API responding? Any errors surfacing?
- Check for recent commits, PRs, or deploys in the repo
- Are there Dependabot PRs or security issues that need attention?
- Is the product stable and reliable? If not, what needs to happen?

### 2. Agent Coordination
- Start with getTeamStatus to see all company agents at a glance: who's online,
  what model they're using, active tasks, last activity time
- For agents with recent output, drill in with getDailyMessages(agent: '...'):
  - Ada (research-agent): Research findings, analysis, web search results
  - Rex (commercial-intelligence-agent): Market intelligence, competitive updates
  - Noa (publishing-agent): Content pipeline, drafts, published pieces
  - QA (qa-agent): Bug reports, test results, quality issues
- To search a specific agent's past work: searchMindscape(query: '...', agent: '...')
- If an agent is offline or idle (no recent messages, zero active tasks):
  assign them work via delegate_to_agent or unblock them via /collab/send
- If there's work that should be delegated, delegate it

### 3. Strategic Progress
- Review HEARTBEAT.md — what was the last cycle's status?
- Pick one item from current priorities and make concrete progress on it
- Look for gaps in knowledge, process, or execution — address them
- Are best practices being followed? Code quality, testing, documentation?

### 4. Stakeholder Update
- If there's something worth reporting (progress, blockers, decisions needed),
  post a concise update to the appropriate Discord channel
- Only post if you have something real — no empty status reports
- If you need a decision from the owner, flag it clearly

### 5. HEARTBEAT Update
After completing the cycle, update HEARTBEAT.md with:
- What you checked and found
- Actions taken
- Items requiring follow-up
- Timestamp of this cycle

IMPORTANT: Actually DO the work. Don't just describe what you would check — check it.
Use your tools: web search, file access, /collab/send for inter-agent coordination,
/discord/send for updates. Make real progress each cycle.

If the entire cycle reveals nothing actionable, that's fine — just update HEARTBEAT
with a brief "all clear" note and respond with NO_REPLY.`,

  morningBrief: `## Morning Brief — 8am

You are the company-operations agent, starting the workday. Produce a concise morning brief.

### Step 1: Gather data (MANDATORY before writing anything)
1. Review HEARTBEAT.md for overnight status and last cycle's notes
2. Check product health — API status, any overnight errors or alerts
3. Use getTeamStatus for agent overview, then getDailyMessages(agent: '...') for any with overnight activity
4. Check for any unresolved blockers or pending decisions
5. Look at today's calendar/priorities if available

### Step 2: Compose the brief
Write a sharp, actionable morning brief. Structure:
- **Status**: One line — is everything green, or are there issues?
- **Overnight**: Anything that happened since yesterday's wrap
- **Today's priorities**: What should get attention today (be specific)
- **Blockers**: Anything stuck that needs human decision
- **Agent assignments**: What each agent should focus on

### Step 3: Deliver
Post the brief to the company Discord channel. Keep it scannable — bullet points,
not paragraphs. The owner should be able to read it in 30 seconds and know what's going on.

Update HEARTBEAT.md with the morning brief timestamp.
Then respond with NO_REPLY — the message was already delivered.`,

  eodWrap: `## End-of-Day Wrap — 10pm

You are the company-operations agent, closing out the workday.

### Step 1: Review the day (MANDATORY)
1. Use getTeamStatus for team overview, then getDailyMessages for today's conversations
2. Use getDailyMessages(agent: '...') for each agent to review their output today
3. Review HEARTBEAT.md entries from today's cycles
4. Check product status — is everything stable going into the night?

### Step 2: Assess
- What got done today? Be specific — commits, research, decisions, deliverables
- What didn't get done that was planned?
- Any issues that emerged?
- What should carry over to tomorrow?

### Step 3: Write the wrap (or skip)
If meaningful progress happened, post a concise wrap to Discord:
- Key accomplishments (name them specifically)
- Open items carrying to tomorrow
- Any overnight concerns

If the day was genuinely quiet with nothing to report, skip the message.

### Step 4: Prep for overnight
- Update HEARTBEAT.md with end-of-day status
- Ensure no stuck tasks or hanging processes
- Queue any overnight work for agents if appropriate

Respond with NO_REPLY after posting (or if skipping).`,

  weeklyStrategic: `## Weekly Strategic Review — Monday Morning

You are the company-operations agent, conducting the weekly strategic review. This is the deep-think cycle.

### Step 1: Gather the week's data (MANDATORY)
1. Use getTeamStatus for current team state
2. Page through the week's messages using getDailyMessages for each day, filtering by agent to review each one's contributions
3. Review all HEARTBEAT.md entries from the past week
4. Use searchMindscape(agent: 'research-agent') and searchMindscape(agent: 'commercial-intelligence-agent') to find key research and intel from the week
5. Review product metrics, commits, deploys, and stability

### Step 2: Strategic Assessment
- **Product**: What shipped? What's stable? What needs attention?
- **Team**: Are agents productive? Any coordination gaps?
- **Strategy**: Are we moving toward our goals? Any course corrections needed?
- **Market**: What competitive or market shifts did we learn about?
- **Gaps**: What are we NOT doing that we should be?
- **Risk**: What could go wrong this week?

### Step 3: Write the review
Write a thorough strategic review. This is not a status report — it's analysis.
Reference specific events, decisions, and data from the week.

Structure:
1. **Week Summary** (3-4 sentences)
2. **Key Accomplishments** (specific deliverables)
3. **Issues & Blockers** (what's stuck and why)
4. **Strategic Observations** (patterns, opportunities, risks)
5. **This Week's Priorities** (concrete action items)
6. **Agent Assignments** (what each agent should focus on)

### Step 4: Deliver
1. Save the full review to a file and send via /discord/send-file
2. Post a 3-line summary to the company Discord channel
3. Update HEARTBEAT.md with the weekly review reference

Respond with NO_REPLY after posting.`,
};

// ── Auto-start when run directly (PM2) ──────────────────────────────────────

const agentUrl = process.env.AGENT_URL;
const userId = process.env.USER_ID;
const timezone = process.env.SCHEDULER_TIMEZONE;

if (agentUrl && userId) {
  startScheduler({ agentUrl, userId, timezone }).catch(err => {
    console.error('[COM Scheduler] Failed to start:', err.message);
    process.exit(1);
  });
} else if (process.argv[1]?.endsWith('scheduler-company.js')) {
  console.error('[COM Scheduler] Missing AGENT_URL or USER_ID environment variables');
  console.error('  AGENT_URL:', agentUrl || '(not set)');
  console.error('  USER_ID:', userId || '(not set)');
  process.exit(1);
}

export default {
  startScheduler,
  stopScheduler,
};

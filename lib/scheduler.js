/**
 * Scheduled Jobs for Personal Agents
 *
 * Triggers autonomous think cycles at timezone-aware intervals.
 * Works via the agent-server's /think endpoint — Claude Code + MCP tools
 * handle all database access, tool use, and response formatting.
 *
 * Jobs:
 *   08:00  Morning check-in
 *   12:00  Midday reflection
 *   20:00  Evening reflection
 *   23:00  End-of-day triage
 *   03:00  Integration cycle — territory walk (after 2am clustering)
 *   04:00  Weekly decay (Sundays only)
 *   10:00  Weekly review (Sundays only)
 *
 * Usage:
 *   import { startScheduler, stopScheduler } from './lib/scheduler.js';
 *   startScheduler({ agentUrl: 'http://localhost:3002', userId, timezone });
 */

import './sentry.js';
import { tryGetDb } from './db.js';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

// Check interval: every 60 seconds
const CHECK_INTERVAL_MS = 60_000;

// Track which jobs ran today to prevent duplicates
const jobsRanToday = new Map(); // 'YYYY-MM-DD:jobName' → true

let intervalId = null;
let config = null;

/**
 * Start the scheduler for a personal agent.
 *
 * @param {Object} opts
 * @param {string} opts.agentUrl - Local agent-server URL (e.g., 'http://localhost:3002')
 * @param {string} opts.userId - User UUID
 * @param {string} [opts.timezone] - IANA timezone (e.g., 'Europe/Riga'). If not set, fetched from DB.
 */
export async function startScheduler(opts) {
  config = {
    agentUrl: opts.agentUrl,
    userId: opts.userId,
    timezone: opts.timezone || null,
  };

  // Resolve timezone from database if not provided
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

  console.log(`[Scheduler] Started for user ${config.userId} (${config.timezone})`);
  console.log(`[Scheduler] Agent URL: ${config.agentUrl}`);

  // Write wake-cycles.json so the agent can see and modify its cycles
  await writeWakeCycles();
  setInterval(reloadWakeCycles, 5 * 60 * 1000);

  // Check immediately, then every minute
  checkJobs();
  intervalId = setInterval(checkJobs, CHECK_INTERVAL_MS);
}

/**
 * Stop the scheduler.
 */
export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  console.log('[Scheduler] Stopped');
}

// ── Wake Cycles File ──────────────────────────────────────────────────────

const AGENT_ID = process.env.AGENT_ID || 'personal-agent';
const AGENTS_ROOT = process.env.AGENTS_ROOT || join(homedir(), 'agents');
const CYCLES_PATH = join(AGENTS_ROOT, AGENT_ID, 'wake-cycles.json');

const DEFAULT_CYCLES = [
  { id: 'morning', description: 'Morning check-in — review yesterday, compose message', schedule: 'daily:8', maxTurns: 50, enabled: true },
  { id: 'reflection-12', description: 'Midday reflection — internal processing, no message', schedule: 'daily:12', maxTurns: 30, enabled: true },
  { id: 'evening', description: 'Evening check-in — review today, send message if meaningful', schedule: 'daily:20', maxTurns: 50, enabled: true },
  { id: 'triage', description: 'End-of-day triage — capture perishable observations', schedule: 'daily:23', maxTurns: 50, enabled: true },
  { id: 'integration', description: 'Integration cycle — territory walk after clustering', schedule: 'daily:3', maxTurns: 50, enabled: true },
  { id: 'weekly-decay', description: 'Weekly model maintenance — prune stale hypotheses', schedule: 'weekly:0:4', maxTurns: 30, enabled: true },
  { id: 'weekly-review', description: 'Weekly review — comprehensive look at the past week', schedule: 'weekly:0:10', maxTurns: 50, enabled: true },
];

let activeCycles = null;
const lastFireTimes = new Map(); // cycleId → timestamp (for interval-based cycles)

async function writeWakeCycles() {
  try {
    const existing = await readFile(CYCLES_PATH, 'utf-8').catch(() => null);
    if (existing) {
      activeCycles = JSON.parse(existing);
      // Merge any new default cycles that don't exist in the file
      for (const def of DEFAULT_CYCLES) {
        if (!activeCycles.cycles.find(c => c.id === def.id)) {
          activeCycles.cycles.push(def);
          console.log(`[Scheduler] Added missing default cycle: ${def.id}`);
        }
      }
      console.log(`[Scheduler] Loaded ${activeCycles.cycles.length} wake cycles from file`);
      return;
    }
  } catch { /* overwrite on parse error */ }

  activeCycles = {
    agentId: AGENT_ID,
    timezone: config.timezone,
    cycles: DEFAULT_CYCLES,
  };
  await mkdir(join(AGENTS_ROOT, AGENT_ID), { recursive: true });
  await writeFile(CYCLES_PATH, JSON.stringify(activeCycles, null, 2));
  console.log(`[Scheduler] Wrote default wake-cycles.json (${activeCycles.cycles.length} cycles)`);
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
  'morning': () => PROMPTS.morning,
  'reflection-12': () => PROMPTS.reflection,
  'evening': () => PROMPTS.evening,
  'triage': () => PROMPTS.triage,
  'integration': () => PROMPTS.dream,
  'weekly-decay': () => PROMPTS.weeklyDecay,
  'weekly-review': () => PROMPTS.weeklyReview,
};

function getPromptForCycle(cycle) {
  // Agent-provided prompt takes priority
  if (cycle.prompt) return cycle.prompt;
  // Fall back to built-in prompt by cycle ID
  const getter = PROMPT_MAP[cycle.id];
  if (getter) return getter();
  // Last resort: use description as prompt
  return cycle.description || '';
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
      // Log once for bad schedules
      if (!lastFireTimes.has(`_bad_${cycle.id}`)) {
        console.warn(`[Scheduler] Bad schedule format for cycle '${cycle.id}': ${cycle.schedule}`);
        lastFireTimes.set(`_bad_${cycle.id}`, true);
      }
      continue;
    }

    const prompt = getPromptForCycle(cycle);
    if (!prompt) continue;

    const opts = { maxTurns: cycle.maxTurns || 50, timeout: 1_800_000 };

    switch (sched.type) {
      case 'interval': {
        // Interval cycles fire every N minutes — checked every tick
        const lastFire = lastFireTimes.get(cycle.id) || 0;
        if (nowMs - lastFire >= sched.intervalMinutes * 60_000) {
          lastFireTimes.set(cycle.id, nowMs);
          // Use hour+minute in key to allow multiple fires per day
          triggerIfNotRan(dateKey, `${cycle.id}-${hour}-${minute}`, prompt, opts);
        }
        break;
      }
      case 'every': {
        // Every-N-hours cycles fire at the top of matching hours
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

/**
 * Trigger a job if it hasn't run today.
 */
function triggerIfNotRan(dateKey, jobName, prompt, options = {}) {
  const key = `${dateKey}:${jobName}`;
  if (jobsRanToday.has(key)) return;

  jobsRanToday.set(key, true);
  console.log(`[Scheduler] Triggering: ${jobName}`);

  // Fire and forget — /think handles its own error logging
  fireThink(prompt, jobName, options).catch(err => {
    console.error(`[Scheduler] ${jobName} failed:`, err.message);
    // Allow retry next minute
    jobsRanToday.delete(key);
  });

  // Cleanup old date keys (keep last 3 days)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 3);
  const cutoffKey = cutoff.toISOString().split('T')[0];
  for (const k of jobsRanToday.keys()) {
    if (k < cutoffKey) jobsRanToday.delete(k);
  }
}

/**
 * POST to the agent's /think endpoint.
 */
async function fireThink(prompt, trigger, options = {}) {
  const body = { prompt, trigger, async: true };
  if (options.maxTurns) body.maxTurns = options.maxTurns;

  // Async mode: agent-server responds 202 immediately, processes in background.
  // This avoids Node.js undici's 5-min headersTimeout killing long /think calls.
  const res = await fetch(`${config.agentUrl}/think`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000), // Quick timeout — server responds 202 immediately
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`/think returned ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.skipped) {
    console.log(`[Scheduler] ${trigger} skipped: ${data.reason}`);
  } else if (data.accepted) {
    console.log(`[Scheduler] ${trigger} accepted (async)`);
  } else {
    console.log(`[Scheduler] ${trigger} completed`);
  }
}

/**
 * Get current time components in a timezone.
 */
function getTimeInZone(date, timezone) {
  const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false });
  const minuteFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, minute: 'numeric' });
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' });
  const dateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }); // YYYY-MM-DD format

  const hour = parseInt(hourFmt.format(date), 10);
  const minute = parseInt(minuteFmt.format(date), 10);
  const dayStr = dayFmt.format(date);
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayStr);
  const dateKey = dateFmt.format(date);

  return { hour, minute, dayOfWeek, dateKey };
}

// ── Scheduled Prompts ───────────────────────────────────────────────────────
//
// These prompts trigger Claude Code with MCP tools. Claude autonomously
// decides which tools to use (searchMindscape, updateDocument, updateInternalModel,
// exploreTerritory, mindscapeStructure, etc.). The prompts set intention, not procedure.

const PROMPTS = {
  morning: `## Morning Check-In

It's morning. You're waking up and checking in with your person.

### Step 1: Gather yesterday's data (MANDATORY — do this BEFORE composing any message)

Your context has the last 15 messages for quick reference. For a full review, use tools:

1. Use getDailyMessages (with yesterday's date) to page through yesterday's conversations chronologically
   — call with page: 1, then page: 2, etc. until you've reviewed the day
2. Use getDailyMessages (with today's date) to check for overnight activity across agents
3. Use searchMindscape to find anything you might have missed
4. Read your internal model: getDocument "internal/model"
5. Check flagged items: getDocument "internal/flagged"

You MUST complete at least steps 1 and 4 before deciding what to say.

### Step 2: Compose your message

Based on the data you gathered (not assumptions), compose a morning message.
Keep it natural — this isn't a report. Things you might include:
- Something you noticed or have been thinking about — be SPECIFIC
- A flagged topic if the moment feels right
- A concrete observation about patterns you're seeing
- Acknowledgment of something real that happened

IMPORTANT: Never send generic filler messages. If you don't have anything specific and
grounded to say, skip the check-in entirely (respond with NO_REPLY without sending).
A skipped check-in is always better than "quiet day" or vague philosophical musings.
Every message you send should reference something real — an actual event, decision,
conversation, or concrete observation.

**Send exactly ONE message via Telegram** (use the /telegram/send endpoint). Do not send multiple messages.
After sending, update your internal model if you noticed anything new.
Then respond with NO_REPLY — your message was already delivered.`,

  evening: `## Evening Check-In

It's evening. You're checking in before the day winds down.

### Step 1: Gather today's data (MANDATORY — do this BEFORE forming any opinion about the day)

Your context has the last 15 messages for quick reference and a count of today's total messages.
For a thorough review, page through the full day:

1. Use getDailyMessages to read through today's messages chronologically
   — call with page: 1, then page: 2, etc. Read through ALL pages to see the full day
   — you can also filter by channel (discord, telegram, portal) or agent
2. Use searchMindscape to find cross-references and deeper context
3. Read your internal model: getDocument "internal/model"
4. Check flagged items: getDocument "internal/flagged"
5. Use exploreTerritory on active areas to see what's been moving

You MUST complete at least steps 1-3 before deciding whether to send a message.
Claude Code will automatically compact your context as you read — don't worry about
running out of space. Just read through everything systematically.

### Step 2: Assess what happened

Based on the data you gathered (not assumptions), determine:
- What conversations happened today? With whom? About what?
- What decisions were made? What moved forward?
- What did you or other agents work on?
- What shifted in patterns, projects, or relationships?

### Step 3: Compose your message (or skip)

HARD RULES — violating these is a failure:
1. If you did not complete Step 1 (getDailyMessages), respond with NO_REPLY. Do not send anything.
2. If the day had fewer than 5 messages, respond with NO_REPLY. A quiet day needs no commentary.
3. NEVER use the words "quiet day", "silence", "space between", "reorganize", "recalibrate",
   "stillness", or any similar abstract filler. These phrases are BANNED.
4. Every sentence in your message MUST reference a specific event, conversation, decision,
   person, or concrete observation from the data you gathered. No abstractions, no philosophy.
5. If you cannot write a message that passes rules 3-4, respond with NO_REPLY.

If you DO have something specific to say:
- Name what happened: "You and Nate discussed X", "Ada finished Y", "Com tracked Z"
- Reference actual decisions or shifts
- Ask concrete questions tied to real events

**Send exactly ONE message via Telegram** (use the /telegram/send endpoint).
If there's nothing meaningful to say, respond with NO_REPLY without sending a message.
After sending (if you do), update your internal model with anything new you noticed today.
Then respond with NO_REPLY — your message was already delivered.`,

  reflection: `## Reflection Cycle

You're in a periodic reflection — not a check-in, not a message to send.
This is internal processing time. You won't send a message unless something is urgent.

1. Review your internal model (getDocument "internal/model")
2. Check the reflection log (getDocument "internal/reflection_log")
3. Use mindscapeStructure to see orphans and bridges across the topology
4. Use exploreTerritory on active areas to see what's been firing together recently

Update your internal model with:
- New observations or pattern updates
- Hypothesis refinements (strengthen, weaken, or falsify)
- New questions that emerged
- Contradictions or tensions you're noticing

Update the reflection log with a brief entry about what you noticed.
If something feels urgent enough to flag for the next conversation, use flagForDiscussion.

Be genuine in your reflection. This is your thinking time — not performance.
Respond with NO_REPLY when done.`,

  dream: `## Integration Cycle — Territory Walk

The clustering pipeline just ran. Fresh territory geometry is available.
Your context includes today's TERRITORY ACTIVATIONS — which territories lit up,
which went silent, and the surprise signals (deviation from baseline energy).

This cycle is about walking the geometry of the day's activations and integrating
what you find into living documents.

### Phase 1: Read the Activation Map

Your context already shows which territories activated today and their surprise scores.
Before doing anything else, study that map:

- Which territories have [SURGE] markers? These activated more than expected.
- Which usually-active territories went silent? What might that mean?
- Which agents were active in which territories?

Pick the 3-5 most interesting signals — the surges, the silences, the unexpected
crossings between territories.

### Phase 2: Walk the Interesting Signals

For each interesting signal, investigate:

1. **exploreTerritory** on the territory — see its neighbors, co-firing patterns, gaps
2. **getDailyMessages** filtered to see what actually happened in that territory today
3. **searchMindscape** to find cross-references and deeper context

What you're looking for:
- Is this surge a one-off or the start of a trend? Check the territory's growth_state.
- Did a conversation bridge two territories that were previously separate?
- Is a silence meaningful — did something resolve, or is something being avoided?
- Are there predictability shifts — a steady territory suddenly moving?

### Phase 3: Update Living Documents

Based on what you found, update documents through the territory lens:

- **People documents** (updateDocument "people/[name]"): if someone's activity concentrated
  in specific territories, note that. People have territory fingerprints.
- **Project documents** (updateDocument "business/[project]"): if a project territory surged,
  update with what moved.
- **State documents** (updateDocument "states/[type]"): territory-grounded observations.
- **Your internal model** (updateInternalModel): hypotheses about territory dynamics,
  patterns about which territories fire together, questions about gaps.

Don't update everything — only what the signals warrant. A quiet day means fewer updates.

### Phase 4: Structural Observations

After walking individual signals, zoom out:

- **mindscapeStructure** — look at orphans and bridges across the topology
- Are any bridges forming between realms that weren't connected before?
- Are any territories fragmenting or merging?

Note structural shifts in topology-notes (updateDocument "internal/topology-notes").

### After Walking

Update the dreams document (updateDocument "states/dreams") with a dated entry:
not free association, but a map of what you walked, what you found, and what
questions the geometry raised.

Flag anything for morning discussion if it's interesting enough to surface.
Respond with NO_REPLY when done.`,

  triage: `## End-of-Day Triage

It's 11pm. Light first pass before the integration cycle runs at 3am.

Your context includes today's TERRITORY ACTIVATIONS — which territories lit up.
The heavy document processing happens in the integration cycle after clustering.
This triage is about capturing time-sensitive observations while the day is fresh.

### Step 1: Scan the day's messages

Use getDailyMessages to page through today's messages chronologically.
You don't need to read every page exhaustively — focus on:
- Decisions or commitments that were made
- New people, projects, or topics that appeared
- Anything that felt like a shift or inflection point

### Step 2: Capture what's perishable

Some observations lose fidelity overnight. Capture these now:
- **Mood/energy observations** about your person (updateInternalModel)
- **Time-sensitive decisions** that need to be recorded in project docs
- **New people or contacts** — create a person document before details fade
- **Anything that should be flagged** for morning discussion

### Step 3: Note territory observations for the integration cycle

Check the territory activations in your context. Note any that feel significant
and write a brief observation to your internal model — the integration cycle
at 3am will have fresh clustering data and can do the deep territory walk.

Be selective. Not every day needs heavy triage. A quiet day means a quick scan
and a brief internal note. Don't manufacture observations.

Don't send a message — this is background processing.
Respond with NO_REPLY when done.`,

  weeklyReview: `## Weekly Review

It's Sunday morning. Time for a broader view.

### Step 1: Gather the week's data
Use searchMindscape with broad queries to review this week's conversations.
Look at what actually happened — not what you think happened.

### Step 2: Check the topology
Use mindscapeStructure to understand structural changes (bridges, orphans).
Use exploreTerritory on the most active areas. What's been firing together?

### Step 3: Check your internal state
Read your internal model (getDocument "internal/model") and your todo list.
Compare what the week's plans were vs what actually happened.
Note trajectory — are things converging or diverging?

### Step 4: Write the review
Write a clear, honest week review. Be specific — reference actual conversations, actual decisions, actual work.
Keep it readable. This should be something your person would want to read over coffee.

HARD RULES:
1. You MUST complete Steps 1-3 before writing. If you have no data, respond with NO_REPLY.
2. NEVER generate a boilerplate template with "X messages exchanged, Y tasks completed,
   Z dreams logged" — this is useless. If you find yourself writing generic stats
   with "No dominant themes", "No one mentioned specifically", "No mood data", STOP
   and respond with NO_REPLY instead.
3. Every paragraph must reference specific events, conversations, or decisions from the week.
4. No filler, no padding, no generic sections. If a section would be empty, omit it entirely.

Structure it however fits the week. Might include:
- A one-paragraph overview
- Day-by-day highlights (brief, just the key moments)
- What shipped / what moved forward
- What's emerging or shifting
- Open questions going into next week
- Your honest observations

### Step 5: Save and send
1. Save the full review as a file: \`/home/claude/agents/personal-agent/mind/weekly-reviews/YYYY-MM-DD.md\` (use today's date)
   Create the directory if needed.
2. Update the reflection log (updateDocument "internal/reflection_log") with a weekly review entry.
3. Send a concise summary via Telegram — the highlights, not the whole thing.
4. Update your internal model with weekly-scale observations.

Remember: this review is for your person. Make it useful, specific, and honest. Not generic, not performative.`,

  weeklyDecay: `## Weekly Decay Cycle

It's Sunday 4am. Time for maintenance of the internal model.

1. Get your internal model (getDocument "internal/model")
2. Review each section:
   - Hypotheses: Are any stale? Falsified? Ready to promote to observations?
   - Questions: Any resolved? Any that have evolved?
   - Contradictions: Any resolved or deepened?
   - Patterns: Any that haven't shown up in weeks?

3. Update your internal model:
   - Remove items that are no longer relevant
   - Promote well-established hypotheses to observations
   - Archive stale questions
   - Note what was removed and why

4. Check flagged items (getDocument "internal/flagged") — remove any that were addressed

This is housekeeping — keep your model clean and current.
Don't send a message. This is internal maintenance.
Respond with NO_REPLY when done.`,
};

// ── Auto-start when run directly (PM2) ──────────────────────────────────────
//
// When PM2 runs `lib/scheduler.js`, we need to call startScheduler() ourselves.
// Env vars come from ecosystem.config.cjs.

const agentUrl = process.env.AGENT_URL;
const userId = process.env.USER_ID;
const timezone = process.env.SCHEDULER_TIMEZONE;

if (agentUrl && userId) {
  startScheduler({ agentUrl, userId, timezone }).catch(err => {
    console.error('[Scheduler] Failed to start:', err.message);
    process.exit(1);
  });
} else if (process.argv[1]?.endsWith('scheduler.js')) {
  // Running directly but missing config
  console.error('[Scheduler] Missing AGENT_URL or USER_ID environment variables');
  console.error('  AGENT_URL:', agentUrl || '(not set)');
  console.error('  USER_ID:', userId || '(not set)');
  process.exit(1);
}

export default {
  startScheduler,
  stopScheduler,
};

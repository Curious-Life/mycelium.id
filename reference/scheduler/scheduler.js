/**
 * Scheduled Jobs for Personal Agents
 *
 * Triggers autonomous think cycles at timezone-aware intervals.
 * Works via the agent-server's /think endpoint — Claude Code + MCP tools
 * handle all database access, tool use, and response formatting.
 *
 * Default built-in cycles (seeded on first run into wake-cycles.json):
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
 *
 * Agent-editable cycle fields (wake-cycles.json, all optional unless noted):
 *   id              — required, stable identifier
 *   description     — required, human-readable name
 *   schedule        — required, DSL (daily:HH | every:Nh | weekly:DOW:HH | interval:Nm)
 *   maxTurns        — max Claude turns per fire (default 50)
 *   essential       — survives energy-conservation gate
 *   enabled         — legacy boolean; false => skip (kept for back-compat)
 *   status          — 'active' | 'paused' | 'cancelled' (preferred over enabled)
 *   created_by      — 'seed' | 'agent' | 'user' (audit)
 *   purpose         — why the agent scheduled it (string, surfaces in portal)
 *   prompt          — custom action prompt; overrides PROMPT_MAP lookup
 *   delivery_channel — 'lifecycle' (default, current behavior) | 'portal' | 'telegram'
 *                      | 'discord' | 'silent'  (non-lifecycle are future waves)
 *   delivery_target — chat_id / channel_id for non-default channels
 *   last_run_at     — ISO timestamp, written by scheduler after each fire
 *   last_run_status — 'success' | 'failed', written after each fire attempt
 *   last_run_error  — error message on failure
 */

import './sentry.js';
import { tryGetDb } from './db.js';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

// Check interval: every 60 seconds
const CHECK_INTERVAL_MS = 60_000;

// Energy state cache (refreshed every 5 minutes).
// When ENERGY_ENABLED is not set, energy-state.js returns a neutral "normal"
// state, so this is effectively a no-op unless the operator opts in.
let _energyLevel = 'normal';
let _energyUpdateTimer = null;
async function _updateEnergyLevel() {
  if (process.env.ENERGY_ENABLED !== '1') return;
  try {
    const { getEnergyState } = await import('./energy-state.js');
    const state = await getEnergyState();
    _energyLevel = state.global.level;
  } catch (err) {
    console.warn(`[Scheduler] Energy state refresh failed: ${err.message}`);
  }
}

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
 * @param {string} [opts.timezone] - IANA timezone (e.g., 'Europe/Berlin'). If not set, fetched from DB.
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

  // Energy level polling (every 5 min, opt-in)
  _updateEnergyLevel();
  _energyUpdateTimer = setInterval(_updateEnergyLevel, 5 * 60 * 1000);

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
  if (_energyUpdateTimer) {
    clearInterval(_energyUpdateTimer);
    _energyUpdateTimer = null;
  }
  console.log('[Scheduler] Stopped');
}

// ── Wake Cycles File ──────────────────────────────────────────────────────

const AGENT_ID = process.env.AGENT_ID || 'personal-agent';
const AGENTS_ROOT = process.env.AGENTS_ROOT || join(homedir(), 'agents');
const CYCLES_PATH = join(AGENTS_ROOT, AGENT_ID, 'wake-cycles.json');

// `essential: true` — cycle runs even when energy is critical. Used for the
// daily user-facing check-ins (morning/evening) that the operator relies on.
// Non-essential cycles (midday reflection, triage, integration, weekly jobs)
// are allowed to skip under conservation pressure.
const DEFAULT_CYCLES = [
  { id: 'morning', description: 'Morning check-in — review yesterday, compose message', schedule: 'daily:8', maxTurns: 50, enabled: true, essential: true },
  { id: 'reflection-12', description: 'Midday reflection — internal processing, no message', schedule: 'daily:12', maxTurns: 30, enabled: true },
  { id: 'evening', description: 'Evening check-in — review today, send message if meaningful', schedule: 'daily:20', maxTurns: 50, enabled: true, essential: true },
  { id: 'triage', description: 'End-of-day triage — capture perishable observations', schedule: 'daily:23', maxTurns: 50, enabled: true },
  { id: 'integration', description: 'Integration cycle — territory walk after clustering, daily consolidation of model.md', schedule: 'daily:3', maxTurns: 50, enabled: true },
  { id: 'weekly-review', description: 'Weekly review — comprehensive look at the past week', schedule: 'weekly:0:10', maxTurns: 50, enabled: true },
];

let activeCycles = null;
const lastFireTimes = new Map(); // cycleId → timestamp (for interval-based cycles)

async function writeWakeCycles() {
  try {
    const existing = await readFile(CYCLES_PATH, 'utf-8').catch(() => null);
    if (existing) {
      activeCycles = JSON.parse(existing);
      let mutated = false;

      // Merge any new default cycles that don't exist in the file.
      for (const def of DEFAULT_CYCLES) {
        const current = activeCycles.cycles.find(c => c.id === def.id);
        if (!current) {
          activeCycles.cycles.push(def);
          mutated = true;
          console.log(`[Scheduler] Added missing default cycle: ${def.id}`);
          continue;
        }
        // Backfill `essential` for default cycles on existing files.
        // If the field is undefined, adopt the default; if the operator has
        // explicitly set true/false, respect their choice.
        if (def.essential !== undefined && current.essential === undefined) {
          current.essential = def.essential;
          mutated = true;
          console.log(`[Scheduler] Backfilled essential=${def.essential} on cycle: ${def.id}`);
        }
      }

      if (mutated) {
        try {
          await writeFile(CYCLES_PATH, JSON.stringify(activeCycles, null, 2));
        } catch (err) {
          console.warn(`[Scheduler] Could not persist cycle merges: ${err.message}`);
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

/**
 * Persist the current activeCycles object to disk. Callers that mutate
 * cycles in-memory (mutation helpers below, fire-path last_run write-
 * through) call this so the JSON file stays authoritative.
 */
async function persistCycles() {
  if (!activeCycles) return;
  try {
    await writeFile(CYCLES_PATH, JSON.stringify(activeCycles, null, 2));
  } catch (err) {
    console.warn(`[Scheduler] persistCycles failed: ${err.message}`);
  }
}

/**
 * Record the outcome of a cycle fire back into the JSON. Fire-and-forget
 * from triggerIfNotRan — a failed persist doesn't crash anything because
 * next reload re-reads disk state.
 */
async function recordLastRun(cycleId, status, errorMessage) {
  if (!activeCycles?.cycles) return;
  const cycle = activeCycles.cycles.find((c) => c.id === cycleId);
  if (!cycle) return;
  cycle.last_run_at = new Date().toISOString();
  cycle.last_run_status = status;
  if (status === 'failed' && errorMessage) cycle.last_run_error = String(errorMessage).slice(0, 500);
  else if (cycle.last_run_error && status === 'success') delete cycle.last_run_error;
  await _persist();
}

// ── Cycle mutation helpers (exported for agent tools + HTTP handlers) ─────

const VALID_STATUSES = new Set(['active', 'paused', 'cancelled']);
const VALID_DELIVERY = new Set(['lifecycle', 'portal', 'telegram', 'discord', 'silent']);
const SEED_CYCLE_IDS = new Set(DEFAULT_CYCLES.map((c) => c.id));

/**
 * Lazy-load activeCycles from disk if the scheduler hasn't been started
 * in this process. Lets the agent-server's HTTP handlers call the mutation
 * helpers without owning the full scheduler lifecycle — the personal-scheduler
 * process runs startScheduler() which populates activeCycles eagerly, but
 * the agent-server process just needs read+write access to the file.
 *
 * No-op when activeCycles is already populated. Falls through without
 * throwing if the file doesn't exist; caller gets the usual "Scheduler
 * not started" error from the helper that follows.
 */
async function ensureActiveCycles() {
  if (activeCycles) return;
  try {
    const data = await readFile(CYCLES_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    if (parsed?.cycles) activeCycles = parsed;
  } catch { /* file missing — helper will throw Scheduler not started */ }
}

function validateCycleShape(cycle, { forCreate } = {}) {
  if (!cycle || typeof cycle !== 'object') throw new Error('cycle: object required');
  if (forCreate) {
    if (typeof cycle.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(cycle.id)) {
      throw new Error('cycle.id: 1-64 chars of [a-zA-Z0-9_-] required');
    }
    if (typeof cycle.schedule !== 'string' || !parseSchedule(cycle.schedule)) {
      throw new Error(`cycle.schedule: invalid DSL (got ${JSON.stringify(cycle.schedule)})`);
    }
    if (typeof cycle.description !== 'string' || !cycle.description.trim()) {
      throw new Error('cycle.description: non-empty string required');
    }
  } else {
    if (cycle.id !== undefined) throw new Error('cycle.id: cannot change existing id');
  }
  if (cycle.schedule !== undefined && !parseSchedule(cycle.schedule)) {
    throw new Error(`cycle.schedule: invalid DSL`);
  }
  if (cycle.status !== undefined && !VALID_STATUSES.has(cycle.status)) {
    throw new Error(`cycle.status: must be one of ${[...VALID_STATUSES].join('|')}`);
  }
  if (cycle.delivery_channel !== undefined && !VALID_DELIVERY.has(cycle.delivery_channel)) {
    throw new Error(`cycle.delivery_channel: must be one of ${[...VALID_DELIVERY].join('|')}`);
  }
  if (cycle.maxTurns !== undefined) {
    const n = Number(cycle.maxTurns);
    if (!Number.isFinite(n) || n < 1 || n > 500) throw new Error('cycle.maxTurns: 1-500 required');
  }
  if (cycle.prompt !== undefined && cycle.prompt !== null) {
    if (typeof cycle.prompt !== 'string') throw new Error('cycle.prompt: string required');
    if (cycle.prompt.length > 8000) throw new Error('cycle.prompt: 8000 char max');
  }
  if (cycle.purpose !== undefined && cycle.purpose !== null) {
    if (typeof cycle.purpose !== 'string') throw new Error('cycle.purpose: string required');
    if (cycle.purpose.length > 500) throw new Error('cycle.purpose: 500 char max');
  }
}

/**
 * Create a new cycle. Rejects duplicate ids. Defaults status=active,
 * created_by=agent, enabled=true. Returns the inserted cycle row.
 */
export async function createCycle(cycle) {
  await ensureActiveCycles();
  if (!activeCycles) throw new Error('Scheduler not started');
  validateCycleShape(cycle, { forCreate: true });
  if (activeCycles.cycles.some((c) => c.id === cycle.id)) {
    throw new Error(`cycle.id "${cycle.id}" already exists`);
  }
  if (activeCycles.cycles.length >= 50) {
    throw new Error('cycle density cap reached (50/agent); pause or cancel one first');
  }
  const row = {
    status: 'active',
    created_by: 'agent',
    enabled: true,
    maxTurns: 50,
    essential: false,
    delivery_channel: 'lifecycle',
    ...cycle,
    created_at: new Date().toISOString(),
  };
  activeCycles.cycles.push(row);
  await _persist();
  console.log(`[Scheduler] createCycle: ${row.id} (${row.schedule}, ${row.delivery_channel})`);
  return row;
}

/**
 * Merge `patch` into an existing cycle. Protected fields rejected.
 * Returns the updated cycle.
 */
export async function updateCycle(id, patch) {
  await ensureActiveCycles();
  if (!activeCycles) throw new Error('Scheduler not started');
  const cycle = activeCycles.cycles.find((c) => c.id === id);
  if (!cycle) throw new Error(`cycle "${id}" not found`);
  validateCycleShape(patch, { forCreate: false });
  Object.assign(cycle, patch, { updated_at: new Date().toISOString() });
  await _persist();
  console.log(`[Scheduler] updateCycle: ${id} → ${JSON.stringify(Object.keys(patch))}`);
  return cycle;
}

export async function pauseCycle(id) {
  return updateCycle(id, { status: 'paused', enabled: false });
}

export async function resumeCycle(id) {
  return updateCycle(id, { status: 'active', enabled: true });
}

/**
 * Cancel a cycle. Seeded defaults cannot be cancelled (only paused) —
 * the user can always turn them back on. Custom cycles are truly removed
 * after the next 24h of being in `cancelled` status so scheduler history
 * rolls off cleanly; for now we just flip the status.
 */
export async function cancelCycle(id) {
  if (SEED_CYCLE_IDS.has(id)) {
    throw new Error(`"${id}" is a built-in cycle — pause it instead of cancelling`);
  }
  return updateCycle(id, { status: 'cancelled', enabled: false });
}

export function listCycles() {
  return activeCycles?.cycles ? [...activeCycles.cycles] : [];
}

export function getCycle(id) {
  if (!activeCycles?.cycles) return null;
  return activeCycles.cycles.find((c) => c.id === id) || null;
}

// Test seam: lets unit tests seed in-memory state and swap persistCycles
// for a spy, without a full startScheduler() init (which requires FS access
// + env config). Not part of the public API — underscore-prefixed.
let _persistCyclesImpl = persistCycles;
export const _test = {
  setActiveCycles(obj) { activeCycles = obj; },
  clearActiveCycles()  { activeCycles = null; },
  setPersist(fn)       { _persistCyclesImpl = fn || persistCycles; },
  getActiveCycles()    { return activeCycles; },
  DEFAULT_CYCLES,
  SEED_CYCLE_IDS,
};

// Internal call-site — routes through the swappable impl so tests can spy.
async function _persist() { return _persistCyclesImpl(); }

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
    if (cycle.status === 'paused' || cycle.status === 'cancelled') continue;
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

    const opts = {
      cycleId: cycle.id,
      maxTurns: cycle.maxTurns || 50,
      timeout: 1_800_000,
      essential: cycle.essential === true, // propagate essential flag to energy gating
    };

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
 *
 * Energy-aware (only active when ENERGY_ENABLED=1): skips non-essential cycles
 * when energy is critical, reduces maxTurns when energy is low. Cycles marked
 * `essential: true` in wake-cycles.json always run regardless of energy state —
 * morning and evening check-ins are essential by default.
 */
function triggerIfNotRan(dateKey, jobName, prompt, options = {}) {
  const key = `${dateKey}:${jobName}`;
  if (jobsRanToday.has(key)) return;

  // Clone options locally so energy adjustments do not mutate the caller's
  // object (which is the shared per-cycle config from wake-cycles.json).
  const effectiveOptions = { ...options };

  // Energy-aware gating (no-op unless ENERGY_ENABLED=1 — see _updateEnergyLevel)
  if (_energyLevel === 'critical' && !effectiveOptions.essential) {
    console.log(`[Scheduler] Skipping ${jobName} — energy critical`);
    return;
  }
  if (_energyLevel === 'low' && effectiveOptions.maxTurns) {
    effectiveOptions.maxTurns = Math.round(effectiveOptions.maxTurns * 0.6);
    console.log(`[Scheduler] ${jobName} — energy low, reduced maxTurns to ${effectiveOptions.maxTurns}`);
  }

  jobsRanToday.set(key, true);
  console.log(`[Scheduler] Triggering: ${jobName}`);

  // cycleId may differ from jobName (interval cycles append time suffix).
  // Extract the base cycle id so last-run write-through lands on the right row.
  const cycleId = effectiveOptions.cycleId || jobName.split('-')[0];

  // Fire and forget — /think handles its own error logging
  fireThink(prompt, jobName, effectiveOptions)
    .then(() => recordLastRun(cycleId, 'success'))
    .catch(err => {
      console.error(`[Scheduler] ${jobName} failed:`, err.message);
      recordLastRun(cycleId, 'failed', err.message);
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
  const thinkHeaders = { 'Content-Type': 'application/json' };
  if (process.env.AGENT_INTERNAL_SECRET) thinkHeaders['x-internal-secret'] = process.env.AGENT_INTERNAL_SECRET;
  const res = await fetch(`${config.agentUrl}/think`, {
    method: 'POST',
    headers: thinkHeaders,
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
- Name what happened: "You and Alex discussed X", "Ada finished Y", "Com tracked Z"
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

### Phase 3.5: Consolidate model.md (capture → consolidate)

You spent the cycle adding new observations to model.md via updateInternalModel
(capture mode — fast, append-only, low-friction). Now consolidate. This single
phase replaces the prior weekly-decay cycle: dedup AND lifecycle (stale removal,
hypothesis promotion, archival) happen here, daily.

**mind/ files are encrypted at rest.** Claude Code's built-in \`Read\`,
\`Write\`, and \`Edit\` tools see ciphertext envelopes (4-byte "MIND" magic +
base64), not your model. Always use the MCP tools below — they decrypt on
read and encrypt on write transparently.

**Step 1: Read model.md fresh.** Call \`readMindFile('model.md')\`. Your context
loaded it at cycle start; it has changed since then due to your own
updateInternalModel calls during this cycle and any in-conversation appends
earlier today. The MCP tool returns the decrypted plaintext.

**Step 2: Consolidate via writeMindFileWhole.** Call
\`writeMindFileWhole('model.md', '<consolidated content>')\` with the leaner,
deduplicated, lifecycle-current version. One whole-file rewrite, not many
edits. The tool **auto-snapshots the pre-write state** to
\`mind/snapshots/model.md/<date>.md\` (idempotent first-write-wins) — your
trail anchor is preserved structurally, you don't have to remember to
snapshot first. If a consolidation move turns out wrong, the operator can
restore from the snapshot.

DEDUP — mechanical, apply uniformly:
1. **One entry per H-id.** If H-007 has 9 update entries, collapse to one entry
   with the current state + one-line conclusion. Drop the chain.
2. **Cap pattern confirmations at 2.** A third+ confirmation becomes an inline
   count on the existing entry (e.g. "CONFIRMED ×4 (Apr 27 / May 1 / May 7 / May 14)").
   Never a new CONFIRMED block for an existing pattern.
3. **One daily summary per date.** Older dates (>48h ago) collapse to a single
   summary. Recent dates (last 48h) can keep more granular entries if they're
   genuinely distinct.
4. **No duplicate section headers.** If two \`## Section\` headers share a name,
   merge their contents.
5. **Migrate \`## undefined\`.** Move its contents into the appropriate named
   section, then delete the malformed header.
6. **Strip stale double-dates.** Old entries shaped \`- [DATE] [DATE] content\`
   collapse to \`- [DATE] content\` (the bug class that produced 153 such entries
   in Apr 2026 before the tool fix; the data persists).

LIFECYCLE — judgment, apply where it's earned (this is what the deleted
weekly-decay cycle used to ask for, now part of every cycle):
- Stale hypotheses (no reinforcement in 4+ weeks): mark archived or remove.
- Hypotheses confirmed by repeated evidence: promote to Established Patterns.
- Resolved questions: archive.
- Outdated \`## Current Context\` section: rewrite, never append. This section
  is always-volatile by design — current state, not cumulative log.

**Step 3: Validate.** Call \`readMindFile('model.md')\` again — the content
length should be visibly smaller. If it isn't, you didn't consolidate;
revise and call \`writeMindFileWhole\` again (the snapshot anchor is preserved
across multiple writes — first-write-wins). Target: 30-50% reduction on the
first pass; subsequent cycles see <5% changes (steady-state).

**Tool reminder for mind/ files (all encryption-aware):**
- \`updateInternalModel\` — capture mode (any time, append-only).
- \`readMindFile\` — fetch decrypted current state.
- \`editMindFile\` — surgical edit with unique \`old_string\` → \`new_string\`
  contract. Auto-snapshots pre-edit state. Use for one-line status flips,
  hypothesis renames, typo fixes.
- \`writeMindFileWhole\` — whole-file rewrite (Phase 3.5 consolidation).
  Auto-snapshots pre-write state.
- \`snapshotMindFile\` — explicit "capture state without modifying" call;
  rarely needed because edit/write tools auto-snapshot.

**Do NOT use Claude Code's built-in Read/Write/Edit/Bash on mind/ files** —
they bypass encryption and would either show ciphertext (Read) or corrupt
the on-disk format (Write/Edit).

**Operating instructions are firmware — do not compact heavily.** Blind-spots,
durable-posture, and any RULES content earned through error correction stay
intact across consolidations. (Future PR-G extracts these to a separate file
\`mind/operating-instructions.md\`.)

If in doubt about a consolidation move, leave it for next cycle. The snapshot
preserves the pre-cycle state; nothing you do here is irreversible.

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
1. Save the full review using \`writeMindFileWhole('weekly-reviews/YYYY-MM-DD.md', '<full review>')\`
   (use today's date). The MCP tool encrypts at rest + creates parent dirs lazily.
   Do NOT use Claude Code's built-in Write tool here — mind/ files are encrypted,
   raw Write would corrupt the on-disk format.
2. Update the reflection log (updateDocument "internal/reflection_log") with a weekly review entry.
3. Send a concise summary via Telegram — the highlights, not the whole thing.
4. Update your internal model with weekly-scale observations.

Remember: this review is for your person. Make it useful, specific, and honest. Not generic, not performative.`,

  // weeklyDecay deleted 2026-05-07 — its lifecycle responsibility (stale removal,
  // hypothesis promotion, archival) merged into the integration cycle's Phase 3.5
  // Consolidation. One write path for all model.md cleanup, daily cadence.
  // See docs/MIND-MODEL-COMPACTION-DESIGN-V3-2026-05-07.md.
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

// src/agent/cycle-activity.js — the deterministic quiet-day gate (C2).
//
// A check-in cycle should stay silent on an empty day. Trusting the model to notice
// "fewer than 5 messages → NO_REPLY" is unreliable (in production it wrote a status
// report about its own empty tools instead). So we decide it in CODE, before composing:
// count the user's REAL messages in the cycle's window (excluding the agent's own
// 'scheduler' output so past check-ins don't inflate tomorrow's count), and skip the
// turn entirely when it's below the cycle's threshold. Saves tokens and eliminates the
// "meta-report on a quiet day" class at the source. Internal cycles (no minActivity)
// always run.

import { localDayStartUtc } from './scheduler-time.js';

/** [since, until) UTC-ISO window for a cycle's activityWindow, in the cycle's tz. */
function windowFor(name, now, tz) {
  const untilIso = (now instanceof Date ? now : new Date(now)).toISOString();
  switch (name) {
    case 'yesterday': return { since: localDayStartUtc(now, tz, -1), until: untilIso }; // yesterday + overnight
    case 'today':     return { since: localDayStartUtc(now, tz, 0), until: untilIso };
    case 'week':      return { since: localDayStartUtc(now, tz, -7), until: untilIso };
    default:          return null;
  }
}

/**
 * @returns {Promise<{enough:boolean, count:(number|null), min:number}>}
 *   enough=true means "run the cycle". A cycle without minActivity always runs.
 *   Fail-open: a count-query error never blocks a cycle (the C1 finalizer still guards output).
 */
export async function hasEnoughActivity(db, userId, cycle, { now = new Date(), tz = null } = {}) {
  const min = Number(cycle?.minActivity) || 0;
  if (!min) return { enough: true, count: null, min: 0 };
  const win = windowFor(cycle.activityWindow || 'today', now, tz);
  if (!win || !db?.messages?.countInRange) return { enough: true, count: null, min };
  let count = null;
  try {
    count = await db.messages.countInRange(userId, { since: win.since, until: win.until, excludeSources: ['scheduler'] });
  } catch { return { enough: true, count: null, min }; }
  return { enough: count >= min, count, min };
}

export default hasEnoughActivity;

// src/claims/windows.js — calendar window boundaries for the discovery cadences.
// Pure (takes `nowMs`), UTC, returns the LAST COMPLETE period for a granularity
// so discovery runs over a window that has fully elapsed (windowEnd = the start
// of the current period = a stable snapshot key). Mirrors frequency_snapshots'
// day/week/month bucketing and adds quarter.
//
// See docs/PERSONA-CLAIMS-DESIGN-2026-06-06.md §3.5.
const DAY = 86400000;

export const CADENCES = ['day', 'week', 'month', 'quarter'];

function startOfUTCDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * The last complete window for a cadence relative to nowMs.
 * @returns {{ windowStart:string, windowEnd:string }} ISO-8601 UTC boundaries
 */
export function previousCompleteWindow(nowMs, granularity) {
  const today = startOfUTCDay(nowMs);
  let endMs, startMs;
  if (granularity === 'day') {
    endMs = today;
    startMs = today - DAY;
  } else if (granularity === 'week') {
    const dow = new Date(today).getUTCDay(); // 0=Sun..6=Sat
    const isoDow = dow === 0 ? 7 : dow; // 1=Mon..7=Sun
    const thisWeek = today - (isoDow - 1) * DAY;
    endMs = thisWeek;
    startMs = thisWeek - 7 * DAY;
  } else if (granularity === 'month') {
    const d = new Date(today);
    endMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1); // Date.UTC rolls negative months into the prior year
  } else if (granularity === 'quarter') {
    const d = new Date(today);
    const qStartMonth = Math.floor(d.getUTCMonth() / 3) * 3;
    endMs = Date.UTC(d.getUTCFullYear(), qStartMonth, 1);
    startMs = Date.UTC(d.getUTCFullYear(), qStartMonth - 3, 1);
  } else {
    throw new TypeError(`previousCompleteWindow: unknown granularity ${JSON.stringify(granularity)} (valid: ${CADENCES.join(', ')})`);
  }
  return { windowStart: new Date(startMs).toISOString(), windowEnd: new Date(endMs).toISOString() };
}

export default { CADENCES, previousCompleteWindow };

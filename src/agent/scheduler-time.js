// src/agent/scheduler-time.js — the wake-cycle schedule DSL + next-run computation.
// Phase 5, Step 4 (pure core). Spec §5.6.
//
// Consolidates the canonical wake-cycle DSL (daily/weekly/every/interval) with odysseus
// compute_next_run (monthly + IANA-timezone wall-clock → UTC + month-clamp + cron). No
// external deps — IANA offsets via Intl.DateTimeFormat; a minimal 5-field cron evaluator.
//
//   daily:HH            fire at hour HH (0-23) every day
//   weekly:DOW:HH       fire on day-of-week DOW (0=Sun..6=Sat) at HH
//   monthly:DOM:HH      fire on day-of-month DOM (1-31; clamped on short months) at HH
//   every:Nh            fire at hours where hour % N === 0 (N≥1)
//   interval:Nm         fire every N minutes (minimum 30)
//   once                fire once at scheduledAt (ISO)
//   cron:<m h dom mon dow>   standard 5-field cron (* , - / supported)
//
// Times are interpreted in the task's IANA `tz` (or UTC when absent) and returned as an
// ISO-8601 UTC string — the format scheduled_tasks.next_run stores.

const MIN_INTERVAL_MIN = 30;

/** Parse a DSL string into a structured descriptor, or null if invalid. */
export function parseSchedule(dsl) {
  if (typeof dsl !== 'string' || !dsl) return null;
  const s = dsl.trim();
  if (s === 'once') return { type: 'once' };
  if (s.startsWith('cron:')) { const expr = s.slice(5).trim(); return expr ? { type: 'cron', expr } : null; }
  const [kind, a, b] = s.split(':');
  const int = (v) => (/^\d+$/.test(v || '') ? parseInt(v, 10) : NaN);
  if (kind === 'daily') { const h = int(a); return h >= 0 && h <= 23 ? { type: 'daily', hour: h } : null; }
  if (kind === 'weekly') { const d = int(a); const h = int(b); return d >= 0 && d <= 6 && h >= 0 && h <= 23 ? { type: 'weekly', dow: d, hour: h } : null; }
  if (kind === 'monthly') { const d = int(a); const h = int(b); return d >= 1 && d <= 31 && h >= 0 && h <= 23 ? { type: 'monthly', dom: d, hour: h } : null; }
  if (kind === 'every') { const m = /^(\d+)h$/.exec(a || ''); const n = m ? parseInt(m[1], 10) : NaN; return n >= 1 && n <= 24 ? { type: 'every', hours: n } : null; }
  if (kind === 'interval') { const m = /^(\d+)m$/.exec(a || ''); const n = m ? parseInt(m[1], 10) : NaN; return Number.isFinite(n) ? { type: 'interval', minutes: Math.max(MIN_INTERVAL_MIN, n) } : null; }
  return null;
}

// ── IANA timezone helpers (no deps) ──────────────────────────────────────────
// Wall-clock parts of an instant in a zone, and the inverse: the UTC instant for a
// given wall-clock in a zone (double-refined so DST transitions land correctly).

function partsInTz(tz, date) {
  if (!tz) return { y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, d: date.getUTCDate(), h: date.getUTCHours(), mi: date.getUTCMinutes(), dow: date.getUTCDay() };
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const p = {}; for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, dow: dowMap[p.weekday] };
}

function tzOffsetMs(tz, date) {
  if (!tz) return 0;
  const p = partsInTz(tz, date);
  const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, 0);
  return asUTC - (Math.floor(date.getTime() / 60000) * 60000);
}

/** Epoch ms for a wall-clock (y,mo,d,h,mi) interpreted in `tz` (or UTC). Date.UTC overflow
 *  normalizes out-of-range day/month (e.g. day 32 → next month; the month-clamp is the
 *  caller's job for monthly:). */
function wallToUtcMs(tz, y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  if (!tz) return guess;
  let utc = guess - tzOffsetMs(tz, new Date(guess));
  const off2 = tzOffsetMs(tz, new Date(utc));          // refine across a DST edge
  const utc2 = guess - off2;
  if (utc2 !== utc) utc = utc2;
  return utc;
}

const daysInMonth = (y, mo /*1-12*/) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

// ── minimal 5-field cron ─────────────────────────────────────────────────────
function cronFieldMatch(spec, value, min, max) {
  for (const part of spec.split(',')) {
    if (part === '*') return true;
    const step = part.includes('/') ? part.split('/') : [part, '1'];
    const range = step[0];
    const inc = parseInt(step[1], 10) || 1;
    let lo = min; let hi = max;
    if (range !== '*') {
      if (range.includes('-')) { const [a, b] = range.split('-').map(Number); lo = a; hi = b; }
      else { lo = hi = Number(range); }
    }
    if (value < lo || value > hi) continue;
    if ((value - lo) % inc === 0) return true;
  }
  return false;
}

function cronMatches(expr, parts) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  return cronFieldMatch(f[0], parts.mi, 0, 59)
    && cronFieldMatch(f[1], parts.h, 0, 23)
    && cronFieldMatch(f[2], parts.d, 1, 31)
    && cronFieldMatch(f[3], parts.mo, 1, 12)
    && cronFieldMatch(f[4], parts.dow, 0, 6);
}

/**
 * Next fire time as an ISO-8601 UTC string (or null if none, e.g. a past `once`).
 * @param {string} dsl                schedule DSL (or pre-parsed via parseSchedule — both accepted)
 * @param {object} [opt]
 * @param {Date|string} [opt.after]   compute the next fire strictly after this instant
 * @param {string} [opt.tz]           IANA zone; absent ⇒ UTC
 * @param {string} [opt.scheduledAt]  ISO datetime for `once`
 */
export function computeNextRun(dsl, { after = new Date(), tz = null, scheduledAt = null } = {}) {
  const p = typeof dsl === 'string' ? parseSchedule(dsl) : dsl;
  if (!p) return null;
  const afterMs = after instanceof Date ? after.getTime() : Date.parse(after);
  if (!Number.isFinite(afterMs)) return null;

  if (p.type === 'once') { const t = scheduledAt ? Date.parse(scheduledAt) : NaN; return Number.isFinite(t) && t > afterMs ? new Date(t).toISOString() : null; }
  if (p.type === 'interval') return new Date(afterMs + p.minutes * 60000).toISOString();

  const lp = partsInTz(tz, new Date(afterMs));

  if (p.type === 'daily') {
    for (let add = 0; add <= 1; add++) { const ms = wallToUtcMs(tz, lp.y, lp.mo, lp.d + add, p.hour, 0); if (ms > afterMs) return new Date(ms).toISOString(); }
    return null;
  }
  if (p.type === 'weekly') {
    for (let add = 0; add <= 7; add++) {
      const ms = wallToUtcMs(tz, lp.y, lp.mo, lp.d + add, p.hour, 0);
      if (ms <= afterMs) continue;
      if (partsInTz(tz, new Date(ms)).dow === p.dow) return new Date(ms).toISOString();
    }
    return null;
  }
  if (p.type === 'monthly') {
    for (let add = 0; add <= 1; add++) {
      const y = lp.y; const mo = lp.mo + add;
      const yy = y + Math.floor((mo - 1) / 12); const mm = ((mo - 1) % 12) + 1;
      const dom = Math.min(p.dom, daysInMonth(yy, mm));               // short-month clamp
      const ms = wallToUtcMs(tz, yy, mm, dom, p.hour, 0);
      if (ms > afterMs) return new Date(ms).toISOString();
    }
    return null;
  }
  if (p.type === 'every') {
    for (let add = 1; add <= 48; add++) {
      const ms = wallToUtcMs(tz, lp.y, lp.mo, lp.d, lp.h + add, 0);
      if (ms <= afterMs) continue;
      if (partsInTz(tz, new Date(ms)).h % p.hours === 0) return new Date(ms).toISOString();
    }
    return null;
  }
  if (p.type === 'cron') {
    // Step minute-by-minute from the next minute up to ~366 days (bounded).
    let ms = (Math.floor(afterMs / 60000) + 1) * 60000;
    const cap = afterMs + 366 * 24 * 60 * 60000;
    for (; ms <= cap; ms += 60000) { if (cronMatches(p.expr, partsInTz(tz, new Date(ms)))) return new Date(ms).toISOString(); }
    return null;
  }
  return null;
}

export default computeNextRun;

// verify:harness-schedule — the wake-cycle DSL + next-run math (src/agent/scheduler-time.js),
// pure. Proves parity with odysseus compute_next_run + canonical DSL (spec §5.6).
//   T1 parseSchedule: all forms + invalid + interval min-clamp
//   T2 daily (today vs tomorrow)   T3 weekly (next DOW)   T4 monthly short-month clamp
//   T5 every:Nh   T6 interval (+clamp)   T7 once (future/past)   T8 cron   T9 IANA tz   T10 strictly-after
import { parseSchedule, computeNextRun } from '../src/agent/scheduler-time.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const nextUTC = (dsl, afterIso, opt = {}) => computeNextRun(dsl, { after: afterIso, ...opt });

// ── T1 parse ──
{
  rec('T1 daily/weekly/monthly/every/interval/once/cron parse', !!parseSchedule('daily:8') && !!parseSchedule('weekly:1:9') && !!parseSchedule('monthly:31:0') && !!parseSchedule('every:4h') && !!parseSchedule('interval:45m') && !!parseSchedule('once') && !!parseSchedule('cron:0 9 * * *'));
  rec('T1 invalid → null', parseSchedule('daily:99') === null && parseSchedule('weekly:9:0') === null && parseSchedule('garbage') === null && parseSchedule('') === null);
  rec('T1 interval clamps to 30m minimum', parseSchedule('interval:5m').minutes === 30 && parseSchedule('interval:45m').minutes === 45);
}

// ── T2 daily ──
{
  rec('T2 daily:8 later today', nextUTC('daily:8', '2026-06-17T06:00:00Z') === '2026-06-17T08:00:00.000Z', nextUTC('daily:8', '2026-06-17T06:00:00Z'));
  rec('T2 daily:8 rolls to tomorrow when past', nextUTC('daily:8', '2026-06-17T09:00:00Z') === '2026-06-18T08:00:00.000Z', nextUTC('daily:8', '2026-06-17T09:00:00Z'));
}

// ── T3 weekly ──
{
  const r = nextUTC('weekly:1:9', '2026-06-17T06:00:00Z'); // next Monday 09:00 UTC
  const d = new Date(r);
  rec('T3 weekly:1:9 lands on a Monday at 09:00 UTC, in the future', d.getUTCDay() === 1 && d.getUTCHours() === 9 && d.getTime() > Date.parse('2026-06-17T06:00:00Z'), r);
}

// ── T4 monthly short-month clamp ──
{
  rec('T4 monthly:31 in February clamps to the 28th (2026 non-leap)', nextUTC('monthly:31:0', '2026-02-10T00:00:00Z') === '2026-02-28T00:00:00.000Z', nextUTC('monthly:31:0', '2026-02-10T00:00:00Z'));
}

// ── T5 every:Nh ──
{
  const r = nextUTC('every:4h', '2026-06-17T06:30:00Z'); // next hour where hour%4==0 → 08:00
  rec('T5 every:4h → next 4-hour boundary', r === '2026-06-17T08:00:00.000Z', r);
}

// ── T6 interval ──
{
  rec('T6 interval:45m → after + 45min', nextUTC('interval:45m', '2026-06-17T06:00:00Z') === '2026-06-17T06:45:00.000Z');
  rec('T6 interval:5m clamped → after + 30min', nextUTC('interval:5m', '2026-06-17T06:00:00Z') === '2026-06-17T06:30:00.000Z');
}

// ── T7 once ──
{
  rec('T7 once future → that instant', computeNextRun('once', { after: '2026-06-17T06:00:00Z', scheduledAt: '2026-06-20T10:00:00Z' }) === '2026-06-20T10:00:00.000Z');
  rec('T7 once past → null', computeNextRun('once', { after: '2026-06-17T06:00:00Z', scheduledAt: '2026-06-10T10:00:00Z' }) === null);
}

// ── T8 cron ──
{
  rec('T8 cron 0 9 * * * → next 09:00', nextUTC('cron:0 9 * * *', '2026-06-17T06:00:00Z') === '2026-06-17T09:00:00.000Z', nextUTC('cron:0 9 * * *', '2026-06-17T06:00:00Z'));
  rec('T8 cron */15 → next quarter hour', nextUTC('cron:*/15 * * * *', '2026-06-17T06:07:00Z') === '2026-06-17T06:15:00.000Z', nextUTC('cron:*/15 * * * *', '2026-06-17T06:07:00Z'));
}

// ── T9 IANA timezone ──
{
  // daily:8 in America/New_York (EDT = UTC-4 in June) → 08:00 NY = 12:00 UTC.
  const r = nextUTC('daily:8', '2026-06-17T06:00:00Z', { tz: 'America/New_York' });
  const nyHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit' }).formatToParts(new Date(r)).find((p) => p.type === 'hour').value;
  rec('T9 tz wall-clock honored (08:00 New York → 12:00 UTC)', r === '2026-06-17T12:00:00.000Z' && nyHour === '08', `${r} (NY ${nyHour}:00)`);
}

// ── T10 strictly after ──
{
  const after = '2026-06-17T08:00:00Z';
  rec('T10 daily:8 at exactly 08:00 → next day (strictly after)', new Date(nextUTC('daily:8', after)).getTime() > Date.parse(after), nextUTC('daily:8', after));
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — schedule: DSL parse · daily/weekly/monthly-clamp · every/interval · once · cron · IANA tz · strictly-after' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

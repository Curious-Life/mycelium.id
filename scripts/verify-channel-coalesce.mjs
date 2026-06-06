// verify:channel-coalesce — Phase 3 inbound coalescer (DI, virtual clock).
// Asserts:
//   - rapid fragments within the window flush as ONE merged turn (latest ctx)
//   - a new fragment debounces (resets) the timer
//   - separate chats coalesce independently
//   - flushAll drains pending buffers
// PASS/FAIL ledger; exit 1 on any fail.
import { createCoalescer } from '../packages/channel-daemon/transport/coalescer.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// Minimal virtual clock so the test is deterministic (no real timers).
function makeClock() {
  let nowMs = 0; let seq = 0; const timers = new Map();
  return {
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, due: nowMs + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    tick: (ms) => {
      nowMs += ms;
      for (const [id, t] of [...timers]) if (t.due <= nowMs) { timers.delete(id); t.fn(); }
    },
  };
}

const ctx = (id) => ({ source: 'telegram', channelKind: 'telegram', channelId: id, inboundMessageId: `m-${id}` });

// ── merge within window ──────────────────────────────────────────────────────
{
  const clk = makeClock();
  const flushes = [];
  const co = createCoalescer({ windowMs: 1000, flush: (turnCtx, m) => flushes.push({ id: turnCtx.channelId, ctxMsg: turnCtx.inboundMessageId, content: m.content }), setTimer: clk.setTimer, clearTimer: clk.clearTimer });

  co.push({ ...ctx('A'), inboundMessageId: 'm1' }, { content: 'hey' });
  clk.tick(400);
  co.push({ ...ctx('A'), inboundMessageId: 'm2' }, { content: 'did you see' });
  clk.tick(400); // 800 since 2nd push? no — 400 since 2nd. timer was reset at 2nd push.
  rec('CO1. no flush while fragments keep arriving (debounce)', flushes.length === 0, `flushes=${flushes.length}`);
  co.push({ ...ctx('A'), inboundMessageId: 'm3' }, { content: 'the thing?' });
  clk.tick(1000); // quiet window elapses after the 3rd
  rec('CO2. one merged flush after the quiet window', flushes.length === 1, `flushes=${flushes.length}`);
  rec('CO3. merged content joins all fragments', flushes[0]?.content === 'hey\ndid you see\nthe thing?', `content=${JSON.stringify(flushes[0]?.content)}`);
  rec('CO4. latest turnCtx wins (reply-to = most recent message)', flushes[0]?.ctxMsg === 'm3', `ctxMsg=${flushes[0]?.ctxMsg}`);
}

// ── independent chats ────────────────────────────────────────────────────────
{
  const clk = makeClock();
  const flushes = [];
  const co = createCoalescer({ windowMs: 500, flush: (turnCtx, m) => flushes.push({ id: turnCtx.channelId, content: m.content }), setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  co.push(ctx('A'), { content: 'a1' });
  co.push(ctx('B'), { content: 'b1' });
  clk.tick(500);
  rec('CO5. separate chats flush independently', flushes.length === 2 && flushes.some((f) => f.id === 'A' && f.content === 'a1') && flushes.some((f) => f.id === 'B' && f.content === 'b1'), `flushes=${flushes.length}`);
}

// ── flushAll drains ──────────────────────────────────────────────────────────
{
  const clk = makeClock();
  const flushes = [];
  const co = createCoalescer({ windowMs: 10_000, flush: (turnCtx, m) => flushes.push(m.content), setTimer: clk.setTimer, clearTimer: clk.clearTimer });
  co.push(ctx('A'), { content: 'pending' });
  rec('CO6. buffer pending before window', co._pending() === 1);
  co.flushAll();
  rec('CO7. flushAll drains immediately (graceful stop)', flushes.length === 1 && flushes[0] === 'pending' && co._pending() === 0);
}

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO');

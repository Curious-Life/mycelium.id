// verify:channel-agent — Phase 2 unit gate (DI, no network, no LLM): the single-
// user lane + runtime selection + reply system prompt. Asserts:
//   - the lane sets the active turn DURING the turn and clears it AFTER (finally)
//   - turns are SERIALIZED — never two active at once — and run in order
//   - a throwing turn is isolated: cleared + the next turn still runs
//   - a hung turn is aborted via the signal (timeout) and still clears
//   - selectRuntime is config-implied (BYOK key → runtime; none → null)
//   - the reply prompt carries the mandatory delivery contract
// PASS/FAIL ledger; exit 1 on any fail.
import { createLane } from '../packages/channel-daemon/agent/lane.js';
import { selectRuntime } from '../packages/channel-daemon/agent/runtime.js';
import { buildReplySystemPrompt } from '../packages/channel-daemon/agent/prompt.js';
import { getActiveTurn, _resetForTests } from '../packages/channel-daemon/inbound-context.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const turn = (id) => ({ source: 'telegram', channelKind: 'telegram', channelId: id, inboundMessageId: `m-${id}` });
const msg = (t) => ({ content: t });

// ── lane: set-during / clear-after + serialization + order ───────────────────
{
  _resetForTests();
  const events = [];
  let maxConcurrent = 0, concurrent = 0;
  const runtime = {
    label: 'fake',
    async runTurn({ turnCtx }) {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      events.push(`start:${turnCtx.channelId}`);
      // active turn must be set + correct WHILE the turn runs
      events.push(`active:${getActiveTurn()?.channelId}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`end:${turnCtx.channelId}`);
      concurrent--;
      return { delivered: true, usedReplyTool: true };
    },
  };
  const lane = createLane({ runtime });
  lane.runTurn(turn('A'), msg('a'));
  lane.runTurn(turn('B'), msg('b'));
  lane.runTurn(turn('C'), msg('c'));
  await lane.idle();

  rec('L1. active turn is set + correct DURING each turn', events.includes('active:A') && events.includes('active:B') && events.includes('active:C'));
  rec('L2. active turn CLEARED after the lane drains', getActiveTurn() === null);
  rec('L3. turns never overlap (max concurrency = 1)', maxConcurrent === 1, `max=${maxConcurrent}`);
  rec('L4. turns run in FIFO order', events.join('|') === 'start:A|active:A|end:A|start:B|active:B|end:B|start:C|active:C|end:C', events.join('|'));
}

// ── lane: error isolation ────────────────────────────────────────────────────
{
  _resetForTests();
  const ran = [];
  const runtime = {
    async runTurn({ turnCtx }) {
      ran.push(turnCtx.channelId);
      if (turnCtx.channelId === 'B') throw new Error('boom');
      return { delivered: true };
    },
  };
  const lane = createLane({ runtime });
  lane.runTurn(turn('A'), msg('a'));
  lane.runTurn(turn('B'), msg('b'));
  lane.runTurn(turn('C'), msg('c'));
  await lane.idle();
  rec('L5. a throwing turn is isolated — the next turn still runs', ran.join(',') === 'A,B,C', ran.join(','));
  rec('L6. active turn cleared even after a throwing turn', getActiveTurn() === null);
}

// ── lane: timeout aborts a hung turn ─────────────────────────────────────────
{
  _resetForTests();
  let sawAbort = false;
  const runtime = {
    async runTurn({ signal }) {
      await new Promise((resolve) => {
        signal.addEventListener('abort', () => { sawAbort = true; resolve(); }, { once: true });
      });
      return { delivered: false, usedReplyTool: false };
    },
  };
  const lane = createLane({ runtime, turnTimeoutMs: 30 });
  lane.runTurn(turn('Z'), msg('hang'));
  await lane.idle();
  rec('L7. a hung turn is aborted via the signal (timeout)', sawAbort);
  rec('L8. active turn cleared after a timed-out turn', getActiveTurn() === null);
}

// ── runtime selection: config-implied locus ──────────────────────────────────
{
  const withKey = selectRuntime({ anthropicApiKey: 'sk-ant-test', mcpMode: 'http' });
  rec('R1. BYOK key → a runtime (claude-agent-sdk)', !!withKey && /claude-agent-sdk/.test(withKey.label), `label=${withKey?.label}`);
  const none = selectRuntime({ anthropicApiKey: '' });
  rec('R2. no key → null (two-way disabled, capture-only)', none === null);
}

// ── reply prompt: the delivery contract is present ───────────────────────────
{
  const dm = buildReplySystemPrompt({ turnCtx: turn('1') });
  rec('P1. prompt names the reply tool as the only delivery path', /`reply` tool/.test(dm) && /NOT delivered/.test(dm));
  const grp = buildReplySystemPrompt({ turnCtx: { channelKind: 'telegram-group', channelId: '-1' } });
  rec('P2. surface wording differs DM vs group', /direct message/.test(dm) && /Telegram group/.test(grp));
}

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO');

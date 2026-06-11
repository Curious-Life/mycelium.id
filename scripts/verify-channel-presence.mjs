// verify:channel-presence — (1) reply-tagging is the agent's CHOICE: the reply
// tool sends a plain message by default and tags only on quote:true; (2) the
// typing presence fires for Telegram DM turns, keeps alive on an interval, is
// gated off for groups/discord, and is always stopped when the turn ends —
// including on turn error (it must never outlive a turn).
import { createReplyDomain } from '../src/tools/reply.js';
import { createTypingPresence } from '../packages/channel-daemon/presence.js';
import { createLane } from '../packages/channel-daemon/agent/lane.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Part 1: reply tool quote semantics (mock agent-server fetch) ──
const TURN = { source: 'telegram', channelKind: 'telegram-dm', channelId: '777', inboundMessageId: '4242' };
let lastSendBody = null;
const fetchMock = async (url, init) => {
  if (String(url).endsWith('/internal/inbound-context/current')) {
    return { ok: true, status: 200, json: async () => TURN };
  }
  lastSendBody = JSON.parse(init.body);
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};
const domain = createReplyDomain({ agentUrl: 'http://localhost:0', fetch: fetchMock });

await domain.handlers.reply({ text: 'plain message by default — no tag expected here' });
rec('R1. default reply carries NO replyToMessageId (plain message)',
  lastSendBody && !('replyToMessageId' in lastSendBody), JSON.stringify(lastSendBody));

await domain.handlers.reply({ text: 'quoted message when the agent chooses to', quote: true });
rec('R2. quote:true tags the inbound message',
  lastSendBody?.replyToMessageId === '4242', JSON.stringify(lastSendBody));

await domain.handlers.reply({ text: 'quote false explicit stays plain too ok', quote: false });
rec('R3. quote:false stays plain',
  lastSendBody && !('replyToMessageId' in lastSendBody), JSON.stringify(lastSendBody));

// ── Part 2: typing presence gating + lifecycle ──
let pings = [];
const presence = createTypingPresence({ sendChatAction: (chatId) => { pings.push(String(chatId)); }, intervalMs: 25 });

const stopDm = presence.start({ channelKind: 'telegram-dm', channelId: '777' });
rec('P1. DM turn starts typing immediately', typeof stopDm === 'function' && pings.length === 1, `pings=${pings.length}`);
await sleep(70);
const midCount = pings.length;
rec('P2. keepalive re-fires while the turn runs', midCount >= 3, `pings=${midCount}`);
stopDm();
await sleep(60);
rec('P3. stop() halts the keepalive', pings.length === midCount, `pings=${pings.length}`);
rec('P4. group turn gets NO typing (no triage step yet — by design)',
  presence.start({ channelKind: 'telegram-group', channelId: '-100' }) === null && pings.length === midCount);
rec('P5. discord turn gets NO typing',
  presence.start({ channelKind: 'discord-guild', channelId: '555' }) === null);

// ── Part 3: the lane stops presence even when the turn THROWS ──
pings = [];
const failingRuntime = { label: 'boom', runTurn: async () => { await sleep(40); throw new Error('turn exploded'); } };
const lane = createLane({ runtime: failingRuntime, presence, turnTimeoutMs: 5_000, logPrefix: 'verify-presence' });
lane.runTurn({ source: 'telegram', channelKind: 'telegram-dm', channelId: '777', inboundMessageId: '1' }, { content: 'hi' });
await lane.idle();
const afterError = pings.length;
await sleep(70);
rec('P6. presence stopped in finally on turn error (never outlives the turn)',
  pings.length === afterError && afterError >= 1, `pings=${pings.length} (during turn: ${afterError})`);

const okAll = ledger.every(Boolean);
console.log(`VERDICT: ${okAll ? 'GO' : 'NO-GO'} — reply quote opt-in + typing presence (DM-gated, keepalive, error-safe)  EXIT=${okAll ? 0 : 1}`);
process.exit(okAll ? 0 : 1);

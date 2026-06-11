// verify:channel-presence — (1) reply-tagging is the agent's CHOICE: the reply
// tool sends a plain message by default and tags only on quote:true; (2) the
// typing presence fires for Telegram DM turns, keeps alive on an interval, is
// gated off for groups/discord, and is always stopped when the turn ends —
// including on turn error (it must never outlive a turn).
import { createReplyDomain } from '../src/tools/reply.js';
import { createTypingPresence } from '../packages/channel-daemon/presence.js';
import { createLane } from '../packages/channel-daemon/agent/lane.js';
import { createInboundHandler } from '../packages/channel-daemon/inbound.js';

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

// ── Part 4: inbound pre-turn presence — typing covers the MEDIA stage ──
// (vision/transcription runs BEFORE the turn and is the longest phase for
// images + voice notes; text messages get pre-turn typing too).
pings = [];
let mediaRunning = false, typedDuringMedia = false, stoppedAtEnqueue = false;
const inbound = createInboundHandler({
  vault: { captureMessage: async () => ({}) },
  ownerTelegramId: '42',
  runTurn: () => { stoppedAtEnqueue = false; return Promise.resolve(); }, // enqueue-and-return
  contextualizeMedia: async () => {
    mediaRunning = true;
    await sleep(60); // typing keepalive (25ms) must fire during this
    typedDuringMedia = pings.length >= 2;
    mediaRunning = false;
    return { attachmentId: null, contextLine: '[photo: a test]' };
  },
  presence,
});
await inbound({ channelKind: 'telegram-dm', chatId: '42', fromId: '42', messageId: '9', source: 'telegram', content: '', media: { kind: 'photo' } });
const afterInbound = pings.length;
await sleep(60);
rec('P7. media inbound: typing during vision/transcription, stopped after enqueue',
  typedDuringMedia && pings.length === afterInbound, `duringMedia=${typedDuringMedia} pings=${pings.length}/${afterInbound}`);

pings = [];
await inbound({ channelKind: 'telegram-dm', chatId: '42', fromId: '42', messageId: '10', source: 'telegram', content: 'plain text message' });
rec('P8. text inbound also starts pre-turn typing', pings.length >= 1, `pings=${pings.length}`);

pings = [];
await inbound({ channelKind: 'telegram-dm', chatId: '99', fromId: '99', messageId: '11', source: 'telegram', content: 'not the owner' });
rec('P9. unauthorized inbound never types (auth precedes presence)', pings.length === 0, `pings=${pings.length}`);

const okAll = ledger.every(Boolean);
console.log(`VERDICT: ${okAll ? 'GO' : 'NO-GO'} — reply quote opt-in + typing presence (DM-gated, keepalive, error-safe)  EXIT=${okAll ? 0 : 1}`);
process.exit(okAll ? 0 : 1);

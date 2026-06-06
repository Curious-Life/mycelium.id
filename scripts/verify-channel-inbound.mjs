// verify:channel-inbound — Phase 1 of the channel-daemon: inbound transport +
// capture. Pure DI (no network): fake getUpdates + fake vault. Asserts:
//   - normalizeUpdate maps private/group/non-message updates correctly
//   - the poller advances the offset (maxUpdateId+1) and feeds each message
//   - inbound handler captures owner DMs with the right captureMessage shape
//     (idempotent id, role=user, source, conversationId, owner metadata)
//   - fail-closed authorization: non-owner + group messages are dropped
//   - voice-only / empty content is skipped (no capture, no throw)
//   - a capture failure is soft (runTurn still fires; no throw escapes)
//   - runTurn receives the ActiveTurnContext the egress chokepoint resolves on
// PASS/FAIL ledger; exit 1 on any fail.
import { normalizeUpdate, maxUpdateId } from '../packages/channel-daemon/transport/normalize.js';
import { createTelegramPoller } from '../packages/channel-daemon/transport/telegram-poller.js';
import { createInboundHandler } from '../packages/channel-daemon/inbound.js';
import { setActiveTurn, getActiveTurn, _resetForTests } from '../packages/channel-daemon/inbound-context.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const OWNER = '111';
const upd = (id, over = {}) => ({ update_id: id, message: { message_id: 500 + id, date: 1717600000, chat: { id: Number(OWNER), type: 'private' }, from: { id: Number(OWNER), username: 'op', first_name: 'Op' }, text: 'hello vault', ...over } });

// ── normalize ───────────────────────────────────────────────────────────────
{
  const n = normalizeUpdate(upd(1));
  rec('N1. private text → source telegram + ids', n && n.source === 'telegram' && n.channelKind === 'telegram' && n.chatId === OWNER && n.messageId === '501' && n.content === 'hello vault', `src=${n?.source}`);

  const g = normalizeUpdate({ update_id: 2, message: { message_id: 9, date: 1, chat: { id: -100, type: 'supergroup', title: 'Grp' }, from: { id: 5 }, text: 'hi', reply_to_message: { message_id: 8 } } });
  rec('N2. supergroup → telegram-group + chatTitle + replyTo', g.source === 'telegram-group' && g.channelKind === 'telegram-group' && g.chatTitle === 'Grp' && g.replyToMessageId === '8', `src=${g?.source}`);

  const c = normalizeUpdate({ update_id: 3, message: { message_id: 1, date: 1, chat: { id: 7, type: 'private' }, from: { id: 7 }, caption: 'pic note' } });
  rec('N3. caption used when no text', c.content === 'pic note', `content=${c?.content}`);

  const v = normalizeUpdate({ update_id: 4, message: { message_id: 1, date: 1, chat: { id: 7, type: 'private' }, from: { id: 7 }, voice: { duration: 3 } } });
  rec('N4. voice-only → content empty + voiceMode true', v.content === '' && v.voiceMode === true, `voice=${v?.voiceMode}`);

  rec('N5. non-message update → null', normalizeUpdate({ update_id: 5, edited_message: {} }) === null);
  rec('N6. maxUpdateId picks the largest', maxUpdateId([upd(3), upd(7), upd(5)]) === 7);
}

// ── poller offset + fan-out ──────────────────────────────────────────────────
{
  const seen = [];
  const calls = [];
  let batch = 0;
  const telegram = {
    getUpdates: async ({ offset }) => {
      calls.push(offset);
      if (batch++ === 0) return [upd(10), upd(11)];
      return []; // subsequent polls empty
    },
  };
  const poller = createTelegramPoller({ telegram, handleInbound: async (m) => seen.push(m.messageId) });
  await poller._pollOnce(); // batch 0
  await poller._pollOnce(); // batch 1 (empty) — should pass offset = 12
  rec('P1. both messages fanned out to the handler', seen.length === 2 && seen[0] === '510' && seen[1] === '511', `seen=${seen.join(',')}`);
  rec('P2. offset advances to maxUpdateId+1 (12) on the next poll', calls[0] === undefined && calls[1] === 12, `calls=${JSON.stringify(calls)}`);
}

// ── inbound handler ──────────────────────────────────────────────────────────
function mkHandler({ ownerTelegramId = OWNER, captureImpl } = {}) {
  const captures = [];
  const turns = [];
  const vault = { captureMessage: captureImpl || (async (a) => { captures.push(a); return { id: a.id }; }) };
  const handle = createInboundHandler({ vault, ownerTelegramId, runTurn: (ctx) => { turns.push(ctx); } });
  return { handle, captures, turns };
}

{
  const { handle, captures, turns } = mkHandler();
  await handle(normalizeUpdate(upd(20))); // owner DM, msg 520
  const c = captures[0] || {};
  rec('H1. owner DM captured (role user, source telegram)', captures.length === 1 && c.role === 'user' && c.source === 'telegram', `caps=${captures.length}`);
  rec('H2. idempotent id = tg-<msg>-<chat>', c.id === `tg-520-${OWNER}`, `id=${c.id}`);
  rec('H3. conversationId + owner metadata', c.conversationId === OWNER && c.metadata?.senderRole === 'owner' && c.metadata?.channelId === OWNER, `senderRole=${c.metadata?.senderRole}`);
  rec('H4. createdAt preserved from telegram date', c.createdAt === 1717600000, `createdAt=${c.createdAt}`);
  rec('H5. runTurn got the ActiveTurnContext (channelId + inboundMessageId)', turns.length === 1 && turns[0].channelId === OWNER && turns[0].inboundMessageId === '520' && turns[0].source === 'telegram', `turn=${JSON.stringify(turns[0])}`);
}

{
  // unauthorized: different chat/sender
  const { handle, captures, turns } = mkHandler();
  await handle(normalizeUpdate({ update_id: 30, message: { message_id: 1, date: 1, chat: { id: 999, type: 'private' }, from: { id: 999 }, text: 'intruder' } }));
  rec('H6. non-owner DM dropped (no capture, no turn)', captures.length === 0 && turns.length === 0);
}

{
  // group dropped in Phase 1
  const { handle, captures } = mkHandler();
  await handle(normalizeUpdate({ update_id: 31, message: { message_id: 1, date: 1, chat: { id: -100, type: 'supergroup', title: 'g' }, from: { id: Number(OWNER) }, text: 'in group' } }));
  rec('H7. group message dropped in Phase 1', captures.length === 0);
}

{
  // voice-only skipped (no content) — no capture, no throw
  const { handle, captures, turns } = mkHandler();
  await handle(normalizeUpdate(upd(32, { text: undefined, voice: { duration: 2 } })));
  rec('H8. empty-content inbound skipped (no capture, no turn)', captures.length === 0 && turns.length === 0);
}

{
  // capture failure is soft — runTurn still fires, no throw escapes
  const { handle, turns } = mkHandler({ captureImpl: async () => { throw new Error('vault busy'); } });
  let threw = false;
  try { await handle(normalizeUpdate(upd(33))); } catch { threw = true; }
  rec('H9. capture failure is soft (runTurn still fires, no throw)', !threw && turns.length === 1, `threw=${threw} turns=${turns.length}`);
}

// ── phase-1 runTurn stub sets the active turn the chokepoint reads ────────────
{
  _resetForTests();
  const vault = { captureMessage: async () => ({}) };
  const handle = createInboundHandler({ vault, ownerTelegramId: OWNER, runTurn: (ctx) => setActiveTurn(ctx) });
  await handle(normalizeUpdate(upd(40)));
  const t = getActiveTurn();
  rec('H10. active-turn registry populated for the reply path', t?.channelId === OWNER && t?.inboundMessageId === '540', `turn=${t?.channelId}`);
  _resetForTests();
}

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO');

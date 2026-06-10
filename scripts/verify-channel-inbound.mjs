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

// ── media descriptors (normalize) ────────────────────────────────────────────
{
  const p = normalizeUpdate(upd(50, { text: undefined, caption: 'my cat', photo: [
    { file_id: 'small', file_unique_id: 'u1', file_size: 1000 },
    { file_id: 'big', file_unique_id: 'u2', file_size: 90000 },
  ] }));
  rec('M1. photo → largest PhotoSize descriptor + caption as content',
    p.media?.kind === 'photo' && p.media.fileId === 'big' && p.media.mimeType === 'image/jpeg' && p.content === 'my cat', `fileId=${p.media?.fileId}`);

  const v = normalizeUpdate(upd(51, { text: undefined, voice: { file_id: 'vf', file_unique_id: 'vu', duration: 7, mime_type: 'audio/ogg', file_size: 4000 } }));
  rec('M2. voice → descriptor with duration + ogg mime + voiceMode',
    v.media?.kind === 'voice' && v.media.duration === 7 && v.media.mimeType === 'audio/ogg' && v.voiceMode === true, `kind=${v.media?.kind}`);

  const d = normalizeUpdate(upd(52, { text: undefined, document: { file_id: 'df', file_unique_id: 'du', file_name: 'notes.md', mime_type: 'text/markdown', file_size: 222 } }));
  rec('M3. document → descriptor with fileName + mime', d.media?.kind === 'document' && d.media.fileName === 'notes.md' && d.media.mimeType === 'text/markdown', `name=${d.media?.fileName}`);

  rec('M4. plain text → media null (path unchanged)', normalizeUpdate(upd(53)).media === null);
}

// ── media stage wiring (inbound handler) ─────────────────────────────────────
function mkMediaHandler({ stageImpl, captureImpl } = {}) {
  const captures = [];
  const turns = [];
  const staged = [];
  const vault = { captureMessage: captureImpl || (async (a) => { captures.push(a); return { id: a.id }; }) };
  const contextualizeMedia = stageImpl === null ? undefined : (stageImpl || (async (msg) => {
    staged.push(msg.media?.kind);
    return { attachmentId: 'att-1', contextLine: '[Image attached — a tabby cat]' };
  }));
  const handle = createInboundHandler({ vault, ownerTelegramId: OWNER, runTurn: (ctx, m) => { turns.push({ ctx, content: m.content }); }, contextualizeMedia });
  return { handle, captures, turns, staged };
}
const photoUpd = (id, over = {}) => upd(id, { text: undefined, caption: 'look', photo: [{ file_id: 'pf', file_unique_id: 'pu', file_size: 500 }], ...over });

{
  const { handle, captures, turns, staged } = mkMediaHandler();
  await handle(normalizeUpdate(photoUpd(60)));
  const c = captures[0] || {};
  rec('M5. media stage runs; caption + context line ride content; attachmentId + mediaKind captured',
    staged.length === 1 && c.content === 'look\n[Image attached — a tabby cat]' && c.attachmentId === 'att-1' && c.metadata?.mediaKind === 'photo' && c.metadata?.fileUniqueId === 'pu',
    `content="${c.content}" att=${c.attachmentId}`);
  rec('M6. turn sees the SAME augmented content', turns[0]?.content === 'look\n[Image attached — a tabby cat]', `turn="${turns[0]?.content}"`);
}

{
  // media-only (no caption) is NO LONGER skipped when the stage is wired
  const { handle, captures } = mkMediaHandler();
  await handle(normalizeUpdate(upd(61, { text: undefined, voice: { file_id: 'vf', file_unique_id: 'vu', duration: 3, file_size: 100 } })));
  rec('M7. media-only message captured (content = context line)', captures.length === 1 && captures[0].content === '[Image attached — a tabby cat]', `caps=${captures.length}`);
}

{
  // stage fail-soft: placeholder line still captured, turn still runs
  const { handle, captures, turns } = mkMediaHandler({ stageImpl: async () => ({ attachmentId: null, contextLine: '[Image — could not be fetched]' }) });
  await handle(normalizeUpdate(photoUpd(62)));
  rec('M8. stage failure → placeholder captured, no attachmentId, turn runs',
    captures[0]?.content === 'look\n[Image — could not be fetched]' && captures[0]?.attachmentId === undefined && turns.length === 1, `content="${captures[0]?.content}"`);
}

{
  // unauthorized chat: the media stage must NEVER run (no download of strangers' files)
  let stageRan = false;
  const { handle, captures } = mkMediaHandler({ stageImpl: async () => { stageRan = true; return { attachmentId: null, contextLine: 'x' }; } });
  await handle(normalizeUpdate({ update_id: 63, message: { message_id: 1, date: 1, chat: { id: 999, type: 'private' }, from: { id: 999 }, caption: 'hi', photo: [{ file_id: 'pf', file_size: 5 }] } }));
  rec('M9. unauthorized inbound → media stage never invoked', !stageRan && captures.length === 0, `stageRan=${stageRan}`);
}

{
  // no stage wired (capture-only / non-telegram) → media-only skipped as before
  const { handle, captures } = mkMediaHandler({ stageImpl: null });
  await handle(normalizeUpdate(upd(64, { text: undefined, photo: [{ file_id: 'pf', file_size: 5 }] })));
  rec('M10. stage not wired → media-only message skipped (legacy behavior)', captures.length === 0);
}

// ── media.js unit: size gates + fallbacks (fake telegram + vault) ─────────────
const { contextualizeMedia: realStage, mediaContextLine } = await import('../packages/channel-daemon/media.js');
const mkMsg = (media) => ({ messageId: '70', chatId: OWNER, media });
{
  // happy path: download → upload → context
  const telegram = { getFile: async () => Buffer.from('IMGBYTES') };
  const vault = {
    uploadAttachment: async (bytes, { fileName, fileType }) => ({ attachmentId: `att-${bytes.length}-${fileName}-${fileType}` }),
    attachmentContext: async ({ attachmentId, kind }) => `desc(${attachmentId},${kind})`,
  };
  const r = await realStage(mkMsg({ kind: 'photo', fileId: 'f', fileSize: 8, mimeType: 'image/jpeg', fileName: null }), { telegram, vault });
  rec('ME1. happy path: bytes → upload(name,type) → context(kind=image) → line',
    r.attachmentId === 'att-8-photo-70.jpg-image/jpeg' && /a?desc\(att-8-photo-70.jpg-image\/jpeg,image\)/.test(r.contextLine),
    `att=${r.attachmentId} line="${r.contextLine}"`);
}
{
  // descriptor over the cap → no download attempted
  let downloaded = false;
  const telegram = { getFile: async () => { downloaded = true; return Buffer.alloc(1); } };
  const r = await realStage(mkMsg({ kind: 'document', fileId: 'f', fileSize: 30 * 1024 * 1024, fileName: 'big.bin', mimeType: null }), { telegram, vault: {} });
  rec('ME2. oversize descriptor → never downloaded + honest placeholder',
    !downloaded && r.attachmentId === null && /exceeds the import limit/.test(r.contextLine), `line="${r.contextLine}"`);
}
{
  // server-side FILE_TOO_LARGE → too-large placeholder
  const telegram = { getFile: async () => { const e = new Error('big'); e.code = 'FILE_TOO_LARGE'; throw e; } };
  const r = await realStage(mkMsg({ kind: 'photo', fileId: 'f', fileSize: null }), { telegram, vault: {} });
  rec('ME3. server-side too-large → placeholder, no throw', r.attachmentId === null && /exceeds the import limit/.test(r.contextLine));
}
{
  // download error → fetched:false placeholder; upload null → same, no throw
  const telegram = { getFile: async () => { throw new Error('net down'); } };
  const r = await realStage(mkMsg({ kind: 'voice', fileId: 'f', fileSize: 10, duration: 65 }), { telegram, vault: {} });
  const telegram2 = { getFile: async () => Buffer.from('X') };
  const vault2 = { uploadAttachment: async () => null, attachmentContext: async () => { throw new Error('never reached'); } };
  const r2 = await realStage(mkMsg({ kind: 'voice', fileId: 'f', fileSize: 10, duration: 65 }), { telegram: telegram2, vault: vault2 });
  rec('ME4. download / upload failures → fail-soft placeholders (1:05 duration shown)',
    /could not be fetched/.test(r.contextLine) && /1:05/.test(r.contextLine) && /could not be fetched/.test(r2.contextLine), `line="${r.contextLine}"`);
}
{
  // context line shapes: transcript quoted, null transcript honest
  const withT = mediaContextLine({ kind: 'voice', duration: 7, fileName: null }, 'hello there');
  const noT = mediaContextLine({ kind: 'voice', duration: 7, fileName: null }, null);
  const doc = mediaContextLine({ kind: 'document', fileName: 'n.md' }, '# Notes');
  rec('ME5. context lines: transcript quoted / unavailable honest / doc content block',
    /transcript: "hello there"/.test(withT) && /transcription unavailable/.test(noT) && /content:\n# Notes/.test(doc), `t="${withT}"`);
}

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO');

// verify:channel-discord — Discord egress (via the shared send-handler core +
// discord adapter), the REST api (injected fetch), normalize, and inbound auth.
// Pure DI — no network, no discord.js (gateway is host-verified). PASS/FAIL.
import http from 'node:http';
import crypto from 'node:crypto';
import { createDiscordApi } from '../packages/channel-daemon/discord-api.js';
import { createDiscordChokepoint } from '../packages/channel-daemon/discord-chokepoint.js';
import { createDiscordInboundHandler } from '../packages/channel-daemon/discord-inbound.js';
import { createDiscordCommandHandler } from '../packages/channel-daemon/commands-discord.js';
import { normalizeDiscordMessage } from '../packages/channel-daemon/transport/discord-normalize.js';
import { createEnvelopeDedup } from '../packages/channel-daemon/dedup.js';
import { createDaemonApp } from '../packages/channel-daemon/server.js';
import { getActiveTurn, setActiveTurn, _resetForTests } from '../packages/channel-daemon/inbound-context.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const CH = '987654321';
const TEXT = 'A real Discord reply body that should never appear in any audit row.';

// ── normalize ────────────────────────────────────────────────────────────────
{
  const guild = normalizeDiscordMessage({ id: '1', channelId: CH, guildId: 'g1', author: { id: '42', username: 'op', globalName: 'Op', bot: false }, content: 'hi', createdTimestamp: 1717600000000, guild: { name: 'Srv' }, reference: { messageId: '9' } });
  rec('DN1. guild message → source discord, chatId=channelId, ids', guild.source === 'discord' && guild.chatId === CH && guild.fromId === '42' && guild.replyToMessageId === '9' && guild.chatTitle === 'Srv' && guild.isBot === false, `src=${guild?.source}`);
  const bot = normalizeDiscordMessage({ id: '2', channelId: CH, author: { id: '7', bot: true }, content: 'beep' });
  rec('DN2. bot message flagged isBot', bot.isBot === true);
  rec('DN3. dm (no guild) → chatType dm', normalizeDiscordMessage({ id: '3', channelId: CH, author: { id: '42' }, content: 'yo' }).chatType === 'dm');
  rec('DN4. no channelId → null', normalizeDiscordMessage({ id: '4', author: {} }) === null);
  const thread = normalizeDiscordMessage({ id: '5', channelId: 'T1', guildId: 'g', author: { id: '42' }, content: 'in thread', channel: { isThread: () => true } });
  rec('DN5. thread message → source/kind discord-thread', thread.source === 'discord-thread' && thread.channelKind === 'discord-thread');
}

// ── REST api (injected fetch) ────────────────────────────────────────────────
{
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, async json() { return { id: 'm1' }; } }; };
  const api = createDiscordApi({ botToken: 'tok', fetch: fakeFetch });
  await api.sendMessage({ channelId: CH, content: 'hello', replyToMessageId: '55' });
  const c = calls[0];
  const body = JSON.parse(c.init.body);
  rec('DA1. sendMessage → POST /channels/{id}/messages with Bot auth', /\/channels\/987654321\/messages$/.test(c.url) && c.init.headers.Authorization === 'Bot tok' && body.content === 'hello');
  rec('DA2. reply uses message_reference (not reply_to)', body.message_reference?.message_id === '55');

  // chunking > 2000
  calls.length = 0;
  await api.sendMessage({ channelId: CH, content: 'x'.repeat(4100) });
  rec('DA3. content >2000 chunked into multiple sends', calls.length === 3, `chunks=${calls.length}`);

  // voice multipart
  calls.length = 0;
  await api.sendVoice({ channelId: CH, audio: Buffer.from('ogg'), waveform: 'AAA', durationSecs: 1.5 });
  const vbody = calls[0].init.body;
  rec('DA4. sendVoice → multipart FormData (flags + attachment)', typeof FormData !== 'undefined' && vbody instanceof FormData);

  // failure throws httpStatus
  const errApi = createDiscordApi({ botToken: 'tok', fetch: async () => ({ ok: false, status: 403 }) });
  let threw = null; try { await errApi.sendMessage({ channelId: CH, content: 'x'.repeat(10) }); } catch (e) { threw = e; }
  rec('DA5. non-2xx → throws with httpStatus', threw?.httpStatus === 403);
}

// ── chokepoint (egress via shared core + discord adapter) ─────────────────────
function makeApp({ authorityAllowed = true } = {}) {
  const audits = [], sends = [], persists = [];
  const handler = createDiscordChokepoint({
    sendToDiscord: async (a) => { sends.push(a); return { sent: 1, total: 1, httpStatus: 200 }; },
    recordEgress: (e) => audits.push(e),
    persistOutbound: (a) => persists.push(a),
    checkAuthority: async () => ({ allowed: authorityAllowed, reason: authorityAllowed ? 'reply-to-inbound' : 'discord-channel-not-authorized' }),
    dedup: createEnvelopeDedup(),
    getActiveTurn,
    agentId: 'personal-agent',
  });
  const server = http.createServer(createDaemonApp({ discordSendHandler: handler, getActiveTurn }));
  return { server, audits, sends, persists };
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = (s) => new Promise((r) => s.close(r));
const post = async (port, body, headers) => { const r = await fetch(`http://127.0.0.1:${port}/discord/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };

{
  _resetForTests();
  const { server } = makeApp(); const port = await listen(server);
  let r = await post(port, { channelId: CH }); rec('DC1. missing content → 400', r.status === 400 && /content required/.test(r.json?.error || ''));
  r = await post(port, { content: TEXT }); rec('DC2. missing channelId → 400', r.status === 400 && /channelId required/.test(r.json?.error || ''));
  await close(server);
}
{
  _resetForTests();
  const { server, audits, sends } = makeApp({ authorityAllowed: false }); const port = await listen(server);
  const r = await post(port, { channelId: CH, content: TEXT });
  rec('DC3. authority denied → 403 + audited denied + no send', r.status === 403 && r.json?.error === 'channel-authority-denied' && audits[0]?.decision === 'denied' && sends.length === 0);
  await close(server);
}
{
  _resetForTests();
  const { server, audits, sends, persists } = makeApp({ authorityAllowed: true }); const port = await listen(server);
  const r = await post(port, { channelId: CH, content: TEXT }, { 'x-egress-provenance': 'agent-explicit' });
  const a = audits[0] || {};
  rec('DC4. happy path → 200 delivered, discord api got channelId+content', r.json?.delivered === true && sends.length === 1 && String(sends[0].channelId) === CH && sends[0].content === TEXT);
  rec('DC5. audit channelKind=discord, agent-explicit-via-tool, hash only', a.channelKind === 'discord' && a.provenanceKind === 'agent-explicit-via-tool' && a.contentHash === crypto.createHash('sha256').update(TEXT).digest('hex') && !JSON.stringify(a).includes(TEXT));
  rec('DC6. outbound persisted source=discord', persists[0]?.role === 'assistant' && persists[0]?.source === 'discord');
  await close(server);
}

// ── inbound ──────────────────────────────────────────────────────────────────
{
  const captured = [], turns = [];
  const handle = createDiscordInboundHandler({ vault: { captureMessage: async (x) => captured.push(x) }, ownerDiscordId: '42', runTurn: (ctx) => turns.push(ctx) });
  await handle(normalizeDiscordMessage({ id: '100', channelId: CH, author: { id: '42', username: 'op' }, content: 'hello vault', createdTimestamp: 1717600000000 }));
  rec('DI1. owner message captured (dc-id, source discord) + turn', captured.length === 1 && captured[0].id === `dc-100-${CH}` && captured[0].source === 'discord' && turns.length === 1 && turns[0].channelKind === 'discord');
  await handle(normalizeDiscordMessage({ id: '101', channelId: CH, author: { id: '999' }, content: 'intruder' }));
  rec('DI2. non-owner dropped', captured.length === 1 && turns.length === 1);
  await handle(normalizeDiscordMessage({ id: '102', channelId: CH, author: { id: '7', bot: true }, content: 'beep' }));
  rec('DI3. bot message dropped', captured.length === 1);
}

// ── inbound: channel allowlist + commands ────────────────────────────────────
{
  const captured = [], turns = [], cmdHandled = [];
  let authorized = false;
  const commands = { isCommand: (c) => c.trim().startsWith('/'), handle: async (m) => { cmdHandled.push(m.content); authorized = true; return true; } };
  const handle = createDiscordInboundHandler({
    vault: { captureMessage: async (x) => captured.push(x) }, ownerDiscordId: '42',
    runTurn: (ctx) => turns.push(ctx), commands, isChannelAuthorized: async () => authorized,
  });
  // non-owner in UNauthorized channel → dropped
  await handle(normalizeDiscordMessage({ id: '200', channelId: CH, author: { id: '500' }, content: 'hi all' }));
  rec('DI4. non-owner in unauthorized channel dropped', captured.length === 0 && turns.length === 0);
  // owner /allow → command handled (authorizes), not captured
  await handle(normalizeDiscordMessage({ id: '201', channelId: CH, author: { id: '42' }, content: '/allow' }));
  rec('DI5. owner /allow handled as command (not captured)', cmdHandled.length === 1 && authorized === true && captured.length === 0);
  // now non-owner in the authorized channel → captured + turned
  await handle(normalizeDiscordMessage({ id: '202', channelId: CH, author: { id: '500', username: 'mate' }, content: 'hey bot' }));
  rec('DI6. non-owner in authorized channel captured + turned', captured.length === 1 && turns.length === 1);
}

// ── discord command handler ──────────────────────────────────────────────────
{
  const calls = { set: [], list: 0, replies: [] };
  const vault = { setDiscordChannel: async (a) => calls.set.push(a), listDiscordChannels: async () => { calls.list++; return [{ id: CH, name: 'general' }]; } };
  const cmd = createDiscordCommandHandler({ vault, sendReply: async (a) => calls.replies.push(a), ownerDiscordId: '42' });
  const m = (content, fromId = '42') => ({ chatId: CH, messageId: '1', chatTitle: 'general', fromId, content });
  rec('DCMD1. /allow authorizes channel on', await cmd.handle(m('/allow')) === true && calls.set[0]?.on === true && String(calls.set[0]?.id) === CH);
  rec('DCMD2. /disallow turns it off', await cmd.handle(m('/disallow')) === true && calls.set[1]?.on === false);
  rec('DCMD3. /channels lists', await cmd.handle(m('/channels')) === true && calls.list === 1 && /general/.test(calls.replies.at(-1).content));
  const before = calls.set.length;
  rec('DCMD4. non-owner command swallowed (no side effects)', await cmd.handle(m('/allow', '999')) === true && calls.set.length === before);
}

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO');

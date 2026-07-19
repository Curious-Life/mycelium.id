#!/usr/bin/env node
// verify:channel-auth-notice — U1: an AUTH outage becomes VISIBLE to the owner.
//
// Drives the REAL daemon assembly (buildDaemon → real lane → real onOutcome →
// real notifier → fetch(selfUrl)/telegram/send → the REAL server.js route → the
// REAL send-handler chokepoint → telegram-api) with fakes ONLY at the two outer
// boundaries: the vault REST (a recording stub server) and api.telegram.org (a
// recording global-fetch shim). The gate does NOT inject its own chokepoint or
// sink — a past gate was blind because it supplied one — so the assertions
// observe the real route registration: the notice is only counted when it
// produced BOTH a Bot-API sendMessage AND the chokepoint's egress-audit write.
//
// Asserts (identity + destination, not call counts alone):
//   N1  auth no-reply on the owner DM → exactly ONE notice; text === the static
//       AUTH_NOTICE_TEXT; chat_id === the owner chat that messaged
//   N2  the notice traversed the chokepoint: egress audit carries
//       provenanceKind=system-template + sha256(AUTH_NOTICE_TEXT) + the owner chat
//   N3  second auth no-reply in the SAME episode → ZERO additional sends
//   N4  a delivered turn then auth again → ONE new notice (outcome-based reset)
//   N5  never broadcast: a/b Telegram non-owner chat + group → zero sends; c
//       Discord owner outage in a GUILD channel → zero sends (suppressed), but a
//       Discord owner DM (guildId null) → exactly one send (recipient-safety: the
//       owner is authorized anywhere + the notice is a trusted send that bypasses
//       the chokepoint authority gate, so the DM restriction is the only guard)
//   N6  the notice send failing (Bot API 500) → fail-soft: no throw, the lane
//       keeps running turns, and the episode stays one-notice
// PASS/FAIL ledger; exit 0 only on full GO.
import http from 'node:http';
import crypto from 'node:crypto';
import { buildDaemon } from '../packages/channel-daemon/index.js';
import { loadConfig } from '../packages/channel-daemon/config.js';
import { createEnvelopeDedup } from '../packages/channel-daemon/dedup.js';
import { AUTH_NOTICE_TEXT } from '../packages/channel-daemon/auth-notice.js';

const OWNER = '111';
const STRANGER = '222';
const DISCORD_OWNER = '333';          // Discord SENDER id of the owner
const DC_DM_CHAN = 'dm-9001';         // a Discord DM channel (guildId null)
const DC_GUILD_CHAN = 'guild-chan-42';// a Discord SERVER channel (guildId set)
const DC_GUILD_ID = 'guild-70000';
const ledger = [];
let allPass = true;
const check = (n, c, d = '') => { const ok = !!c; allPass = allPass && ok; ledger.push(`[${ok ? '✓' : '✗'}] ${n}${d ? ` — ${d}` : ''}`); };
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// Console-only turn log for this gate (no file side effects).
delete process.env.MYCELIUM_CHANNEL_TURN_LOG;
delete process.env.MYCELIUM_DATA_DIR;
delete process.env.MYCELIUM_VAULT_DIR;
delete process.env.MYCELIUM_STATE_DIR;

// ── vault REST stub: records egress-audit writes, 200 {} for everything ──────
const audits = [];
const vaultStub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/api/v1/internal/egress-audit') {
      try { audits.push(JSON.parse(body)); } catch { /* */ }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
const vaultPort = await new Promise((r) => vaultStub.listen(0, '127.0.0.1', () => r(vaultStub.address().port)));

// ── api.telegram.org + discord.com shims: record outbound sends, pass the rest ─
const tgSends = [];
const dcSends = []; // N5c: Discord outbound messages (POST /channels/{id}/messages)
let tgFail = false; // N6: flip to make the Bot API fail the send
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  // Parse the host once and compare it EXACTLY — a substring match on the URL would
  // let an attacker-controlled host (…api.telegram.org.evil.com) route through the mock.
  let host = '', path = '';
  try { const parsed = new URL(u); host = parsed.host; path = parsed.pathname; } catch { /* non-URL → fall through to realFetch */ }
  if (host === 'api.telegram.org') {
    if (path.includes('/sendMessage')) {
      if (tgFail) return new Response(JSON.stringify({ ok: false, description: 'gate-injected failure' }), { status: 500 });
      tgSends.push(JSON.parse(opts?.body || '{}'));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1000 + tgSends.length } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }); // sendChatAction etc.
  }
  if (host === 'discord.com' && path.startsWith('/api')) {
    // POST /channels/{channelId}/messages — the ONLY egress we assert on. Capture the
    // target channel from the URL (the notice content is in the body).
    if (path.includes('/messages') && String(opts?.method).toUpperCase() === 'POST') {
      const m = path.match(/\/channels\/([^/]+)\/messages/);
      dcSends.push({ channelId: m ? m[1] : null, ...JSON.parse(opts?.body || '{}') });
      return new Response(JSON.stringify({ id: `dcmsg-${dcSends.length}` }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
  }
  return realFetch(url, opts);
};

// ── the REAL daemon assembly, fake only the LLM (scripted runtime outcomes) ──
const outcomes = [];
const runtime = {
  label: 'fake-auth-gate',
  async runTurn() {
    return outcomes.shift() || { delivered: false, usedReplyTool: false, reason: 'no-reply' };
  },
};
const cfg = loadConfig({
  TELEGRAM_BOT_TOKEN: 'gate-token',
  OWNER_TELEGRAM_ID: OWNER,
  // Discord configured too (N5c): wires the real /discord/send chokepoint + the
  // Discord branch of isOwnerChat. The gateway is constructed but never .start()ed
  // by buildDaemon, so no websocket/network is opened.
  DISCORD_BOT_TOKEN: 'gate-discord-token',
  OWNER_DISCORD_ID: DISCORD_OWNER,
  MYCELIUM_API_URL: `http://127.0.0.1:${vaultPort}`,
  CHANNEL_MCP_MODE: 'http',
});
let daemonServer;
try {
  // Real assembly; the ONLY compressions are the scripted runtime (the LLM) and a
  // short-TTL envelope dedup (the real module — production TTL is 30s, which would
  // mask notifier behavior behind the chokepoint's double-send guard at gate speed).
  const built = await buildDaemon(cfg, { runtime, dedup: createEnvelopeDedup({ ttlMs: 250 }) });
  daemonServer = http.createServer(built.app);
  const dport = await new Promise((r) => daemonServer.listen(0, '127.0.0.1', () => r(daemonServer.address().port)));
  cfg.selfUrl = `http://127.0.0.1:${dport}`; // closures read cfg.selfUrl per call

  const lane = built.getLane();
  check('S0. injected runtime rode the REAL lane wiring (replies on)', !!lane && built.replies.mode === 'on', `mode=${built.replies.mode}`);

  const turn = async (chatId, outcome, ctx = {}) => {
    outcomes.push(outcome);
    lane.runTurn({ source: 'telegram', channelKind: 'telegram', channelId: chatId, userId: chatId, senderRole: 'owner', ...ctx }, { content: 'gate message' });
    await lane.idle();
    await settle(); // let the fire-and-forget notify + audit land
  };
  const AUTH = { delivered: false, usedReplyTool: false, reason: 'auth', degraded: true };
  const OK = { delivered: true, usedReplyTool: true, reason: 'replied' };

  // N1 + N2: first auth failure on the owner DM → exactly one notice, through the chokepoint.
  await turn(OWNER, AUTH);
  check('N1. one notice sent, static text, to the owner chat that messaged',
    tgSends.length === 1 && String(tgSends[0].chat_id) === OWNER && tgSends[0].text === AUTH_NOTICE_TEXT,
    `sends=${tgSends.length} chat=${tgSends[0]?.chat_id}`);
  const noticeAudit = audits.find((a) => a.contentHash === sha256(AUTH_NOTICE_TEXT));
  check('N2. notice traversed the REAL chokepoint (egress audit: system-template + hash + owner chat)',
    !!noticeAudit && noticeAudit.provenanceKind === 'system-template' && String(noticeAudit.channelId) === OWNER && noticeAudit.decision === 'allowed',
    `audits=${audits.length} prov=${noticeAudit?.provenanceKind}`);

  // N3: second auth failure in the SAME episode → no additional send — and no
  // second ATTEMPT either (the audit trail would show an envelope-dedup entry if
  // the notifier had fired and only the chokepoint saved us).
  await turn(OWNER, AUTH);
  const noticeAudits = () => audits.filter((a) => a.contentHash === sha256(AUTH_NOTICE_TEXT));
  check('N3. same-episode follow-up auth failure → ZERO additional notices (and zero attempts)',
    tgSends.length === 1 && noticeAudits().length === 1, `sends=${tgSends.length} attempts=${noticeAudits().length}`);

  // N4: a successful turn resets the episode; the next auth failure notifies again.
  await turn(OWNER, OK);
  check('N4a. delivered turn sends nothing extra', tgSends.length === 1, `sends=${tgSends.length}`);
  await turn(OWNER, AUTH);
  check('N4b. auth after recovery → ONE new notice (outcome-based episode reset)',
    tgSends.length === 2 && tgSends[1].text === AUTH_NOTICE_TEXT && String(tgSends[1].chat_id) === OWNER,
    `sends=${tgSends.length}`);

  // N5: never broadcast — a non-owner DM and a group chat get NO notice.
  await turn(OWNER, OK); // reset episode
  await turn(STRANGER, AUTH, { senderRole: 'other' });
  check('N5a. auth on a non-owner chat → zero notices', tgSends.length === 2, `sends=${tgSends.length}`);
  await turn('-100777', AUTH, { channelKind: 'telegram-group', senderRole: 'other' });
  check('N5b. auth on a group chat → zero notices', tgSends.length === 2, `sends=${tgSends.length}`);

  // N5c: Discord recipient-safety. The inbound authorizes the owner ANYWHERE (bypasses
  // channel policy), and a notice send is `trusted` (bypasses the chokepoint authority
  // gate), so an owner auth outage in a PUBLIC guild channel would broadcast the notice
  // there. isOwnerChat must restrict the Discord notice to DMs (guildId == null).
  //   - guild-channel (guildId set) owner outage → ZERO Discord sends (suppressed)
  //   - DM (guildId null) owner outage        → exactly ONE Discord send
  // A Discord turnCtx carries source 'discord', channelId=CHANNEL id, userId=SENDER id,
  // and guildId (null for a DM) — exactly what discord-inbound.js threads onto the lane.
  const dturn = async (channelId, guildId, outcome) => {
    outcomes.push(outcome);
    lane.runTurn({ source: 'discord', channelKind: 'discord', channelId, userId: DISCORD_OWNER, guildId, senderRole: 'owner' }, { content: 'gate discord message' });
    await lane.idle();
    await settle();
  };
  await turn(OWNER, OK); // reset the shared episode latch before the Discord cases
  const dcBefore = dcSends.length;
  await dturn(DC_GUILD_CHAN, DC_GUILD_ID, AUTH); // owner in a GUILD channel → must suppress
  check('N5c-1. Discord auth outage in a GUILD channel (owner sender) → ZERO Discord sends (suppressed)',
    dcSends.length === dcBefore, `dcSends=${dcSends.length - dcBefore}`);
  await dturn(DC_DM_CHAN, null, AUTH); // owner in a DM → exactly one notice
  check('N5c-2. Discord auth outage in a DM (owner sender) → exactly ONE Discord send, static text, to the DM channel',
    dcSends.length === dcBefore + 1 && dcSends[dcSends.length - 1].content === AUTH_NOTICE_TEXT && String(dcSends[dcSends.length - 1].channelId) === DC_DM_CHAN,
    `dcSends=${dcSends.length - dcBefore} chan=${dcSends[dcSends.length - 1]?.channelId}`);

  // N6: the notice send itself failing is fail-soft — the lane keeps running.
  await turn(OWNER, OK); // reset episode
  tgFail = true;
  await turn(OWNER, AUTH); // notice attempted → Bot API 500 → swallowed
  tgFail = false;
  const before = tgSends.length;
  let laneAlive = false;
  outcomes.push(OK);
  lane.runTurn({ source: 'telegram', channelKind: 'telegram', channelId: OWNER, userId: OWNER, senderRole: 'owner' }, { content: 'still alive?' });
  await lane.idle().then(() => { laneAlive = true; }).catch(() => { laneAlive = false; });
  await settle();
  check('N6. failed notice send is fail-soft — no throw, lane keeps running turns',
    laneAlive && tgSends.length === before, `alive=${laneAlive}`);
} catch (e) {
  check(`fatal: ${e?.stack?.split('\n')[0] || e}`, false);
} finally {
  globalThis.fetch = realFetch;
  try { daemonServer?.close(); } catch { /* */ }
  try { vaultStub.close(); } catch { /* */ }
}

console.log(ledger.join('\n'));
console.log('='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);

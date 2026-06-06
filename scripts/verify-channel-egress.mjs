// verify:channel-egress — Phase 0 of the channel-daemon (packages/channel-daemon).
// Boots the REAL daemon Express app on an ephemeral loopback port with injected
// fakes for the vault + Telegram, and exercises every gate of the egress
// chokepoint + the inbound-context endpoint the `reply` MCP tool reads.
//
// Asserts:
//   - GET /internal/inbound-context/current → 404 empty, 200 when a turn is set
//   - POST /telegram/send fail-closed input gates (text, chatId, trivial)
//   - channel authority is fail-closed (denied → 403 + audit 'denied')
//   - happy path delivers, marks delivered, persists an assistant row
//   - envelope dedup collapses an identical resend (no 2nd Telegram call)
//   - send failure audits delivered=false + httpStatus, returns 5xx
//   - provenance: agent-explicit header (loopback) → 'agent-explicit-via-tool'
//   - cross-channel detection sets crossChannel=1
//   - ZERO-PLAINTEXT: no audit row ever carries the message body
// Pure DI test — no network, no vault boot. PASS/FAIL ledger, exit 1 on any fail.
import crypto from 'node:crypto';
import http from 'node:http';
import { createTelegramChokepoint } from '../packages/channel-daemon/chokepoint.js';
import { createEnvelopeDedup } from '../packages/channel-daemon/dedup.js';
import { createDaemonApp } from '../packages/channel-daemon/server.js';
import { setActiveTurn, getActiveTurn, _resetForTests } from '../packages/channel-daemon/inbound-context.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

/** Build a fresh daemon app + capture buffers + a knob for authority/telegram. */
function makeApp({ authorityAllowed = true, telegram = 'ok' } = {}) {
  const audits = [];
  const sends = [];
  const persists = [];
  const dedup = createEnvelopeDedup();

  async function sendToTelegram(a) {
    sends.push(a);
    if (telegram === 'ok') return { sent: 1, total: 1, httpStatus: 200 };
    const err = new Error('boom'); err.httpStatus = 502; err.partial = false; err.sent = 0;
    throw err;
  }

  const handler = createTelegramChokepoint({
    sendToTelegram,
    recordEgress: (e) => audits.push(e),
    persistOutbound: (a) => persists.push(a),
    checkAuthority: async () => ({ allowed: authorityAllowed, reason: authorityAllowed ? 'registry' : 'not-bound' }),
    dedup,
    getActiveTurn,
    agentId: 'personal-agent',
  });

  const app = createDaemonApp({ telegramSendHandler: handler, getActiveTurn });
  const server = http.createServer(app);
  return { app, server, audits, sends, persists, dedup };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) { return new Promise((r) => server.close(r)); }

async function req(port, method, path, { body, headers } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

const OWNER = '111';
const TEXT = 'Hello from the vault, this is a real reply body.';
const HASH = crypto.createHash('sha256').update(TEXT, 'utf8').digest('hex');

// ── inbound-context endpoint ────────────────────────────────────────────────
{
  _resetForTests();
  const { server } = makeApp();
  const port = await listen(server);

  let r = await req(port, 'GET', '/internal/inbound-context/current');
  rec('C1. inbound-context empty → 404 no-active-turn', r.status === 404 && r.json?.error === 'no-active-turn', `status=${r.status}`);

  setActiveTurn({ source: 'telegram', channelKind: 'telegram', channelId: OWNER, inboundMessageId: '9' });
  r = await req(port, 'GET', '/internal/inbound-context/current');
  rec('C2. inbound-context set → 200 with channelId', r.status === 200 && r.json?.channelId === OWNER, `status=${r.status} ch=${r.json?.channelId}`);
  await close(server);
}

// ── input gates ─────────────────────────────────────────────────────────────
{
  _resetForTests();
  const { server } = makeApp();
  const port = await listen(server);

  let r = await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER } });
  rec('C3. missing text → 400', r.status === 400 && /text required/.test(r.json?.error || ''), `status=${r.status}`);

  r = await req(port, 'POST', '/telegram/send', { body: { text: TEXT } });
  rec('C4. missing chatId → 400 fail-closed routing', r.status === 400 && /chatId required/.test(r.json?.error || ''), `status=${r.status}`);

  r = await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: 'hi.' } });
  rec('C5. trivial content → 200 blocked', r.status === 200 && r.json?.blocked === true, `status=${r.status} blocked=${r.json?.blocked}`);
  await close(server);
}

// ── authority denied ────────────────────────────────────────────────────────
{
  _resetForTests();
  const { server, audits, sends } = makeApp({ authorityAllowed: false });
  const port = await listen(server);

  const r = await req(port, 'POST', '/telegram/send', { body: { chatId: '999', text: TEXT } });
  const a = audits[0] || {};
  rec('C6. authority denied → 403 channel-authority-denied', r.status === 403 && r.json?.error === 'channel-authority-denied', `status=${r.status}`);
  rec('C6b. denied send is audited (decision=denied) + NOT delivered to Telegram',
    a.decision === 'denied' && /channel-authority/.test(a.reason || '') && sends.length === 0,
    `decision=${a.decision} sends=${sends.length}`);
  await close(server);
}

// ── happy path + provenance + persist ───────────────────────────────────────
{
  _resetForTests();
  const { server, audits, sends, persists } = makeApp({ authorityAllowed: true });
  const port = await listen(server);

  const r = await req(port, 'POST', '/telegram/send', {
    headers: { 'x-egress-provenance': 'agent-explicit' },
    body: { chatId: OWNER, text: TEXT },
  });
  const a = audits[0] || {};
  rec('C7. happy path → 200 delivered', r.status === 200 && r.json?.delivered === true, `status=${r.status}`);
  rec('C7b. Telegram received the exact chatId + text', sends.length === 1 && String(sends[0].chatId) === OWNER && sends[0].text === TEXT, `sends=${sends.length}`);
  rec('C7c. audit allowed + delivered=true + provenance agent-explicit-via-tool',
    a.decision === 'allowed' && a.delivered === true && a.provenanceKind === 'agent-explicit-via-tool',
    `decision=${a.decision} delivered=${a.delivered} prov=${a.provenanceKind}`);
  rec('C7d. audit carries sha256 hash + length (not body)', a.contentHash === HASH && a.contentLength === TEXT.length, `hash=${String(a.contentHash).slice(0, 12)}…`);
  rec('C7e. outbound persisted as assistant/telegram row', persists.length === 1 && persists[0].role === 'assistant' && persists[0].source === 'telegram' && persists[0].content === TEXT, `persists=${persists.length} role=${persists[0]?.role}`);

  // dedup: identical resend collapses, no 2nd Telegram call
  const r2 = await req(port, 'POST', '/telegram/send', { headers: { 'x-egress-provenance': 'agent-explicit' }, body: { chatId: OWNER, text: TEXT } });
  rec('C8. identical resend → 200 deduped, no 2nd Telegram send', r2.status === 200 && r2.json?.deduped === true && sends.length === 1, `deduped=${r2.json?.deduped} sends=${sends.length}`);
  rec('C8b. dedup audited reason=envelope-dedup', (audits[1] || {}).reason === 'envelope-dedup', `reason=${audits[1]?.reason}`);
  await close(server);
}

// ── provenance: plain curl (no header) ──────────────────────────────────────
{
  _resetForTests();
  const { server, audits } = makeApp({ authorityAllowed: true });
  const port = await listen(server);
  await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: TEXT } });
  rec('C9. no provenance header → agent-explicit-via-curl', (audits[0] || {}).provenanceKind === 'agent-explicit-via-curl', `prov=${audits[0]?.provenanceKind}`);
  await close(server);
}

// ── send failure ────────────────────────────────────────────────────────────
{
  _resetForTests();
  const { server, audits } = makeApp({ authorityAllowed: true, telegram: 'fail' });
  const port = await listen(server);
  const r = await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: TEXT } });
  const a = audits[0] || {};
  rec('C10. Telegram failure → 5xx send-failed', r.status >= 500 && r.json?.error === 'send-failed', `status=${r.status}`);
  rec('C10b. failure audited delivered=false + httpStatus', a.delivered === false && a.httpStatus === 502 && /apicall-failed/.test(a.reason || ''), `delivered=${a.delivered} http=${a.httpStatus}`);
  await close(server);
}

// ── cross-channel ───────────────────────────────────────────────────────────
{
  _resetForTests();
  const { server, audits } = makeApp({ authorityAllowed: true });
  const port = await listen(server);
  setActiveTurn({ source: 'telegram', channelKind: 'telegram', channelId: OWNER }); // inbound = OWNER
  await req(port, 'POST', '/telegram/send', { body: { chatId: '222', text: TEXT, crossChannelReason: 'proactive note' } }); // target ≠ inbound
  const a = audits[0] || {};
  rec('C11. send to a different chat than inbound → crossChannel=1', a.crossChannel === true && a.crossChannelReason === 'proactive note', `xchan=${a.crossChannel}`);
  await close(server);
}

// ── zero-plaintext sweep across every audit entry produced above ────────────
{
  _resetForTests();
  const { server, audits } = makeApp({ authorityAllowed: true });
  const port = await listen(server);
  await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: TEXT } });
  const leak = audits.some((e) => JSON.stringify(e).includes(TEXT));
  rec('C12. ZERO-PLAINTEXT — no audit entry contains the message body', !leak, leak ? 'LEAK DETECTED' : 'clean');
  await close(server);
}

const passed = ledger.filter(Boolean).length;
const failed = ledger.length - passed;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (failed > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO');

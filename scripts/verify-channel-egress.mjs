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
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
import http from 'node:http';
import { createTelegramChokepoint } from '../packages/channel-daemon/chokepoint.js';
import { createEnvelopeDedup } from '../packages/channel-daemon/dedup.js';
import { createRateLimiter } from '../packages/channel-daemon/ratelimit.js';
import { createDaemonApp } from '../packages/channel-daemon/server.js';
import { setActiveTurn, getActiveTurn, _resetForTests } from '../packages/channel-daemon/inbound-context.js';
import { markdownToTelegramHtml, chunkMarkdown, normalizeThreadId } from '../packages/channel-daemon/telegram-format.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

/** Build a fresh daemon app + capture buffers + a knob for authority/telegram. */
function makeApp({ authorityAllowed = true, telegram = 'ok', rateLimit = null, voicePipeline = null, trustedToken = null, voiceReplyDefault = null, voiceNoticeThrottleMs } = {}) {
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
    rateLimit,
    voicePipeline,
    getActiveTurn,
    agentId: 'personal-agent',
    trustedToken,
    voiceReplyDefault,
    ...(voiceNoticeThrottleMs != null ? { voiceNoticeThrottleMs } : {}),
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

// ── model-in-history: `model` rides to persist(), NEVER to the external send ─
// The reply tool carries WHICH model produced the reply so the daemon can record it
// on the persisted message. Security-critical: the model name must NEVER reach the
// external Telegram payload (adapter.send). It goes ONLY to persistOutbound.
{
  _resetForTests();
  const { server, sends, persists } = makeApp({ authorityAllowed: true });
  const port = await listen(server);
  const MODEL = 'claude-opus-4-8';
  const MTEXT = 'A distinctly different reply body for the model test.';
  const r = await req(port, 'POST', '/telegram/send', {
    headers: { 'x-egress-provenance': 'agent-explicit' },
    body: { chatId: OWNER, text: MTEXT, model: MODEL },
  });
  rec('C7f. send with model → 200 delivered', r.status === 200 && r.json?.delivered === true, `status=${r.status}`);
  rec('C7g. persisted row carries model', persists.some((p) => p.content === MTEXT && p.model === MODEL), `models=${JSON.stringify(persists.map((p) => p.model))}`);
  const extSend = sends.find((s) => s.text === MTEXT) || {};
  rec('C7h. SECURITY: model NOT in external Telegram payload', !('model' in extSend), `sendKeys=${Object.keys(extSend).join(',')}`);
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

// ── rate limit (Phase 3) — fixed-window per-target cap ──────────────────────
{
  _resetForTests();
  const { server, audits, sends } = makeApp({ authorityAllowed: true, rateLimit: createRateLimiter({ maxPerWindow: 2, windowMs: 60_000 }) });
  const port = await listen(server);
  // 3 DISTINCT bodies (so envelope-dedup doesn't collapse them) to one target.
  const r1 = await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: `${TEXT} one` } });
  const r2 = await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: `${TEXT} two` } });
  const r3 = await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: `${TEXT} three` } });
  rec('C13. first two sends allowed (within window cap)', r1.json?.delivered === true && r2.json?.delivered === true && sends.length === 2, `sends=${sends.length}`);
  rec('C14. third send → 429 rate-limited (not delivered)', r3.status === 429 && r3.json?.error === 'rate-limited' && sends.length === 2, `status=${r3.status} sends=${sends.length}`);
  rec('C15. rate-limited send audited decision=denied reason=rate-limited', (audits[audits.length - 1] || {}).decision === 'denied' && (audits[audits.length - 1] || {}).reason === 'rate-limited');
  await close(server);
}

// ── voice (TTS) wiring — runs after text, fail-soft ─────────────────────────
{
  _resetForTests();
  const calls = [];
  const voicePipeline = { deliver: async (a) => { calls.push(a); return { voiceSent: 1, voiceTotal: 1 }; } };
  const { server, sends } = makeApp({ authorityAllowed: true, voicePipeline });
  const port = await listen(server);
  const r = await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: TEXT, voice: true } });
  rec('C16. voice:true → text sent + voice pipeline invoked with same text', r.json?.delivered === true && sends.length === 1 && calls.length === 1 && calls[0].text === TEXT && r.json?.voiceSent === 1, `voiceSent=${r.json?.voiceSent}`);
  await close(server);
}
{
  _resetForTests();
  const calls = [];
  const { server } = makeApp({ authorityAllowed: true, voicePipeline: { deliver: async (a) => { calls.push(a); return { voiceSent: 0 }; } } });
  const port = await listen(server);
  const r = await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: TEXT, voice: false } });
  rec('C17. voice:false → voice pipeline NOT invoked', r.json?.delivered === true && calls.length === 0);
  await close(server);
}
{
  _resetForTests();
  const { server, sends } = makeApp({ authorityAllowed: true, voicePipeline: { deliver: async () => { throw new Error('tts boom'); } } });
  const port = await listen(server);
  const r = await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: TEXT, voice: true } });
  // Fail-soft, but NEVER silent: the text still lands, AND the owner is told voice
  // failed (a second send through this same chokepoint) — see the V-block below.
  rec('C18. voice failure is fail-soft (text still 200 delivered) + honestly notified',
    r.status === 200 && r.json?.delivered === true && sends[0]?.text === TEXT
    && r.json?.voiceError === 'render-failed' && sends.length === 2 && /voice reply unavailable/i.test(sends[1]?.text || ''),
    `status=${r.status} sends=${sends.length} err=${r.json?.voiceError}`);
  await close(server);
}

// ── H2: `trusted` is a token-gated capability, not a self-assertable body flag ─
{
  _resetForTests();
  const TOKEN = 'a'.repeat(64);
  const { server, sends, audits } = makeApp({ authorityAllowed: false, trustedToken: TOKEN });
  const port = await listen(server);

  // body trusted:true WITHOUT the secret header → ignored → full authority gate → 403.
  let r = await req(port, 'POST', '/telegram/send', { body: { chatId: '999', text: TEXT, trusted: true } });
  rec('C19. body trusted:true without token is NOT trusted (authority enforced → 403)',
    r.status === 403 && sends.length === 0, `status=${r.status} sends=${sends.length}`);

  // wrong token → still not trusted → 403.
  r = await req(port, 'POST', '/telegram/send', { headers: { 'x-egress-trusted': 'b'.repeat(64) }, body: { chatId: '999', text: TEXT, trusted: true } });
  rec('C20. body trusted:true with WRONG token → still enforced (403)', r.status === 403 && sends.length === 0, `status=${r.status}`);

  // correct token (strict-loopback, no XFF) → trusted → bypasses denied authority → delivered.
  r = await req(port, 'POST', '/telegram/send', { headers: { 'x-egress-trusted': TOKEN }, body: { chatId: '999', text: `${TEXT} trusted`, trusted: true } });
  rec('C21. correct token on loopback → trusted bypass delivers despite denied authority',
    r.status === 200 && r.json?.delivered === true && sends.length === 1, `status=${r.status} sends=${sends.length}`);
  rec('C21b. trusted send audited provenance=system-template', (audits[audits.length - 1] || {}).provenanceKind === 'system-template');

  // correct token but a forwarded (proxied) request → not strict-loopback → enforced.
  r = await req(port, 'POST', '/telegram/send', { headers: { 'x-egress-trusted': TOKEN, 'x-forwarded-for': '203.0.113.9' }, body: { chatId: '999', text: `${TEXT} proxied`, trusted: true } });
  rec('C22. correct token but XFF present (proxied) → not trusted (403)', r.status === 403, `status=${r.status}`);
  await close(server);
}

// ── R2-TGFORMAT: the egress markdown → Telegram HTML converter (pure) ────────
// The converter is the LOAD-BEARING correctness path (the model is never trusted
// to emit valid escaped markup). Assert the constructs + the security escaping.
{
  const html = markdownToTelegramHtml('**b** _i_ `c` [x](https://e.com/a?u=1&v=2)');
  rec('F1. bold/italic/code/link convert to Telegram HTML',
    html === '<b>b</b> <i>i</i> <code>c</code> <a href="https://e.com/a?u=1&amp;v=2">x</a>', html);

  rec('F2. header → <b>, list → bullets, table → row-groups',
    markdownToTelegramHtml('# Hi') === '<b>Hi</b>'
    && markdownToTelegramHtml('- a\n- b') === '• a\n• b'
    && markdownToTelegramHtml('| K | V |\n|---|---|\n| a | 1 |').includes('<b>a</b>'));

  // SECURITY: raw HTML in the reply must be escaped, never emitted as live markup.
  const xss = markdownToTelegramHtml('<script>alert(1)</script> a & b');
  rec('F3. SECURITY — HTML is escaped (no live tags), & escaped',
    xss === '&lt;script&gt;alert(1)&lt;/script&gt; a &amp; b', xss);

  // Code contents are escaped AND not re-parsed as emphasis (fence protects them).
  const code = markdownToTelegramHtml('```\n**x** <y>\n```');
  rec('F4. fenced code: contents escaped, emphasis NOT applied inside',
    code === '<pre>**x** &lt;y&gt;</pre>', code);

  // Chunking: short = 1 chunk; a large body splits under the budget on boundaries.
  const big = 'paragraph.\n\n'.repeat(1000);
  const chunks = chunkMarkdown(big);
  rec('F5. chunkMarkdown splits large bodies under the 4096 cap',
    chunkMarkdown('hi').length === 1 && chunks.length > 1 && chunks.every((c) => c.length <= 4096));

  rec('F6. normalizeThreadId accepts positive ints only',
    normalizeThreadId('42') === 42 && normalizeThreadId(0) === null
    && normalizeThreadId(-1) === null && normalizeThreadId('x') === null && normalizeThreadId(null) === null);
}

// ── R3-TGTHREAD: message_thread_id is carried body/turn → adapter.send ───────
// The forum-topic id must reach the external Bot API body. Two sources: an explicit
// body value, or the active turn's topic (inherited ONLY for the SAME chat).
{
  _resetForTests();
  const { server, sends } = makeApp({ authorityAllowed: true });
  const port = await listen(server);

  // (a) explicit body.messageThreadId → adapter receives it.
  let r = await req(port, 'POST', '/telegram/send', { headers: { 'x-egress-provenance': 'agent-explicit' }, body: { chatId: OWNER, text: TEXT, messageThreadId: 77 } });
  rec('T1. explicit body messageThreadId reaches adapter.send',
    r.json?.delivered === true && sends[sends.length - 1]?.messageThreadId === 77, `thread=${sends[sends.length - 1]?.messageThreadId}`);

  // (b) active turn topic is INHERITED when the reply targets the same chat.
  setActiveTurn({ source: 'telegram', channelKind: 'telegram', channelId: OWNER, messageThreadId: '55' });
  r = await req(port, 'POST', '/telegram/send', { headers: { 'x-egress-provenance': 'agent-explicit' }, body: { chatId: OWNER, text: `${TEXT} topic` } });
  rec('T2. active-turn topic inherited for the SAME chat',
    r.json?.delivered === true && sends[sends.length - 1]?.messageThreadId === 55, `thread=${sends[sends.length - 1]?.messageThreadId}`);

  // (c) a cross-chat send must NOT leak the turn's topic onto another chat.
  r = await req(port, 'POST', '/telegram/send', { headers: { 'x-egress-provenance': 'agent-explicit' }, body: { chatId: '222', text: `${TEXT} elsewhere`, crossChannelReason: 'note' } });
  rec('T3. cross-chat send does NOT inherit the turn topic',
    r.json?.delivered === true && sends[sends.length - 1]?.messageThreadId == null, `thread=${sends[sends.length - 1]?.messageThreadId}`);

  // (d) an invalid/malformed thread id is dropped (never reaches the wire).
  _resetForTests();
  r = await req(port, 'POST', '/telegram/send', { headers: { 'x-egress-provenance': 'agent-explicit' }, body: { chatId: OWNER, text: `${TEXT} bad`, messageThreadId: -9 } });
  rec('T4. malformed messageThreadId is dropped', sends[sends.length - 1]?.messageThreadId == null, `thread=${sends[sends.length - 1]?.messageThreadId}`);
  await close(server);
}

// ── QA6-VOICE: a VOICE-ENABLED channel actually reaches telegram sendVoice ──
// THE regression this gate exists for: before the fix, `voice` could only come
// from the model passing voice:true to the `reply` tool. Nothing told it voice
// was switched on, so send-handler's `if (voice && voicePipeline)` was never
// true and sendVoice was NEVER called — the owner turned voice ON and no voice
// note ever arrived. These checks run the REAL voice pipeline over the REAL TTS
// module (qwen provider → a stubbed loopback render service) into the REAL
// telegram-api sendVoice with an injected fetch, so nothing between the
// chokepoint and the Bot API multipart is faked away.
{
  process.env.TTS_PROVIDER = 'qwen';
  process.env.QWEN_TTS_ENABLED = '1';
  delete process.env.CHANNEL_VOICE_REPLIES;

  // A real 1.5s 24kHz mono s16le WAV — what the vault's voice-render returns.
  function makeWav(seconds = 1.5, rate = 24000) {
    const n = Math.floor(seconds * rate);
    const data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 8000), i * 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
  }

  // Stub the vault's loopback /internal/voice-render (the confinement seam).
  let renderMode = 'ok';
  const renderCalls = [];
  const renderSrv = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => { body += c; });
    rq.on('end', () => {
      renderCalls.push(1);
      if (renderMode === 'down') { rs.writeHead(503, { 'content-type': 'application/json' }); rs.end('{"ok":false,"error":"render-service-unavailable"}'); return; }
      if (renderMode === 'pending') { rs.writeHead(501, { 'content-type': 'application/json' }); rs.end('{"ok":false,"error":"voice-sample-pending"}'); return; }
      const wav = makeWav();
      rs.writeHead(200, { 'content-type': 'audio/wav' });
      rs.end(wav);
    });
  });
  const renderPort = await listen(renderSrv);
  process.env.MYCELIUM_VOICE_RENDER_URL = `http://127.0.0.1:${renderPort}/api/v1/internal/voice-render`;

  const { createVoicePipeline, createVoiceReplyPolicy, resolveVoiceReplyMode } = await import('../packages/channel-daemon/voice-pipeline.js');
  const { createTelegramApi, MAX_VOICE_UPLOAD_BYTES } = await import('../packages/channel-daemon/telegram-api.js');

  // Real telegram-api with an injected fetch: records every Bot API call.
  const tgCalls = [];
  const tgFetch = async (url, init) => {
    tgCalls.push({ url: String(url), body: init?.body });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  const telegramApi = createTelegramApi({ botToken: 'test-token', fetch: tgFetch });
  const realPipeline = () => createVoicePipeline({
    sendVoice: ({ target, filePath, replyToMessageId, messageThreadId }) => telegramApi.sendVoice({ chatId: target, filePath, replyToMessageId, messageThreadId }),
    agentId: 'personal-agent',
  });
  const voiceOf = () => tgCalls.filter((c) => /\/sendVoice$/.test(c.url));

  const VTEXT = 'This is a spoken reply body long enough for the TTS chunker to accept it.';

  // V1 ⭐ THE FIX: voice ON in Settings + a reply with NO explicit voice flag →
  //     the note actually reaches Telegram sendVoice.
  {
    _resetForTests();
    renderMode = 'ok'; tgCalls.length = 0;
    const pipeline = realPipeline();
    const { server, sends } = makeApp({
      voicePipeline: pipeline,
      voiceReplyDefault: createVoiceReplyPolicy({ isEnabled: () => pipeline.isEnabled(), getActiveTurn }),
    });
    const port = await listen(server);
    const r = await req(port, 'POST', '/telegram/send', { headers: { 'x-egress-provenance': 'agent-explicit' }, body: { chatId: OWNER, text: VTEXT } });
    const voiceCalls = voiceOf();
    rec('V1. ⭐ voice-enabled channel + NO body.voice → telegram sendVoice CALLED',
      r.status === 200 && r.json?.delivered === true && sends.length === 1 && voiceCalls.length === 1,
      `sendVoice=${voiceCalls.length} voiceSent=${r.json?.voiceSent}`);
    rec('V1b. sendVoice posts multipart to the Bot API /sendVoice for the right chat',
      voiceCalls.length === 1 && typeof FormData !== 'undefined' && voiceCalls[0].body instanceof FormData
      && String(voiceCalls[0].body.get('chat_id')) === OWNER,
      `chat=${voiceCalls[0]?.body?.get?.('chat_id')}`);
    rec('V1c. response reports the voice note as sent (no voiceError)',
      r.json?.voiceSent === 1 && r.json?.voiceRequested === true && r.json?.voiceError === undefined,
      `voiceSent=${r.json?.voiceSent} err=${r.json?.voiceError}`);
    await close(server);
  }

  // V2: the agent can still suppress voice for ONE reply (explicit false wins).
  {
    _resetForTests();
    renderMode = 'ok'; tgCalls.length = 0;
    const pipeline = realPipeline();
    const { server } = makeApp({ voicePipeline: pipeline, voiceReplyDefault: createVoiceReplyPolicy({ isEnabled: () => pipeline.isEnabled(), getActiveTurn }) });
    const port = await listen(server);
    const r = await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: `${VTEXT} silent`, voice: false } });
    rec('V2. explicit voice:false overrides the ON setting (no sendVoice)',
      r.json?.delivered === true && voiceOf().length === 0, `sendVoice=${voiceOf().length}`);
    await close(server);
  }

  // V3 ⭐ HONESTY: render fails → ZERO voice notes, text still delivered, and the
  //     user is TOLD (a second chokepoint send), never a silent drop.
  {
    _resetForTests();
    renderMode = 'down'; tgCalls.length = 0;
    const pipeline = realPipeline();
    const { server, sends, audits, persists } = makeApp({ voicePipeline: pipeline, voiceReplyDefault: () => true });
    const port = await listen(server);
    const r = await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: `${VTEXT} render-down` } });
    const notice = sends[1]?.text || '';
    rec('V3. ⭐ render failure → text still delivered (200) + zero voice notes',
      r.status === 200 && r.json?.delivered === true && voiceOf().length === 0, `sendVoice=${voiceOf().length}`);
    rec('V3b. ⭐ the user is TOLD voice is unavailable (2nd send through the SAME chokepoint)',
      sends.length === 2 && /voice reply unavailable/i.test(notice), `sends=${sends.length} notice=${notice.slice(0, 40)}`);
    rec('V3c. response carries an honest machine code + notified flag',
      r.json?.voiceError === 'render-service-unavailable' && r.json?.voiceNotified === true, `err=${r.json?.voiceError}`);
    rec('V3d. the notice is audited + persisted (never an unlogged egress)',
      audits.some((a) => /voice-unavailable-notice/.test(a.reason || '')) && persists.some((p) => p.metadata?.origin === 'voice-unavailable-notice'),
      `audits=${audits.map((a) => a.reason).join('|')}`);
    rec('V3e. ZERO-PLAINTEXT — the notice audit carries no message body',
      !audits.some((a) => JSON.stringify(a).includes(VTEXT)));
    await close(server);
  }

  // V4: a permanently broken renderer says it ONCE per window, but every response
  //     still reports voiceError (throttled ≠ silent).
  {
    _resetForTests();
    renderMode = 'down'; tgCalls.length = 0;
    const pipeline = realPipeline();
    const { server, sends } = makeApp({ voicePipeline: pipeline, voiceReplyDefault: () => true, voiceNoticeThrottleMs: 60_000 });
    const port = await listen(server);
    await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: `${VTEXT} one` } });
    const r2 = await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: `${VTEXT} two` } });
    const notices = sends.filter((s) => /voice reply unavailable/i.test(s.text || ''));
    rec('V4. repeated failures → notice throttled to once per window…', notices.length === 1, `notices=${notices.length}`);
    rec('V4b. …but the 2nd response STILL reports voiceError (throttled ≠ silent)',
      r2.json?.voiceError === 'render-service-unavailable' && r2.json?.voiceNotified === false, `err=${r2.json?.voiceError}`);
    await close(server);
  }

  // V5: the policy itself — off / auto / always.
  {
    _resetForTests();
    renderMode = 'ok'; tgCalls.length = 0;
    const pipeline = realPipeline();
    const policy = createVoiceReplyPolicy({ isEnabled: () => pipeline.isEnabled(), getActiveTurn });
    const { server } = makeApp({ voicePipeline: pipeline, voiceReplyDefault: policy });
    const port = await listen(server);

    process.env.CHANNEL_VOICE_REPLIES = 'off';
    await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: `${VTEXT} off` } });
    rec('V5. CHANNEL_VOICE_REPLIES=off → no voice note', voiceOf().length === 0, `sendVoice=${voiceOf().length}`);

    process.env.CHANNEL_VOICE_REPLIES = 'auto';
    setActiveTurn({ source: 'telegram', channelKind: 'telegram', channelId: OWNER, voiceMode: false });
    await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: `${VTEXT} auto-text` } });
    rec('V5b. auto + text inbound → no voice note', voiceOf().length === 0, `sendVoice=${voiceOf().length}`);

    setActiveTurn({ source: 'telegram', channelKind: 'telegram', channelId: OWNER, voiceMode: true });
    await req(port, 'POST', '/telegram/send', { body: { chatId: OWNER, text: `${VTEXT} auto-voice` } });
    rec('V5c. auto + VOICE inbound → voice note sent', voiceOf().length === 1, `sendVoice=${voiceOf().length}`);

    delete process.env.CHANNEL_VOICE_REPLIES;
    rec('V5d. unset mode defaults to always', resolveVoiceReplyMode() === 'always');

    // Fail-closed: TTS switched off ⇒ the policy says no, whatever the mode.
    const offPolicy = createVoiceReplyPolicy({ isEnabled: () => false, getActiveTurn });
    rec('V5e. TTS off ⇒ policy false (fail-closed)', offPolicy() === false);
    await close(server);
  }

  // V5f: a TRUSTED system-template send (command ack / pairing code) is NEVER
  //      auto-voiced by the policy — it would speak a pairing code aloud.
  {
    _resetForTests();
    renderMode = 'ok'; tgCalls.length = 0;
    const TOKEN = 'a'.repeat(64);
    const pipeline = realPipeline();
    const { server } = makeApp({
      authorityAllowed: false, trustedToken: TOKEN,
      voicePipeline: pipeline, voiceReplyDefault: () => true,   // policy says "always"
    });
    const port = await listen(server);
    const r = await req(port, 'POST', '/telegram/send', {
      headers: { 'x-egress-trusted': TOKEN },
      body: { chatId: OWNER, text: `${VTEXT} pairing-code-0000`, trusted: true },
    });
    rec('V5f. trusted command-ack is NOT auto-voiced (policy ignored for system-template)',
      r.json?.delivered === true && voiceOf().length === 0, `sendVoice=${voiceOf().length}`);
    await close(server);
  }

  // V6: OUTBOUND Telegram limit — a too-large note is refused BEFORE the upload,
  //     with a code the pipeline reports honestly (not a burned multi-minute POST).
  {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'voicecap-'));
    const big = path.join(dir, 'big.ogg');
    await writeFile(big, Buffer.alloc(MAX_VOICE_UPLOAD_BYTES + 1));
    tgCalls.length = 0;
    let code = null;
    try { await telegramApi.sendVoice({ chatId: OWNER, filePath: big }); } catch (e) { code = e?.code || null; }
    rec('V6. voice note over the Bot API upload cap → refused with voice-too-large, no upload',
      code === 'voice-too-large' && voiceOf().length === 0, `code=${code} calls=${voiceOf().length}`);
    await rm(dir, { recursive: true, force: true });
  }

  await close(renderSrv);
  delete process.env.MYCELIUM_VOICE_RENDER_URL;
  delete process.env.TTS_PROVIDER;
  delete process.env.QWEN_TTS_ENABLED;
}

const passed = ledger.filter(Boolean).length;
const failed = ledger.length - passed;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (failed > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO');

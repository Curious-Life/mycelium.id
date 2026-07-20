// verify:telegram-format — R2-TGFORMAT + R3-TGTHREAD at the WIRE.
// Boots the REAL telegram-api.js sendMessage with an injected fetch that records
// every Bot API body, and asserts the on-wire request shape:
//   - text sends carry parse_mode:'HTML' with the converted body
//   - a Telegram 400 on the formatted send retries the SAME chunk as PLAIN text
//     (no parse_mode) so the message is never lost
//   - message_thread_id (forum topic) is set on every chunk's body
//   - a body that overflows the 4096 cap chunks into multiple ordered sends
//   - a non-400 error surfaces (httpStatus/partial) exactly as before
// Pure DI — no network. PASS/FAIL ledger, exit 1 on any fail.
import { createTelegramApi } from '../packages/channel-daemon/telegram-api.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

/** A recording fetch. `status(url)` decides the response per call. */
function makeFetch(plan) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : {};
    calls.push({ url: u, body });
    const status = typeof plan === 'function' ? plan(calls.length, body) : 200;
    return new Response(JSON.stringify({ ok: status < 400, result: { message_id: calls.length } }), { status });
  };
  return { fetchImpl, calls };
}

const CHAT = '12345';

// ── parse_mode:'HTML' + converted body ──────────────────────────────────────
{
  const { fetchImpl, calls } = makeFetch(() => 200);
  const api = createTelegramApi({ botToken: 'x', fetch: fetchImpl });
  const res = await api.sendMessage({ chatId: CHAT, text: 'Hello **world** and `code`' });
  rec('W1. text send uses parse_mode HTML + converted body',
    calls.length === 1 && calls[0].body.parse_mode === 'HTML'
    && calls[0].body.text === 'Hello <b>world</b> and <code>code</code>'
    && res.sent === 1, JSON.stringify(calls[0]?.body));
}

// ── 400 on the formatted send → retry the SAME chunk as PLAIN text ───────────
{
  // First call (HTML) → 400; the retry (plain) → 200.
  let htmlSeen = false;
  const { fetchImpl, calls } = makeFetch((n, body) => {
    if (body.parse_mode === 'HTML') { htmlSeen = true; return 400; }
    return 200;
  });
  const api = createTelegramApi({ botToken: 'x', fetch: fetchImpl });
  const res = await api.sendMessage({ chatId: CHAT, text: 'A body with **markup** that Telegram rejects.' });
  const plain = calls.find((c) => c.body.parse_mode == null);
  rec('W2. formatted 400 → retried as PLAIN text (original markdown, no parse_mode)',
    htmlSeen && !!plain && plain.body.text === 'A body with **markup** that Telegram rejects.'
    && res.sent === 1, `calls=${calls.length}`);
  rec('W2b. the plain retry is NOT counted as a second delivered message',
    res.sent === 1 && res.total === 1, `sent=${res.sent}`);
}

// ── message_thread_id on the wire body ──────────────────────────────────────
{
  const { fetchImpl, calls } = makeFetch(() => 200);
  const api = createTelegramApi({ botToken: 'x', fetch: fetchImpl });
  await api.sendMessage({ chatId: CHAT, text: 'Reply in a forum topic.', messageThreadId: 909 });
  rec('W3. message_thread_id set on the Bot API body', calls[0].body.message_thread_id === 909, JSON.stringify(calls[0]?.body));

  // malformed thread id → dropped
  const { fetchImpl: f2, calls: c2 } = makeFetch(() => 200);
  const api2 = createTelegramApi({ botToken: 'x', fetch: f2 });
  await api2.sendMessage({ chatId: CHAT, text: 'No topic here please.', messageThreadId: 'nope' });
  rec('W3b. malformed messageThreadId absent from the body', !('message_thread_id' in c2[0].body));
}

// ── chunking a >4096 body into ordered sends, each formatted + threaded ──────
{
  const { fetchImpl, calls } = makeFetch(() => 200);
  const api = createTelegramApi({ botToken: 'x', fetch: fetchImpl });
  const big = 'This is one paragraph of text.\n\n'.repeat(400); // ~12.8k chars
  const res = await api.sendMessage({ chatId: CHAT, text: big, messageThreadId: 5, replyToMessageId: 42 });
  rec('W4. large body splits into multiple sends, each under the cap',
    res.total > 1 && calls.length === res.total && calls.every((c) => c.body.text.length <= 4096), `chunks=${calls.length}`);
  rec('W4b. every chunk carries the topic; reply_parameters ONLY on the first',
    calls.every((c) => c.body.message_thread_id === 5)
    && calls[0].body.reply_parameters?.message_id === 42
    && calls.slice(1).every((c) => c.body.reply_parameters == null), 'ok');
}

// ── a non-400 failure surfaces (unchanged error contract) ───────────────────
{
  const { fetchImpl } = makeFetch(() => 502);
  const api = createTelegramApi({ botToken: 'x', fetch: fetchImpl });
  let threw = null;
  try { await api.sendMessage({ chatId: CHAT, text: 'This should fail to send.' }); }
  catch (e) { threw = e; }
  rec('W5. a 502 (not 400) throws with httpStatus preserved', threw && threw.httpStatus === 502, `http=${threw?.httpStatus}`);
}

const passed = ledger.filter(Boolean).length;
const failed = ledger.length - passed;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (failed > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO');

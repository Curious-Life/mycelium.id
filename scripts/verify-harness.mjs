// verify:harness — the provider-agnostic tool-use loop (src/agent/harness.js),
// driven against STUBBED provider streams (no live key). Covers both adapters,
// the tool loop, the no-tool fallback, the maxIterations cap, tool-error
// recovery, egress audit (hash+len only), and abort.
//   H1 Anthropic: text → tool_use → tool result fed back → final text (end_turn)
//   H2 OpenAI: streamed tool_calls deltas → tool result → final text (stop)
//   H3 no-tool model: provider errors on `tools` → retry text-only → answer
//   H4 maxIterations cap: always-tool provider → capped + final pass + logged
//   H5 tool handler throws → tool_error event + is_error fed back; loop continues
//   H6 egress audited per model call (sha256 hash + length, NEVER the plaintext)
//   H7 abort signal → loop stops early
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { createAgentHarness } from '../src/agent/harness.js';
import { webSearchEnabled } from '../src/agent/web-search.js';

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const enc = new TextEncoder();
const streamRes = (chunks) => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } }) });
const errRes = (status) => ({ ok: false, status, async text() { return '{"error":{"type":"invalid_request_error"}}'; } });
const sse = (objs) => objs.map((o) => (o === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(o)}\n\n`));

// Canned Anthropic passes
const aTool = sse([
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Searching. ' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'searchMindscape' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
  '[DONE]',
]);
const aFinal = sse([
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Found it.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  '[DONE]',
]);
// Canned OpenAI passes
const oTool = sse([
  { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'getContext', arguments: '' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"recentMessages":5}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { usage: { prompt_tokens: 12, completion_tokens: 4 }, choices: [] },
  '[DONE]',
]);
const oFinal = sse([
  { choices: [{ index: 0, delta: { content: 'Here you go.' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { usage: { prompt_tokens: 20, completion_tokens: 3 }, choices: [] },
  '[DONE]',
]);

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const TOOLS = [{ name: 'searchMindscape', description: 's', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }, { name: 'getContext', description: 'c', inputSchema: { type: 'object', properties: {} } }];

// ── H1 Anthropic tool loop ──
{
  const egress = []; let calledWith = null;
  const queue = [streamRes(aTool), streamRes(aFinal)];
  const fetch = async () => queue.shift();
  const events = [];
  const h = createAgentHarness({ onEgress: (e) => egress.push(e), fetch });
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K', jurisdiction: 'us-standard' }, system: 'SYS', userMessage: 'hi', tools: TOOLS, call: async (n, a) => { calledWith = { n, a }; return 'RESULT'; }, send: (e) => events.push(e) });
  const types = events.map((e) => e.type);
  const text = events.filter((e) => e.type === 'text_delta').map((e) => e.content).join('');
  rec('H1 tool called with parsed args', calledWith?.n === 'searchMindscape' && calledWith?.a?.query === 'x', JSON.stringify(calledWith));
  rec('H1 event order: tool_start before tool_complete; both present', types.includes('tool_start') && types.indexOf('tool_start') < types.indexOf('tool_complete'));
  rec('H1 streamed text across both passes', text === 'Searching. Found it.', JSON.stringify(text));
  rec('H1 toolsUsed recorded', r.toolsUsed.join(',') === 'searchMindscape');
  rec('H1 usage emitted (no fabrication)', events.some((e) => e.type === 'usage' && e.outputTokens === 3));
  rec('H1 done not capped', r.capped !== true);
}

// ── H2 OpenAI tool loop ──
{
  let calledWith = null;
  const queue = [streamRes(oTool), streamRes(oFinal)];
  const fetch = async (url, opts) => { const b = JSON.parse(opts.body); if (!b.messages?.some((m) => m.role === 'system')) throw new Error('system missing'); return queue.shift(); };
  const events = [];
  const h = createAgentHarness({ fetch });
  const r = await h.streamTurn({ provider: { openaiApiKey: 'K', baseUrl: 'https://api.openai.com/v1', jurisdiction: 'us-standard' }, system: 'SYS', userMessage: 'hi', tools: TOOLS, call: async (n, a) => { calledWith = { n, a }; return 'CTX'; }, send: (e) => events.push(e) });
  rec('H2 tool_calls assembled across deltas', calledWith?.n === 'getContext' && calledWith?.a?.recentMessages === 5, JSON.stringify(calledWith));
  rec('H2 final text streamed', events.filter((e) => e.type === 'text_delta').map((e) => e.content).join('') === 'Here you go.');
  rec('H2 usage from include_usage chunk', events.some((e) => e.type === 'usage' && e.inputTokens === 20));
  rec('H2 toolsUsed', r.toolsUsed.join(',') === 'getContext');
}

// ── H3 no-tool model: errors when tools present, retry text-only ──
// (A CLOUD OpenAI-compatible model that rejects the `tools` param. Local chat is
// now tool-free by construction — the native /api/chat adapter never sends tools —
// so this fallback applies to the cloud openai path; see verify:harness-local L10.)
{
  const queue = [errRes(400), streamRes(oFinal)];
  const fetch = async (url, opts) => { const b = JSON.parse(opts.body); if (b.tools) return queue.shift(); /* first call has tools → err */ return queue.shift(); };
  const events = []; let logged = '';
  const h = createAgentHarness({ fetch, logger: (m) => { logged += m; } });
  const r = await h.streamTurn({ provider: { openaiApiKey: 'K', jurisdiction: 'us-standard' }, system: 'SYS', userMessage: 'hi', tools: TOOLS, call: async () => 'X', send: (e) => events.push(e) });
  rec('H3 fell back to text-only (no tool events)', !events.some((e) => e.type === 'tool_start') && events.some((e) => e.type === 'text_delta'), JSON.stringify(events.map((e) => e.type)));
  rec('H3 fallback logged', /falling back to text-only/.test(logged));
  rec('H3 returned an answer', events.filter((e) => e.type === 'text_delta').map((e) => e.content).join('') === 'Here you go.');
}

// ── H4 maxIterations cap ──
{
  // Provider always returns a tool_use (with DISTINCT args each iter so the repeated-call
  // circuit breaker (Step 7b) doesn't trip first — this isolates the maxIterations cap).
  let calls = 0;
  const aToolQ = (q) => sse([
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'searchMindscape' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query: q }) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    '[DONE]',
  ]);
  const fetch = async () => { calls += 1; return streamRes(calls <= 3 ? aToolQ(`q${calls}`) : aFinal); };
  const events = []; let logged = '';
  const h = createAgentHarness({ fetch, logger: (m) => { logged += m; } });
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: TOOLS, call: async () => 'R', send: (e) => events.push(e), maxIterations: 3 });
  rec('H4 capped flag set', r.capped === true, `calls=${calls}`);
  rec('H4 cap logged (no silent truncation)', /maxIterations=3/.test(logged));
  rec('H4 final answer pass ran (4 model calls = 3 iters + final)', calls === 4);
}

// ── H5 tool handler throws ──
{
  const queue = [streamRes(aTool), streamRes(aFinal)];
  const fetch = async () => queue.shift();
  const events = [];
  const h = createAgentHarness({ fetch });
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: TOOLS, call: async () => { throw new Error('SECRET PLAINTEXT'); }, send: (e) => events.push(e) });
  rec('H5 tool_error emitted', events.some((e) => e.type === 'tool_error'));
  rec('H5 loop recovered to a final answer', events.some((e) => e.type === 'text_delta' && e.content === 'Found it.'));
  rec('H5 err.message never surfaced to events', !JSON.stringify(events).includes('SECRET PLAINTEXT'));
}

// ── H6 egress audited per model call, hash+len only ──
{
  const egress = [];
  const queue = [streamRes(aTool), streamRes(aFinal)];
  const fetch = async () => queue.shift();
  const h = createAgentHarness({ onEgress: (e) => egress.push(e), fetch });
  await h.streamTurn({ provider: { anthropicApiKey: 'K', jurisdiction: 'us-standard' }, system: 'S', userMessage: 'SENSITIVE-XYZ', tools: TOOLS, call: async () => 'R', send: () => {} });
  rec('H6 egress fired per model call (2)', egress.length === 2, `n=${egress.length}`);
  rec('H6 audit carries hash + length, never plaintext', egress.every((e) => /^[0-9a-f]{64}$/.test(e.contentHash) && typeof e.contentLength === 'number' && !JSON.stringify(e).includes('SENSITIVE-XYZ')));
  rec('H6 audit tags provider + jurisdiction', egress.every((e) => e.provider === 'anthropic' && e.jurisdiction === 'us-standard' && e.decision === 'allowed'));
}

// ── H7 abort ──
{
  const queue = [streamRes(aTool), streamRes(aFinal)];
  const fetch = async () => queue.shift();
  const ctrl = new AbortController();
  const events = [];
  const h = createAgentHarness({ fetch });
  // Abort as soon as the first tool starts.
  const send = (e) => { events.push(e); if (e.type === 'tool_start') ctrl.abort(); };
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: TOOLS, call: async () => 'R', send, signal: ctrl.signal });
  rec('H7 aborted flag set, loop stopped', r.aborted === true);
  rec('H7 no second-pass text after abort', !events.some((e) => e.type === 'text_delta' && e.content === 'Found it.'));
}

// ── H8 Anthropic truncation on a TEXT turn (stop_reason 'max_tokens') ──
// The output cap was hit mid-answer. The harness must REPORT truncation (not
// swallow it as a clean stop) and keep the partial text already streamed.
{
  const aTruncText = sse([
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'This answer was cut o' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } },
    '[DONE]',
  ]);
  const fetch = async () => streamRes(aTruncText);
  const events = []; let logged = '';
  const h = createAgentHarness({ fetch, logger: (m) => { logged += m; } });
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: TOOLS, call: async () => 'R', send: (e) => events.push(e) });
  rec('H8 Anthropic max_tokens → truncated reported (not swallowed)', r.truncated === true, JSON.stringify(r));
  rec('H8 partial text preserved', events.filter((e) => e.type === 'text_delta').map((e) => e.content).join('') === 'This answer was cut o');
  rec('H8 truncation logged (no silent swallow)', /output cap|truncat/i.test(logged), logged);
}

// ── H9 Anthropic truncation on a TOOL-CALL turn (the silent-no-op bug) ──
// The model was emitting writeMindFileWhole({content}) when the cap hit, so the
// tool-call JSON is cut mid-string → parses to {} → a silent no-op write. The
// harness must NOT execute that broken call, and must report truncated.
{
  const aTruncTool = sse([
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_x', name: 'writeMindFileWhole' } },
    // Partial, INVALID JSON — the content string is cut off (no closing quote/brace).
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"notes.md","content":"a very long note that got cut o' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4096 } },
    '[DONE]',
  ]);
  const fetch = async () => streamRes(aTruncTool);
  const events = []; let toolCalled = false;
  const h = createAgentHarness({ fetch });
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'save this', tools: TOOLS, call: async () => { toolCalled = true; return 'R'; }, send: (e) => events.push(e) });
  rec('H9 truncated tool-call → tool NOT executed (no silent no-op write)', toolCalled === false && r.truncated === true, `toolCalled=${toolCalled} ${JSON.stringify(r)}`);
  rec('H9 no tool_start emitted for the broken call', !events.some((e) => e.type === 'tool_start'), JSON.stringify(events.map((e) => e.type)));
  rec('H9 not reported as capped/clean completion', r.capped !== true);
}

// ── H10 OpenAI truncation (finish_reason 'length') ──
{
  const oTrunc = sse([
    { choices: [{ index: 0, delta: { content: 'partial reply' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
    { usage: { prompt_tokens: 12, completion_tokens: 4096 }, choices: [] },
    '[DONE]',
  ]);
  const fetch = async () => streamRes(oTrunc);
  const events = [];
  const h = createAgentHarness({ fetch });
  const r = await h.streamTurn({ provider: { openaiApiKey: 'K', baseUrl: 'https://api.openai.com/v1' }, system: 'S', userMessage: 'hi', tools: TOOLS, call: async () => 'R', send: (e) => events.push(e) });
  rec('H10 OpenAI finish_reason length → truncated reported', r.truncated === true, JSON.stringify(r));
  rec('H10 partial text preserved', events.filter((e) => e.type === 'text_delta').map((e) => e.content).join('') === 'partial reply');
}

// ── H11 Ollama native truncation (done_reason 'length') ──
// Local chat is tool-free, but a cut-off reply must still be reported, not read
// as a clean stop (the native adapter previously hardcoded stopReason 'stop').
{
  const ndjson = (objs) => objs.map((o) => JSON.stringify(o) + '\n');
  const oll = ndjson([
    { message: { role: 'assistant', content: 'partial ' }, done: false },
    { message: { role: 'assistant', content: 'local answer' }, done: false },
    { message: { role: 'assistant', content: '' }, done: true, done_reason: 'length', prompt_eval_count: 50, eval_count: 4096 },
  ]);
  const fetch = async () => streamRes(oll);
  const events = [];
  const h = createAgentHarness({ fetch });
  const r = await h.streamTurn({ provider: { jurisdiction: 'local' }, system: 'S', userMessage: 'hi', tools: [], call: async () => 'R', send: (e) => events.push(e) });
  rec('H11 Ollama done_reason length → truncated reported', r.truncated === true, JSON.stringify(r));
  rec('H11 partial text preserved', events.filter((e) => e.type === 'text_delta').map((e) => e.content).join('') === 'partial local answer');
}

// ── H12 a CLEAN stop is NOT mis-flagged as truncated (no false positives) ──
{
  const queue = [streamRes(aFinal)];
  const fetch = async () => queue.shift();
  const h = createAgentHarness({ fetch });
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: [], call: async () => 'R', send: () => {} });
  rec('H12 end_turn → truncated falsy (no false positive)', !r.truncated, JSON.stringify(r));
}

// ── H13 owner web access: Anthropic server-side web_search injected ONLY when enabled ──
// Owner-only capability (web-search.js). Anthropic runs it server-side; we just append the
// tool. Non-Anthropic providers must NOT get it (their adapter ignores the flag).
{
  const bodyOf = async (provider, webSearch) => {
    let captured = null;
    const fetch = async (_url, opts) => { captured = JSON.parse(opts.body); return streamRes(aFinal); };
    const h = createAgentHarness({ fetch });
    await h.streamTurn({ provider, system: 'S', userMessage: 'hi', tools: TOOLS, call: async () => 'R', send: () => {}, webSearch });
    return captured;
  };
  const hasWeb = (b) => Array.isArray(b?.tools) && b.tools.some((t) => t?.type === 'web_search_20250305' && t?.name === 'web_search');
  const anthOn = await bodyOf({ anthropicApiKey: 'K' }, true);
  rec('H13 web_search injected on Anthropic when enabled', hasWeb(anthOn));
  rec('H13 our vault tools still present alongside web_search', anthOn.tools.some((t) => t.name === 'searchMindscape'));
  const anthOff = await bodyOf({ anthropicApiKey: 'K' }, false);
  rec('H13 NOT injected when webSearch off', !hasWeb(anthOff));
  const oai = await bodyOf({ openaiApiKey: 'K', baseUrl: 'https://api.openai.com/v1' }, true);
  rec('H13 NOT injected on a non-Anthropic provider even when enabled', !hasWeb(oai));
}

// ── H16 full web access: web_FETCH injected alongside search + its beta header, only when on ──
{
  const capture = async (provider, webSearch) => {
    let body = null, headers = null;
    const fetch = async (_url, opts) => { body = JSON.parse(opts.body); headers = opts.headers || {}; return streamRes(aFinal); };
    const h = createAgentHarness({ fetch });
    await h.streamTurn({ provider, system: 'S', userMessage: 'hi', tools: TOOLS, call: async () => 'R', send: () => {}, webSearch });
    return { body, headers };
  };
  const hasFetch = (b) => Array.isArray(b?.tools) && b.tools.some((t) => t?.type === 'web_fetch_20250910' && t?.name === 'web_fetch');
  const on = await capture({ anthropicApiKey: 'K' }, true);
  rec('H16 web_fetch injected on Anthropic when web access on', hasFetch(on.body));
  rec('H16 web-fetch beta header set when web access on', /web-fetch-2025-09-10/.test(on.headers['anthropic-beta'] || ''));
  const off = await capture({ anthropicApiKey: 'K' }, false);
  rec('H16 web_fetch NOT injected when off', !hasFetch(off.body));
  rec('H16 NO web-fetch beta header when off', !/web-fetch-2025-09-10/.test(off.headers['anthropic-beta'] || ''));
  const oai = await capture({ openaiApiKey: 'K', baseUrl: 'https://api.openai.com/v1' }, true);
  rec('H16 web_fetch NOT injected on non-Anthropic', !hasFetch(oai.body));
}

// ── H14 webSearchEnabled gate: default ON, explicit false OFF, env kill-switch wins ──
{
  delete process.env.MYCELIUM_WEB_SEARCH;
  rec('H14 default (no setting) → enabled', webSearchEnabled(undefined) === true && webSearchEnabled({}) === true);
  rec('H14 explicit webSearch:false → disabled', webSearchEnabled({ webSearch: false }) === false);
  rec('H14 webSearch:true → enabled', webSearchEnabled({ webSearch: true }) === true);
  process.env.MYCELIUM_WEB_SEARCH = '0';
  rec('H14 env kill-switch overrides even an on setting', webSearchEnabled({ webSearch: true }) === false);
  delete process.env.MYCELIUM_WEB_SEARCH;
}

// ── H15 web_search is BEST-EFFORT: a provider that rejects it must NOT break the turn ──
// (default-on web_search would otherwise 400 every owner chat on a path that doesn't support
// the server tool). On rejection: drop web_search, retry WITH client tools, succeed.
{
  const sawWeb = [];
  const fetch = async (_url, opts) => {
    const b = JSON.parse(opts.body);
    const hasWeb = Array.isArray(b.tools) && b.tools.some((t) => t?.type === 'web_search_20250305');
    sawWeb.push(hasWeb);
    if (hasWeb) return errRes(400);         // provider rejects the request carrying web_search
    return streamRes(aFinal);               // …but the same turn WITHOUT web_search is fine
  };
  const parts = [];
  const h = createAgentHarness({ fetch });
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: TOOLS, call: async () => 'R', send: (e) => { if (e.type === 'text_delta') parts.push(e.content); }, webSearch: true });
  rec('H15 web_search rejection → turn still succeeds (not broken)', parts.join('') === 'Found it.' && !r.truncated && !r.aborted, JSON.stringify({ text: parts.join(''), r }));
  rec('H15 first call carried web_search, retry dropped it (kept tools)', sawWeb[0] === true && sawWeb[1] === false, JSON.stringify(sawWeb));
}

// ── H17 channel reply-delivery finalizer: a TEXT answer forces a reply pass (the no-reply fix) ──
// A channel turn delivers ONLY via the reply tool; a free-form text answer is discarded. When
// requireTool='reply' and the model ends with text, streamTurn makes ONE forced pass with
// tool_choice PINNED to reply so the model explicitly delivers through the egress chokepoint.
{
  const REPLY_TOOLS = [...TOOLS, { name: 'reply', description: 'send', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }];
  const aTextOnly = sse([
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Here is my answer.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    '[DONE]',
  ]);
  const aReplyForced = sse([
    { type: 'message_start', message: { usage: { input_tokens: 12 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_r', name: 'reply' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"text":"Here is my answer."}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } },
    '[DONE]',
  ]);
  const bodies = []; let replyArgs = null;
  const queue = [streamRes(aTextOnly), streamRes(aReplyForced)];
  const fetch = async (_url, opts) => { bodies.push(JSON.parse(opts.body)); return queue.shift(); };
  const events = [];
  const h = createAgentHarness({ fetch });
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: REPLY_TOOLS, call: async (n, a) => { if (n === 'reply') replyArgs = a; return 'OK'; }, send: (e) => events.push(e), requireTool: 'reply' });
  rec('H17 forced second pass made (finalizer fired on a text answer)', bodies.length === 2, `calls=${bodies.length}`);
  rec('H17 first pass used auto tool_choice (unchanged)', bodies[0]?.tool_choice?.type === 'auto');
  rec('H17 second pass PINS tool_choice to reply', bodies[1]?.tool_choice?.type === 'tool' && bodies[1]?.tool_choice?.name === 'reply', JSON.stringify(bodies[1]?.tool_choice));
  rec('H17 forced pass ends on a user nudge turn (clean forced-call shape)', bodies[1]?.messages?.[bodies[1].messages.length - 1]?.role === 'user');
  rec('H17 reply tool executed with the model-composed args', replyArgs?.text === 'Here is my answer.', JSON.stringify(replyArgs));
  rec('H17 toolsUsed records reply (delivered)', r.toolsUsed.includes('reply'));
  rec('H17 tool_start/complete emitted for the forced reply', events.some((e) => e.type === 'tool_start' && e.name === 'reply') && events.some((e) => e.type === 'tool_complete' && e.name === 'reply'));
}

// ── H17b forced tool call with finish_reason 'stop' (NOT 'tool_calls') still delivers ──
// The real-world bug: OpenAI-compat providers return a FORCED tool call with finish_reason
// 'stop', so `isTool` is false — but the reply call is present and must be executed. Gate on
// the tool call's PRESENCE, not the stop reason.
{
  const REPLY_TOOLS = [...TOOLS, { name: 'reply', description: 'send', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }];
  const oTextOnly = sse([
    { choices: [{ index: 0, delta: { content: 'My answer.' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 10, completion_tokens: 3 }, choices: [] },
    '[DONE]',
  ]);
  const oReplyForcedStop = sse([
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_r', type: 'function', function: { name: 'reply', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":"My answer."}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },   // STOP, not tool_calls — the bug
    { usage: { prompt_tokens: 12, completion_tokens: 5 }, choices: [] },
    '[DONE]',
  ]);
  const bodies = []; let replyArgs = null;
  const queue = [streamRes(oTextOnly), streamRes(oReplyForcedStop)];
  const fetch = async (_url, opts) => { bodies.push(JSON.parse(opts.body)); return queue.shift(); };
  const h = createAgentHarness({ fetch });
  const r = await h.streamTurn({ provider: { openaiApiKey: 'K', baseUrl: 'https://api.openai.com/v1' }, system: 'S', userMessage: 'hi', tools: REPLY_TOOLS, call: async (n, a) => { if (n === 'reply') replyArgs = a; return 'OK'; }, send: () => {}, requireTool: 'reply' });
  rec('H17b forced pass pins tool_choice=function reply (OpenAI shape)', bodies[1]?.tool_choice?.type === 'function' && bodies[1]?.tool_choice?.function?.name === 'reply', JSON.stringify(bodies[1]?.tool_choice));
  rec('H17b delivered despite finish_reason=stop (gate on presence, not isTool)', r.toolsUsed.includes('reply') && replyArgs?.text === 'My answer.', JSON.stringify({ used: r.toolsUsed, replyArgs }));
}

// ── H18 no double-send: if the model ALREADY called reply, the finalizer does NOT fire ──
{
  const REPLY_TOOLS = [...TOOLS, { name: 'reply', description: 'send', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }];
  const aReplyDirect = sse([
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_r', name: 'reply' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"text":"direct hi"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    '[DONE]',
  ]);
  let calls = 0, replyCalls = 0;
  const queue = [streamRes(aReplyDirect), streamRes(aFinal)];
  const fetch = async () => { calls += 1; return queue.shift(); };
  const h = createAgentHarness({ fetch });
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: REPLY_TOOLS, call: async (n) => { if (n === 'reply') replyCalls += 1; return 'OK'; }, send: () => {}, requireTool: 'reply' });
  rec('H18 reply called exactly once (no forced double-send)', replyCalls === 1, `replyCalls=${replyCalls}`);
  rec('H18 exactly 2 model calls — no 3rd forced pass after reply', calls === 2, `calls=${calls}`);
  rec('H18 toolsUsed has a single reply', r.toolsUsed.filter((t) => t === 'reply').length === 1);
}

// ── H19 the finalizer is OPT-IN + gated: chat (no requireTool) and un-granted reply never force ──
{
  // (a) chat path: requireTool unset → a text answer just returns, no forced pass.
  let callsA = 0;
  const fetchA = async () => { callsA += 1; return streamRes(aFinal); };
  await createAgentHarness({ fetch: fetchA }).streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: TOOLS, call: async () => 'R', send: () => {} });
  rec('H19a chat (requireTool unset) → no forced pass (1 model call)', callsA === 1, `calls=${callsA}`);
  // (b) requireTool='reply' but reply NOT granted (e.g. a no-tool turn) → guard skips the force.
  let callsB = 0;
  const fetchB = async () => { callsB += 1; return streamRes(aFinal); };
  const rB = await createAgentHarness({ fetch: fetchB }).streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: TOOLS, call: async () => 'R', send: () => {}, requireTool: 'reply' });
  rec('H19b requireTool set but tool NOT granted → guard skips force (1 call)', callsB === 1 && !rB.toolsUsed.includes('reply'), `calls=${callsB}`);
}

// ── H20 circuit-breaker → finalizer: the message stays well-formed (MED-1 regression) ──
// The breaker `break`s the tool loop AFTER pushing the assistant tool_use. Without pushing a
// matching tool_result, the forced reply pass would send a dangling tool_use → Anthropic 400 →
// no delivery on any breaker-tripped channel turn. Assert: breaker trips, message is well-formed
// (every tool_use answered, no plain-string nudge after a tool_use), and the reply IS delivered.
{
  const REPLY_TOOLS = [...TOOLS, { name: 'reply', description: 'send', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }];
  const aToolSame = sse([
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_s', name: 'searchMindscape' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"same"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    '[DONE]',
  ]);
  const aReplyForced = sse([
    { type: 'message_start', message: { usage: { input_tokens: 12 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_r', name: 'reply' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"text":"delivered after breaker"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } },
    '[DONE]',
  ]);
  let calls = 0; const bodies = []; let replyArgs = null;
  const fetch = async (_url, opts) => { calls += 1; bodies.push(JSON.parse(opts.body)); return streamRes(calls <= 3 ? aToolSame : aReplyForced); };
  const h = createAgentHarness({ fetch });
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: REPLY_TOOLS, call: async (n, a) => { if (n === 'reply') replyArgs = a; return 'R'; }, send: () => {}, requireTool: 'reply', maxIterations: 10 });
  rec('H20 breaker tripped then reply delivered via finalizer', r.toolsUsed.includes('reply') && replyArgs?.text === 'delivered after breaker', JSON.stringify({ used: r.toolsUsed, calls }));
  const forced = bodies[bodies.length - 1];
  const useIds = [], resIds = [];
  for (const m of forced.messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_use') useIds.push(b.id);
    if (m.role === 'user' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_result') resIds.push(b.tool_use_id);
  }
  rec('H20 forced request well-formed: every tool_use has a tool_result (no dangling → no 400)', useIds.length > 0 && useIds.every((id) => resIds.includes(id)), JSON.stringify({ useIds, resIds }));
  const last = forced.messages[forced.messages.length - 1];
  rec('H20 no plain-string nudge after a tool_use (last msg = tool_result user turn)', last.role === 'user' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result'));
}

// ── H21 delivery guarantee: when forcing FAILS (weak/no-tool provider), text-harvest delivers ──
// Verified-live failure: a fallback local model (ollama qwen3.5:4b) ignores forced tool_choice
// (forced nCalls=0) → reply never lands → answer dropped. The harvest last-resort must send the
// model's final text through the reply chokepoint and flag `harvested` for the operator alert.
{
  const REPLY_TOOLS = [...TOOLS, { name: 'reply', description: 'send', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }];
  const aTextOnly = sse([
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'My answer.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    '[DONE]',
  ]);
  // The FORCED pass on a weak provider: returns text, NO tool call (ignores tool_choice).
  const aForcedNoTool = sse([
    { type: 'message_start', message: { usage: { input_tokens: 11 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'still text' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    '[DONE]',
  ]);
  const queue = [streamRes(aTextOnly), streamRes(aForcedNoTool)];
  const fetch = async () => queue.shift();
  let replyArgs = null;
  const h = createAgentHarness({ fetch });
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: REPLY_TOOLS, call: async (n, a) => { if (n === 'reply') replyArgs = a; return 'OK'; }, send: () => {}, requireTool: 'reply' });
  rec('H21 forcing failed → text-harvest delivered the final answer via the reply chokepoint', r.toolsUsed.includes('reply') && replyArgs?.text === 'My answer.', JSON.stringify({ used: r.toolsUsed, replyArgs }));
  rec('H21 harvested flag set (drives the operator "degraded" alert)', r.harvested === true, JSON.stringify({ harvested: r.harvested }));
}

// ── H22 harvest does NOT fire when forcing SUCCEEDS (no double-send) ──
{
  const REPLY_TOOLS = [...TOOLS, { name: 'reply', description: 'send', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }];
  const aTextOnly = sse([
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Answer.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    '[DONE]',
  ]);
  const aReplyForced = sse([
    { type: 'message_start', message: { usage: { input_tokens: 12 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_r', name: 'reply' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"text":"Answer."}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    '[DONE]',
  ]);
  const queue = [streamRes(aTextOnly), streamRes(aReplyForced)];
  const fetch = async () => queue.shift();
  let replyCalls = 0;
  const h = createAgentHarness({ fetch });
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: REPLY_TOOLS, call: async (n) => { if (n === 'reply') replyCalls += 1; return 'OK'; }, send: () => {}, requireTool: 'reply' });
  rec('H22 forcing succeeded → reply once, NO harvest (harvested=false)', replyCalls === 1 && r.harvested === false, JSON.stringify({ replyCalls, harvested: r.harvested }));
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — harness: Anthropic + OpenAI tool loops · no-tool fallback · cap · tool-error recovery · truncation surfaced · reply-finalizer (incl. breaker path) · text-harvest delivery-guarantee · audited · abortable' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

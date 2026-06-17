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
import { createAgentHarness } from '../src/agent/harness.js';

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

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — harness: Anthropic + OpenAI tool loops · no-tool fallback · cap · tool-error recovery · truncation surfaced · audited · abortable' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

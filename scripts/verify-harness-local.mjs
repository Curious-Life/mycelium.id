// verify:harness-local — the native Ollama local chat adapter (§13, the A7 pivot).
// Drives streamTurn with a LOCAL provider through an INJECTED fetch and asserts the
// harness now speaks Ollama's NATIVE /api/chat (so it can size num_ctx) instead of
// the OpenAI-compatible /v1 surface (which ignores num_ctx). Also checks the cloud
// path is unchanged, usage is captured, and the floor (no provider) routes native.
import { createAgentHarness } from '../src/agent/harness.js';

const enc = new TextEncoder();
const streamRes = (lines) => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { for (const x of lines) c.enqueue(enc.encode(x)); c.close(); } }) });
const ndjson = (objs) => objs.map((o) => JSON.stringify(o) + '\n');
const ollamaChat = ndjson([
  { message: { role: 'assistant', content: 'Hello ' }, done: false },
  { message: { role: 'assistant', content: 'world' }, done: false },
  { message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 50, eval_count: 7 },
]);

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// ── L1 configured LOCAL provider → native /api/chat with num_ctx ─────────────
{
  let url = null, body = null;
  const fetch = async (u, opts) => { url = u; body = JSON.parse(opts.body); return streamRes(ollamaChat); };
  const events = []; const usage = [];
  const h = createAgentHarness({ fetch, onUsage: (e) => usage.push(e) });
  const r = await h.streamTurn({
    provider: { baseUrl: 'http://127.0.0.1:11434/v1', jurisdiction: 'local', cloudModel: 'gemma3:12b' },
    system: 'SYS', userMessage: 'hi', tools: [], call: async () => 'x', send: (e) => events.push(e),
    maxTokens: 1024, numCtx: 8192,
  });
  rec('L1. local → native /api/chat (NOT /v1/chat/completions), /v1 stripped', url === 'http://127.0.0.1:11434/api/chat', `url=${url}`);
  rec('L2. body carries options.num_ctx (8192) + num_predict (1024)', body?.options?.num_ctx === 8192 && body?.options?.num_predict === 1024, JSON.stringify(body?.options));
  rec('L3. body has think:false + stream:true', body?.think === false && body?.stream === true);
  rec('L4. first message is the system preamble', body?.messages?.[0]?.role === 'system' && body?.messages?.[0]?.content === 'SYS', JSON.stringify(body?.messages?.[0]));
  const text = events.filter((e) => e.type === 'text_delta').map((e) => e.content).join('');
  rec('L5. streamed text reassembled from NDJSON', text === 'Hello world', JSON.stringify(text));
  rec('L6. usage captured from done event (50/7)', usage.length === 1 && usage[0].inputTokens === 50 && usage[0].outputTokens === 7 && usage[0].area === 'chat' && usage[0].isLocal === true, JSON.stringify(usage[0]));
  rec('L7. result.local true', r.local === true);
}

// ── L8 no num_ctx passed → option omitted (let Ollama default) ───────────────
{
  let body = null;
  const fetch = async (u, opts) => { body = JSON.parse(opts.body); return streamRes(ollamaChat); };
  const h = createAgentHarness({ fetch });
  await h.streamTurn({ provider: { jurisdiction: 'local' }, system: 'S', userMessage: 'hi', tools: [], call: async () => 'x', send: () => {} });
  rec('L8. no numCtx → options.num_ctx omitted; num_predict = default 4096', body?.options?.num_ctx === undefined && body?.options?.num_predict === 4096, JSON.stringify(body?.options));
}

// ── L9 no-provider FLOOR routes native /api/chat at the default host ─────────
{
  let url = null;
  const fetch = async (u, opts) => { url = u; return streamRes(ollamaChat); };
  const h = createAgentHarness({ fetch });
  await h.streamTurn({ provider: {}, system: 'S', userMessage: 'hi', tools: [], call: async () => 'x', send: () => {} });
  rec('L9. empty provider (floor) → native /api/chat on 127.0.0.1:11434', url === 'http://127.0.0.1:11434/api/chat', `url=${url}`);
}

// ── L10 local adapter is TOOL-CAPABLE — sends tool defs when the caller passes
//    them (capability gating is the CALLER's job; the harness maps what it's given) ─
{
  let body = null;
  const fetch = async (u, opts) => { body = JSON.parse(opts.body); return streamRes(ollamaChat); };
  const h = createAgentHarness({ fetch });
  await h.streamTurn({ provider: { jurisdiction: 'local' }, system: 'S', userMessage: 'hi', tools: [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } }], call: async () => 'x', send: () => {} });
  rec('L10. native adapter SENDS tools when passed (tool-capable local)', Array.isArray(body?.tools) && body.tools[0]?.function?.name === 't', JSON.stringify(body?.tools));
}

// ── L10b no tools passed → body.tools omitted (no-tool model / relay floor) ──
{
  let body = null;
  const fetch = async (u, opts) => { body = JSON.parse(opts.body); return streamRes(ollamaChat); };
  const h = createAgentHarness({ fetch });
  await h.streamTurn({ provider: { jurisdiction: 'local' }, system: 'S', userMessage: 'hi', tools: [], call: async () => 'x', send: () => {} });
  rec('L10b. no tools passed → body.tools omitted (relay floor stays tool-free)', body?.tools === undefined, JSON.stringify(Object.keys(body || {})));
}

// ── L10c local TOOL CALL parsed → dispatched (object args) → result fed back → done ─
{
  const toolTurn = ndjson([
    { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'saveDocument', arguments: { path: 'p', content: 'c' } } }] }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 2 },
  ]);
  const answerTurn = ndjson([
    { message: { role: 'assistant', content: 'Saved.' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 3 },
  ]);
  const bodies = []; let n = 0;
  const fetch = async (u, opts) => { bodies.push(JSON.parse(opts.body)); return streamRes(n++ === 0 ? toolTurn : answerTurn); };
  const calls = []; const events = [];
  const h = createAgentHarness({ fetch });
  const r = await h.streamTurn({
    provider: { jurisdiction: 'local' }, system: 'S', userMessage: 'save it',
    tools: [{ name: 'saveDocument', description: 'd', inputSchema: { type: 'object', properties: {} } }],
    call: async (name, args) => { calls.push({ name, args }); return 'ok'; }, send: (e) => events.push(e),
  });
  rec('L10c. tool call parsed + dispatched with OBJECT args', calls.length === 1 && calls[0].name === 'saveDocument' && calls[0].args?.path === 'p', JSON.stringify(calls));
  rec('L10c. result fed back → 2nd /api/chat carries assistant tool_calls + a tool result', bodies.length === 2 && bodies[1].messages.some((m) => m.role === 'tool') && bodies[1].messages.some((m) => Array.isArray(m.tool_calls)), JSON.stringify(bodies[1]?.messages?.map((m) => m.role)));
  rec('L10c. final answer streamed + tool recorded in toolsUsed', r.toolsUsed?.includes('saveDocument') && events.some((e) => e.type === 'tool_complete'), JSON.stringify(r.toolsUsed));
}

// ── L11 CLOUD path UNCHANGED — anthropic still hits the messages API ─────────
{
  const aStream = ['data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 3 } } }) + '\n\n',
    'data: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) + '\n\n',
    'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }) + '\n\n',
    'data: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) + '\n\n',
    'data: [DONE]\n\n'];
  let url = null;
  const fetch = async (u, opts) => { url = u; return streamRes(aStream); };
  const h = createAgentHarness({ fetch });
  await h.streamTurn({ provider: { anthropicApiKey: 'K', jurisdiction: 'us-standard' }, system: 'S', userMessage: 'hi', tools: [], call: async () => 'x', send: () => {} });
  rec('L11. cloud (anthropic) UNCHANGED → api.anthropic.com/v1/messages', url === 'https://api.anthropic.com/v1/messages', `url=${url}`);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — local chat speaks native /api/chat with sized num_ctx (the A7 pivot); usage captured; tool-capable (caller-gated) incl. tool-call round-trip; cloud path unchanged' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

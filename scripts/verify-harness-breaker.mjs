// verify:harness-breaker — the tool-loop circuit breaker in streamTurn (src/agent/harness.js),
// driven against STUBBED Anthropic streams (no live key). Spec §7b.
//   B1 same tool + same args 3× → breaker trips, stops the tool loop, final answer pass runs
//   B2 the repeated (3rd) call is NOT executed (toolsUsed has only the 2 that ran)
//   B3 distinct-arg tool calls do NOT trip the breaker (it's identity-based)
//   B4 maxIterations still caps a non-repeating always-tool loop (existing guard intact)
import { createAgentHarness } from '../src/agent/harness.js';

const enc = new TextEncoder();
const streamRes = (chunks) => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } }) });
const sse = (objs) => objs.map((o) => (o === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(o)}\n\n`));
// A tool-call pass for searchMindscape with a given query (args identity = the breaker key).
const aTool = (query) => streamRes(sse([
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'searchMindscape' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
  '[DONE]',
]));
const aFinal = () => streamRes(sse([   // factory: a ReadableStream can only be consumed once
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Final answer.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  '[DONE]',
]));
const TOOLS = [{ name: 'searchMindscape', description: 's', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }];

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// ── B1+B2 repeated identical call trips at 3 ──
{
  let calls = 0; let logged = '';
  const fetch = async () => { calls += 1; return calls <= 3 ? aTool('x') : aFinal(); }; // 3 identical tool calls, then final pass
  const h = createAgentHarness({ fetch, logger: (m) => { logged += m + '\n'; } });
  const events = [];
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: TOOLS, call: async () => 'R', send: (e) => events.push(e), maxIterations: 8 });
  const text = events.filter((e) => e.type === 'text_delta').map((e) => e.content).join('');
  rec('B1 breaker tripped on the 3rd identical call (capped + breaker flag + final pass)', r.breaker === 'repeat' && r.capped === true && text.includes('Final answer.'), JSON.stringify({ breaker: r.breaker, capped: r.capped }));
  rec('B2 the repeated 3rd call did NOT execute (only 2 in toolsUsed)', r.toolsUsed.length === 2 && r.toolsUsed.every((t) => t === 'searchMindscape'), `toolsUsed=${r.toolsUsed}`);
  rec('B1 logged the circuit-breaker (no maxIterations claim)', /circuit-breaker/.test(logged) && !/hit maxIterations/.test(logged));
}

// ── B3 distinct args do NOT trip ──
{
  let calls = 0;
  const fetch = async () => { calls += 1; return calls <= 4 ? aTool(`q${calls}`) : aFinal(); }; // 4 DISTINCT tool calls then final
  const h = createAgentHarness({ fetch });
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: TOOLS, call: async () => 'R', send: () => {}, maxIterations: 8 });
  rec('B3 distinct-arg calls never trip the breaker (all executed, no breaker flag)', !r.breaker && r.toolsUsed.length === 4, JSON.stringify({ breaker: r.breaker, n: r.toolsUsed.length }));
}

// ── B4 maxIterations still caps a non-repeating loop ──
{
  let calls = 0; let logged = '';
  const fetch = async () => { calls += 1; return aTool(`q${calls}`); }; // always a NEW tool call (never finishes)
  const h = createAgentHarness({ fetch, logger: (m) => { logged += m + '\n'; } });
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: TOOLS, call: async () => 'R', send: () => {}, maxIterations: 3 });
  rec('B4 maxIterations cap still fires (capped, no breaker) + final pass', r.capped === true && !r.breaker && /hit maxIterations=3/.test(logged), JSON.stringify({ capped: r.capped, breaker: r.breaker }));
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — circuit-breaker: repeated-identical-call trip (→ final pass, repeat not executed) · distinct-args safe · maxIterations cap intact' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

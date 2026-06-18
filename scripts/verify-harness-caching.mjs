// verify:harness-caching — G2 prompt caching (two levers), against STUBBED streams.
// Design: docs/PROMPT-CACHING-DESIGN-2026-06-19.md. No live key.
//   C1 withCacheBreakpoint marks the LAST block of the LAST message; string content
//      wrapped into a text block; earlier messages untouched (observed via the body).
//   C2 default ON → Anthropic body.messages last block carries cache_control;
//      MYCELIUM_PROMPT_CACHE=0 → no marker, body byte-identical to pre-change.
//   C3 OpenAI + Ollama bodies carry NO cache_control regardless of the flag.
//   C4 usage parse: message_start cache tokens → usage.cacheRead/cacheWriteTokens.
//   C5 recordUsage threads cache tokens into onUsage; llm-usage record INSERTs them.
//   C6 Lever 1: getContext emits Current time + RECENT MESSAGES AFTER all stable sections.
//   C7 multi-iteration: a fresh breakpoint each streamOnce; turn completes.
import { createAgentHarness } from '../src/agent/harness.js';
import { createContextDomain } from '../src/tools/context.js';
import { createLlmUsageNamespace } from '../src/db/llm-usage.js';

const enc = new TextEncoder();
const streamRes = (chunks) => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } }) });
const sse = (objs) => objs.map((o) => (o === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(o)}\n\n`));

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const TOOLS = [{ name: 'searchMindscape', description: 's', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }];
const lastBlockCacheControl = (body) => {
  const msgs = body.messages || [];
  const last = msgs[msgs.length - 1];
  if (!last || !Array.isArray(last.content) || !last.content.length) return undefined;
  return last.content[last.content.length - 1].cache_control;
};

// Canned Anthropic passes (tool_use → end_turn), with cache accounting on message_start.
const aTool = sse([
  { type: 'message_start', message: { usage: { input_tokens: 5000, cache_creation_input_tokens: 4800, cache_read_input_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'searchMindscape' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
  '[DONE]',
]);
const aFinal = sse([
  { type: 'message_start', message: { usage: { input_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 4800 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Found it.' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  '[DONE]',
]);

// ── C1 + C2 (default ON) + C7: capture every Anthropic body across a 2-pass turn ──
{
  delete process.env.MYCELIUM_PROMPT_CACHE;   // default ON
  const bodies = [];
  const queue = [streamRes(aTool), streamRes(aFinal)];
  const fetch = async (url, opts) => { bodies.push(JSON.parse(opts.body)); return queue.shift(); };
  const usageEvents = [];
  const h = createAgentHarness({ onUsage: (e) => usageEvents.push(e), fetch });
  const r = await h.streamTurn({ provider: { anthropicApiKey: 'K', jurisdiction: 'us-standard' }, system: 'SYS', userMessage: 'hi there', tools: TOOLS, call: async () => 'RESULT', send: () => {} });

  // C1: pass 1 — the initial STRING user message is wrapped into a text block + marked.
  const b1last = bodies[0].messages[bodies[0].messages.length - 1];
  rec('C1 string content wrapped into a text block', Array.isArray(b1last.content) && b1last.content[0].type === 'text' && b1last.content[0].text === 'hi there', JSON.stringify(b1last));
  rec('C1 breakpoint on the last block of the last message (pass 1)', !!lastBlockCacheControl(bodies[0]) && lastBlockCacheControl(bodies[0]).type === 'ephemeral');

  // C7: pass 2 — after a tool round, the last message (tool_result array) is freshly marked.
  const b2 = bodies[1];
  const b2last = b2.messages[b2.messages.length - 1];
  rec('C7 pass 2 present (multi-iteration)', bodies.length === 2 && b2last.role === 'user' && Array.isArray(b2last.content));
  rec('C7 fresh breakpoint on pass 2 last block', !!lastBlockCacheControl(b2) && lastBlockCacheControl(b2).type === 'ephemeral');
  // C1: earlier messages (the wrapped user msg, the assistant turn) carry NO stray cache_control beyond the tail.
  const strayMarks = b2.messages.slice(0, -1).filter((m) => Array.isArray(m.content) && m.content.some((bl) => bl.cache_control)).length;
  rec('C1 earlier messages not marked (only the tail)', strayMarks === 0, `stray=${strayMarks}`);
  rec('C7 turn completed with the tool result', r.toolsUsed.join(',') === 'searchMindscape');

  // C4: cache tokens parsed from message_start → threaded to onUsage.
  rec('C4 cacheWriteTokens parsed (pass 1 write)', usageEvents.some((e) => e.cacheWriteTokens === 4800));
  rec('C4 cacheReadTokens parsed (pass 2 read)', usageEvents.some((e) => e.cacheReadTokens === 4800));
  // C5: onUsage shape carries both cache fields (accounting passthrough).
  rec('C5 onUsage carries both cache fields', usageEvents.every((e) => 'cacheReadTokens' in e && 'cacheWriteTokens' in e));
}

// ── C2 (OFF): MYCELIUM_PROMPT_CACHE=0 → no marker, body byte-identical shape ──
{
  process.env.MYCELIUM_PROMPT_CACHE = '0';
  const bodies = [];
  const fetch = async (url, opts) => { bodies.push(JSON.parse(opts.body)); return streamRes(aFinal); };
  const h = createAgentHarness({ fetch });
  await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'SYS', userMessage: 'plain', tools: [], call: async () => 'R', send: () => {} });
  const last = bodies[0].messages[bodies[0].messages.length - 1];
  rec('C2 OFF → content left as the raw string (unwrapped)', last.content === 'plain', JSON.stringify(last));
  rec('C2 OFF → no cache_control anywhere in the body', !JSON.stringify(bodies[0]).includes('cache_control'));
  delete process.env.MYCELIUM_PROMPT_CACHE;   // restore default for later checks
}

// ── C3 OpenAI + Ollama bodies never carry cache_control (default ON) ──
{
  delete process.env.MYCELIUM_PROMPT_CACHE;
  // OpenAI
  const oFinal = sse([
    { choices: [{ index: 0, delta: { content: 'hi' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 20, completion_tokens: 3 }, choices: [] },
    '[DONE]',
  ]);
  let oBody = null;
  const oFetch = async (url, opts) => { oBody = JSON.parse(opts.body); return streamRes(oFinal); };
  const oh = createAgentHarness({ fetch: oFetch });
  await oh.streamTurn({ provider: { openaiApiKey: 'K', baseUrl: 'https://api.openai.com/v1' }, system: 'SYS', userMessage: 'hi', tools: [], call: async () => 'R', send: () => {} });
  rec('C3 OpenAI body carries no cache_control', !JSON.stringify(oBody).includes('cache_control'));

  // Ollama native
  const oll = [{ message: { role: 'assistant', content: 'hi' }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 2 }].map((o) => JSON.stringify(o) + '\n');
  let lBody = null;
  const lFetch = async (url, opts) => { lBody = JSON.parse(opts.body); return streamRes(oll); };
  const lh = createAgentHarness({ fetch: lFetch });
  await lh.streamTurn({ provider: { jurisdiction: 'local' }, system: 'SYS', userMessage: 'hi', tools: [], call: async () => 'R', send: () => {} });
  rec('C3 Ollama body carries no cache_control', !JSON.stringify(lBody).includes('cache_control'));
}

// ── C5 (DAL) llm-usage record persists the two cache columns ──
{
  const rows = [];
  const d1Query = async (sql, params) => {
    if (/INSERT INTO llm_usage/i.test(sql)) {
      // Map the column list to params positionally (matches the DAL's INSERT order).
      const cols = sql.match(/\(([^)]+)\)\s+VALUES/i)[1].split(',').map((s) => s.trim());
      const row = {}; cols.forEach((c, i) => { row[c] = params[i]; });
      rows.push(row);
    }
    return { results: [] };
  };
  const usage = createLlmUsageNamespace({ d1Query });
  await usage.record('u1', { source: 'chat', area: 'chat', provider: 'anthropic', inputTokens: 200, outputTokens: 3, cacheReadTokens: 4800, cacheWriteTokens: 0 });
  const row = rows[0] || {};
  rec('C5 DAL INSERT includes cache_read_tokens', row.cache_read_tokens === 4800, JSON.stringify(row));
  rec('C5 DAL INSERT includes cache_write_tokens', row.cache_write_tokens === 0);
  // Defaults: absent cache fields → 0 (intOr0), never undefined/NaN.
  rows.length = 0;
  await usage.record('u1', { source: 'chat', area: 'chat', inputTokens: 10, outputTokens: 2 });
  rec('C5 DAL defaults cache tokens to 0 when absent', rows[0].cache_read_tokens === 0 && rows[0].cache_write_tokens === 0);
}

// ── C6 Lever 1: getContext emits volatile (time + recent messages) AFTER stable ──
{
  const db = {
    users: { getTimezone: async () => 'UTC' },
    facts: { forContext: async () => [{ pinned: 0, category: 'identity', key: 'name', value: 'Altus' }] },
    messages: { selectRecent: async () => [{ role: 'user', created_at: '2026-06-18T10:00:00Z', content: 'hello there' }] },
    fisher: { getCurrentPhase: async () => ({ phase: 'cycling' }) },
  };
  const { handlers } = createContextDomain({ getDb: () => db, readMindFile: async () => null, userId: 'u1' });
  const out = await handlers.getContext({ recentMessages: 5 });
  const iTime = out.indexOf('Current time');
  const iFacts = out.indexOf('# FACTS YOU KNOW');
  const iPhase = out.indexOf('# COGNITIVE PHASE');
  const iMsgs = out.indexOf('# RECENT MESSAGES');
  rec('C6 stable FACTS present before volatile time', iFacts >= 0 && iTime >= 0 && iFacts < iTime, `facts=${iFacts} time=${iTime}`);
  rec('C6 stable PHASE present before volatile time', iPhase >= 0 && iPhase < iTime, `phase=${iPhase} time=${iTime}`);
  rec('C6 RECENT MESSAGES is in the volatile tail (after stable phase)', iMsgs >= 0 && iMsgs > iPhase, `msgs=${iMsgs} phase=${iPhase}`);
  rec('C6 content preserved (facts + time + messages all present)', iFacts >= 0 && iTime >= 0 && iMsgs >= 0 && out.includes('Altus'));
  // include filter still works (messages only → no FACTS section).
  const only = await handlers.getContext({ include: ['messages'] });
  rec('C6 include filter intact (messages-only omits FACTS)', only.includes('# RECENT MESSAGES') && !only.includes('# FACTS YOU KNOW'));
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — prompt caching: intra-turn Anthropic breakpoint · flag off-switch · OpenAI/Ollama untouched · cache-token accounting · volatile-last preamble' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

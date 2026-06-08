// verify:channel-agent — Phase 2 unit gate (DI, no network, no LLM): the single-
// user lane + runtime selection + reply system prompt. Asserts:
//   - the lane sets the active turn DURING the turn and clears it AFTER (finally)
//   - turns are SERIALIZED — never two active at once — and run in order
//   - a throwing turn is isolated: cleared + the next turn still runs
//   - a hung turn is aborted via the signal (timeout) and still clears
//   - selectRuntime is config-implied (BYOK key → runtime; none → null)
//   - the reply prompt carries the mandatory delivery contract
// PASS/FAIL ledger; exit 1 on any fail.
import { createLane } from '../packages/channel-daemon/agent/lane.js';
import { selectRuntime } from '../packages/channel-daemon/agent/runtime.js';
import { buildReplySystemPrompt } from '../packages/channel-daemon/agent/prompt.js';
import { createReplyTracker } from '../packages/channel-daemon/agent/backends/claude-sdk.js';
import { runOllamaTurn } from '../packages/channel-daemon/agent/backends/ollama.js';
import { classifyTurn } from '../packages/channel-daemon/agent/classify.js';
import { createAutoRuntime } from '../packages/channel-daemon/agent/backends/auto.js';
import crypto from 'node:crypto';
import { getActiveTurn, _resetForTests } from '../packages/channel-daemon/inbound-context.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const turn = (id) => ({ source: 'telegram', channelKind: 'telegram', channelId: id, inboundMessageId: `m-${id}` });
const msg = (t) => ({ content: t });

// ── lane: set-during / clear-after + serialization + order ───────────────────
{
  _resetForTests();
  const events = [];
  let maxConcurrent = 0, concurrent = 0;
  const runtime = {
    label: 'fake',
    async runTurn({ turnCtx }) {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      events.push(`start:${turnCtx.channelId}`);
      // active turn must be set + correct WHILE the turn runs
      events.push(`active:${getActiveTurn()?.channelId}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`end:${turnCtx.channelId}`);
      concurrent--;
      return { delivered: true, usedReplyTool: true };
    },
  };
  const lane = createLane({ runtime });
  lane.runTurn(turn('A'), msg('a'));
  lane.runTurn(turn('B'), msg('b'));
  lane.runTurn(turn('C'), msg('c'));
  await lane.idle();

  rec('L1. active turn is set + correct DURING each turn', events.includes('active:A') && events.includes('active:B') && events.includes('active:C'));
  rec('L2. active turn CLEARED after the lane drains', getActiveTurn() === null);
  rec('L3. turns never overlap (max concurrency = 1)', maxConcurrent === 1, `max=${maxConcurrent}`);
  rec('L4. turns run in FIFO order', events.join('|') === 'start:A|active:A|end:A|start:B|active:B|end:B|start:C|active:C|end:C', events.join('|'));
}

// ── lane: error isolation ────────────────────────────────────────────────────
{
  _resetForTests();
  const ran = [];
  const runtime = {
    async runTurn({ turnCtx }) {
      ran.push(turnCtx.channelId);
      if (turnCtx.channelId === 'B') throw new Error('boom');
      return { delivered: true };
    },
  };
  const lane = createLane({ runtime });
  lane.runTurn(turn('A'), msg('a'));
  lane.runTurn(turn('B'), msg('b'));
  lane.runTurn(turn('C'), msg('c'));
  await lane.idle();
  rec('L5. a throwing turn is isolated — the next turn still runs', ran.join(',') === 'A,B,C', ran.join(','));
  rec('L6. active turn cleared even after a throwing turn', getActiveTurn() === null);
}

// ── lane: timeout aborts a hung turn ─────────────────────────────────────────
{
  _resetForTests();
  let sawAbort = false;
  const runtime = {
    async runTurn({ signal }) {
      await new Promise((resolve) => {
        signal.addEventListener('abort', () => { sawAbort = true; resolve(); }, { once: true });
      });
      return { delivered: false, usedReplyTool: false };
    },
  };
  const lane = createLane({ runtime, turnTimeoutMs: 30 });
  lane.runTurn(turn('Z'), msg('hang'));
  await lane.idle();
  rec('L7. a hung turn is aborted via the signal (timeout)', sawAbort);
  rec('L8. active turn cleared after a timed-out turn', getActiveTurn() === null);
}

// ── runtime selection: config-implied locus ──────────────────────────────────
{
  const withKey = selectRuntime({ anthropicApiKey: 'sk-ant-test', mcpMode: 'http' });
  rec('R1. BYOK key → claude-agent-sdk runtime', !!withKey && /claude-agent-sdk/.test(withKey.label), `label=${withKey?.label}`);
  const local = selectRuntime({ anthropicApiKey: '', ollamaModel: 'llama3.1', ollamaUrl: 'http://127.0.0.1:11434', mcpUrl: 'http://x/mcp' });
  rec('R2. no key + ollama model → ollama runtime (sovereign)', !!local && /ollama/.test(local.label), `label=${local?.label}`);
  const none = selectRuntime({ anthropicApiKey: '', ollamaModel: '' });
  rec('R3. neither → null (two-way disabled, capture-only)', none === null);
}

// ── ollama tool-use loop (pure, fake ollama + fake mcp) ──────────────────────
{
  const calls = [];
  const mcpClient = {
    listTools: async () => ({ tools: [{ name: 'searchMindscape', description: 's', inputSchema: { type: 'object' } }, { name: 'reply', description: 'r', inputSchema: { type: 'object' } }] }),
    callTool: async ({ name, arguments: args }) => { calls.push({ name, args }); return { content: [{ type: 'text', text: name === 'reply' ? '{"delivered":true}' : 'search results here' }] }; },
  };
  // scripted ollama: turn 1 calls searchMindscape, turn 2 calls reply, then done.
  const script = [
    { message: { content: '', tool_calls: [{ function: { name: 'searchMindscape', arguments: { q: 'x' } } }] } },
    { message: { content: '', tool_calls: [{ function: { name: 'reply', arguments: { text: 'here you go' } } }] } },
  ];
  let n = 0;
  const ollamaChat = async () => script[n++];
  const r = await runOllamaTurn({ ollamaChat, mcpClient, systemPrompt: 'sys', userMessage: 'hi' });
  rec('OL1. loop: read tool then reply tool, mcp.callTool invoked for both', calls.length === 2 && calls[0].name === 'searchMindscape' && calls[1].name === 'reply');
  rec('OL2. reply delivered detected from tool result', r.usedReplyTool === true && r.delivered === true && r.reason === 'delivered');
}
{
  // no tool calls → no reply
  const mcpClient = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) };
  const r = await runOllamaTurn({ ollamaChat: async () => ({ message: { content: 'just chatting' } }), mcpClient, systemPrompt: 's', userMessage: 'hi' });
  rec('OL3. no tool_calls → usedReplyTool false', r.usedReplyTool === false && r.delivered === false);
}
{
  // reply returns delivered:false (e.g. rate-limited)
  const mcpClient = { listTools: async () => ({ tools: [{ name: 'reply', inputSchema: {} }] }), callTool: async () => ({ content: [{ type: 'text', text: '{"delivered":false,"errorCode":"rate-limited"}' }] }) };
  let n = 0; const script = [{ message: { tool_calls: [{ function: { name: 'reply', arguments: { text: 'x' } } }] } }, { message: { content: 'done' } }];
  const r = await runOllamaTurn({ ollamaChat: async () => script[n++], mcpClient, systemPrompt: 's', userMessage: 'hi' });
  rec('OL4. reply used but not delivered', r.usedReplyTool === true && r.delivered === false);
}
{
  // GUARANTEED DELIVERY: a wandering local model calls a read tool then ends with
  // FREE-FORM TEXT (no reply) → the forced-reply safety net fires and delivers.
  const calls = [];
  const mcpClient = {
    listTools: async () => ({ tools: [{ name: 'search', inputSchema: {} }, { name: 'reply', inputSchema: {} }] }),
    callTool: async ({ name }) => { calls.push(name); return { content: [{ type: 'text', text: name === 'reply' ? '{"delivered":true}' : 'results' }] }; },
  };
  let sawForcedToolChoice = false; let forcedTools = null;
  const script = [
    { message: { tool_calls: [{ function: { name: 'search', arguments: { q: 'x' } } }] } }, // turn 1: read tool
    { message: { content: 'here is my answer as free text' } },                              // turn 2: free text, NO reply → loop ends undelivered
    { message: { tool_calls: [{ function: { name: 'reply', arguments: { text: 'forced answer' } } }] } }, // forced call result
  ];
  let n = 0;
  const ollamaChat = async (req) => { if (req.tool_choice) { sawForcedToolChoice = true; forcedTools = req.tools; } return script[n++]; };
  const r = await runOllamaTurn({ ollamaChat, mcpClient, systemPrompt: 's', userMessage: 'hi' });
  rec('OL5. wandering model → forced reply call made WITH tool_choice', sawForcedToolChoice === true && r.forced === true);
  rec('OL6. forced reply delivers; reason=delivered-forced', r.delivered === true && r.reason === 'delivered-forced' && calls.includes('reply'));
  rec('OL7. forced call constrains tools to the reply tool only', Array.isArray(forcedTools) && forcedTools.length === 1 && forcedTools[0].function.name === 'reply');
}
{
  // Model delivers naturally on the first pass → the forced net does NOT fire.
  const mcpClient = { listTools: async () => ({ tools: [{ name: 'reply', inputSchema: {} }] }), callTool: async () => ({ content: [{ type: 'text', text: '{"delivered":true}' }] }) };
  let forcedFired = false;
  const script = [{ message: { tool_calls: [{ function: { name: 'reply', arguments: { text: 'hi' } } }] } }];
  let n = 0;
  const ollamaChat = async (req) => { if (req.tool_choice) forcedFired = true; return script[n++] || { message: { content: '' } }; };
  const r = await runOllamaTurn({ ollamaChat, mcpClient, systemPrompt: 's', userMessage: 'hi' });
  rec('OL8. natural reply → forced net NOT used (forced=false, reason=delivered)', r.delivered === true && r.forced === false && r.reason === 'delivered' && forcedFired === false);
}

// ── reply prompt: the delivery contract is present ───────────────────────────
{
  const dm = buildReplySystemPrompt({ turnCtx: turn('1') });
  rec('P1. prompt names the reply tool as the only delivery path', /`reply` tool/.test(dm) && /(NOT|NEVER) delivered/.test(dm));
  const grp = buildReplySystemPrompt({ turnCtx: { channelKind: 'telegram-group', channelId: '-1' } });
  rec('P2. surface wording differs DM vs group', /direct message/.test(dm) && /Telegram group/.test(grp));
}

// ── SDK message interpretation (createReplyTracker) — verified shapes ─────────
// Claude Agent SDK v0.3.x: tool_use rides a type:'assistant' SDKMessage at
// msg.message.content[]; the tool_result comes on a LATER type:'user' message.
{
  // happy: reply tool_use (assistant) → tool_result delivered:true (user)
  const t = createReplyTracker();
  t.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__mycelium__reply', id: 'tu_1', input: { text: 'hi' } }] } });
  t.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"delivered":true}' }] } });
  const r = t.result();
  rec('S1. reply tool_use(assistant)+tool_result(user) → used+delivered', r.usedReplyTool === true && r.delivered === true, JSON.stringify(r));
}
{
  // a non-reply tool result must NOT mark delivered
  const t = createReplyTracker();
  t.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__mycelium__searchMindscape', id: 'tu_x' }] } });
  t.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_x', content: '{"delivered":true}' }] } });
  const r = t.result();
  rec('S2. non-reply tool result does NOT count as delivered', r.usedReplyTool === false && r.delivered === false, JSON.stringify(r));
}
{
  // reply called but delivered:false
  const t = createReplyTracker();
  t.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__mycelium__reply', id: 'tu_2' }] } });
  t.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: '{"delivered":false,"errorCode":"rate-limited"}' }] } });
  const r = t.result();
  rec('S3. reply used but not delivered → used=true, delivered=false', r.usedReplyTool === true && r.delivered === false, JSON.stringify(r));
}
{
  // no reply tool at all
  const t = createReplyTracker();
  t.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } });
  t.observe({ type: 'result', subtype: 'success' });
  const r = t.result();
  rec('S4. no reply tool → used=false, delivered=false', r.usedReplyTool === false && r.delivered === false, JSON.stringify(r));
}

// ── classifier (auto router) ─────────────────────────────────────────────────
{
  rec('CL1. sensitive marker → local (hard)', classifyTurn({ userMessage: 'whats my bank account password again' }).locus === 'local' && classifyTurn({ userMessage: 'my therapy medication' }).sensitive === true);
  rec('CL2. complexity marker → cloud', classifyTurn({ userMessage: 'explain how this works' }).locus === 'cloud');
  rec('CL3. long message → cloud', classifyTurn({ userMessage: 'x'.repeat(300) }).locus === 'cloud');
  rec('CL4. short greeting → local (simple)', classifyTurn({ userMessage: 'hey there, all good?' }).locus === 'local');
  rec('CL5. sensitive + complex → local (sensitive wins)', classifyTurn({ userMessage: 'explain my therapy plan in detail' }).locus === 'local');
}

// ── auto runtime (fake local/cloud + audit capture) ──────────────────────────
function mkAuto({ cloudFails = false } = {}) {
  const calls = [];
  const audits = [];
  const local = { label: 'local', runTurn: async () => { calls.push('local'); return { delivered: true, usedReplyTool: true }; } };
  const cloud = { label: 'cloud', runTurn: async () => { calls.push('cloud'); if (cloudFails) throw new Error('cloud boom'); return { delivered: true, usedReplyTool: true }; } };
  const auto = createAutoRuntime({ local, cloud, auditEgress: (e) => audits.push(e) });
  return { auto, calls, audits };
}
{
  const { auto, calls, audits } = mkAuto();
  await auto.runTurn({ userMessage: 'explain the thing in detail', turnCtx: {} });
  rec('AU1. complex → cloud.runTurn + audit allowed/jurisdiction cloud', calls.join() === 'cloud' && audits[0]?.decision === 'allowed' && audits[0]?.jurisdiction === 'cloud');
  rec('AU2. audit is hash-only (no plaintext)', audits[0]?.contentHash === crypto.createHash('sha256').update('explain the thing in detail').digest('hex') && !JSON.stringify(audits[0]).includes('explain the thing'));
}
{
  const { auto, calls, audits } = mkAuto();
  await auto.runTurn({ userMessage: 'hi ok thanks', turnCtx: {} });
  rec('AU3. simple → local.runTurn, no cloud, no allowed-cloud audit', calls.join() === 'local' && !audits.some((a) => a.jurisdiction === 'cloud'));
}
{
  const { auto, calls, audits } = mkAuto();
  await auto.runTurn({ userMessage: 'my bank password is leaking, help', turnCtx: {} });
  rec('AU4. sensitive → local + denied/kept-local audit', calls.join() === 'local' && audits.some((a) => a.decision === 'denied' && /sensitive/.test(a.reason)));
}
{
  const { auto, calls } = mkAuto({ cloudFails: true });
  const r = await auto.runTurn({ userMessage: 'explain in detail why', turnCtx: {} });
  rec('AU5. cloud failure → falls back to local', calls.join() === 'cloud,local' && r.delivered === true);
}

// ── selectRuntime: auto + overrides ──────────────────────────────────────────
{
  const both = selectRuntime({ anthropicApiKey: 'k', ollamaModel: 'llama3.1', mcpUrl: 'http://x/mcp' });
  rec('AU6. both configured → auto runtime', /^auto\(/.test(both.label), `label=${both?.label}`);
  rec('AU7. router=cloud forces cloud', /claude-agent-sdk/.test(selectRuntime({ anthropicApiKey: 'k', ollamaModel: 'llama3.1', channelRouter: 'cloud', mcpUrl: 'http://x/mcp' }).label));
  rec('AU8. router=local forces ollama', /ollama/.test(selectRuntime({ anthropicApiKey: 'k', ollamaModel: 'llama3.1', channelRouter: 'local', mcpUrl: 'http://x/mcp' }).label));
}

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO');

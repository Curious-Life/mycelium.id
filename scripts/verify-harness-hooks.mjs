#!/usr/bin/env node
// verify:harness-hooks — the lifecycle hook bus (G1). Design: docs/HOOK-BUS-DESIGN-2026-06-18.md
//
// Step 1 (this file, U-section): the fire-helper semantics in ISOLATION — fail-CLOSED
// blocking, fail-OPEN observers, timeout, and the createAgentHooks tool-guard factory
// (incl. the §1 no-plaintext-in-audit canary). The K-section (K1–K8: harness + history
// integration) is appended in Step 2 once the wiring lands.

import {
  fireBeforeToolCall, fireAfterToolCall, fireBeforeCompaction, fireAfterCompaction,
  createAgentHooks, autonomousToolGuard,
} from '../src/agent/hooks.js';
import { createAgentHarness } from '../src/agent/harness.js';
import { hydrateHistoryBlock } from '../src/agent/history.js';

// ── shared stubbed-Anthropic SSE fixtures (mirror verify-harness.mjs) ──
const enc = new TextEncoder();
const streamRes = (chunks) => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } }) });
const sse = (objs) => objs.map((o) => (o === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(o)}\n\n`));
const aToolWith = (q) => sse([
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Searching. ' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'searchMindscape' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: `{"query":"${q}"}` } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
  '[DONE]',
]);
const aTool = aToolWith('x');
const aFinal = sse([
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Found it.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  '[DONE]',
]);
const TOOLS = [{ name: 'searchMindscape', description: 's', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }];

// Drive one stubbed turn (firstPass → aFinal) through the REAL streamTurn with `hooks`.
// Returns { events, calls }; `calls` counts tool executions.
async function runTurn(hooks, { firstPass = aTool } = {}) {
  const queue = [streamRes(firstPass), streamRes(aFinal)];
  const fetch = async () => queue.shift();
  const events = []; let calls = 0;
  const h = createAgentHarness({ hooks, surface: 'test', fetch });
  await h.streamTurn({ provider: { anthropicApiKey: 'K' }, system: 'S', userMessage: 'hi', tools: TOOLS, call: async () => { calls += 1; return 'R'; }, send: (e) => events.push(e) });
  await new Promise((r) => setTimeout(r, 0)); // let fire-and-forget observers settle
  return { events, calls };
}
const final = (events) => events.some((e) => e.type === 'text_delta' && e.content === 'Found it.');

let pass = 0, fail = 0;
const rec = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const CANARY = 'SENSITIVE-HOOK-XYZ';

// ── U1 no hook → allow (undefined) ──
{
  const r = await fireBeforeToolCall(undefined, { name: 'x', args: {} });
  rec('U1 no beforeToolCall hook → allow (undefined)', r === undefined);
  const r2 = await fireBeforeToolCall({}, { name: 'x', args: {} });
  rec('U1 empty hooks bag → allow', r2 === undefined);
}

// ── U2 clean block / clean allow ──
{
  const block = await fireBeforeToolCall({ beforeToolCall: () => ({ block: true, reason: 'nope' }) }, { name: 'reply', args: {} });
  rec('U2 hook {block:true,reason} → blocks with reason', !!block?.block && block.reason === 'nope');
  const allow = await fireBeforeToolCall({ beforeToolCall: () => undefined }, { name: 'x', args: {} });
  rec('U2 hook returns falsy → allow', allow === undefined);
  const noReason = await fireBeforeToolCall({ beforeToolCall: () => ({ block: true }) }, { name: 'x', args: {} });
  rec('U2 block without reason → default reason "policy"', noReason?.reason === 'policy');
}

// ── U3 throw → fail-CLOSED ──
{
  const r = await fireBeforeToolCall({ beforeToolCall: () => { throw new Error(CANARY); } }, { name: 'x', args: {} });
  rec('U3 beforeToolCall throws → BLOCK (fail-closed)', !!r?.block && r.reason === 'hook-error');
  rec('U3 thrown error message NOT leaked into the verdict', !JSON.stringify(r).includes(CANARY));
}

// ── U4 timeout → fail-CLOSED ──
{
  process.env.MYCELIUM_HOOK_TIMEOUT_MS = '50';
  const t0 = Date.now();
  const r = await fireBeforeToolCall({ beforeToolCall: () => new Promise(() => {}) }, { name: 'x', args: {} }); // never resolves
  const dt = Date.now() - t0;
  rec('U4 hung beforeToolCall → BLOCK on timeout (fail-closed)', !!r?.block && r.reason === 'hook-timeout', `reason=${r?.reason}`);
  rec('U4 timeout fired ~promptly (<1s, not the 15s default)', dt < 1000, `${dt}ms`);
  delete process.env.MYCELIUM_HOOK_TIMEOUT_MS;
}

// ── U5 afterToolCall observer fails OPEN ──
{
  let logged = '';
  const p = fireAfterToolCall({ afterToolCall: () => { throw new Error(CANARY); } }, { name: 'x', args: {}, output: 'o', isError: false }, (m) => { logged += m; });
  let resolved = false;
  await p.then(() => { resolved = true; });
  rec('U5 afterToolCall throw → returned promise RESOLVES (fail-open)', resolved);
  rec('U5 observer error routed to logger', /afterToolCall failed/.test(logged));
  rec('U5 no afterToolCall hook → resolves', (await fireAfterToolCall({}, {}, () => {})) === undefined);
}

// ── U6 compaction observers fail OPEN ──
{
  let ok1 = false, ok2 = false;
  await fireBeforeCompaction({ beforeCompaction: () => { throw new Error('b'); } }, { messages: [], contextWindow: 1, maxOutputTokens: 1 }, () => {}).then(() => { ok1 = true; });
  await fireAfterCompaction({ afterCompaction: () => { throw new Error('a'); } }, { compacted: true }, () => {}).then(() => { ok2 = true; });
  rec('U6 beforeCompaction throw → fail-open', ok1);
  rec('U6 afterCompaction throw → fail-open', ok2);
  let saw = null;
  await fireAfterCompaction({ afterCompaction: (e) => { saw = e; } }, { summary: 'S', compacted: true, savedRatio: 0.4 }, () => {});
  rec('U6 afterCompaction receives {summary,compacted,savedRatio}', saw?.summary === 'S' && saw?.compacted === true && saw?.savedRatio === 0.4);
}

// ── U7 createAgentHooks tool-guard factory ──
{
  rec('U7 no toolGuard → undefined (unchanged path)', createAgentHooks({}) === undefined);

  const auditRows = [];
  const db = { audit: { log: (row) => auditRows.push(row) } };
  const hooks = createAgentHooks({
    db, userId: 'u1', source: 'scheduler',
    toolGuard: (name) => (name === 'reply' ? 'reply not allowed here' : false),
  });
  rec('U7 factory returns an AgentHooks with beforeToolCall', typeof hooks?.beforeToolCall === 'function');

  const denied = await fireBeforeToolCall(hooks, { name: 'reply', args: { text: CANARY }, surface: 'scheduler' });
  rec('U7 guard denies "reply" with its reason', denied?.block === true && denied.reason === 'reply not allowed here');

  const allowed = await fireBeforeToolCall(hooks, { name: 'searchMindscape', args: { q: CANARY } });
  rec('U7 guard allows a non-denylisted tool', allowed === undefined);

  rec('U7 a deny was audited (name + decision)', auditRows.some((r) => r.action === 'tool-guard' && r.resourceId === 'reply' && r.details?.decision === 'blocked'));
  rec('U7 allows are NOT audited (clean log signal)', auditRows.length === 1);
  rec('U7 §1 audit carries NO plaintext args (canary absent)', !JSON.stringify(auditRows).includes(CANARY));
}

// ── U8 createAgentHooks: a throwing guard fails CLOSED ──
{
  const hooks = createAgentHooks({ toolGuard: () => { throw new Error('boom'); } });
  const r = await fireBeforeToolCall(hooks, { name: 'x', args: {} });
  rec('U8 throwing toolGuard → BLOCK (fail-closed)', r?.block === true && r.reason === 'guard-error');
}

// ════════════════ K-section: streamTurn integration (Step 2 wiring) ════════════════

// ── K1 no hooks → tool runs, no block (the hook-free path is unchanged) ──
{
  const { events, calls } = await runTurn(undefined);
  rec('K1 no hooks → tool executed once', calls === 1);
  rec('K1 no hooks → tool_start + tool_complete, NO tool_blocked',
    events.some((e) => e.type === 'tool_start') && events.some((e) => e.type === 'tool_complete') && !events.some((e) => e.type === 'tool_blocked'));
  rec('K1 no hooks → reached final answer', final(events));
}

// ── K2 beforeToolCall blocks → call() NOT run; model re-plans to a final answer ──
{
  const { events, calls } = await runTurn({ beforeToolCall: () => ({ block: true, reason: 'denied' }) });
  rec('K2 block → call() NOT invoked', calls === 0);
  rec('K2 block → tool_blocked emitted, NO tool_start',
    events.some((e) => e.type === 'tool_blocked' && e.name === 'searchMindscape') && !events.some((e) => e.type === 'tool_start'));
  rec('K2 block → loop continued to final answer', final(events));
}

// ── K3 beforeToolCall throws → fail-CLOSED block ──
{
  const { events, calls } = await runTurn({ beforeToolCall: () => { throw new Error('SECRET-K3'); } });
  rec('K3 throw → blocked (call not invoked)', calls === 0 && events.some((e) => e.type === 'tool_blocked'));
  rec('K3 throw → turn still completes', final(events));
  rec('K3 thrown message never reaches events', !JSON.stringify(events).includes('SECRET-K3'));
}

// ── K4 beforeToolCall times out → fail-CLOSED block ──
{
  process.env.MYCELIUM_HOOK_TIMEOUT_MS = '50';
  const { events, calls } = await runTurn({ beforeToolCall: () => new Promise(() => {}) });
  delete process.env.MYCELIUM_HOOK_TIMEOUT_MS;
  rec('K4 timeout → blocked (call not invoked)', calls === 0 && events.some((e) => e.type === 'tool_blocked'));
  rec('K4 timeout → turn completes', final(events));
}

// ── K5 afterToolCall observes (fail-OPEN), fires per executed tool ──
{
  const seen = [];
  const { calls } = await runTurn({ afterToolCall: (e) => seen.push(e) });
  rec('K5 afterToolCall fired once with {name,output,isError}',
    seen.length === 1 && seen[0].name === 'searchMindscape' && seen[0].output === 'R' && seen[0].isError === false, `seen=${seen.length}`);
  rec('K5 the tool actually ran', calls === 1);
  const { events, calls: c2 } = await runTurn({ afterToolCall: () => { throw new Error('obs'); } });
  rec('K5 throwing afterToolCall → fail-OPEN (tool ran + turn completed)', c2 === 1 && final(events));
}

// ── K6 §1 no plaintext args in the event stream on a block ──
{
  const C = 'SENSITIVE-HOOK-XYZ';
  const { events } = await runTurn({ beforeToolCall: () => ({ block: true, reason: 'x' }) }, { firstPass: aToolWith(C) });
  rec('K6 blocked-call events carry NO plaintext args (canary absent)', !JSON.stringify(events).includes(C));
}

// ── K7 compaction hooks fire in the over-budget path (observe · fail-OPEN) ──
{
  const big = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(2000) }));
  const summarize = async () => 'SUMMARY';
  let before = null, after = null;
  const block = await hydrateHistoryBlock({
    history: big, contextWindow: 200, maxOutputTokens: 20, summarize, conversationId: 'c1', userId: 'u1',
    hooks: { beforeCompaction: (e) => { before = e; }, afterCompaction: (e) => { after = e; } },
  });
  await new Promise((r) => setTimeout(r, 0));
  rec('K7 beforeCompaction fired with {messages,contextWindow}', !!before && Array.isArray(before.messages) && before.contextWindow === 200);
  rec('K7 afterCompaction fired with a summary + compacted', !!after && after.compacted === true && typeof after.summary === 'string' && after.summary.length > 0);
  rec('K7 hydrateHistoryBlock still returned a preamble block', typeof block === 'string' && block.length > 0);

  const block2 = await hydrateHistoryBlock({
    history: big, contextWindow: 200, maxOutputTokens: 20, summarize, conversationId: 'c2', userId: 'u1',
    hooks: { beforeCompaction: () => { throw new Error('b'); }, afterCompaction: () => { throw new Error('a'); } },
  });
  rec('K7 throwing compaction hooks → fail-OPEN (still returns a block)', typeof block2 === 'string' && block2.length > 0);
}

// ── W1/W2 autonomousToolGuard env denylist (the Step-4 config surface) ──
{
  delete process.env.MYCELIUM_AUTONOMOUS_TOOL_DENY;
  rec('W1 env unset → autonomousToolGuard() undefined (no guard ⇒ unchanged path)', autonomousToolGuard() === undefined);

  process.env.MYCELIUM_AUTONOMOUS_TOOL_DENY = 'reply, schedule_task';   // note the space → trim
  const g = autonomousToolGuard();
  delete process.env.MYCELIUM_AUTONOMOUS_TOOL_DENY;
  rec('W2 env set → predicate denies listed tools (trimmed)', typeof g === 'function' && typeof g('reply') === 'string' && typeof g('schedule_task') === 'string');
  rec('W2 predicate allows non-listed tools', g('searchMindscape') === false);
}

// ── W3 end-to-end: the REAL createAgentHooks factory + env guard blocks through streamTurn ──
{
  process.env.MYCELIUM_AUTONOMOUS_TOOL_DENY = 'searchMindscape';
  const auditRows = [];
  const hooks = createAgentHooks({ db: { audit: { log: (r) => auditRows.push(r) } }, userId: 'u', source: 'scheduler', toolGuard: autonomousToolGuard() });
  delete process.env.MYCELIUM_AUTONOMOUS_TOOL_DENY; // guard closure already captured the denylist
  const { events, calls } = await runTurn(hooks);
  rec('W3 factory denylist blocks the tool through streamTurn (call not run)', calls === 0 && events.some((e) => e.type === 'tool_blocked'));
  rec('W3 block audited (name only) + turn reached final answer',
    auditRows.some((r) => r.action === 'tool-guard' && r.resourceId === 'searchMindscape' && r.details?.decision === 'blocked') && final(events));
}

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log(`VERDICT: GO — hook bus: fire helpers (fail-closed block + timeout, fail-open observers, no-plaintext factory) + streamTurn wiring (block/observe/no-leak) — ${pass}/${pass} checks`);
  process.exit(0);
} else {
  console.log(`VERDICT: NO-GO — ${fail} failing check(s), ${pass} passing`);
  process.exit(1);
}

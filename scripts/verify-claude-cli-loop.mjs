// verify:claude-cli-loop — the Claude Code (cli) agent engine (src/agent/loop-claude-cli.js).
// Mocks `spawn` and feeds canned stream-json NDJSON (the canonical schema, runner.js:388-424)
// so the parser + flags + lifecycle are proven WITHOUT a live binary. NB: this validates the
// mapping against the ASSUMED schema — the live-binary spike (scripts/spike-claude-cli.mjs)
// confirms that schema + the --allowedTools confinement before the engine is enabled.
//   CL1 text deltas accumulate + responding + tool_start/complete + usage; uniform return shape
//   CL2 result.result OVERWRITES accumulated text
//   CL3 subtype 'error_max_turns' → truncated:true
//   CL4 secure flags: --allowedTools mcp__mycelium__* present, --dangerously-skip-permissions ABSENT,
//       --model/--mcp-config present, prompt via stdin
//   CL5 mcp-config → loopback /internal/mcp, type:http, NO bearer/headers
//   CL6 signal abort → SIGTERM + aborted:true
//   CL7 spawn 'error' → resolves (never throws) with lastErr
import { EventEmitter } from 'node:events';
import { createClaudeCliLoop, buildMcpConfig } from '../src/agent/loop-claude-cli.js';

const ledger = [];
const rec = (label, cond, detail = '') => { ledger.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  — ' + detail}`); };

const j = (o) => JSON.stringify(o);
const textDelta = (t) => j({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const toolStart = (name) => j({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name } } });
const blockStop = () => j({ type: 'stream_event', event: { type: 'content_block_stop' } });
const result = (o) => j({ type: 'result', ...o });

function mkChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child._stdin = [];
  child.stdin = { write: (s) => child._stdin.push(s), end: () => {} };
  child.kill = (sig) => { child._killed = sig; queueMicrotask(() => child.emit('close', null, sig)); };
  return child;
}
// A spawn seam: records (bin,args,child); optionally auto-streams `lines` then closes.
function seam({ lines = [], autoClose = true, error = false } = {}) {
  const cap = {};
  const spawnImpl = (bin, args) => {
    cap.bin = bin; cap.args = args; cap.child = mkChild();
    queueMicrotask(() => {
      if (error) { cap.child.emit('error', new Error('spawn ENOENT')); return; }
      for (const l of lines) cap.child.stdout.emit('data', Buffer.from(l + '\n'));
      if (autoClose) cap.child.emit('close', 0, null);
    });
    return cap.child;
  };
  return { spawnImpl, cap };
}
const mkLoop = (spawnImpl, writeSink) => createClaudeCliLoop({
  claudeBin: '/x/claude', restPort: 8799, model: 'claude-opus-4-8',
  spawnImpl, writeConfigImpl: writeSink || (() => {}), cleanupImpl: () => {},
});

// ── CL1 — happy path ──
{
  const events = [];
  const { spawnImpl } = seam({ lines: [
    textDelta('Hello '), textDelta('world'),
    toolStart('getContext'), blockStop(),
    result({ result: 'Hello world', usage: { input_tokens: 10, output_tokens: 3 }, subtype: 'success' }),
  ] });
  const r = await mkLoop(spawnImpl).run({ system: 'SYS', userMessage: 'hi', send: (e) => events.push(e) });
  const types = events.map((e) => e.type);
  rec('CL1 text accumulates + final shape', r.text === 'Hello world' && r.toolsUsed.join() === 'getContext' && r.truncated === false && r.aborted === false && r.fellBack === false && r.capped === false);
  rec('CL1 emits responding + text_delta + tool_start/complete + usage',
    types.includes('responding') && types.filter((t) => t === 'text_delta').length === 2 &&
    types.includes('tool_start') && types.includes('tool_complete') && types.includes('usage'),
    types.join(','));
}

// ── CL2 — result.result overwrites accumulated deltas ──
{
  const { spawnImpl } = seam({ lines: [textDelta('partial'), result({ result: 'FINAL canonical text', subtype: 'success' })] });
  const r = await mkLoop(spawnImpl).run({ system: 'S', userMessage: 'hi', send: () => {} });
  rec('CL2 result.result overwrites', r.text === 'FINAL canonical text', r.text);
}

// ── CL3 — max-turns → truncated ──
{
  const { spawnImpl } = seam({ lines: [textDelta('cut off'), result({ subtype: 'error_max_turns' })] });
  const r = await mkLoop(spawnImpl).run({ system: 'S', userMessage: 'hi', send: () => {} });
  rec('CL3 error_max_turns → truncated', r.truncated === true && r.text === 'cut off', JSON.stringify(r));
}

// ── CL4 — secure flag set + stdin prompt ──
{
  const { spawnImpl, cap } = seam({ lines: [result({ result: 'ok', subtype: 'success' })] });
  await mkLoop(spawnImpl).run({ system: 'SYSTEM-PREAMBLE', userMessage: 'the user message', send: () => {} });
  const a = cap.args;
  const pairPresent = (flag, val) => { const i = a.indexOf(flag); return i >= 0 && a[i + 1] === val; };
  rec('CL4 --strict-mcp-config present (CONFINEMENT — ignores account MCP connectors)', a.includes('--strict-mcp-config'), a.join(' '));
  rec('CL4 --tools mcp__mycelium__* present (CONFINEMENT — restricts available toolset)', pairPresent('--tools', 'mcp__mycelium__*'), a.join(' '));
  rec('CL4 --allowedTools mcp__mycelium__* present (auto-approve)', pairPresent('--allowedTools', 'mcp__mycelium__*'), a.join(' '));
  rec('CL4 --dangerously-skip-permissions ABSENT', !a.includes('--dangerously-skip-permissions'), a.join(' '));
  rec('CL4 --model + --mcp-config + --append-system-prompt present', pairPresent('--model', 'claude-opus-4-8') && a.includes('--mcp-config') && pairPresent('--append-system-prompt', 'SYSTEM-PREAMBLE') && a.includes('--output-format') && a.includes('stream-json'), a.join(' '));
  rec('CL4 prompt delivered via stdin', cap.child._stdin.join('') === 'the user message', cap.child._stdin.join('|'));
}

// ── CL5 — mcp-config points at loopback /internal/mcp, no bearer ──
{
  let written = null;
  const { spawnImpl } = seam({ lines: [result({ result: 'ok', subtype: 'success' })] });
  await mkLoop(spawnImpl, (_p, s) => { written = s; }).run({ system: 'S', userMessage: 'hi', send: () => {} });
  const cfg = JSON.parse(written);
  const m = cfg?.mcpServers?.mycelium;
  rec('CL5 mcp-config → loopback /internal/mcp, type:http, no bearer',
    m?.type === 'http' && m?.url === 'http://127.0.0.1:8799/internal/mcp' && !('headers' in (m || {})) && !written.toLowerCase().includes('authorization'),
    written);
  // and the pure builder matches
  rec('CL5 buildMcpConfig pure', buildMcpConfig(8799).mcpServers.mycelium.url === 'http://127.0.0.1:8799/internal/mcp');
}

// ── CL6 — abort → SIGTERM + aborted ──
{
  const ctrl = new AbortController();
  const { spawnImpl, cap } = seam({ autoClose: false });   // stays open until killed
  const p = mkLoop(spawnImpl).run({ system: 'S', userMessage: 'hi', send: () => {}, signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 5));
  ctrl.abort();
  const r = await p;
  rec('CL6 abort → SIGTERM + aborted + clientGone', cap.child._killed === 'SIGTERM' && r.aborted === true && r.clientGone === true, JSON.stringify(r));
}

// ── CL7 — spawn error resolves (never throws) ──
{
  const { spawnImpl } = seam({ error: true });
  let threw = false; let r = null;
  try { r = await mkLoop(spawnImpl).run({ system: 'S', userMessage: 'hi', send: () => {} }); } catch { threw = true; }
  rec('CL7 spawn error resolves with lastErr (no throw)', !threw && r && r.lastErr instanceof Error && r.text === '', threw ? 'threw' : JSON.stringify(r?.lastErr?.message));
}

// ── CL8-11 — session continuity (--session-id create / --resume continue) ──
const pairIn = (cap, flag, val) => { const i = cap.args.indexOf(flag); return i >= 0 && cap.args[i + 1] === val; };
{
  // resume an existing session → --resume <id>, NOT --session-id
  const { spawnImpl, cap } = seam({ lines: [result({ result: 'ok', subtype: 'success' })] });
  const r = await mkLoop(spawnImpl).run({ system: 'S', userMessage: 'hi', send: () => {}, sessionId: 'S1', resume: true });
  rec('CL8 resume=true → --resume <id>, no --session-id', pairIn(cap, '--resume', 'S1') && !cap.args.includes('--session-id'), cap.args.join(' '));
  rec('CL8 result carries sessionId + sessionError=false on a clean turn', r.sessionId === 'S1' && r.sessionError === false, JSON.stringify({ s: r.sessionId, e: r.sessionError }));
}
{
  // first turn (create) → --session-id <id>, NOT --resume
  const { spawnImpl, cap } = seam({ lines: [result({ result: 'ok', subtype: 'success' })] });
  const r = await mkLoop(spawnImpl).run({ system: 'S', userMessage: 'hi', send: () => {}, sessionId: 'S2', resume: false });
  rec('CL9 resume=false → --session-id <id>, no --resume', pairIn(cap, '--session-id', 'S2') && !cap.args.includes('--resume'), cap.args.join(' '));
  rec('CL9 created session echoed back', r.sessionId === 'S2', JSON.stringify(r.sessionId));
}
{
  // no sessionId → legacy one-shot: neither flag; result.sessionId null
  const { spawnImpl, cap } = seam({ lines: [result({ result: 'ok', subtype: 'success' })] });
  const r = await mkLoop(spawnImpl).run({ system: 'S', userMessage: 'hi', send: () => {} });
  rec('CL10 no sessionId → no --session-id/--resume + result.sessionId null', !cap.args.includes('--session-id') && !cap.args.includes('--resume') && r.sessionId === null, cap.args.join(' '));
}
{
  // claude reports a missing session as an is_error RESULT (real stream-json shape,
  // verified live) → result.sessionError=true so the caller self-heals.
  const { spawnImpl } = seam({ lines: [result({ subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: S3'] })] });
  const r = await mkLoop(spawnImpl).run({ system: 'S', userMessage: 'hi', send: () => {}, sessionId: 'S3', resume: true });
  rec('CL11 session-not-found (is_error result) → result.sessionError=true', r.sessionError === true, JSON.stringify(r));
}
{
  // FALSE-POSITIVE GUARD (review LOW): the model's own answer quoting "already in use"
  // must NOT flip sessionError — the match is scoped to the is_error result, not text.
  const { spawnImpl } = seam({ lines: [textDelta('That port is already in use, try another.'), result({ result: 'That port is already in use, try another.', subtype: 'success' })] });
  const r = await mkLoop(spawnImpl).run({ system: 'S', userMessage: 'hi', send: () => {}, sessionId: 'S4', resume: true });
  rec('CL12 benign answer quoting "already in use" → sessionError stays false', r.sessionError === false, JSON.stringify({ e: r.sessionError, t: r.text }));
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — claude-cli engine: stream-json mapping · secure flags (mcp__mycelium__* only, no skip-permissions) · loopback mcp-config · stdin prompt · SIGTERM abort · error-safe · session --resume/--session-id continuity' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

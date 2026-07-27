// verify:model-honesty — the app must never claim a model that didn't answer.
//
// The repo documents the lie it is guarding (src/inference/claude-config-dir.js:101-105):
//   "…silently downgraded the turn to local/EU qwen while the activity feed still
//    recorded claude-opus-4-8."
// Two separate masks existed:
//   • the RETURN value (fixed earlier: run-turn.js prefers out.actualModel), and
//   • the PERSISTED label — run-turn's `call` closure ran INSIDE the turn and could only
//     see the PRE-TURN primary, so a fallen-back turn stamped messages.model with the
//     model the user *chose*, not the one that answered. That is what H2/H3 guard.
//
//   H1 the loop's fallback event carries the new MODEL (not just a label)
//   H2 ⭐ a transient fallback stamps the reply with the model that ACTUALLY answered
//   H3 no fallback → the primary is stamped (unchanged behavior)
//   H4 ⭐ an AUTH failure never reaches the reply tool at all (no answer, no false label)
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
process.env.MYCELIUM_BACKOFF_BASE_MS = '1';   // shrink backoff so retries don't slow the gate
process.env.MYCELIUM_BACKOFF_CAP_MS = '2';
const { createAgentLoop } = await import('../src/agent/loop.js');

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const err = (status) => { const e = new Error('provider'); e.status = status; return e; };

// REAL provider-config shapes — describeProvider(cfg) keys off a credential field and
// reads cfg.cloudModel (NOT cfg.model). Using a toy {model} shape makes describeProvider
// return null and the test silently proves nothing.
const CLAUDE = { claudeOAuthToken: 'sk-ant-oat-x', cloudModel: 'claude-opus-4-8', jurisdiction: 'us-standard', providerName: 'claude_subscription' };
const QWEN   = { openaiApiKey: 'k', baseUrl: 'http://127.0.0.1:11434/v1', cloudModel: 'qwen-local', jurisdiction: 'local' };
const mdl = (p) => p?.cloudModel;

// A fake harness that (a) may throw per provider, (b) invokes the `reply` tool so we can
// observe the label the caller stamps — mirroring a real channel turn's delivery path.
function makeLoop(behavior) {
  const harness = { streamTurn: async ({ provider, call, send }) => {
    const b = behavior(provider) || {};
    if (b.throw) throw b.throw;
    if (call) await call('reply', { text: 'hi' });
    send?.({ type: 'text_delta', content: 'x' });
    return { toolsUsed: ['reply'] };
  } };
  return createAgentLoop({ harness });
}
// Mirror run-turn.js's live-model tracking + `call` closure.
function runWithLiveLabel({ primaryModel, chain, behavior }) {
  const stamped = [];
  const live = { model: primaryModel };
  const loop = makeLoop(behavior);
  const call = async (tool, args) => { if (tool === 'reply') stamped.push(live.model); return 'sent'; };
  return loop.run({
    provider: chain[0], providerChain: chain, system: '', userMessage: 'x', maxRetries: 2,
    tools: [{ name: 'reply' }], call,
    send: (e) => { if (e?.type === 'fallback' && e.toModel) live.model = e.toModel; },
  }).then((r) => ({ r, stamped }));
}

// ── H1 the fallback event carries the model ──────────────────────────────────────
{
  const ev = [];
  const loop = makeLoop((p) => mdl(p) === 'claude-opus-4-8' ? { throw: err(429) } : {});
  await loop.run({
    provider: CLAUDE, providerChain: [CLAUDE, QWEN],
    system: '', userMessage: 'x', maxRetries: 2, send: (e) => ev.push(e),
  });
  const fb = ev.find((e) => e.type === 'fallback');
  rec('H1 fallback event carries toModel (not just a label)', !!fb && fb.toModel === 'qwen-local', `event=${JSON.stringify(fb)}`);
}

// ── H2 ⭐ a transient fallback stamps the ACTUAL model ────────────────────────────
{
  const { r, stamped } = await runWithLiveLabel({
    primaryModel: 'claude-opus-4-8',
    chain: [CLAUDE, QWEN],
    behavior: (p) => mdl(p) === 'claude-opus-4-8' ? { throw: err(429) } : {},   // transient → cascades
  });
  rec('H2 ⭐ fallen-back turn stamps the model that ACTUALLY answered (not the primary)',
    r.fellBack === true && stamped.length === 1 && stamped[0] === 'qwen-local',
    `stamped=${JSON.stringify(stamped)} fellBack=${r.fellBack}`);
}

// ── H3 no fallback → primary stamped (unchanged) ─────────────────────────────────
{
  const { r, stamped } = await runWithLiveLabel({
    primaryModel: 'claude-opus-4-8',
    chain: [CLAUDE, QWEN],
    behavior: () => ({}),
  });
  rec('H3 no fallback → the primary is stamped (behavior unchanged)',
    r.fellBack === false && stamped[0] === 'claude-opus-4-8', `stamped=${JSON.stringify(stamped)}`);
}

// ── H4 ⭐ auth never answers at all → no reply, no false label ────────────────────
{
  const { r, stamped } = await runWithLiveLabel({
    primaryModel: 'claude-opus-4-8',
    chain: [CLAUDE, QWEN],
    behavior: (p) => mdl(p) === 'claude-opus-4-8' ? { throw: err(401) } : {},   // auth → must NOT cascade
  });
  rec('H4 ⭐ auth 401 → no reply delivered, no fallback, nothing mislabelled',
    r.fellBack === false && stamped.length === 0,
    `stamped=${JSON.stringify(stamped)} fellBack=${r.fellBack}`);
}

// ── H5 ⭐ an auth failure is LOUD at the channel boundary, not a silent no-reply ──
// Killing the silent downgrade is only half the job: if an expired subscription then
// surfaces as reason:'no-reply' + degraded:false, it is indistinguishable from a triage
// "nothing worth answering" skip — the owner gets silence on Telegram with no alert.
// That would trade a silently-DOWNGRADED reply for a silently MISSING one. The loop must
// hand back a classifiable lastErr so channel-turn can report reason:'auth'.
{
  const { classifyProviderError } = await import('../src/agent/provider-errors.js');
  const loop = makeLoop((p) => mdl(p) === 'claude-opus-4-8' ? { throw: err(401) } : {});
  const r = await loop.run({
    provider: CLAUDE, providerChain: [CLAUDE, QWEN], system: '', userMessage: 'x', maxRetries: 1,
  });
  // Mirror channel-turn.js's classification of the turn result.
  const usedReplyTool = false;                       // auth broke before any reply
  const authFailed = !usedReplyTool && classifyProviderError(r?.lastErr)?.reason === 'auth';
  const reason = usedReplyTool ? 'replied' : (authFailed ? 'auth' : 'no-reply');
  rec('H5 ⭐ auth failure is reported as reason:"auth" (loud) — never a silent "no-reply"',
    r.lastErr?.status === 401 && authFailed === true && reason === 'auth' && r.fellBack === false,
    `lastErr=${r.lastErr?.status} reason=${reason} fellBack=${r.fellBack}`);
}

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — model honesty: the label follows the model that answered · auth fails loudly, never silently');

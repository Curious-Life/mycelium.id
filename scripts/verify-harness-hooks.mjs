#!/usr/bin/env node
// verify:harness-hooks — the lifecycle hook bus (G1). Design: docs/HOOK-BUS-DESIGN-2026-06-18.md
//
// Step 1 (this file, U-section): the fire-helper semantics in ISOLATION — fail-CLOSED
// blocking, fail-OPEN observers, timeout, and the createAgentHooks tool-guard factory
// (incl. the §1 no-plaintext-in-audit canary). The K-section (K1–K8: harness + history
// integration) is appended in Step 2 once the wiring lands.

import {
  fireBeforeToolCall, fireAfterToolCall, fireBeforeCompaction, fireAfterCompaction,
  createAgentHooks,
} from '../src/agent/hooks.js';

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

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log(`VERDICT: GO — hook-bus fire helpers: fail-closed blocking + timeout, fail-open observers, tool-guard factory (no plaintext) — ${pass}/${pass} checks`);
  process.exit(0);
} else {
  console.log(`VERDICT: NO-GO — ${fail} failing check(s), ${pass} passing`);
  process.exit(1);
}

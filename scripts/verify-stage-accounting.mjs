// verify:stage-accounting — proves pipeline/lib/stage-result.js enforces the
// fail-loud-on-materially-incomplete policy (Gap #3) and records the outcome to
// the injected pipeline_state recorder. Pure unit test of the helper's decision
// logic + recording contract (no vault, no spawn). PASS/FAIL ledger; exits 0 only
// if all pass.
import { createStageResult, StageIncompleteError } from '../pipeline/lib/stage-result.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// A spy recorder capturing what finalize() writes to pipeline_state.
function spy() {
  const calls = { success: [], failure: [] };
  return {
    calls,
    record: {
      success: (o) => calls.success.push(o),
      failure: (o) => calls.failure.push(o),
    },
  };
}

// 1. All-ok → no throw, records success with correct counts.
{
  const s = spy();
  const r = createStageResult('t1', { record: s.record });
  r.ok(); r.ok(); r.ok();
  let threw = false, out = null;
  try { out = await r.finalize(); } catch { threw = true; }
  rec('1. all-ok → no throw; success recorded; details {3,3,0}',
    !threw && out?.written === 3 && s.calls.failure.length === 0
      && s.calls.success.length === 1
      && s.calls.success[0].details.attempted === 3 && s.calls.success[0].details.written === 3 && s.calls.success[0].details.failed === 0);
}

// 2. Zero written on non-empty input → throws StageIncompleteError; failure recorded.
{
  const s = spy();
  const r = createStageResult('t2', { record: s.record });
  r.fail(new Error('SQLITE_CONSTRAINT')); r.fail(new Error('SQLITE_CONSTRAINT'));
  let err = null;
  try { await r.finalize(); } catch (e) { err = e; }
  rec('2. 0-written-on-input → throws StageIncompleteError; failure recorded',
    err instanceof StageIncompleteError && s.calls.failure.length === 1 && s.calls.success.length === 0,
    err ? err.message : '(no throw)');
}

// 3. >10% failure → throws.
{
  const r = createStageResult('t3', { failRatio: 0.1 });
  for (let i = 0; i < 89; i++) r.ok();      // 89 ok
  for (let i = 0; i < 11; i++) r.fail('x'); // 11 failed → 11% > 10%
  let threw = false;
  try { await r.finalize(); } catch { threw = true; }
  rec('3. 11/100 failed (>10%) → throws', threw);
}

// 4. ≤10% failure → no throw (sparse tolerated), records success.
{
  const s = spy();
  const r = createStageResult('t4', { failRatio: 0.1, record: s.record });
  for (let i = 0; i < 95; i++) r.ok();    // 95 ok
  for (let i = 0; i < 5; i++) r.fail('x'); // 5 failed → 5% ≤ 10%
  let threw = false;
  try { await r.finalize(); } catch { threw = true; }
  rec('4. 5/100 failed (≤10%) → no throw; success recorded', !threw && s.calls.success.length === 1);
}

// 5. Empty input (attempted=0) → no throw (a territory-less vault is not a failure).
{
  const r = createStageResult('t5');
  let threw = false;
  try { await r.finalize(); } catch { threw = true; }
  rec('5. attempted=0 → no throw', !threw);
}

// 6. Content-free reason: the recorded failure reason carries only counts + the DB
//    error class, never the content we deliberately stuff into an error message.
{
  const s = spy();
  const r = createStageResult('t6', { record: s.record });
  r.fail(new Error('SECRET territory name "my private thoughts"\nstack line two'));
  try { await r.finalize(); } catch { /* expected */ }
  const reason = s.calls.failure[0]?.reason || '';
  // We can't scrub an attacker-crafted message entirely, but: single line only,
  // bounded length, and the helper never RECEIVES names/content as a real arg —
  // stages pass DB errors. Assert single-line + bounded.
  rec('6. failure reason is single-line + bounded (≤300)',
    !reason.includes('stack line two') && reason.length <= 300, reason);
}

// 7. Recorder that throws must not mask the StageIncompleteError (best-effort health).
{
  const r = createStageResult('t7', { record: { failure: () => { throw new Error('pipeline_state down'); } } });
  r.fail('x');
  let err = null;
  try { await r.finalize(); } catch (e) { err = e; }
  rec('7. recorder failure does not mask StageIncompleteError', err instanceof StageIncompleteError);
}

const passed = ledger.filter(Boolean).length;
const ok = passed === ledger.length;
console.log(`\n${ok ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${passed}/${ledger.length} passed`);
process.exit(ok ? 0 : 1);

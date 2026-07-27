// verify:stage-accounting — proves pipeline/lib/stage-result.js enforces the
// fail-loud-on-materially-incomplete policy (Gap #3) and records the outcome to
// the injected pipeline_state recorder. Pure unit test of the helper's decision
// logic + recording contract (no vault, no spawn). PASS/FAIL ledger; exits 0 only
// if all pass.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { readFileSync } from 'node:fs';
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

// ── COVERAGE: every JS stage the pipeline runs has accounting ────────────────
// ⚠️ THIS CHECK RATCHETS, and it exists because its absence hid a real gap. The helper above
// was well designed and adopted by 17 of 21 stages; the OTHER FOUR (sync-clustering-points,
// describe-clusters, describe-chronicles, snapshot-entities) wrapped every write in try/catch,
// logged, continued and exited 0 — so a systematic failure wrote nothing and reported success.
// This gate was a pure unit test of the helper's decision logic ("no vault, no spawn") and
// therefore could not see any of it.
//
// The stage list is read OUT OF run-clustering.sh, never hardcoded: a stage added tomorrow is
// covered the day it lands, or this REDs. That is the difference between a coverage assertion
// and a snapshot of today.
//
// EXEMPT, with a reason — never a bare skip list:
//   vault-bridge   infrastructure (the Python d1 bridge); writes no metric rows
// The PYTHON stages use the stage_result.py half (pipeline/stage_base.py); this covers JS only.
{
  const sh = readFileSync('pipeline/run-clustering.sh', 'utf8');
  const EXEMPT = new Set(['vault-bridge']);
  const jsStages = [...new Set([...sh.matchAll(/node pipeline\/([a-z0-9-]+)\.js/g)].map((m) => m[1]))]
    .filter((n) => !EXEMPT.has(n));
  // ⚠️ NOT a substring test for 'createStageResult'. The first version was exactly that, and the
  // mutation round walked straight through it: a file that merely MENTIONS the helper — an
  // import it never calls, a comment, a disabled fallback — passed while writing nothing. A
  // stage is instrumented only if it CONSTRUCTS a result AND FINALIZES it; finalize() is what
  // decides the fail-loud verdict and writes pipeline_state, so a stage without it is accounting
  // that nobody reads.
  const missing = jsStages.filter((n) => {
    const src = readFileSync(`pipeline/${n}.js`, 'utf8');
    return !/createStageResult\(/.test(src) || !/\.finalize\(\)/.test(src);
  });
  rec(`8. COVERAGE — every JS stage run-clustering.sh executes has stage accounting (${jsStages.length} found)`,
    jsStages.length >= 6 && missing.length === 0,
    missing.length ? `NO ACCOUNTING: ${missing.join(', ')} — a systematic failure there writes nothing and exits 0`
      : `all ${jsStages.length}: ${jsStages.join(', ')}`);
}

const passed = ledger.filter(Boolean).length;
const ok = passed === ledger.length;
console.log(`\n${ok ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${passed}/${ledger.length} passed`);
process.exit(ok ? 0 : 1);

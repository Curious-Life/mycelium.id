#!/usr/bin/env node
// verify-nul-strip.mjs — the CLI harness must never die on a NUL byte in argv.
//
// LIVE BUG (2026-07-15): every portal chat turn failed with
//   [chat] turn failed: The argument 'args[8]' must be a string without null bytes.
//                       Received 'Your name is altus. Be warm, encouraging...'
// args[8] is `--append-system-prompt` (loop-claude-cli.js:99), assembled from vault
// content. After page-level vault corruption, stray NUL bytes live in text columns
// (observed: 27 rows whose `scope` was 8 NULs). ONE damaged row poisoned the prompt and
// node's spawn rejected the WHOLE turn before the model was reached. This proves the
// boundary sanitizer strips NULs, preserves the text, and keeps spawn working.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { createClaudeCliLoop } from '../src/agent/loop-claude-cli.js';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const NUL = String.fromCharCode(0);
const hasNul = (s) => s.indexOf(NUL) !== -1;

console.log('\nCLI harness NUL-byte sanitation');

t('BASELINE: node spawn genuinely rejects a NUL in argv (the bug is real)', () => {
  let threw = null;
  try { execFileSync('/bin/echo', [`hello${NUL}world`], { stdio: 'ignore' }); } catch (e) { threw = e; }
  assert.ok(threw, 'spawn must reject a NUL arg — otherwise this whole fix is moot');
  assert.match(String(threw.message), /null bytes/i);
});

t('a sanitized arg spawns fine', () => {
  execFileSync('/bin/echo', [`hello${NUL}world`.replace(/\u0000/g, '')], { stdio: 'ignore' });
});

// Drive the REAL loop with a spawn seam so we see the argv it would have used.
function captureArgs(system) {
  let seen = null;
  const fakeChild = {
    stdin: { write() {}, end() {} },
    stdout: { on() {}, setEncoding() {} },
    stderr: { on() {}, setEncoding() {} },
    on(ev, cb) { if (ev === 'close') setImmediate(() => cb(0)); return this; },
    kill() {},
  };
  const loop = createClaudeCliLoop({
    claudeBin: '/bin/echo', restPort: 8787, model: 'sonnet', configDir: null,
    spawnImpl: (_bin, args) => { seen = args; return fakeChild; },
    writeConfigImpl: () => '/tmp/cfg.json',
    cleanupImpl: () => {},
  });
  return { loop, args: () => seen };
}

await (async () => {
  const poisoned = `Your name is altus.${NUL}${NUL} Be warm, encouraging and personable.`;
  const { loop, args } = captureArgs(poisoned);
  try { await loop.run({ system: poisoned, prompt: 'hi', messages: [] }); } catch { /* the fake child ends the turn */ }
  const a = args();
  t('the real loop passes NUL-FREE argv to spawn', () => {
    assert.ok(a, 'spawn was called');
    const dirty = a.filter((v) => typeof v === 'string' && hasNul(v));
    assert.deepEqual(dirty, [], `argv still contains NUL(s): ${JSON.stringify(dirty)}`);
  });
  t('the system prompt TEXT survives (sanitation is lossless for real text)', () => {
    const sys = a[a.indexOf('--append-system-prompt') + 1];
    assert.ok(sys.includes('Your name is altus.'), 'text kept');
    assert.ok(sys.includes('Be warm, encouraging and personable.'), 'text kept');
    assert.equal(hasNul(sys), false);
  });
  t('that exact argv is now spawnable (the turn would no longer die)', () => {
    execFileSync('/bin/echo', a.filter((v) => typeof v === 'string'), { stdio: 'ignore' });
  });
})();

console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
// verify:detect-offloop — D-126: the import detection sweep can NEVER freeze the server.
//
// THE DEFECT (live-reproduced 2026-07-30): GET /portal/import/detect ran detectSources()
// — a synchronous recursive readdirSync walk — on the event loop. One iCloud-evicted
// (dataless) CoreML bundle under ~/Documents wedged that walk inside `__getdirentries64`
// indefinitely: 2543/2543 main-thread samples in the syscall, every other endpoint
// head-of-line-blocked, the whole app reading "Load failed". Depth/file caps cannot help
// — they are consulted BETWEEN readdirSync calls, and the wedge is one call never
// returning. Only process isolation makes the scan killable.
//
// WHAT THIS GATE PROVES:
//   O1  the off-loop scan returns real detection results from a real child process
//   O2  a WEDGED child cannot block the caller: detectSourcesOffLoop resolves on its
//       own deadline (timedOut:true) without waiting for the child to die, and the
//       event loop stays live throughout (measured tick delay)
//   O3  the compiled-bundle skip list keeps both walks OUT of model/app bundles —
//       a .mlmodelc tree full of files is neither counted nor descended
//   O4  the route runs the scan off-loop (source wiring: no bare detectSources() call
//       left in the /import/detect handler)
//   O5  (control for O3) the same files OUTSIDE a bundle dir ARE counted — proves O3
//       is non-vacuous
//
// MUTATION-TESTED: (D-126, 2026-08-03) the deadline in detectSourcesOffLoop was disabled
// (timer callback body emptied) → O2 REDs (gate's own 5s guard trips, loop-liveness
// assertion fails: the call never resolves). Restored → GREEN.
// MUTATION-TESTED: (D-126, 2026-08-03) isCompiledBundleDir reverted to `return false`
// → O3 REDs (the .mlmodelc tree's files land in the tally) while O5 stays GREEN.
// Restored → GREEN.
// MUTATION-TESTED: (D-126, 2026-08-03) the /import/detect route rewired to the bare
// synchronous `detectSources()` → O4 REDs. Restored → GREEN.
// MUTATION-TESTED: (D-126, 2026-08-03, post-review) the child env reverted to the
// full parent env (`env: process.env` — the exact pre-review code) → O6 REDs with the
// leaked sentinel keys named (ENCRYPTION_MASTER_KEY, USER_MASTER, …). Restored → GREEN.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { detectSourcesOffLoop, countByCategory } from '../src/ingest/detect-sources.js';
import { isSkippedSweepDir, isCompiledBundleDir } from '../src/ingest/file-categories.js';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

const root = mkdtempSync(join(tmpdir(), 'myc-detect-'));
const mk = (...p) => { const d = join(root, ...p); mkdirSync(d, { recursive: true }); return d; };

console.log('\nD-126 — detection sweep off the event loop');

// ── O1: real child, real results ─────────────────────────────────────────────
await t('O1: off-loop scan spawns a real child and returns detection results', async () => {
  // A fixture HOME with a Claude Code transcript dir — the cheapest detector to satisfy.
  const home = mk('home1');
  const proj = mk('home1', '.claude', 'projects', 'p1');
  writeFileSync(join(proj, 's1.jsonl'), '{"role":"user"}\n');
  // The child reads os.homedir() — steer it via HOME for the spawned process only.
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const r = await detectSourcesOffLoop({ timeoutMs: 20_000 });
    assert.equal(r.timedOut, false, 'must not time out on a tiny fixture');
    assert.ok(Array.isArray(r.sources), 'sources array');
    assert.ok(r.sources.some((s) => s.source === 'claude-code' && s.count === 1),
      `child must find the fixture transcript (got: ${JSON.stringify(r.sources.map((s) => s.source))})`);
  } finally { process.env.HOME = prevHome; }
});

// ── O2: a wedged child cannot block the caller ───────────────────────────────
await t('O2: a WEDGED child resolves on the deadline; the event loop stays live', async () => {
  // A child that blocks forever inside a SYNCHRONOUS call — the dataless-dir shape:
  // no output, no exit, and (like a syscall) not interruptible from its own JS.
  const wedge = join(root, 'wedged-child.js');
  writeFileSync(wedge, `
    // simulate the __getdirentries64 wedge: a sync sleep that never yields
    const buf = new Int32Array(new SharedArrayBuffer(4));
    for (;;) Atomics.wait(buf, 0, 0, 60_000);
  `);
  // Liveness probe: the event loop must keep ticking while the scan waits.
  let ticks = 0;
  const probe = setInterval(() => { ticks++; }, 50);
  const started = Date.now();
  const r = await Promise.race([
    detectSourcesOffLoop({ timeoutMs: 700, childPath: pathToFileURL(wedge) }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('detectSourcesOffLoop never resolved — the deadline is gone (the D-126 regression)')), 5000)),
  ]);
  clearInterval(probe);
  const elapsed = Date.now() - started;
  assert.equal(r.timedOut, true, 'must report the timeout honestly');
  assert.deepEqual(r.sources, [], 'a timed-out scan returns no fabricated sources');
  assert.ok(elapsed < 3000, `resolved in ${elapsed}ms — must be ~timeoutMs, not the child's lifetime`);
  assert.ok(ticks >= 5, `event loop ticked ${ticks}× during the wait — it must stay live`);
});

// ── O3 + O5: the bundle skip list, behaviorally ─────────────────────────────
await t('O3: a .mlmodelc tree full of files is neither counted nor descended', async () => {
  const docs = mk('home2', 'Documents');
  const model = mk('home2', 'Documents', 'whisper', 'TextDecoder.mlmodelc');
  for (let i = 0; i < 20; i++) writeFileSync(join(model, `weight${i}.txt`), 'x');
  writeFileSync(join(docs, 'real-note.txt'), 'hello');
  const tally = countByCategory(docs);
  assert.equal(tally.document?.count, 1, `only the loose note counts (got ${tally.document?.count})`);
  assert.ok(isSkippedSweepDir('TextDecoder.mlmodelc'), 'mlmodelc skipped');
  assert.ok(isSkippedSweepDir('Foo.framework') && isSkippedSweepDir('Some.app') && isSkippedSweepDir('huggingface'), 'framework/app/huggingface skipped');
  assert.ok(!isSkippedSweepDir('Projects') && !isSkippedSweepDir('models of governance'), 'ordinary dirs still walked');
  assert.ok(isCompiledBundleDir('x.mlpackage') && !isCompiledBundleDir('report.pdf'), 'suffix test is directory-bundle-shaped');
});

await t('O5 (control): the same files OUTSIDE a bundle dir ARE counted — O3 is non-vacuous', async () => {
  const docs = mk('home3', 'Documents');
  const plain = mk('home3', 'Documents', 'whisper', 'TextDecoderPlain');
  for (let i = 0; i < 20; i++) writeFileSync(join(plain, `weight${i}.txt`), 'x');
  const tally = countByCategory(docs);
  assert.equal(tally.document?.count, 20, `a NON-bundle dir's files must count (got ${tally.document?.count})`);
});

// ── O6: the child is KEYLESS — an explicit env allowlist, never the parent env ──
await t('O6: the spawned child inherits NO key material (allowlist env; §4 discipline)', async () => {
  // Found by independent security review (2026-08-03): the first cut passed
  // `env: process.env`, and boot pins the vault MASTER KEY into the server's env — so
  // every scan put the key into a new process. The probe child reports its actual env
  // keys through TMPDIR (which IS allowlisted, proving the allowlist works both ways).
  const probe = join(root, 'env-probe.js');
  const probeOut = join(root, 'env-probe-out.json');
  writeFileSync(probe, `
    import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(probeOut)}, JSON.stringify(Object.keys(process.env)));
    process.stdout.write(JSON.stringify({ ok: true, sources: [], blocked: [] }));
  `);
  const SENTINELS = ['ENCRYPTION_MASTER_KEY', 'USER_MASTER', 'SYSTEM_KEY', 'MYCELIUM_USER_HEX', 'MYCELIUM_SYSTEM_HEX'];
  const prev = {};
  for (const k of SENTINELS) { prev[k] = process.env[k]; process.env[k] = 'aa'.repeat(32); }
  try {
    const r = await detectSourcesOffLoop({ timeoutMs: 20_000, childPath: pathToFileURL(probe) });
    assert.equal(r.timedOut, false, 'probe ran');
    const keys = JSON.parse(readFileSync(probeOut, 'utf8'));
    const leaked = SENTINELS.filter((k) => keys.includes(k));
    assert.deepEqual(leaked, [], `key material reached the child env: ${leaked.join(', ')}`);
    assert.ok(keys.includes('HOME') && keys.includes('PATH'), 'the allowlist itself works (HOME/PATH present)');
  } finally {
    for (const k of SENTINELS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
});

// ── O4: the route is wired off-loop ──────────────────────────────────────────
await t('O4: /import/detect awaits detectSourcesOffLoop — no bare sync call left in the route', async () => {
  const src = readFileSync('src/portal-import.js', 'utf8');
  const routeStart = src.indexOf(`router.get('/import/detect'`);
  assert.ok(routeStart > 0, 'route present');
  const routeBody = src.slice(routeStart, src.indexOf('});', routeStart) + 3);
  assert.ok(/await\s+detectSourcesOffLoop\s*\(/.test(routeBody), 'route must await the off-loop scan');
  assert.ok(!/[^a-zA-Z]detectSources\s*\(/.test(routeBody), 'no bare synchronous detectSources() in the route');
  assert.ok(!src.match(/^import .*\bdetectSources\b[^O]/m), 'the sync symbol is not even imported by the router');
});

try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
console.log(`\nVERDICT: ${fail === 0 ? 'GO — the detection sweep runs in a killable child with a hard deadline; a wedged\n        scan costs one orphaned process, never the server. NOT PROVEN: behaviour on a real\n        iCloud-dataless dir (needs a Mac with an evicted bundle — the skip list makes the walk\n        never enter one, which is the first line of defence).' : 'NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

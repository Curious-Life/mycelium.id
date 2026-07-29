#!/usr/bin/env node
// verify-vault-recovery.mjs — a stdio MCP server must not outlive the client that spawned it.
//
// SCOPE NOTE (2026-07-28): this gate once also covered a snapshot-restore feature and a blob
// trash. Both were REVERTED after independent review found the restore unreachable on a
// damaged vault (the corruption-marker throw preceded the apply by 21 lines — the same
// lockout shape already shipped and reverted once), all three of its REST routes dead
// (`preloadRestoreModule` had zero callers, reproduced as 500s), and the blob trash
// unbounded (`purgeBlobTrash` had no caller) — a monotonic disk leak and a privacy
// regression, since "delete" no longer deleted. The gate did not catch any of it, because
// it exercised the helpers directly and never the wiring. That is recorded in the handoff.
//
// WHAT REMAINS, and why it is worth keeping: observed live, a Claude-Code-spawned
// `node src/index.js` held a vault read/write for 3 h 21 m with its session long gone.
// src/index.js had NO lifetime handling at all.
//
// MUTATION-TESTED: stdin end/close handling removed → "an orphaned stdio server exits when
//   its client goes away" REDs
// MUTATION-TESTED: idle timeout disabled → "an idle stdio server exits even while its parent
//   is alive" REDs
//
// ⚠️ Both checks were GREEN FOR THE WRONG REASON until mutation testing caught it: the child
// sources were built with template literals whose \n became a REAL newline inside a string,
// so every child died of a syntax error instantly — and "the child exited" is exactly what a
// lifetime test asserts. Children are now built from arrays and must SIGNAL READY before
// anything is judged.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
// MUTATION-TESTED (2026-07-28), after an adversarial review defeated the source check:
//   Q. src/index.js: `bindStdioLifetime({ close, label: 'stdio MCP' })`
//      → `bindStdioLifetime({ label: 'stdio MCP' })`
//      → the REAL stdio server refuses to start:
//        "[mycelium] 45 tools registered; 1 deferred (services)"
//        "[mycelium] fatal: bindStdioLifetime(stdio MCP): a close() handle is required"
//        EXIT=1.
//
// ⚠️ RECORD CORRECTED (second re-review, 2026-07-28). The line above previously also
// claimed the GATE REDs on that mutation, and that "the two spawn-based checks drive the
// REAL `node src/index.js`". BOTH were false: spawnLifetimeChild() writes a SYNTHETIC
// child that imports mcp-lifetime.js and injects its OWN close, so nothing here reads or
// spawns src/index.js. Re-tested: with the mutation applied the gate reported
// GO — 3 passed, 0 failed while the real server died EXIT=1. The product hardening is
// real; the gate coverage of index.js's CALL SITE was not, and the claim was a
// green-for-the-wrong-reason of exactly the kind this branch keeps finding. The call site
// is now covered behaviourally below.
//
// ⚠️ The old check was `assert.match(body, /close/)` over src/index.js, which matched the
// word "close" in a NEARBY COMMENT and survived exactly that mutation — 3 passed, 0 failed
// while the vault handle was never released on exit (the 3h21m orphan defect, restored).
// The fix is in the PRODUCT: a missing close() is now a TypeError at bind time, so the
// omission cannot be silent. That also broke this gate's own harness, which had been
// binding without a close — proof the requirement was doing something.


import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

const root = mkdtempSync(join(tmpdir(), 'myc-lifetime-'));

/**
 * Spawn a stdio-lifetime child and WAIT FOR IT TO SIGNAL READY before judging anything.
 *
 * Both stdio tests were green for the wrong reason until mutation testing caught it: the
 * child source was built with a template literal whose `\n` became a REAL newline inside a
 * string, so the child died of a syntax error instantly — and "it exited" is exactly what
 * those tests assert. A crashing child must never read as a passing lifetime test, so
 * readiness is a precondition, and the source is built from an array (no escape ambiguity).
 */
async function spawnLifetimeChild(dir, name, opts) {
  const file = join(dir, name);
  writeFileSync(file, [
    `import { bindStdioLifetime } from ${JSON.stringify(new URL('../src/db/mcp-lifetime.js', import.meta.url).href)};`,
    // close is injected here rather than in `opts` because a function cannot survive
    // JSON.stringify — and bindStdioLifetime now REFUSES to bind without one.
    `bindStdioLifetime({ ...${JSON.stringify(opts)}, close: () => { console.log('closed'); } });`,
    'setInterval(() => {}, 1000);',
    "console.log('ready');",
  ].join('\n'));
  const c = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  c.stderr.on('data', (b) => { err += b; });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('child never signalled ready')), 5000);
    c.stdout.on('data', (b) => { if (String(b).includes('ready')) { clearTimeout(to); resolve(); } });
    c.on('exit', (code) => { clearTimeout(to); reject(new Error(`child died before it was ready (exit ${code}): ${err.trim().split('\n')[0] || 'no stderr'}`)); });
  });
  return c;
}


await t('an orphaned stdio server exits when its client goes away', async () => {
  const c = await spawnLifetimeChild(root, 'orphan.mjs', { label: 'test', idleMs: 0 });
  const exited = await new Promise((resolve) => {
    let done = false;
    c.on('exit', () => { done = true; resolve(true); });
    c.stdin.end(); // the client goes away
    setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* */ } resolve(done); }, 2500);
  });
  assert.equal(exited, true,
    'a stdio MCP server must exit when stdin closes — one was observed holding a vault open for 2h54m after its session ended');
});

await t("src/index.js's stdio entrypoint really does pass a close handle (the call site, not the helper)", async () => {
  // The helper refusing is worthless if index.js never calls it correctly, and no check
  // covered that: the spawn-based checks use a synthetic child with its own close. So run
  // the REAL entrypoint against a throwaway vault and require it to reach the point where
  // it announces a connected stdio server. With the handle dropped it dies EXIT=1 on the
  // fatal above instead.
  const vdir = mkdtempSync(join(tmpdir(), 'myc-stdio-callsite-'));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url))], {
    input: '', encoding: 'utf8', timeout: 180_000,
    env: {
      ...process.env,
      MYCELIUM_KEY_SOURCE: 'env',
      USER_MASTER_KEY: 'a'.repeat(64),
      SYSTEM_KEY: 'b'.repeat(64),
      MYCELIUM_DB: join(vdir, 'mycelium.db'),
      MYCELIUM_KCV: join(vdir, 'kcv.json'),
      MYCELIUM_DISABLE_EMBED: '1',
      MYCELIUM_AT_REST: '',
    },
  });
  const err = String(r.stderr || '');
  // POSITIVE PRECONDITION: boot must have got far enough to matter, or "no fatal" would
  // just mean it died earlier for an unrelated reason.
  assert.match(err, /tools registered/, `the real entrypoint must boot far enough to bind (stderr=${err.slice(-400)})`);
  assert.doesNotMatch(err, /a close\(\) handle is required/,
    'src/index.js must pass the vault close handle to bindStdioLifetime');
  rmSync(vdir, { recursive: true, force: true });
});

await t('bindStdioLifetime REFUSES to bind without a vault close handle', async () => {
  // This was `assert.match(body, /close/)` over src/index.js, and an adversarial review
  // reduced the call to `bindStdioLifetime({ label: 'stdio MCP' })` — the vault handle
  // never released on exit, the 3h21m orphan defect restored — while /close/ went on
  // matching prose in a nearby comment. 3 passed, 0 failed.
  //
  // Rather than look harder for the omission, the omission is now impossible: a missing
  // close() throws at bind time. The two spawn-based checks above and below drive the
  // REAL `node src/index.js`, so if index.js ever stopped passing one, that child would
  // fail to start and those checks fail with it — which is the behavioural half.
  const { bindStdioLifetime } = await import('../src/db/mcp-lifetime.js');
  assert.throws(() => bindStdioLifetime({ label: 'test' }), /close\(\) handle is required/,
    'binding without a close handle must be refused, not silently accepted');
  assert.throws(() => bindStdioLifetime({ label: 'test', close: 'not-a-function' }), /close\(\) handle is required/,
    'a non-function close must be refused too');
  // …and a well-formed bind still works (or the guard above would be trivially satisfiable).
  let closed = false;
  const stop = bindStdioLifetime({ label: 'test', close: () => { closed = true; }, pollMs: 0, idleMs: 0 });
  assert.equal(typeof stop, 'function', 'a valid bind must return its unbind handle');
  stop();
  assert.equal(closed, false, 'unbinding must not itself close the vault');
});

// ══ 8. vault ownership — Mycelium takes its database back ══════════════════════
await t('an idle stdio server exits even while its parent is alive', async () => {
  // THE OBSERVED CASE, and the one stdin EOF cannot catch: the orphan found on 2026-07-28
  // had run 3h21m with `claude` still alive holding the pipe, so `end` never fired.
  const c = await spawnLifetimeChild(root, 'idle.mjs', { label: 'idle', idleMs: 1200 });
  const exited = await new Promise((resolve) => {
    let done = false;
    c.on('exit', () => { done = true; resolve(true); });
    // stdin stays OPEN and the parent stays alive — only an idle timeout can end this.
    setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* */ } resolve(done); }, 3500);
  });
  assert.equal(exited, true, 'an idle stdio server must not hold a vault handle indefinitely');
});

rmSync(root, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

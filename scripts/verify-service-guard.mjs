#!/usr/bin/env node
// verify:service-guard — U3: pipeline supervisors stop crash-looping on a held
// port; orphan reap is SAFETY-GATED; restarts are bounded.
//
// Incident (2026-07-18): orphan services from a previous app boot held :8093/
// :8094/:8091; every supervisor spawn died at bind (Errno 48) and "restart #N
// scheduled" repeated ~170×/day — no orphan detection, no bound, no health story.
//
// Module units (src/system/service-guard.js):
//   G1  bind-conflict classifier
//   G2  port-holder inspection (stubbed lsof/ps)
//   G3  own-orphan proof — the SAFETY-CRITICAL clause: exact script + port in the
//       command line AND outside our process tree; anything unprovable → false
//   G4  reap: own orphan → SIGTERM(+KILL) and reaped; FOREIGN → kill NEVER called
//   G5  restart governor: 15s→2min doubling, halt after N straight, success resets,
//       halt(reason)/resume()
//
// Supervisor wiring (REAL supervisors, injected spawn/probe/reap):
//   E*  embed:      conflict exit → reap consulted with the right identity; reaped →
//       bind retried; foreign → health 'down' + content-free reason + NO respawn
//       (halted); nudge() resumes; a plain crash engages the ≥15s backoff (the old
//       code would have respawned within ~3s — the window assert distinguishes)
//   T*  transcribe: foreign holder → down + halted; nudge resumes
//   Q*  qwen3-tts:  conflict → foreign → down + halted (fast ticks)
// PASS/FAIL ledger; exit 0 only on full GO.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { EventEmitter } from 'node:events';
import {
  looksLikePortConflict, inspectPortHolder, isOwnOrphan, reapOwnOrphanOnPort, createRestartGovernor,
} from '../src/system/service-guard.js';

const ledger = [];
let allPass = true;
const check = (n, c, d = '') => { const ok = !!c; allPass = allPass && ok; ledger.push(`[${ok ? '✓' : '✗'}] ${n}${d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── G1: conflict classifier ──────────────────────────────────────────────────
check('G1. classifies Errno 48 / EADDRINUSE / "Address already in use"',
  looksLikePortConflict('OSError: [Errno 48] Address already in use')
  && looksLikePortConflict('Error: listen EADDRINUSE: address already in use 127.0.0.1:8093')
  && !looksLikePortConflict('ModuleNotFoundError: No module named numpy')
  && !looksLikePortConflict(''));

// ── G2: holder inspection over stubbed lsof/ps ───────────────────────────────
const mkExec = (lsofOut, psOut) => (cmd, args, _o, cb) => {
  if (cmd === 'lsof') return cb(null, lsofOut);
  if (cmd === 'ps') return cb(null, psOut);
  return cb(new Error('unexpected'));
};
{
  const holder = await inspectPortHolder(18091, { execFile: mkExec('4242\n', '    1 /usr/bin/python3 pipeline/embed-service.py --serve --port 18091\n') });
  check('G2a. parses pid/ppid/command from lsof+ps', holder && holder.pid === 4242 && holder.ppid === 1 && holder.command.includes('embed-service.py'), JSON.stringify(holder));
  check('G2b. no listener → null', (await inspectPortHolder(18091, { execFile: (c, a, o, cb) => cb(new Error('exit 1')) })) === null);
}

// ── G3: the own-orphan proof ─────────────────────────────────────────────────
{
  const base = { scriptPath: 'pipeline/embed-service.py', port: 18091, selfPid: 500, parentPid: 400 };
  const own = { pid: 4242, ppid: 1, command: 'python3 pipeline/embed-service.py --serve --port 18091' };
  check('G3a. reparented orphan running OUR script+port → own', isOwnOrphan(own, base));
  check('G3b. FOREIGN command (different program) → NOT own', !isOwnOrphan({ ...own, command: 'redis-server 127.0.0.1:18091' }, base));
  check('G3c. our script but a DIFFERENT port instance → NOT own', !isOwnOrphan({ ...own, command: 'python3 pipeline/embed-service.py --serve --port 9999' }, base));
  check('G3d. a live child of ours (ppid == us) → NOT own', !isOwnOrphan({ ...own, ppid: 500 }, base));
  check('G3e. our shell-parent tree (ppid == our ppid) → NOT own', !isOwnOrphan({ ...own, ppid: 400 }, base));
  check('G3f. the child we are supervising right now → NOT own', !isOwnOrphan(own, { ...base, ownChildPid: 4242 }));
  check('G3g. unprovable (no holder / no script) → NOT own', !isOwnOrphan(null, base) && !isOwnOrphan(own, { ...base, scriptPath: '' }));
}

// ── G4: reap — kill gated on the proof ───────────────────────────────────────
{
  const mkKill = () => {
    const calls = []; let terminated = false;
    const kill = (pid, sig) => {
      if (sig === 0) { if (terminated) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; } return true; }
      calls.push([pid, sig]); if (sig === 'SIGTERM' || sig === 'SIGKILL') terminated = true; return true;
    };
    return { kill, calls };
  };
  const ownExec = mkExec('4242\n', '    1 python3 pipeline/embed-service.py --serve --port 18091\n');
  const { kill, calls } = mkKill();
  const r1 = await reapOwnOrphanOnPort({ port: 18091, scriptPath: 'pipeline/embed-service.py', execFile: ownExec, kill, graceMs: 200, log: () => {} });
  check('G4a. own orphan → SIGTERMed and reaped', r1.reaped === true && r1.pid === 4242 && calls.some(([p, s]) => p === 4242 && s === 'SIGTERM'), JSON.stringify(r1));

  const foreignExec = mkExec('777\n', '  123 redis-server 127.0.0.1:18091\n');
  const k2 = mkKill();
  const r2 = await reapOwnOrphanOnPort({ port: 18091, scriptPath: 'pipeline/embed-service.py', execFile: foreignExec, kill: k2.kill, graceMs: 200, log: () => {} });
  check('G4b. FOREIGN holder → kill NEVER called; reason surfaced', r2.reaped === false && r2.reason === 'foreign' && r2.holder?.pid === 777 && k2.calls.length === 0, JSON.stringify(r2));

  // SIGTERM-resistant own orphan → SIGKILL escalation.
  const stubborn = (() => {
    const calls = []; let killed = false;
    const kill = (pid, sig) => {
      if (sig === 0) { if (killed) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; } return true; }
      calls.push([pid, sig]); if (sig === 'SIGKILL') killed = true; return true;
    };
    return { kill, calls };
  })();
  const r3 = await reapOwnOrphanOnPort({ port: 18091, scriptPath: 'pipeline/embed-service.py', execFile: ownExec, kill: stubborn.kill, graceMs: 150, log: () => {} });
  check('G4c. SIGTERM-resistant own orphan → SIGKILL escalation, reaped', r3.reaped === true && stubborn.calls.some(([, s]) => s === 'SIGKILL'), JSON.stringify(r3));
}

// ── G5: restart governor ─────────────────────────────────────────────────────
{
  const g = createRestartGovernor({ minBackoffMs: 15_000, maxBackoffMs: 120_000, maxFailures: 6 });
  const delays = [];
  for (let i = 0; i < 6; i++) delays.push(g.recordFailure().delayMs);
  check('G5a. delays double 15s→2min and cap', JSON.stringify(delays) === JSON.stringify([15000, 30000, 60000, 120000, 120000, 120000]), JSON.stringify(delays));
  check('G5b. halts after N consecutive failures', g.isHalted() && /consecutive/.test(g.haltReason() || ''));
  g.recordSuccess();
  check('G5c. a SUCCESS (outcome, not a clock) resets counter + halt', !g.isHalted() && g.failures() === 0 && g.recordFailure().delayMs === 15000);
  g.halt('port :18093 held by another process');
  check('G5d. halt(reason) surfaces content-free reason', g.isHalted() && g.haltReason() === 'port :18093 held by another process');
  g.resume();
  check('G5e. resume() re-arms from a clean counter', !g.isHalted() && g.failures() === 0);
}

// ── shared supervisor fakes ──────────────────────────────────────────────────
function mkFakeSpawn() {
  const services = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 9000 + services.length;
    child.kill = () => { child._killed = true; };
    if (Array.isArray(args) && args[0] === '-c') { setImmediate(() => { child.emit('close', 0); }); return child; } // deps probe OK
    if (Array.isArray(args) && args.includes('-m')) { setImmediate(() => { child.emit('close', 0); }); return child; } // pip
    services.push({ cmd, args, opts, child });
    return child;
  };
  fn.services = services;
  return fn;
}
const crashWithConflict = (svc) => { svc.child.stderr.emit('data', 'OSError: [Errno 48] Address already in use\n'); svc.child.emit('exit', 1); };
const mkReapStub = (result) => { const calls = []; const fn = async (a) => { calls.push(a); return typeof result === 'function' ? result(a) : result; }; fn.calls = calls; return fn; };

// ── E: embed supervisor wiring ───────────────────────────────────────────────
const { startEmbedSupervisor, getEmbedderHealth, _resetEmbedSupervisor } = await import('../src/embed/supervisor.js');
const failingClient = { health: async () => { throw new Error('ECONNREFUSED'); } };
{
  // E1: reaped own orphan → bind retried promptly.
  _resetEmbedSupervisor();
  const spawn = mkFakeSpawn();
  const reap = mkReapStub({ reaped: true, pid: 4242 });
  startEmbedSupervisor({ home: process.cwd(), pythonBin: 'python3', port: 18091, embed: failingClient, spawn, reapOrphan: reap, log: () => {} });
  await sleep(150);
  check('E1a. supervisor spawned the service', spawn.services.length === 1, `spawns=${spawn.services.length}`);
  crashWithConflict(spawn.services[0]);
  await sleep(150);
  check('E1b. conflict exit → reap consulted with OUR identity (port + exact script)',
    reap.calls.length === 1 && reap.calls[0].port === 18091 && reap.calls[0].scriptPath === 'pipeline/embed-service.py', JSON.stringify(reap.calls[0] || null));
  await sleep(3400); // one tick — nextStartAt was cleared by the successful reap
  check('E1c. reaped → bind retried (respawn within one tick, no backoff penalty)', spawn.services.length === 2, `spawns=${spawn.services.length}`);
  _resetEmbedSupervisor();
}
{
  // E2: FOREIGN holder → not killed here (module-gated), health names it, attempts HALT; nudge resumes.
  _resetEmbedSupervisor();
  const spawn = mkFakeSpawn();
  const reap = mkReapStub({ reaped: false, reason: 'foreign', holder: { pid: 777 } });
  const sup = startEmbedSupervisor({ home: process.cwd(), pythonBin: 'python3', port: 18091, embed: failingClient, spawn, reapOrphan: reap, log: () => {} });
  await sleep(150);
  crashWithConflict(spawn.services[0]);
  await sleep(150);
  const h = getEmbedderHealth();
  check('E2a. foreign holder → health down with a content-free port reason',
    h.status === 'down' && /held by another process/.test(h.detail || ''), `${h.status}: ${h.detail}`);
  await sleep(3400); // a full tick passes…
  check('E2b. …and attempts STOP (halted — no respawn on later ticks)', spawn.services.length === 1, `spawns=${spawn.services.length}`);
  sup.nudge();
  await sleep(200);
  check('E2c. nudge() resumes — a fresh attempt is made', spawn.services.length === 2, `spawns=${spawn.services.length}`);
  _resetEmbedSupervisor();
}
{
  // E3: a PLAIN crash (no conflict) engages the ≥15s governor backoff — the old
  // 1-2-4s backoff would have respawned within the 4s window we watch.
  _resetEmbedSupervisor();
  const spawn = mkFakeSpawn();
  const reap = mkReapStub({ reaped: false, reason: 'no-holder' });
  startEmbedSupervisor({ home: process.cwd(), pythonBin: 'python3', port: 18091, embed: failingClient, spawn, reapOrphan: reap, log: () => {} });
  await sleep(150);
  spawn.services[0].child.stderr.emit('data', 'Traceback: something unrelated\n');
  spawn.services[0].child.emit('exit', 1);
  await sleep(4000); // > one 3s tick + old first backoff (2s); < the new 15s floor
  check('E3. plain crash → bounded backoff engaged (NO respawn inside a 4s window; floor is 15s)',
    spawn.services.length === 1 && reap.calls.length === 0, `spawns=${spawn.services.length}`);
  _resetEmbedSupervisor();
}

// ── T: transcribe supervisor wiring ──────────────────────────────────────────
const { startTranscribeSupervisor, getTranscriberHealth, _resetTranscribeSupervisor } = await import('../src/transcribe/supervisor.js');
{
  _resetTranscribeSupervisor();
  const spawn = mkFakeSpawn();
  const reap = mkReapStub({ reaped: false, reason: 'foreign', holder: { pid: 777 } });
  const failFetch = async () => { throw new Error('ECONNREFUSED'); };
  const sup = startTranscribeSupervisor({ home: process.cwd(), pythonBin: 'python3', port: 18093, model: 'small', fetch: failFetch, spawn, reapOrphan: reap, log: () => {} });
  await sleep(200);
  check('T1a. transcribe spawned with OUR script', spawn.services.length === 1 && spawn.services[0].args[0] === 'pipeline/transcribe-service.py', `spawns=${spawn.services.length}`);
  crashWithConflict(spawn.services[0]);
  await sleep(150);
  const h = getTranscriberHealth();
  check('T1b. foreign holder → down + content-free reason + reap consulted',
    reap.calls.length === 1 && reap.calls[0].scriptPath === 'pipeline/transcribe-service.py' && h.status === 'down' && /held by another process/.test(h.detail || ''), `${h.status}: ${h.detail}`);
  await sleep(3400);
  check('T1c. attempts STOP while halted', spawn.services.length === 1, `spawns=${spawn.services.length}`);
  sup.nudge();
  await sleep(250);
  check('T1d. nudge() resumes', spawn.services.length === 2, `spawns=${spawn.services.length}`);
  _resetTranscribeSupervisor();
}
{
  // T2 — THE IN-FLIGHT LATCH (HIGH-1). An unreachable :8093 forces tryStart; two extra nudges land
  // during the (async) checkDeps window that precedes the `child` assignment. Without startInFlight the
  // `child`-null guard alone lets all three ticks spawn a transcribe-service.py on :8093 (the Retry
  // button is on TWO surfaces, built to be mashed); with the latch exactly ONE service spawns. Mirrors
  // embed S9. mkFakeSpawn counts only --serve spawns (the `-c` deps probe is filtered), so the count is
  // resident services, not probes.
  _resetTranscribeSupervisor();
  const spawn = mkFakeSpawn();
  const reap = mkReapStub({ reaped: false, reason: 'no-holder' });
  const failFetch = async () => { throw new Error('ECONNREFUSED'); };
  const sup = startTranscribeSupervisor({ home: process.cwd(), pythonBin: 'python3', port: 18093, model: 'small', fetch: failFetch, spawn, reapOrphan: reap, log: () => {} });
  sup.nudge(); sup.nudge(); // mash Retry across both rows while the first tryStart is mid-checkDeps
  await sleep(300);
  check('T2. concurrent ticks/retries spawn the transcribe service AT MOST once (the in-flight latch — no double :8093)',
    spawn.services.length === 1, `services=${spawn.services.length}`);
  _resetTranscribeSupervisor();
}

// ── Q: qwen3-tts supervisor wiring (fast ticks) ──────────────────────────────
process.env.MYCELIUM_QWEN_TTS_PORT = '18094'; // read at module load — before import
const { startQwenTtsSupervisor, getQwenTtsHealth } = await import('../src/tts/qwen3-tts-supervisor.js');
{
  const spawn = mkFakeSpawn();
  const reap = mkReapStub({ reaped: false, reason: 'foreign', holder: { pid: 778 } });
  const sup = startQwenTtsSupervisor({
    home: process.cwd(), shouldRun: () => true, tickMs: 80,
    getState: () => ({ phase: 'ready', variant: 'q4' }),
    spawn, reapOrphan: reap,
  });
  await sleep(400); // ticks: probe 127.0.0.1:18094 refused → spawn
  check('Q1a. qwen spawned with OUR script', spawn.services.length === 1 && spawn.services[0].args[0] === 'pipeline/qwen3-tts-service.py', `spawns=${spawn.services.length}`);
  if (spawn.services[0]) crashWithConflict(spawn.services[0]);
  await sleep(500); // several fast ticks
  const h = getQwenTtsHealth();
  check('Q1b. foreign holder → down + content-free reason + attempts STOP',
    reap.calls.length === 1 && h.status === 'down' && /held by another process/.test(h.detail || '') && spawn.services.length === 1,
    `${h.status}: ${h.detail} spawns=${spawn.services.length}`);
  sup.stop();
}

console.log(ledger.join('\n'));
console.log('='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);

#!/usr/bin/env node
// verify:crash-reaper — D-136 fast-half proof: a crash-exit REAPS spawned
// children instead of orphaning them (the leak that left channel-daemon burning
// ~98% CPU for 3 h 46 m after the app closed, and that poisons every later clean
// shutdown via adopt-with-spawnedByUs=false).
//
// Three parts:
//   A. crash-reaper unit surface (injected kill — no real processes): registry
//      add / auto-remove on exit / pid-less no-op; per-pid SIGKILL layer; the
//      group sweep fires ONLY under proven group leadership.
//   B. THE REAL PATH, end to end: a fixture process registers a REAL sleeper,
//      installs the REAL installCrashPolicy() from src/server-rest.js, and
//      crashes (uncaughtException AND unhandledRejection modes). The sleeper
//      must die and the fixture must exit FAST (signal-then-exit — D-108: the
//      crash path never waits on children).
//   C. THE GROUP SWEEP, end to end: the fixture runs DETACHED (its own pgid ==
//      pid — the packaged-app topology main.rs process_group(0) creates), with
//      an UNREGISTERED second sleeper standing in for a grandchild. The group
//      sweep — one kill(-pid, SIGKILL) — must reap it; the registry cannot.
//
// Registration WIRING (the sites the crash sweep depends on) is asserted
// statically in part D: every persistent spawnedByUs owner must call
// registerCrashKillChild. (Their spawn behaviour is driven by their own gates;
// the wiring line is what D-136 adds and what a regression would delete.)
//
// MUTATION-TESTED: (D-136, 2026-08-04) installCrashPolicy's `try { reap(...) }`
// line removed (the crash path exits without reaping — the pre-fix behaviour) →
// B1 + B2 (registered sleeper SURVIVES the crash, both crash modes) and C2 + C3
// RED while every A* unit check stays GREEN. Restored → GO.
// MUTATION-TESTED: (D-136, 2026-08-04) registerCrashKillChild gutted to an
// immediate `return child` (registry never populated) → A1/A1b/A1c/A2, B1, B2,
// C2, C3 all RED (unit registry empty; fixture sleepers survive — the per-pid
// layer is dead) while the D* wiring greps stay GREEN (the call sites still
// exist) — which is exactly why B/C drive real processes instead of trusting
// the wiring greps. Restored → GO.
// MUTATION-TESTED: (D-136, 2026-08-04) group sweep disabled
// (`groupLeader === true` guard short-circuited to false in reapChildrenOnCrash)
// → A4 and C2 RED (the unregistered in-group sleeper survives the crash — the
// grandchild leak) while B1/B2 stay GREEN (the per-pid layer still kills
// registered children). Restored → GO.
// MUTATION-TESTED: (round-1 gate review H1, 2026-08-04) probeGroupLeadership
// hardwired `return true` (a dev server sharing the terminal's pgid would
// SIGKILL the user's whole shell group on crash) → A6 RED (probed non-leader
// still swept) while A7 and every other check stay GREEN. Restored → GO.
// MUTATION-TESTED: (round-1 gate review H2, 2026-08-04) the channel-daemon
// registration line COMMENTED OUT (the "temporarily disabled" shape that
// used to satisfy the src.includes pin) → the D wiring pin for
// channel-daemon REDs (non-comment matching). Restored → GO.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerCrashKillChild, reapChildrenOnCrash, crashKillRegistry, _resetCrashReaperForTest,
} from '../src/system/crash-reaper.js';

const ledger = [];
let allPass = true;
function check(name, cond) {
  const ok = !!cond;
  allPass = allPass && ok;
  ledger.push(`[${ok ? '✓' : '✗'}] ${name}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitDead(pid, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (!alive(pid)) return true; await sleep(50); }
  return !alive(pid);
}

function fakeChild(pid) {
  const c = new EventEmitter();
  c.pid = pid;
  return c;
}
// execFileSync fake for the leadership probe: report a pgid that is NOT our pid.
const notLeaderPs = () => ' 1\n';

try {
  // ── Part A: unit surface (injected kill; no real processes) ────────────────
  {
    _resetCrashReaperForTest();
    const c1 = fakeChild(910001);
    const c2 = fakeChild(910002);
    registerCrashKillChild(c1, 'a', { execFileSync: notLeaderPs });
    registerCrashKillChild(c2, 'b', { execFileSync: notLeaderPs });
    check('A1 register → both pids tracked', crashKillRegistry().size === 2 && crashKillRegistry().has(910001));
    c1.emit('exit', 0);
    check('A1b child exit → auto-deregistered', !crashKillRegistry().has(910001) && crashKillRegistry().size === 1);
    registerCrashKillChild({ pid: undefined }, 'no-pid', { execFileSync: notLeaderPs });
    check('A1c pid-less child → no-op', crashKillRegistry().size === 1);

    const kills = [];
    const res = reapChildrenOnCrash({ kill: (pid, sig) => kills.push([pid, sig]), groupLeader: false });
    check('A2 reap → per-pid SIGKILL of every registered child', kills.length === 1 && kills[0][0] === 910002 && kills[0][1] === 'SIGKILL');
    check('A2b reap → registry cleared', crashKillRegistry().size === 0);
    check('A3 NOT group leader → NO negative-pid group sweep', !kills.some(([pid]) => pid < 0) && res.groupSwept === false);

    _resetCrashReaperForTest();
    registerCrashKillChild(fakeChild(910003), 'c', { execFileSync: notLeaderPs });
    const kills2 = [];
    const res2 = reapChildrenOnCrash({ kill: (pid, sig) => kills2.push([pid, sig]), groupLeader: true });
    check('A4 group leader → ONE kill(-ourPid, SIGKILL) sweep after the per-pid layer',
      res2.groupSwept === true && kills2.some(([pid, sig]) => pid === -process.pid && sig === 'SIGKILL')
      && kills2.findIndex(([pid]) => pid < 0) === kills2.length - 1);
    // A6/A7 (round-1 gate review H1): the REAL leadership probe decides the
    // sweep — not only the injected override. A probe reporting a foreign pgid
    // must disarm the sweep (in dev the server shares the terminal's group;
    // sweeping there would SIGKILL the user's shell session), and a probe
    // reporting pgid==pid must arm it.
    {
      _resetCrashReaperForTest();
      registerCrashKillChild(fakeChild(910010), 'probe-foreign', { execFileSync: () => ' 1\n' });
      const kills = [];
      const r = reapChildrenOnCrash({ kill: (pid, sig) => kills.push([pid, sig]) }); // NO override — the probed value decides
      check('A6 probed NON-leader (pgid≠pid) → NO group sweep without any override',
        r.groupSwept === false && !kills.some(([pid]) => pid < 0));
      _resetCrashReaperForTest();
      registerCrashKillChild(fakeChild(910011), 'probe-self', { execFileSync: () => ` ${process.pid}\n` });
      const kills2 = [];
      const r2 = reapChildrenOnCrash({ kill: (pid, sig) => kills2.push([pid, sig]) });
      check('A7 probed leader (pgid==pid) → the sweep fires from the probe alone',
        r2.groupSwept === true && kills2.some(([pid]) => pid === -process.pid));
      _resetCrashReaperForTest();
    }

    check('A5 reap never throws on a dead pid', (() => {
      _resetCrashReaperForTest();
      registerCrashKillChild(fakeChild(910004), 'd', { execFileSync: notLeaderPs });
      try { reapChildrenOnCrash({ kill: () => { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }, groupLeader: false }); return true; }
      catch { return false; }
    })());
    _resetCrashReaperForTest();
  }

  // ── Parts B + C: the real path, real processes ─────────────────────────────
  const scratch = mkdtempSync(join(tmpdir(), 'crash-reap-gate-'));
  const fixture = join('scripts', 'fixtures', 'crash-reap-fixture.mjs');
  const fixtureEnv = { ...process.env, MYCELIUM_DATA_DIR: join(scratch, 'data') };

  /** Run the fixture; resolve with { pids, exit, ms } once it terminates. */
  const runFixture = (mode, { detached = false } = {}) => new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [fixture, mode], {
      env: fixtureEnv, detached, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code, signal) => {
      const m = out.match(/PIDS (\d+) (\d+)/);
      resolve({
        pids: m ? [Number(m[1]), Number(m[2])].filter((p) => p > 0) : [],
        exit: { code, signal }, ms: Date.now() - t0, err,
      });
    });
  });

  // B1: uncaughtException — the registered sleeper dies; the fixture exits fast.
  {
    const r = await runFixture('basic');
    check('B1 fixture spawned + printed sleeper pid', r.pids.length === 1);
    check('B1 crash → registered sleeper is DEAD (per-pid layer)', r.pids[0] ? await waitDead(r.pids[0], 3000) : false);
    check('B1 fixture exited (crash policy ran to exit)', r.exit.code === 1 || r.exit.signal === 'SIGKILL');
    check('B1 signal-then-exit: no waiting on children (< 5s wall incl. module load)', r.ms < 5000);
  }

  // B2: unhandledRejection — the other crash entrance, same contract.
  {
    const r = await runFixture('rejection');
    check('B2 rejection crash → registered sleeper is DEAD', r.pids[0] ? await waitDead(r.pids[0], 3000) : false);
    check('B2 fixture exited', r.exit.code === 1 || r.exit.signal === 'SIGKILL');
  }

  // C: detached fixture = its own group leader (the packaged-app topology).
  // The UNREGISTERED sleeper shares its group; only the group sweep can reap it.
  {
    const r = await runFixture('group', { detached: true });
    check('C1 group fixture printed both pids', r.pids.length === 2);
    check('C2 group sweep → UNREGISTERED in-group child is DEAD (the grandchild leak)',
      r.pids[1] ? await waitDead(r.pids[1], 3000) : false);
    check('C3 registered sleeper also dead', r.pids[0] ? await waitDead(r.pids[0], 3000) : false);
    // The sweep SIGKILLs the fixture's own group — itself included; either exit
    // shape (signal, or code 1 if exit(1) raced the signal) is a completed crash.
    check('C4 fixture terminated', r.exit.code !== null || r.exit.signal !== null);
  }
  rmSync(scratch, { recursive: true, force: true });

  // ── Part D: registration wiring exists at every persistent spawn owner ─────
  // (B/C prove the machinery on real processes; D pins the call sites so a
  //  regression that silently drops one owner REDs here by name.)
  {
    const sites = [
      ['src/channels/supervisor.js', 'channel-daemon'],
      ['src/embed/supervisor.js', 'embed-service'],
      ['src/transcribe/supervisor.js', 'transcribe-service'],
      ['src/tts/qwen3-tts-supervisor.js', 'qwen3-tts-service'],
      ['src/hardware/ollama-daemon.js', 'ollama-serve'],
      ['src/jobs.js', 'pipeline-job'],
      ['src/jobs.js', 'claim-discovery'],
      ['src/jobs.js', 'describe-chronicles'],
      ['src/jobs.js', 'describe-clusters'],
      ['src/ingest/detect-sources.js', 'detect-sources-child'],
      ['src/agent/loop-claude-cli.js', 'claude-cli-turn'],
    ];
    // Comment-proof (round-1 gate review H2): a commented-out registration must
    // NOT satisfy the pin — match on non-comment lines only.
    const noComments = (p) => readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    for (const [file, label] of sites) {
      check(`D wiring: ${file} registers '${label}' (non-comment line)`,
        noComments(file).includes(`registerCrashKillChild(child, '${label}'`));
    }
    // The deliberately-detached durability children must NOT be registered:
    // a crash must not tear a backup mid-copy (D-110). vault-copy is in this
    // family too (round-1 review: it must also SPAWN detached, or the group
    // sweep kills it anyway — pinned here with its spawn flag).
    for (const file of ['src/db/snapshot-schedule.js', 'src/db/integrity.js', 'src/db/vault-copy.js']) {
      check(`D exclusion: ${file} does NOT register (detached durability child)`,
        !noComments(file).includes('registerCrashKillChild'));
    }
    check('D exclusion: vault-copy spawns DETACHED (own group — the sweep cannot reach it)',
      /detached: true/.test(noComments('src/db/vault-copy.js')));
  }
} catch (e) {
  check(`fatal: ${e?.message || e}`, false);
}

console.log(ledger.join('\n'));
console.log('='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);

// scripts/fixtures/crash-reap-fixture.mjs — D-136 gate fixture. Spawns a REAL
// sleeper child, registers it, installs the REAL crash policy exported by
// src/server-rest.js, then crashes on purpose. The gate (verify-crash-reaper.mjs)
// asserts the sleeper dies and this process exits fast (signal-then-exit, no wait).
//
// Modes (argv[2]):
//   basic     — uncaughtException path; registered sleeper only
//   rejection — unhandledRejection path; registered sleeper only
//   group     — ALSO spawns an UNREGISTERED sleeper (stand-in for a grandchild,
//               e.g. the channel-daemon's ffmpeg). The gate launches this mode
//               DETACHED so this fixture is its own process-group leader — the
//               packaged-app topology (main.rs process_group(0)) — and the group
//               sweep, not the registry, must reap the unregistered one.
//
// The gate sets MYCELIUM_DATA_DIR to a scratch dir so the crash policy's
// durability-log write cannot touch a real vault's data dir.
import { spawn } from 'node:child_process';
import { registerCrashKillChild } from '../../src/system/crash-reaper.js';
import { installCrashPolicy } from '../../src/server-rest.js';

const mode = process.argv[2] || 'basic';
const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
registerCrashKillChild(sleeper, 'gate-sleeper');
let unregistered = null;
if (mode === 'group') {
  // NOT registered — only the process-group sweep can reap this one.
  unregistered = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}
process.stdout.write(`PIDS ${sleeper.pid} ${unregistered ? unregistered.pid : 0}\n`);

installCrashPolicy();

if (mode === 'rejection') {
  setTimeout(() => { void Promise.reject(new Error('gate-crash-rejection')); }, 150);
} else {
  setTimeout(() => { throw new Error('gate-crash'); }, 150);
}
setInterval(() => {}, 1000); // keep alive until the crash fires

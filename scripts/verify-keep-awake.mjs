// Verify — keep-the-Mac-awake assertion (src/system/keep-awake.js):
//   K1 initial status is inactive; `supported` reflects the platform
//   K2 start → active (macOS) and a REAL PreventUserIdleSystemSleep assertion
//      appears (pmset); on non-macOS it's a clean no-op (supported:false)
//   K3 start is idempotent (no second caffeinate spawned)
//   K4 stop → inactive, the caffeinate child is gone, assertion released
//   K5 the held assertion is owned by caffeinate with the -w auto-clean tie
//
// Platform-aware: the macOS assertions are asserted only on darwin; elsewhere the
// no-op path is verified. PASS/FAIL ledger + VERDICT + EXIT=<code>.
import { execFileSync } from 'node:child_process';
import { startKeepAwake, stopKeepAwake, keepAwakeStatus, __resetKeepAwakeForTest } from '../src/system/keep-awake.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const isMac = process.platform === 'darwin';

// caffeinate pids holding PreventUserIdleSystemSleep right now (macOS only).
const caffeinatePids = () => {
  if (!isMac) return new Set();
  try {
    const out = execFileSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' });
    const pids = new Set();
    for (const line of out.split('\n')) {
      const m = line.match(/pid (\d+)\(caffeinate\):.*PreventUserIdleSystemSleep/);
      if (m) pids.add(m[1]);
    }
    return pids;
  } catch { return new Set(); }
};

__resetKeepAwakeForTest();

const s0 = keepAwakeStatus();
rec('K1 initial status inactive; supported matches platform',
  s0.active === false && s0.supported === isMac, JSON.stringify(s0));

const before = caffeinatePids();
const s1 = startKeepAwake({ logger: () => {} });
// caffeinate spawns async; give the assertion a moment to register.
await new Promise((r) => setTimeout(r, 400));
const after = caffeinatePids();
const fresh = [...after].filter((p) => !before.has(p));

if (isMac) {
  rec('K2 start → active + a caffeinate PreventUserIdleSystemSleep assertion appears',
    s1.active === true && s1.supported === true && fresh.length === 1, `status=${JSON.stringify(s1)} freshPids=${fresh.length}`);
} else {
  rec('K2 non-macOS → clean no-op (supported:false, inactive, reason set)',
    s1.supported === false && s1.active === false && /unsupported_platform/.test(s1.reason || ''), JSON.stringify(s1));
}

// K3 idempotent — a second start must not spawn a second caffeinate.
const s2 = startKeepAwake({ logger: () => {} });
await new Promise((r) => setTimeout(r, 200));
const afterAgain = caffeinatePids();
const freshAgain = [...afterAgain].filter((p) => !before.has(p));
rec('K3 start is idempotent (no second assertion spawned)',
  isMac ? (freshAgain.length === 1 && s2.active === true) : (s2.active === false),
  `freshPids=${freshAgain.length}`);

// K5 (macOS) the held assertion is owned by caffeinate (the -w tie is in its argv).
if (isMac && fresh.length === 1) {
  let argv = '';
  try { argv = execFileSync('ps', ['-o', 'command=', '-p', fresh[0]], { encoding: 'utf8' }); } catch { /* */ }
  rec('K5 assertion held by `caffeinate -i -m -s -w <pid>` (auto-clean on exit)',
    /caffeinate/.test(argv) && /-w/.test(argv) && argv.includes(String(process.pid)), argv.trim());
} else if (!isMac) {
  rec('K5 (skipped off macOS — no assertion to hold)', true);
} else {
  rec('K5 assertion held by caffeinate', false, 'no fresh caffeinate pid to inspect');
}

// K4 stop → inactive + the fresh caffeinate is gone.
const s3 = stopKeepAwake({ logger: () => {} });
await new Promise((r) => setTimeout(r, 300));
const afterStop = caffeinatePids();
const stillThere = isMac ? fresh.filter((p) => afterStop.has(p)) : [];
rec('K4 stop → inactive + caffeinate released',
  s3.active === false && stillThere.length === 0, `stillHolding=${stillThere.length}`);

__resetKeepAwakeForTest();
const ok = ledger.every(Boolean);
console.log(`\nVERDICT: ${ok ? 'GO' : 'NO-GO'} — keep-awake: ${isMac ? 'holds + releases a real macOS sleep assertion' : 'clean no-op off macOS'}, idempotent, auto-cleaning`);
console.log(`EXIT=${ok ? 0 : 1}`);
process.exit(ok ? 0 : 1);

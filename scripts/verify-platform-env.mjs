// scripts/verify-platform-env.mjs — gate for src/system/platform-env.js (A4a).
// Exercises BOTH the win32 and posix branches on any host by injecting platform.
// VERDICT: GO / exit 0 on pass; exit 1 on any failure.
import {
  splitPath, homeDir, exeName, exeNames, findExecutable,
  venvPythonPath, bundledPythonPath, systemPython,
} from '../src/system/platform-env.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

// splitPath — delimiter per platform
ok(JSON.stringify(splitPath('/a:/b', { platform: 'linux' })) === JSON.stringify(['/a', '/b']), 'P1. posix PATH splits on :');
ok(JSON.stringify(splitPath('C:\\a;C:\\b', { platform: 'win32' })) === JSON.stringify(['C:\\a', 'C:\\b']), 'P2. win32 PATH splits on ;');
ok(splitPath('', { platform: 'linux' }).length === 0, 'P3. empty PATH → []');

// homeDir — HOME vs USERPROFILE
ok(homeDir({ env: { HOME: '/home/x' }, platform: 'linux' }) === '/home/x', 'H1. posix uses HOME');
ok(homeDir({ env: { USERPROFILE: 'C:\\Users\\x' }, platform: 'win32' }) === 'C:\\Users\\x', 'H2. win32 uses USERPROFILE');
ok(homeDir({ env: {}, platform: 'win32' }) === '' && homeDir({ env: {}, platform: 'linux' }) === '', 'H3. absent → \'\' (env-only: never touches os.homedir, cannot throw)');
ok(homeDir({ env: { USERPROFILE: 'C:\\U' }, platform: 'linux' }) === '', 'H4. posix does NOT read USERPROFILE (hermetic to the injected env)');

// exeName — .exe suffix on win only
ok(exeName('ollama', { platform: 'linux' }) === 'ollama', 'E1. posix no suffix');
ok(exeName('ollama', { platform: 'win32' }) === 'ollama.exe', 'E2. win32 adds .exe');
ok(exeName('ollama.exe', { platform: 'win32' }) === 'ollama.exe', 'E3. win32 idempotent');
// exeNames — PATHEXT expansion for BARE names (claude ships as claude.cmd on win, never .exe)
ok(JSON.stringify(exeNames('claude', { platform: 'linux' })) === JSON.stringify(['claude']), 'X1. posix → bare name only');
ok(exeNames('claude', { platform: 'win32', env: {} }).join(',') === 'claude.exe,claude.cmd,claude.bat', 'X2. win32 default PATHEXT expansion incl .cmd');
ok(exeNames('claude', { platform: 'win32', env: { PATHEXT: '.COM;.EXE;.CMD' } }).join(',') === 'claude.com,claude.exe,claude.cmd', 'X3. honors PATHEXT order');
ok(exeNames('claude', { platform: 'win32', env: { PATHEXT: '.EXE;.JS;.VBS;.WSF;.CMD' } }).join(',') === 'claude.exe,claude.cmd', 'X5. PATHEXT is INTERSECTED with a safe set — a claude.js on PATH is never spawned (CLAUDE.md §4)');
ok(JSON.stringify(exeNames('claude.cmd', { platform: 'win32' })) === JSON.stringify(['claude.cmd']), 'X4. explicit extension respected');

// findExecutable — absolute-first, then PATH×names, exe-suffixed; injectable probe
const has = (set) => (p) => set.has(p);
const present = new Set(['/opt/homebrew/bin/ollama', '/usr/bin/python3', 'C:\\tools\\ollama.exe']);
const isExec = has(present);
ok(findExecutable(['/opt/homebrew/bin/ollama', '/usr/local/bin/ollama'], { platform: 'linux', isExecutable: isExec }) === '/opt/homebrew/bin/ollama', 'F1. absolute candidate wins');
ok(findExecutable(['ollama', 'python3'], { env: { PATH: '/sbin:/usr/bin' }, platform: 'linux', isExecutable: isExec }) === '/usr/bin/python3', 'F2. resolves bare name via PATH');
ok(findExecutable(['ollama'], { env: { PATH: 'C:\\tools' }, platform: 'win32', isExecutable: isExec }) === 'C:\\tools\\ollama.exe', 'F3. win32 finds .exe on PATH');
ok(findExecutable(['claude'], { env: { PATH: 'C:\\npm' }, platform: 'win32', isExecutable: has(new Set(['C:\\npm\\claude.cmd'])) }) === 'C:\\npm\\claude.cmd', 'F5. win32 finds a .cmd shim (the REAL npm claude on Windows)');
ok(findExecutable(['./vendor/tool'], { env: { PATH: '/usr/bin' }, platform: 'linux', isExecutable: has(new Set(['/usr/bin/tool'])) }) === null, 'F6. relative-with-dirs is REJECTED, not collapsed to a PATH search');
ok(findExecutable(['nope'], { env: { PATH: '/usr/bin' }, platform: 'linux', isExecutable: isExec }) === null, 'F4. missing → null');

// python path helpers — per-OS venv/bundled/system (A4b)
ok(venvPythonPath('/app', { platform: 'linux' }) === '/app/pipeline/.venv/bin/python3', 'V1. posix venv → bin/python3');
ok(venvPythonPath('C:\\app', { platform: 'win32' }) === 'C:\\app\\pipeline\\.venv\\Scripts\\python.exe', 'V2. win32 venv → Scripts\\python.exe');
ok(bundledPythonPath('/app', { platform: 'linux' }) === '/app/python/bin/python3', 'V3. posix bundled → python/bin/python3');
ok(bundledPythonPath('C:\\app', { platform: 'win32' }) === 'C:\\app\\python\\python.exe', 'V4. win32 bundled → python\\python.exe');
ok(systemPython() === 'python3', 'V5. systemPython is python3 on every platform (no-op vs the prior literal; win32 bare python is a Store-alias stub)');

console.log('');
if (failures) { console.log(`VERDICT: NO-GO — ${failures} failure(s)`); process.exit(1); }
console.log('VERDICT: GO — platform-env cross-platform primitives verified');

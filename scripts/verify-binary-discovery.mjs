// scripts/verify-binary-discovery.mjs — gate for A4c: cross-platform binary
// discovery in claude-bin.js + ollama-daemon.js. Exercises win32 + posix by
// injecting platform + existsSync (existence-only probe). VERDICT: GO / exit 0.
import { resolveClaudeBin } from '../src/inference/claude-bin.js';
import { findOllamaBinary } from '../src/hardware/ollama-daemon.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const has = (set) => (p) => set.has(p);

// claude — posix: homebrew absolute; env override; PATH bare
ok(resolveClaudeBin({ platform: 'linux', env: { PATH: '/usr/bin' }, existsSync: has(new Set(['/opt/homebrew/bin/claude'])) }) === '/opt/homebrew/bin/claude', 'C1. posix picks homebrew absolute');
ok(resolveClaudeBin({ platform: 'linux', env: { PATH: '/usr/local/bin' }, existsSync: has(new Set(['/usr/local/bin/claude'])) }) === '/usr/local/bin/claude', 'C2. posix resolves bare via PATH');
ok(resolveClaudeBin({ platform: 'linux', env: { CLAUDE_BIN: '/custom/claude', PATH: '' }, existsSync: has(new Set(['/custom/claude'])) }) === '/custom/claude', 'C3. CLAUDE_BIN override wins');
// claude — win32: LOCALAPPDATA .exe; PATH .exe
ok(resolveClaudeBin({ platform: 'win32', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming', PATH: '' }, existsSync: has(new Set(['C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd'])) }) === 'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd', 'C4. win32 finds the npm global-bin claude.cmd');
ok(resolveClaudeBin({ platform: 'win32', env: { PATH: 'C:\\bin' }, existsSync: has(new Set(['C:\\bin\\claude.cmd'])) }) === 'C:\\bin\\claude.cmd', 'C5. win32 resolves the REAL npm shim claude.cmd on PATH (there is no claude.exe)');
ok(resolveClaudeBin({ platform: 'linux', env: { PATH: '/usr/bin' }, existsSync: has(new Set()) }) === null, 'C6. not found → null');

// ollama — posix absolute + app bundle; win32 Program Files
ok(findOllamaBinary({ platform: 'linux', env: { PATH: '' }, existsSync: has(new Set(['/opt/homebrew/bin/ollama'])) }) === '/opt/homebrew/bin/ollama', 'O1. posix homebrew');
ok(findOllamaBinary({ platform: 'darwin', env: { PATH: '' }, existsSync: has(new Set(['/Applications/Ollama.app/Contents/Resources/ollama'])) }) === '/Applications/Ollama.app/Contents/Resources/ollama', 'O2. macOS app bundle');
ok(findOllamaBinary({ platform: 'win32', env: { PATH: '' }, existsSync: has(new Set(['C:\\Program Files\\Ollama\\ollama.exe'])) }) === 'C:\\Program Files\\Ollama\\ollama.exe', 'O3. win32 Program Files ollama.exe');
ok(findOllamaBinary({ platform: 'linux', env: { MYCELIUM_OLLAMA: '/custom/ollama', PATH: '' }, existsSync: has(new Set(['/custom/ollama'])) }) === '/custom/ollama', 'O4. MYCELIUM_OLLAMA override wins');
ok(findOllamaBinary({ platform: 'win32', env: { PATH: '' }, existsSync: has(new Set()) }) === null, 'O5. not found → null');

console.log('');
if (failures) { console.log(`VERDICT: NO-GO — ${failures} failure(s)`); process.exit(1); }
console.log('VERDICT: GO — cross-platform binary discovery (claude + ollama) verified');

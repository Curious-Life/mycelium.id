// scripts/verify-mindfile-sanitize.mjs — Context Engine 1c-A gate.
//
// The scan-on-write gate for mind files: blocks injection (bidi/zero-width) + live credentials
// + runaway size, fail-closed, with LOW false-positives (legitimate reflective prose, emoji,
// multilingual scripts, and abstract security discussion all pass). Also proves the gate is
// wired into writeMindFile (a blocked write throws BEFORE any fs write — no partial persist).
import { sanitizeMindWrite } from '../src/mindfiles/sanitize.js';
import { createMindFiles } from '../src/mindfiles/mind-files.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};
const ZWSP = String.fromCharCode(0x200B);
const RLO = String.fromCharCode(0x202E); // bidi override (Trojan Source)
const ZWJ = String.fromCharCode(0x200D); // legit: emoji + scripts

// ── BLOCK cases ──────────────────────────────────────────────────────────────
ok(sanitizeMindWrite(`hidden${ZWSP}instruction`, 'model.md').code === 'invisible-unicode', 'blocks zero-width space');
ok(sanitizeMindWrite(`spoof${RLO}txet`, 'model.md').code === 'invisible-unicode', 'blocks bidi override (Trojan Source)');
ok(sanitizeMindWrite('my key is sk-ant-api03-AbCdEf0123456789xyz', 'model.md').code === 'credential-token', 'blocks an Anthropic key');
ok(sanitizeMindWrite('token ghp_ABCDEFGHIJ0123456789KLMNOPQRST', 'model.md').code === 'credential-token', 'blocks a GitHub token');
ok(sanitizeMindWrite('aws AKIAIOSFODNN7EXAMPLE here', 'model.md').code === 'credential-token', 'blocks an AWS key id');
ok(sanitizeMindWrite('eyJhbGciOiJIUzI1NiIsInR5.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4', 'model.md').code === 'credential-token', 'blocks a JWT');
ok(sanitizeMindWrite('x'.repeat(80_000), 'model.md').code === 'oversized', 'blocks a runaway-size write');

// ── PASS cases (the false-positive guard — these must NOT be blocked) ─────────
ok(sanitizeMindWrite('Recently you seem to be building more than reflecting. I notice a pattern.', 'model.md').ok, 'normal reflective prose passes');
ok(sanitizeMindWrite('Note: AWS access keys look like AKIA[0-9A-Z]{16}; GitHub tokens are ghp_ then 36 chars.', 'model.md').ok, 'abstract security discussion passes (pattern text, not a live key)');
ok(sanitizeMindWrite('Family time today 👨' + ZWJ + '👩' + ZWJ + '👧 — felt close.', 'model.md').ok, 'emoji-ZWJ sequence passes (no false positive)');
ok(sanitizeMindWrite('من امروز خوب بودم. سلام دنیا.', 'model.md').ok, 'non-Latin script passes');
ok(sanitizeMindWrite('the content hash was a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90', 'model.md').ok, 'a 64-hex SHA-256 passes (NOT treated as the master key)');
// snapshots/ are skipped (already-scanned source) even if they would otherwise trip a rule
ok(sanitizeMindWrite(`old${ZWSP}content`, 'snapshots/model.md/2026-06-19.md').ok, 'snapshot paths are skipped');

// ── wired into writeMindFile (fail-closed, no partial write) ─────────────────
function fakeFs() {
  const calls = { open: 0, writeFile: 0, rename: 0, mkdir: 0 };
  return { _calls: calls,
    readFile: async () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; },
    writeFile: async () => { calls.writeFile++; },
    mkdir: async () => { calls.mkdir++; },
    rename: async () => { calls.rename++; },
    open: async () => { calls.open++; return { writeFile: async () => {}, sync: async () => {}, close: async () => {} }; },
  };
}
{
  const fs = fakeFs();
  const mf = createMindFiles({ agentRoot: '/tmp/ctx-engine-test-mind', agentId: 'personal-agent', fs, path: await import('node:path') });
  let threw = null;
  try { await mf.writeMindFile('model.md', `bad${RLO}write`); } catch (e) { threw = e; }
  ok(threw && /^mindfile-blocked:invisible-unicode$/.test(threw.message), 'writeMindFile throws on a blocked write');
  ok(fs._calls.open === 0 && fs._calls.writeFile === 0 && fs._calls.rename === 0, 'no fs write happened (fail-closed before encrypt/persist)');
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);

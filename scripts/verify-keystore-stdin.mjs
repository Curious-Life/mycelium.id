// verify:keystore-stdin — the recovery key must reach `security`/`op` via STDIN,
// never as a command-line argument. argv is world-readable on the host
// (`ps`, `/proc/<pid>/cmdline`), so a master key in argv leaks to other local
// users for the process lifetime — a master-key-discipline violation (CLAUDE.md
// §⚠️4). Regression guard for the argv→stdin fixes: the "save my recovery key"
// helpers (PR #17 retro-review finding E, MEDIUM) AND the core key-write path
// (kcWrite/kcBackup) that persists both master keys on every ceremony.
//
// Two layers:
//   1. SOURCE (runs everywhere, incl. Linux CI): assert no save helper NOR the
//      core write path (kcWrite/kcBackup) embeds the secret in the argv array,
//      and all feed it via `input:`/stdin.
//   2. LIVE (macOS only, skipped when `security` is absent): save a throwaway
//      64-hex key via the helper (L1) and via writeKeychain → readUserMaster (L2),
//      each in an isolated namespace, proving the stdin invocations work
//      end-to-end without ever putting a key on argv.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const KEYSTORE = join(ROOT, 'src/account/keystore.js');

let pass = 0;
let fail = 0;
const rec = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

// ── 1. SOURCE guards ────────────────────────────────────────────────────────
const src = readFileSync(KEYSTORE, 'utf8');

// The exact argv-leak patterns the fix removed must NOT reappear.
rec(!/'-w',\s*normalizeKey\(/.test(src) && !/'-w',\s*key\b/.test(src),
  'S1. Keychain: no secret value passed after the `-w` flag in argv',
  "guards against `['... , '-w', <key>]`");
rec(!/`password=\$\{/.test(src) && !/'password='\s*\+/.test(src),
  'S2. 1Password: no `password=<key>` assignment in argv',
  'guards against the op `password=${key}` argv element');

// And both helpers must feed the secret via stdin (`input:`).
const kcFn = src.match(/export function saveRecoveryKeyToKeychain[\s\S]*?\n}/)?.[0] ?? '';
const opFn = src.match(/export function saveRecoveryKeyTo1Password[\s\S]*?\n}/)?.[0] ?? '';
rec(/input:\s*`\$\{key\}/.test(kcFn) && /'-w'\s*\]/.test(kcFn),
  'S3. Keychain: secret travels via `input:` stdin, `-w` flag carries no value', `len=${kcFn.length}`);
rec(/input:\s*template/.test(opFn) && /'--template',\s*'-'/.test(opFn),
  'S4. 1Password: secret travels via stdin JSON template (`--template -`)', `len=${opFn.length}`);

// Core key-write path (kcWrite/kcBackup) — same discipline: the master keys must
// reach `security` on stdin, never argv. (Generalises the #17 helper fix.)
rec(/function defaultExec\(cmd, args, input\)/.test(src),
  'S5. defaultExec accepts an optional `input` so writes can feed the secret on stdin');
rec(!/'-w',\s*value\]/.test(src) && /'-w'\],\s*`\$\{value\}/.test(src),
  'S6. kcWrite: secret on stdin (`-w` no value + `${value}` double-line), not argv');
rec(!/'-w',\s*priorValue\]/.test(src) && /'-w'\],\s*`\$\{priorValue\}/.test(src),
  'S7. kcBackup: prior secret on stdin, not argv');

// ── 2. LIVE Keychain round-trip (macOS only) ────────────────────────────────
let hasSecurity = false;
try { execFileSync('security', ['-h'], { stdio: 'ignore' }); hasSecurity = true; } catch { /* not macOS */ }

if (!hasSecurity) {
  rec(true, 'L1. live Keychain round-trip — SKIPPED (no `security` CLI; Linux CI)', 'source guards above still enforced');
} else {
  const account = `mycelium-verify-stdin-${process.pid}`;
  const service = 'Mycelium Recovery Key'; // hardcoded in the helper; account isolates the test item
  const key = 'a'.repeat(64); // valid 64-hex; never the user's real key
  let readback = null;
  try {
    const { saveRecoveryKeyToKeychain } = await import('../src/account/keystore.js');
    saveRecoveryKeyToKeychain(key, { env: { ...process.env, MYCELIUM_KC_ACCOUNT: account } });
    readback = execFileSync('security', ['find-generic-password', '-a', account, '-s', service, '-w'], { encoding: 'utf8' }).trim();
  } catch (e) {
    rec(false, 'L1. live Keychain round-trip threw', String(e?.message || e));
  } finally {
    try { execFileSync('security', ['delete-generic-password', '-a', account, '-s', service], { stdio: 'ignore' }); } catch { /* best-effort */ }
  }
  if (readback !== null) {
    rec(readback === key, 'L1. live Keychain round-trip via stdin (saved → read back → match)',
      `readback ${readback === key ? 'matched' : `MISMATCH (${readback})`}, isolated account ${account}, cleaned up`);
  }
}

// ── 3. LIVE writeKeychain round-trip — the CORE path (macOS only) ────────────
// Exercises kcWrite (and thus defaultExec's stdin write) end-to-end via an
// ephemeral Keychain namespace, so it can never touch the user's real keys.
if (!hasSecurity) {
  rec(true, 'L2. live writeKeychain round-trip — SKIPPED (no `security` CLI)', 'source guards S5–S7 still enforced');
} else {
  const suf = `verify-kcw-${process.pid}`;
  const env = { ...process.env,
    MYCELIUM_KC_ACCOUNT: `myc-${suf}`, MYCELIUM_KC_USER: `myc-user-${suf}`, MYCELIUM_KC_SYSTEM: `myc-sys-${suf}` };
  const userHex = 'b'.repeat(64);   // valid 64-hex; never a real key
  const systemHex = 'c'.repeat(64);
  let got = null;
  try {
    const ks = await import('../src/account/keystore.js');
    ks.writeKeychain(userHex, systemHex, { env });
    got = ks.readUserMaster({ env });
  } catch (e) {
    rec(false, 'L2. live writeKeychain round-trip threw', String(e?.message || e));
  } finally {
    try { const ks = await import('../src/account/keystore.js'); ks.deleteKeychain({ env }); } catch { /* best-effort */ }
  }
  if (got !== null) {
    rec(got === userHex, 'L2. live writeKeychain → readUserMaster via stdin (USER_MASTER round-trips through the core path)',
      `readback ${got === userHex ? 'matched' : `MISMATCH (${got})`}, ephemeral namespace myc-${suf}, cleaned up`);
  }
}

console.log(`\n${pass} pass · ${fail} fail`);
console.log(fail === 0
  ? 'VERDICT: GO — recovery key reaches security/op via stdin, never argv'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(fail === 0 ? 0 : 1);

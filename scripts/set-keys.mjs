// scripts/set-keys.mjs — one-time key setup for a local Mac.
//
// Generates the two 64-char hex master keys (or uses ones you provide) and
// stores them where boot() can read them without keeping keys in shell history
// or config files:
//
//   node scripts/set-keys.mjs               # generate + store in macOS Keychain
//   node scripts/set-keys.mjs --show        # also print the keys (for 1Password)
//   node scripts/set-keys.mjs --user <hex> --system <hex>   # store specific keys
//
// After running, start the server with:   MYCELIUM_KEY_SOURCE=keychain npm start
//
// Security: keys are written to the login Keychain via `security`. Generating
// fresh keys overwrites the in-memory values when done. We never log a key
// unless you pass --show (so they don't linger in terminal scrollback).

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

const ACCOUNT = process.env.MYCELIUM_KC_ACCOUNT || 'mycelium';
const USER_SVC = process.env.MYCELIUM_KC_USER || 'mycelium-user-master';
const SYSTEM_SVC = process.env.MYCELIUM_KC_SYSTEM || 'mycelium-system-key';
const HEX64 = /^[0-9a-f]{64}$/i;

function genOrTake(provided, label) {
  if (provided === undefined) return crypto.randomBytes(32).toString('hex');
  if (!HEX64.test(provided)) { console.error(`set-keys: --${label} must be 64 hex chars`); process.exit(1); }
  return provided.toLowerCase();
}

function storeKeychain(service, value) {
  // -U updates an existing item instead of erroring. -w <value> sets the secret.
  execFileSync('security', ['add-generic-password', '-U', '-a', ACCOUNT, '-s', service, '-w', value], { stdio: ['ignore', 'ignore', 'inherit'] });
}

function main() {
  const userHex = genOrTake(opt('--user'), 'user');
  const systemHex = genOrTake(opt('--system'), 'system');
  const isMac = process.platform === 'darwin';

  if (isMac && !flag('--print-only')) {
    try {
      storeKeychain(USER_SVC, userHex);
      storeKeychain(SYSTEM_SVC, systemHex);
      console.log('✓ Stored both keys in the macOS login Keychain:');
      console.log(`    service "${USER_SVC}" / account "${ACCOUNT}"  (USER_MASTER)`);
      console.log(`    service "${SYSTEM_SVC}" / account "${ACCOUNT}"  (SYSTEM_KEY)`);
      console.log('\nStart the server reading from Keychain:');
      console.log('    MYCELIUM_KEY_SOURCE=keychain npm start');
    } catch (err) {
      console.error('set-keys: failed to write to Keychain:', err.message);
      process.exit(1);
    }
  } else if (!isMac) {
    console.log(`set-keys: not macOS (${process.platform}) — Keychain unavailable. Keys generated below; store them yourself.`);
  }

  if (flag('--show') || flag('--print-only') || !isMac) {
    console.log('\n⚠️  Secret keys — store in a password manager, then clear your scrollback:');
    console.log(`USER_MASTER_KEY=${userHex}`);
    console.log(`SYSTEM_KEY=${systemHex}`);
  }

  console.log('\n— 1Password (optional) — create one item with two fields, then export the refs:');
  console.log('    op item create --category=password --title=Mycelium \\');
  console.log('      "user_master[password]=<USER_MASTER_KEY>" "system_key[password]=<SYSTEM_KEY>"');
  console.log('    export MYCELIUM_KEY_SOURCE=1password');
  console.log('    export MYCELIUM_OP_USER="op://Private/Mycelium/user_master"');
  console.log('    export MYCELIUM_OP_SYSTEM="op://Private/Mycelium/system_key"');
  console.log('\n⚠️  Back up both keys offline. Lose them = lose the vault. No recovery.');
}

main();

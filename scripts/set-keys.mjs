// scripts/set-keys.mjs — one-time key setup for a local Mac (CLI path).
//
// The app's first-run ceremony (src/account/router.js) is the normal way to do
// this; this script is the headless/dev equivalent and shares the SAME code
// (src/account/keystore.js), so both derive SYSTEM_KEY the same way.
//
// There is ONE secret to save: USER_MASTER (the recovery key). SYSTEM_KEY is
// derived from it, so backing up the single key is enough.
//
//   node scripts/set-keys.mjs                 # generate + store in the Keychain
//   node scripts/set-keys.mjs --user <hex>    # import an existing recovery key
//   node scripts/set-keys.mjs --print-only    # just print (don't touch Keychain)
//   node scripts/set-keys.mjs --force         # overwrite keys already in Keychain
//
// After running:  MYCELIUM_KEY_SOURCE=keychain npm start
import {
  generateUserMaster, deriveSystemKey, normalizeKey, isHex64,
  writeKeychain, keychainHasKeys, keychainAvailable,
} from '../src/account/keystore.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function main() {
  const provided = opt('--user');
  if (provided !== undefined && !isHex64(provided)) {
    console.error('set-keys: --user must be a 64-character hex key');
    process.exit(1);
  }
  const userHex = provided !== undefined ? normalizeKey(provided) : generateUserMaster();
  const systemHex = deriveSystemKey(userHex);
  const isMac = keychainAvailable();
  const printOnly = flag('--print-only');

  if (isMac && !printOnly) {
    if (keychainHasKeys() && !flag('--force')) {
      console.error('set-keys: keys already exist in the Keychain. Overwriting them would');
      console.error('          lock you out of the current vault. Re-run with --force only if');
      console.error('          you intend to replace them (e.g. restoring a different vault).');
      process.exit(2);
    }
    try {
      writeKeychain(userHex, systemHex);
      console.log('✓ Stored your vault keys in the macOS login Keychain.');
      console.log('  Start the server reading from Keychain:');
      console.log('      MYCELIUM_KEY_SOURCE=keychain npm start');
    } catch (err) {
      console.error('set-keys: failed to write to Keychain:', err.message);
      process.exit(1);
    }
  } else if (!isMac) {
    console.log('set-keys: macOS Keychain unavailable — keys printed below; store them yourself.');
  }

  console.log('\n⚠️  YOUR RECOVERY KEY — save this in a password manager. It is the ONLY way');
  console.log('    to recover your vault on a new machine. Lose it = lose the vault. No reset.\n');
  console.log(`    ${userHex}\n`);

  if (flag('--show') || printOnly || !isMac) {
    console.log('— Running from env or 1Password instead of the Keychain? Both keys (SYSTEM_KEY');
    console.log('  is derived from your recovery key, shown for convenience):');
    console.log(`      USER_MASTER_KEY=${userHex}`);
    console.log(`      SYSTEM_KEY=${systemHex}`);
  }
}

main();

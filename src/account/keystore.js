// src/account/keystore.js — generate, derive, store and read the vault's master
// keys on macOS, in one place shared by the first-run account ceremony
// (src/account/router.js) and the `npm run set-keys` CLI (scripts/set-keys.mjs).
//
// SINGLE RECOVERY KEY: the one secret the user saves IS USER_MASTER (a 64-char
// hex string). SYSTEM_KEY is DERIVED from it via HKDF-SHA256, so one key
// reconstructs both. This is safe because SYSTEM_KEY only encrypts the operator
// `secrets` table (SYSTEM_KEY_TABLES in src/crypto/crypto-local.js), which is
// empty for a normal local user. Both keys are still WRITTEN to the Keychain so
// the boot path (src/crypto/key-source.js → resolveKeys) is unchanged.
//
// Security discipline (mirrors key-source.js): we shell out with execFile + an
// argv array (never a shell string); secrets arrive on the child's stdout and
// are never logged. Keychain writes use `add-generic-password -U`.
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { keychainNames } from './keychain-names.js';

const HEX64 = /^[0-9a-f]{64}$/i;
// HKDF domain-separation label for SYSTEM_KEY. This is a PERMANENT part of the
// scheme — changing it would orphan any data encrypted under the old SYSTEM_KEY.
const SYSTEM_KEY_INFO = 'mycelium:system-key:v1';

export function isHex64(s) { return typeof s === 'string' && HEX64.test(s.trim()); }

/** Normalise a pasted recovery key (strip spaces, lowercase) or throw. */
export function normalizeKey(s) {
  const k = String(s ?? '').trim().replace(/\s+/g, '').toLowerCase();
  if (!HEX64.test(k)) throw new Error('expected a 64-character hex key');
  return k;
}

/** A fresh 256-bit USER_MASTER — the single recovery key the user saves. */
export function generateUserMaster() { return crypto.randomBytes(32).toString('hex'); }

/**
 * Deterministically derive SYSTEM_KEY from USER_MASTER (HKDF-SHA256, no salt,
 * info=SYSTEM_KEY_INFO). Same input → same output, forever.
 */
export function deriveSystemKey(userHex) {
  const ikm = Buffer.from(normalizeKey(userHex), 'hex');
  const out = crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(SYSTEM_KEY_INFO), 32);
  return Buffer.from(out).toString('hex');
}

/** Is the macOS `security` CLI usable (i.e. can we touch the Keychain)? */
export function keychainAvailable() {
  if (process.platform !== 'darwin') return false;
  try { execFileSync('security', ['list-keychains'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function kcRead(service, env) {
  const { account } = keychainNames({ env });
  try {
    return execFileSync('security', ['find-generic-password', '-a', account, '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; } // not found → null (never throws / never logs)
}

function kcWrite(service, value, env) {
  const { account } = keychainNames({ env });
  // -U updates an existing item in place; -w sets the secret. argv array, no shell.
  execFileSync('security', ['add-generic-password', '-U', '-a', account, '-s', service, '-w', value],
    { stdio: ['ignore', 'ignore', 'inherit'] });
}

function kcDelete(service, env) {
  const { account } = keychainNames({ env });
  try { execFileSync('security', ['delete-generic-password', '-a', account, '-s', service], { stdio: 'ignore' }); }
  catch { /* absent — fine */ }
}

/** Write both keys to the Keychain (USER_MASTER + its derived SYSTEM_KEY). */
export function writeKeychain(userHex, systemHex, { env = process.env } = {}) {
  const { userService, systemService } = keychainNames({ env });
  kcWrite(userService, normalizeKey(userHex), env);
  kcWrite(systemService, normalizeKey(systemHex), env);
}

/** Remove both key items (test cleanup / explicit reset). */
export function deleteKeychain({ env = process.env } = {}) {
  const { userService, systemService } = keychainNames({ env });
  kcDelete(userService, env);
  kcDelete(systemService, env);
}

/** Read USER_MASTER (the recovery key) back from the Keychain, or null. */
export function readUserMaster({ env = process.env } = {}) {
  const { userService } = keychainNames({ env });
  const v = kcRead(userService, env);
  return v && HEX64.test(v) ? v.toLowerCase() : null;
}

/** Are BOTH key items present in the Keychain? */
export function keychainHasKeys({ env = process.env } = {}) {
  const { userService, systemService } = keychainNames({ env });
  return Boolean(kcRead(userService, env)) && Boolean(kcRead(systemService, env));
}

// ── one-click "save my recovery key" targets (ceremony convenience) ──────────
const RECOVERY_LABEL = 'Mycelium Recovery Key';

/** Is the 1Password CLI (`op`) installed? (Sign-in is checked when saving.) */
export function onePasswordAvailable() {
  try { execFileSync('op', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

/** Save the recovery key as a discoverable, labelled item in the login Keychain
 *  (separate from the app's working key item, so the user can find it easily). */
export function saveRecoveryKeyToKeychain(value, { env = process.env } = {}) {
  const { account } = keychainNames({ env });
  execFileSync('security', ['add-generic-password', '-U', '-a', account, '-s', RECOVERY_LABEL,
    '-j', 'Your Mycelium vault recovery key — the only way to recover your vault on a new computer.',
    '-w', normalizeKey(value)], { stdio: ['ignore', 'ignore', 'inherit'] });
}

/** Save the recovery key to 1Password via the `op` CLI (requires `op` signed in;
 *  throws otherwise — the caller surfaces a friendly message). */
export function saveRecoveryKeyTo1Password(value) {
  execFileSync('op', ['item', 'create', '--category=password', `--title=${RECOVERY_LABEL}`,
    `password=${normalizeKey(value)}`,
    'notesPlain=Mycelium vault recovery key — the only way to recover your vault on a new computer.'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
}

/** Best-effort: open the store app so the user SEES the saved item natively
 *  (the External-URL webview can't, so the server does it). Never throws. */
export function openInStore(target) {
  const args = target === '1password' ? ['onepassword://'] : ['-a', 'Keychain Access'];
  try { execFile('open', args, () => {}); } catch { /* best-effort, non-fatal */ }
}

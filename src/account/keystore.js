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
//
// DATA-LOSS GUARD (added 2026-06-05 after a fresh-key ceremony clobbered a real
// `mycelium-user-master` item in place — `-U` keeps no version history, so the
// 81MB vault encrypted under the old key became permanently undecryptable):
//   1. BACKUP-BEFORE-OVERWRITE — kcWrite() never overwrites a DIFFERENT existing
//      value without first copying the prior secret to a timestamped companion
//      item (`<service>.bak.<ts>`). Any overwrite is therefore recoverable.
//   2. REFUSE-IN-DEFAULT-NAMESPACE — writeKeychain() refuses to overwrite an
//      existing key in the real (default) namespace with a DIFFERENT value
//      unless { force:true } is passed. Tests/ceremonies that namespace away via
//      MYCELIUM_KC_* are unaffected; a run that FORGETS to namespace is blocked.
// Both layers are independent (CLAUDE.md §2 defense-in-depth) and fail closed.
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { keychainNames, isDefaultNamespace } from './keychain-names.js';

const HEX64 = /^[0-9a-f]{64}$/i;
// HKDF domain-separation label for SYSTEM_KEY. This is a PERMANENT part of the
// scheme — changing it would orphan any data encrypted under the old SYSTEM_KEY.
const SYSTEM_KEY_INFO = 'mycelium:system-key:v1';
// HKDF domain-separation label for the whole-file SQLCipher DB key (at-rest
// blindness). PERMANENT — changing it would make the encrypted vault unopenable.
// No third secret: like SYSTEM_KEY, this is derived from USER_MASTER, so the one
// recovery key still reconstructs everything (operator: "no third KCV, all local").
const DB_CIPHER_INFO = 'mycelium:db-cipher:v1';

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

/**
 * Deterministically derive the whole-file SQLCipher key from USER_MASTER
 * (HKDF-SHA256, no salt, info=DB_CIPHER_INFO). Returns 64-char hex (the raw key
 * SQLCipher binds via `key="x'<hex>'"`). Same input → same output, forever.
 * No new secret and no third KCV: SQLCipher self-verifies (wrong key → the file
 * won't open), so the per-key KCV scheme is untouched. @see deriveSystemKey.
 */
export function deriveDbKey(userHex) {
  const ikm = Buffer.from(normalizeKey(userHex), 'hex');
  const out = crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(DB_CIPHER_INFO), 32);
  return Buffer.from(out).toString('hex');
}

/** Is the macOS `security` CLI usable (i.e. can we touch the Keychain)? */
export function keychainAvailable() {
  if (process.platform !== 'darwin') return false;
  try { execFileSync('security', ['list-keychains'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

/** Thrown when writeKeychain refuses a destructive overwrite (no force). The
 *  message NEVER contains a key value — only service names + remediation. */
export class KeyOverwriteError extends Error {
  constructor(message) { super(message); this.name = 'KeyOverwriteError'; }
}

/** Default executor: run `security` with an argv array, return trimmed stdout.
 *  Injectable so the verify gate can mock the Keychain with zero risk to the real
 *  one. stderr is SUPPRESSED (not inherited): the read-probes routinely "fail" on
 *  a missing item and `security` would otherwise spam "could not be found"; write
 *  failures are surfaced via the thrown Error's message, never raw stderr. stdout
 *  (which may carry a secret) is captured and never logged. */
function defaultExec(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function kcRead(service, account, exec) {
  try {
    return exec('security', ['find-generic-password', '-a', account, '-s', service, '-w']);
  } catch { return null; } // not found → null (never throws / never logs)
}

// Monotonic, collision-resistant suffix for backup companion items, so two
// writes in the same millisecond can't clobber each other's backup.
let _bakSeq = 0;
function backupSuffix() {
  // 20260605T164326123Z.<seq> — compact UTC matching the Keychain mdat style.
  const compact = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
  return `${compact}.${(_bakSeq++).toString(36)}`;
}

/** Copy the PRIOR secret to a timestamped companion item before it is overwritten.
 *  The value is the old key (kept encrypted in the Keychain, never logged); the
 *  `-j` comment carries only guidance. Returns the backup service name. */
function kcBackup(service, account, priorValue, exec) {
  const bakService = `${service}.bak.${backupSuffix()}`;
  exec('security', ['add-generic-password', '-U', '-a', account, '-s', bakService,
    '-j', 'Mycelium key backup — saved automatically before an overwrite. Safe to delete once you have confirmed the vault still opens.',
    '-w', priorValue]);
  return bakService;
}

function kcWrite(service, value, account, exec) {
  const prior = kcRead(service, account, exec);
  // Never lose a key silently: back up any DIFFERENT existing value first.
  if (prior !== null && prior !== value) kcBackup(service, account, prior, exec);
  // -U updates an existing item in place; -w sets the secret. argv array, no shell.
  exec('security', ['add-generic-password', '-U', '-a', account, '-s', service, '-w', value]);
}

function kcDelete(service, account, exec) {
  try { exec('security', ['delete-generic-password', '-a', account, '-s', service]); }
  catch { /* absent — fine */ }
}

/**
 * Write both keys to the Keychain (USER_MASTER + its derived SYSTEM_KEY).
 *
 * In the REAL (default) namespace, refuses to overwrite an existing key with a
 * DIFFERENT value unless { force:true } — this is the guard that would have
 * stopped the 2026-06-05 data loss. Writing the SAME value is always idempotent
 * (so /restore re-pinning a verified key and /passphrase/disable restoring the
 * vault's own keys need no force). On a genuine forced replacement, the prior
 * key is backed up first (see kcWrite).
 *
 * @param {object} [opts]
 * @param {object} [opts.env=process.env]
 * @param {boolean} [opts.force=false]  allow a different-value overwrite of the real namespace
 * @param {(cmd:string,args:string[])=>string} [opts.exec]  injectable (tests)
 */
export function writeKeychain(userHex, systemHex, { env = process.env, force = false, exec = defaultExec } = {}) {
  const { account, userService, systemService } = keychainNames({ env });
  const items = [[userService, normalizeKey(userHex)], [systemService, normalizeKey(systemHex)]];

  if (isDefaultNamespace({ env }) && !force) {
    for (const [service, value] of items) {
      const prior = kcRead(service, account, exec);
      if (prior !== null && prior !== value) {
        // No secret in the message — only the service name + remediation.
        throw new KeyOverwriteError(
          `refusing to overwrite the existing key "${service}" with a different value: ` +
          `this would lock you out of the current vault (the data encrypted under the old ` +
          `key would become unrecoverable). Re-run with force ONLY if you intend to replace ` +
          `it — the previous key is backed up to "${service}.bak.<timestamp>" first.`);
      }
    }
  }

  // Pre-check passed (or force/ephemeral): write, backing up any prior value.
  kcWrite(userService, items[0][1], account, exec);
  kcWrite(systemService, items[1][1], account, exec);
}

/** Remove both key items (test cleanup / explicit reset). Backup companions are
 *  intentionally left in place — they are recovery artifacts the user removes by
 *  hand once the vault is confirmed open. */
export function deleteKeychain({ env = process.env, exec = defaultExec } = {}) {
  const { account, userService, systemService } = keychainNames({ env });
  kcDelete(userService, account, exec);
  kcDelete(systemService, account, exec);
}

/** Read USER_MASTER (the recovery key) back from the Keychain, or null. */
export function readUserMaster({ env = process.env, exec = defaultExec } = {}) {
  const { account, userService } = keychainNames({ env });
  const v = kcRead(userService, account, exec);
  return v && HEX64.test(v) ? v.toLowerCase() : null;
}

/** Are BOTH key items present in the Keychain? */
export function keychainHasKeys({ env = process.env, exec = defaultExec } = {}) {
  const { account, userService, systemService } = keychainNames({ env });
  return Boolean(kcRead(userService, account, exec)) && Boolean(kcRead(systemService, account, exec));
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

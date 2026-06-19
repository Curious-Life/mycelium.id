// src/crypto/key-source.js — where the two hex master keys come from.
//
// The vault unlock (src/crypto/keys.js) takes two 64-char hex keys and verifies
// them against the KCV. This module decides WHERE those hex strings are read
// from at boot, so they need not live in shell history or a config file:
//
//   MYCELIUM_KEY_SOURCE = env        (default) read USER_MASTER_KEY / SYSTEM_KEY
//                       = keychain    read from the macOS Keychain (`security`)
//                       = 1password   read from the 1Password CLI (`op read`)
//
// Security discipline (CLAUDE.md §4 — master key):
//   - We shell out with execFile + an ARGUMENT ARRAY (never a shell string), so
//     a service name / secret reference can never inject a command.
//   - The secret arrives on the child's stdout; it is trimmed and returned. It
//     is NEVER logged, never put in an error message, never echoed. Errors carry
//     only the source + a generic reason.
//   - Fail closed: missing tool, missing item, or a value that is not 64 hex
//     chars → throw. We never fall back to a weaker source silently.
//
// Keychain/1Password are strictly MORE secure than env here: an env var is
// visible to `ps -E` / `/proc`, whereas these keep the key out of the process
// environment until unlock needs it.

import { execFileSync } from 'node:child_process';
import { keychainNames } from '../account/keychain-names.js';

const HEX64 = /^[0-9a-f]{64}$/i;

/** Default executor: run a command with an arg array, return trimmed stdout. */
function defaultExec(cmd, args) {
  // No shell: args are passed as argv, not interpolated. stdout captured;
  // stderr inherited so the user sees e.g. a 1Password auth prompt.
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/** Read a generic-password secret from the macOS Keychain. */
function fromKeychain(service, account, exec) {
  let out;
  try {
    out = exec('security', ['find-generic-password', '-a', account, '-s', service, '-w']);
  } catch (err) {
    const reason = err?.code === 'ENOENT'
      ? '`security` not found (macOS only)'
      : `no Keychain item for service "${service}" (add it with: npm run set-keys)`;
    throw new KeySourceError(`keychain: ${reason}`, { cause: err });
  }
  return out;
}

/** Read a secret from the 1Password CLI via a secret reference (op://...). */
function from1Password(ref, exec) {
  if (!ref) throw new KeySourceError('1password: missing secret reference (set MYCELIUM_OP_USER / MYCELIUM_OP_SYSTEM to an op:// path)');
  let out;
  try {
    out = exec('op', ['read', ref]);
  } catch (err) {
    const reason = err?.code === 'ENOENT'
      ? '`op` (1Password CLI) not found — install it and run `op signin`'
      : 'could not read the secret reference (is `op` signed in?)';
    throw new KeySourceError(`1password: ${reason}`, { cause: err });
  }
  return out;
}

export class KeySourceError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'KeySourceError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** Validate a hex key WITHOUT ever putting its value in the error. */
function assertHex(value, label) {
  if (typeof value !== 'string' || !HEX64.test(value.trim())) {
    throw new KeySourceError(`${label}: expected a 64-char hex key, got ${value ? `${value.trim().length} chars` : 'nothing'}`);
  }
  return value.trim();
}

/**
 * Resolve the two hex master keys from the configured source. Returns
 * { userHex, systemHex }. Throws KeySourceError (fail-closed) on any problem.
 *
 * @param {object} [opts]
 * @param {object} [opts.env=process.env]
 * @param {(cmd:string,args:string[])=>string} [opts.exec]  injectable (tests)
 */
export function resolveKeys({ env = process.env, exec = defaultExec } = {}) {
  const source = (env.MYCELIUM_KEY_SOURCE || 'env').trim().toLowerCase();
  let userHex, systemHex;

  if (source === 'env') {
    userHex = env.USER_MASTER_KEY;
    systemHex = env.SYSTEM_KEY;
  } else if (source === 'keychain') {
    const { account, userService, systemService } = keychainNames({ env });
    userHex = fromKeychain(userService, account, exec);
    systemHex = fromKeychain(systemService, account, exec);
  } else if (source === '1password' || source === 'op') {
    userHex = from1Password(env.MYCELIUM_OP_USER, exec);
    systemHex = from1Password(env.MYCELIUM_OP_SYSTEM, exec);
  } else {
    throw new KeySourceError(`unknown MYCELIUM_KEY_SOURCE "${source}" (env | keychain | 1password)`);
  }

  return {
    userHex: assertHex(userHex, source === 'env' ? 'USER_MASTER_KEY' : 'user master key'),
    systemHex: assertHex(systemHex, source === 'env' ? 'SYSTEM_KEY' : 'system key'),
  };
}

export default resolveKeys;

// scripts/vault-repair/operational-vault.mjs — resolve THE VAULT THE USER RUNS, for
// operational tooling (health probes, diagnosis, rebuild, swap).
//
// THE DEFECT THIS FIXES (hit twice in one session, 2026-07-28, and it produced a false
// diagnosis both times): these tools resolved their target with `dbPath()`, which is the
// APPLICATION's resolver — it answers "the vault for THIS process's env", and in a repo
// checkout that is `<repo>/data/mycelium.db`, a dev fixture. So:
//
//   • `db-health.mjs --live` — whose own flag means "THE app's vault" — silently probed
//     the repo dev vault. Keyed with the real Keychain key it returned SQLITE_NOTADB,
//     which reads exactly like "your master key does not open your vault". It cost a
//     wrong, alarming conclusion ("the key is missing from the Keychain") on a machine
//     whose Keychain was fine. Its `if (!existsSync(p))` fallback to the app vault never
//     fired, because a dev vault DID exist.
//   • `install-vault.mjs` — the vault SWAP — takes no fallback at all. Run from the repo
//     it would have archived and replaced the DEV vault, printed "DONE — installed vault
//     verified", and left the user's real, corrupt vault untouched. A repair tool that
//     silently repairs the wrong database is worse than no repair tool.
//
// THE RULE: for operational tooling the default must be the vault the USER runs, not the
// vault this checkout would run. An explicit MYCELIUM_DB still wins — that is how a
// deliberate target (a copy, a fixture, a second profile) is named — but the fallback is
// the platform app-support vault, never the checkout. And the choice is always PRINTED,
// because a tool that can act on two different databases must say which one it picked.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The packaged app's vault, per the Tauri bundle identifier (src-tauri/tauri.conf.json). */
export function platformVaultPath() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'id.mycelium.app', 'mycelium.db');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'id.mycelium.app', 'mycelium.db');
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'id.mycelium.app', 'mycelium.db');
}

/**
 * Resolve the vault an operational tool should act on.
 *
 * Precedence — explicit beats implicit, and the user's vault beats the checkout's:
 *   1. an explicit argument (a path the operator typed)
 *   2. MYCELIUM_DB / MYCELIUM_DATA_DIR set in the environment
 *   3. the platform app vault
 *
 * @param {object}  [opts]
 * @param {string}  [opts.explicit]     a path the operator passed on argv
 * @param {string}  [opts.what='vault'] label for the printed line
 * @param {boolean} [opts.mustExist=true]
 * @returns {{ path: string, source: 'argv'|'env'|'platform' }}
 */
export function resolveOperationalVault({ explicit = null, what = 'vault', mustExist = true } = {}) {
  let path, source;
  if (explicit) {
    path = resolve(explicit); source = 'argv';
  } else if (process.env.MYCELIUM_DB) {
    path = resolve(process.env.MYCELIUM_DB); source = 'env';
  } else if (process.env.MYCELIUM_DATA_DIR) {
    path = join(resolve(process.env.MYCELIUM_DATA_DIR), 'mycelium.db'); source = 'env';
  } else {
    path = platformVaultPath(); source = 'platform';
  }

  // ALWAYS say which database is about to be acted on. Silence is what made the two
  // failures above indistinguishable from a real problem with the user's vault.
  console.error(`[vault] target: ${path}  (from ${source})`);

  if (mustExist && !existsSync(path)) {
    const hint = source === 'platform'
      ? 'no vault at the app location — is the app installed and set up? Pass an explicit path or set MYCELIUM_DB to target a different one.'
      : `no vault at the ${source === 'argv' ? 'given path' : 'MYCELIUM_DB/MYCELIUM_DATA_DIR location'}.`;
    throw Object.assign(new Error(`${what}: ${hint} (${path})`), { code: 'vault_not_found' });
  }
  return { path, source };
}

export default resolveOperationalVault;

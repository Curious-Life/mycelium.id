// src/paths.js — single source of truth for WHERE Mycelium keeps its data.
//
// The vault used to default to ./data/mycelium.db *inside the repo / app
// bundle*, so an app update wiped the user's history. This module centralises
// the data location so every reader/writer agrees, and so the durable per-OS
// application-data directory (which survives updates) is used by the packaged
// app.
//
// Resolution (per item: explicit env var wins, else <dataDir>/<file>):
//   dataDir():
//     1. MYCELIUM_DATA_DIR — the Tauri shell passes its app_data_dir() here on
//        every launch (see src-tauri/src/main.rs); tests/CLI may pin a dir too.
//     2. else ./data relative to cwd — the legacy location, kept so a bare
//        `npm start` / `npm run init-db` dev run behaves exactly as before.
//   The packaged .app is durable because (1) is always set by the shell.
//
// appDataDir() computes the same per-OS path Tauri would, so Node-side tooling
// (Settings "where is my data", docs) can show/derive it without the shell.
import os from 'node:os';
import path from 'node:path';

export const APP_IDENTIFIER = 'id.mycelium.app';

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The per-OS application-data directory, matching Tauri v2 `app_data_dir()`:
 *   macOS   → ~/Library/Application Support/id.mycelium.app
 *   Windows → %APPDATA%\id.mycelium.app
 *   Linux   → $XDG_DATA_HOME/id.mycelium.app  (or ~/.local/share/...)
 */
export function appDataDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_IDENTIFIER);
  if (platform === 'win32') return path.join(clean(env.APPDATA) || path.join(home, 'AppData', 'Roaming'), APP_IDENTIFIER);
  return path.join(clean(env.XDG_DATA_HOME) || path.join(home, '.local', 'share'), APP_IDENTIFIER);
}

/** The active data directory (absolute). See module header for resolution. */
export function dataDir({ env = process.env, cwd = process.cwd() } = {}) {
  const explicit = clean(env.MYCELIUM_DATA_DIR);
  return explicit ? path.resolve(explicit) : path.resolve(cwd, 'data');
}

/** <dataDir>/<file>, unless the per-item env override is set (then resolve it). */
function under(file, envVar, { env = process.env } = {}) {
  const override = clean(env[envVar]);
  // SQLite's in-memory sentinel must pass through verbatim — path.resolve() would
  // turn ':memory:' into a real on-disk file (better-sqlite3 takes it literally).
  if (override === ':memory:') return ':memory:';
  return override ? path.resolve(override) : path.join(dataDir({ env }), file);
}

export function dbPath(opts = {})      { return under('mycelium.db', 'MYCELIUM_DB', opts); }
export function kcvPath(opts = {})     { return under('kcv.json',    'MYCELIUM_KCV', opts); }
export function authDbPath(opts = {})  { return under('auth.db',     'MYCELIUM_AUTH_DB', opts); }
export function uploadsRoot(opts = {}) { return under('uploads',     'MYCELIUM_UPLOADS_ROOT', opts); }
// Optional passphrase-lock seal (src/account/passphrase-lock.js). Present ONLY
// when the user enables an app passphrase; its presence means the vault is
// passphrase-locked and the plaintext keys have been removed from the Keychain.
export function lockPath(opts = {})    { return under('vault-lock.json', 'MYCELIUM_VAULT_LOCK', opts); }

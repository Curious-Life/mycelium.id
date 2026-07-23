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

// ── Attachment blob storage-key convention ──────────────────────────────────
// Every uploaded/imported file blob is stored under uploadsRoot() with a key of
// the form `<userId>/<uuid><ext>.enc` (see src/ingest/blob-store.js putBlob).
// The reference-counted blob GC keys on that stored path ALONE, unscoped by
// user_id (intentional — it guards ONE physical file and must keep it while ANY
// row references it; scoping the COUNT would let one tenant's delete unlink
// another tenant's blob). That unscoped GC is safe only while every stored path
// is provably namespaced under its owner — otherwise two tenants' rows could
// collide on one path and share/destroy a blob. These guards are that proof,
// enforced fail-closed on every attachment insert/restore. Defined here (a leaf
// path util) so both the blob store and the db attachments namespace can import
// them without a layer inversion.
//
// `true` iff `rel` is `<userId>/<file...>` with a real file segment and no
// empty/`.`/`..` segment (traversal belt-and-suspenders). Null/non-string → false.
export function isUserNamespacedBlobPath(rel, userId) {
  if (typeof rel !== 'string' || !rel) return false;
  if (typeof userId !== 'string' || !userId) return false;
  // putBlob builds the key with node:path join on darwin/linux (sep '/'); the
  // importers likewise persist posix-relative keys.
  const segs = rel.split('/');
  if (segs.length < 2) return false;          // must be <userId>/<file>
  if (segs[0] !== userId) return false;       // owned by the importing user
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return false; // no traversal
  return true;
}

/** Fail-closed variant: throws unless `rel` is namespaced under `userId`. */
export function assertUserNamespacedBlobPath(rel, userId) {
  if (!isUserNamespacedBlobPath(rel, userId)) {
    // Zero-leakage: the message names neither the path nor the user id.
    throw new Error('attachment local_path is not namespaced under the owning user — refusing to write (cross-tenant blob-collision guard)');
  }
}
// Optional passphrase-lock seal (src/account/passphrase-lock.js). Present ONLY
// when the user enables an app passphrase; its presence means the vault is
// passphrase-locked and the plaintext keys have been removed from the Keychain.
export function lockPath(opts = {})    { return under('vault-lock.json', 'MYCELIUM_VAULT_LOCK', opts); }
// Non-secret remote-access config (publicBaseUrl, remoteEnabled, operatorEmail).
// Secrets do NOT live here — see src/remote/config.js.
export function remoteConfigPath(opts = {}) { return under('remote.json', 'MYCELIUM_REMOTE_CONFIG', opts); }

// ── Agent mind-file location ────────────────────────────────────────────────
// The agent's on-disk interior — self.md (loaded every turn), model.md,
// flagged.md, the mirror docs, snapshots/, .authorship.json — lives at
// <agentRoot>/mind (mind-files.js getMindDir appends the `mind` segment). The
// resolver used to be duplicated in mcp.js / server-rest.js / portal-character.js
// with subtle relative-vs-cwd-join differences; it is centralised HERE (the single
// source of truth for data locations) so the agent runtime, the backup/restore
// pass, and the destroy wipe all agree on ONE absolute directory. A divergence
// would silently lose the agent's interior on a restore, or leave it behind on a
// factory reset (the destroy engine skips a non-absolute root — server-rest.js /
// account/destroy.js isSafeRoot).
//
// DURABILITY: the default is <dataDir>/mind — UNDER app_data_dir (via dataDir()),
// exactly like mycelium.db — so an app update / cwd change can no longer orphan
// the identity capsule. It used to default to <cwd>/data/mind (with an extra
// nested `mind`, i.e. <cwd>/data/mind/mind), which in the packaged app resolved
// INSIDE the code-signed, update-replaceable bundle (cwd = resource_dir/app).
// A one-time boot migration relocates any pre-existing legacy tree — see
// src/mindfiles/migrate-root.js, run under .vault-init.lock in initVaultStorage.
// MYCELIUM_AGENT_ROOT still overrides (points at a wrapper whose /mind child holds
// the files) and, when set, DISABLES the migration (the operator owns the path).
export function mindAgentRoot({ env = process.env, cwd = process.cwd() } = {}) {
  const override = clean(env.MYCELIUM_AGENT_ROOT);
  // Resolve the override to an ABSOLUTE path: mindDir() feeds the destroy/factory-
  // reset wipe, which fail-closed skips any non-absolute root — a relative override
  // would silently leave the encrypted mind tree behind on a reset.
  return override ? path.resolve(cwd, override) : dataDir({ env, cwd });
}
/** The directory holding the encrypted `MIND`-magic files: <agentRoot>/mind. */
export function mindDir(opts = {}) { return path.join(mindAgentRoot(opts), 'mind'); }
/** The pre-relocation legacy mind dir for a given cwd: <cwd>/data/mind/mind. */
export function legacyMindDir({ cwd = process.cwd() } = {}) {
  return path.join(cwd, 'data', 'mind', 'mind');
}

/**
 * The absolute mind directories a factory reset MUST wipe. SINGLE SOURCE OF TRUTH:
 * the destroy route (server-rest.js extraRoots) AND the migration gate
 * (scripts/verify-mind-root-migration.mjs) both call THIS, so dropping either root
 * here changes the real wipe and REDs the gate together — the destroy coverage can
 * never silently diverge from what the gate asserts.
 *   - mindDir()       — the durable dir (dataDir()/mind) the runtime reads/writes now.
 *   - legacyMindDir() — <cwd>/data/mind/mind, OUTSIDE dataDir (INSIDE the app bundle),
 *     so the normal dataDir wipe never reaches it. The one-time relocation can leave
 *     residual encrypted mind files there (a skipped name-collision, a partial/failed
 *     move, or a pinned MYCELIUM_AGENT_ROOT that disables the move); a factory reset
 *     must not let that encrypted identity outlive the vault.
 * The isAbsolute filter is belt-and-suspenders — the destroy engine fail-closed skips
 * any non-absolute root, and both helpers are always absolute today.
 */
export function mindDestroyRoots({ env = process.env, cwd = process.cwd() } = {}) {
  return [mindDir({ env, cwd }), legacyMindDir({ cwd })].filter((p) => path.isAbsolute(p));
}

// Frozen TTS voice sample(s): <dataDir>/voice-samples/<agentId>.mvs (encrypted,
// "the identity" — not re-rollable). Carried by backup like uploads/.
export function voiceSamplesRoot(opts = {}) { return under('voice-samples', 'MYCELIUM_VOICE_SAMPLES_ROOT', opts); }

// ── Factory-reset coverage: the EFFECTIVE artifact paths ────────────────────
// `under()` lets EVERY artifact be relocated independently of dataDir(), so a
// factory reset that wipes dataDir() alone leaves any relocated artifact behind
// — the vault (MYCELIUM_DB), the PASSKEY store (MYCELIUM_AUTH_DB), the key-check
// value, the uploaded blobs, the passphrase seal, the remote config, the frozen
// voice sample. Worse, the Keychain is destroyed AROUND them, so the user is
// told "everything is gone" while decryptable content survives on disk.
//
// The destroy engine therefore wipes the EFFECTIVE paths (the same resolvers the
// app boots with), not a bare dataDir(). Anything that already resolves INSIDE
// dataDir is omitted here — the recursive dir wipe covers it — so this list is
// exactly "what the dir wipe cannot reach".
const RELOCATABLE_RESOLVERS = [dbPath, kcvPath, authDbPath, uploadsRoot, lockPath, remoteConfigPath, voiceSamplesRoot];

/** true iff `p` is `root` itself or lives under it. */
function isInside(root, p) {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * SQLite writes its journal + shared-memory companions NEXT TO the db file, and
 * the regenerable FTS/vec index lives in a `<name>.search.db` sidecar beside it
 * (src/search/sqlite/sidecar.js sidecarPath — the rule is mirrored here rather
 * than imported so paths.js stays a dependency-free leaf; verify:destroy-paths
 * asserts the two agree). All of them hold decryptable content or its structure,
 * so a relocated vault must take its whole file family with it.
 */
export function vaultFileFamily(db) {
  const sidecar = /\.db$/i.test(db) ? db.replace(/\.db$/i, '.search.db') : `${db}.search.db`;
  return [db, `${db}-wal`, `${db}-shm`, sidecar, `${sidecar}-wal`, `${sidecar}-shm`];
}

/**
 * The absolute artifact paths that live OUTSIDE dataDir() because a per-item env
 * override relocated them. Empty in the default install (everything is under
 * dataDir). `:memory:` and non-absolute values are dropped (nothing on disk).
 */
export function relocatedArtifactPaths({ env = process.env, cwd = process.cwd() } = {}) {
  const root = dataDir({ env, cwd });
  const out = [];
  const add = (p) => {
    if (typeof p !== 'string' || !p || p === ':memory:') return;
    if (!path.isAbsolute(p) || isInside(root, p)) return;
    out.push(p);
  };
  for (const resolve of RELOCATABLE_RESOLVERS) add(resolve({ env }));
  const db = dbPath({ env });
  if (typeof db === 'string' && db !== ':memory:' && path.isAbsolute(db) && !isInside(root, db)) {
    for (const f of vaultFileFamily(db)) add(f);
  }
  return [...new Set(out)];
}

/**
 * EVERY absolute root a factory reset must wipe on top of the recursive dataDir()
 * wipe: the mind trees (mindDestroyRoots) PLUS any artifact an env override moved
 * out of dataDir (relocatedArtifactPaths). SINGLE SOURCE OF TRUTH for the destroy
 * route's `extraRoots` — the engine still fail-closed refuses an unsafe root.
 */
export function destroyExtraRoots({ env = process.env, cwd = process.cwd() } = {}) {
  return [...new Set([...mindDestroyRoots({ env, cwd }), ...relocatedArtifactPaths({ env, cwd })])];
}

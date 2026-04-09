/**
 * Spore Loader (CJS) — discovers spore PM2 entries for ecosystem.config.cjs.
 *
 * CommonJS module because ecosystem.config.cjs is CJS.
 * Reads `spores/<name>/manifest.json` and returns PM2 app definitions.
 */

const fs = require('fs');
const path = require('path');

const SPORES_DIR = __dirname;

/**
 * Minimal environment allowlist for spore processes.
 *
 * Spores do NOT inherit the full SHARED_AGENT_ENV because that includes
 * KMS_URL, USER_ID, MYA_WORKER_URL, AGENT_SCOPES, and other values that
 * grant access to encrypted data and the Swiss KEK server. A spore that
 * wants any of these must list them explicitly in manifest.envAllow — the
 * user sees the request in the manifest and can audit it per spore.
 *
 * NODE_ENV is always forwarded; nothing else is by default.
 */
const DEFAULT_SPORE_ENV_KEYS = Object.freeze(['NODE_ENV']);

function filterSporeEnv(sharedEnv, allow) {
  const out = {};
  const allowSet = new Set([...DEFAULT_SPORE_ENV_KEYS, ...(Array.isArray(allow) ? allow : [])]);
  for (const key of allowSet) {
    if (sharedEnv && Object.prototype.hasOwnProperty.call(sharedEnv, key) && sharedEnv[key] != null) {
      out[key] = sharedEnv[key];
    }
  }
  out.NODE_ENV = (sharedEnv && sharedEnv.NODE_ENV) || 'production';
  return out;
}

/**
 * Build PM2 app entries from all spore manifests.
 *
 * Opt-in: SPORES_ENABLED=1 is required. Spores are user-land extensions that
 * get a full PM2 process with the shared agent environment, which is a new
 * attack surface (any directory with a valid manifest.json becomes a running
 * process on deploy). Disabled by default so merging the framework does not
 * implicitly activate it on any existing VPS.
 *
 * @param {Object} sharedEnv - Shared environment variables from ecosystem.config.cjs
 * @returns {Array} PM2 app definitions
 */
function buildSporeApps(sharedEnv) {
  if (process.env.SPORES_ENABLED !== '1') return [];

  const apps = [];

  let entries;
  try {
    entries = fs.readdirSync(SPORES_DIR, { withFileTypes: true });
  } catch {
    return apps;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;

    const manifestPath = path.join(SPORES_DIR, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      continue;
    }

    if (!manifest.pm2 || !Array.isArray(manifest.pm2)) continue;

    // Per-manifest env allowlist: spore declares which SHARED_AGENT_ENV keys
    // it actually needs. Absent = minimum (NODE_ENV only).
    const manifestEnv = filterSporeEnv(sharedEnv, manifest.envAllow);

    for (const pm2App of manifest.pm2) {
      if (!pm2App.name || !pm2App.script) continue;

      apps.push({
        name: pm2App.name,
        script: pm2App.script,
        cwd: path.join(SPORES_DIR, entry.name),
        interpreter: 'node',
        interpreter_args: '--experimental-modules',
        instances: 1,
        exec_mode: 'fork',
        watch: false,
        max_memory_restart: pm2App.max_memory_restart || '256M',
        env: {
          ...manifestEnv,
          ...pm2App.env,  // spore-declared non-secret env last (so spore can override NODE_ENV if needed)
        },
        error_file: `/var/log/mycelium/${pm2App.name}-error.log`,
        out_file: `/var/log/mycelium/${pm2App.name}-out.log`,
        log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      });
    }
  }

  if (apps.length > 0) {
    console.log(`[spore-loader] Found ${apps.length} PM2 app(s) from spores`);
  }

  return apps;
}

module.exports = { buildSporeApps };
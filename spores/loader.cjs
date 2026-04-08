/**
 * Spore Loader (CJS) — discovers spore PM2 entries for ecosystem.config.cjs.
 *
 * CommonJS module because ecosystem.config.cjs is CJS.
 * Reads spores/*/manifest.json and returns PM2 app definitions.
 */

const fs = require('fs');
const path = require('path');

const SPORES_DIR = __dirname;

/**
 * Build PM2 app entries from all spore manifests.
 *
 * @param {Object} sharedEnv - Shared environment variables from ecosystem.config.cjs
 * @returns {Array} PM2 app definitions
 */
function buildSporeApps(sharedEnv) {
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
          NODE_ENV: 'production',
          ...sharedEnv,
          ...pm2App.env,
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
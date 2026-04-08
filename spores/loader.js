/**
 * Spore Loader (ESM) — discovers and loads spore extensions.
 *
 * Reads spores/*/manifest.json, mounts Express routes, registers hooks.
 * Used by agent-server.js at startup.
 *
 * Spores are opt-in: if the spores/ directory doesn't exist or has no
 * valid manifests, nothing happens. The system degrades gracefully.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load all spore manifests from spores/*/manifest.json.
 * Skips directories starting with _ (templates) or . (hidden).
 */
export function listSpores() {
  const spores = [];
  try {
    const entries = readdirSync(__dirname, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;

      const manifestPath = join(__dirname, entry.name, 'manifest.json');
      if (!existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        if (manifest.id) {
          spores.push({ ...manifest, _dir: join(__dirname, entry.name) });
        }
      } catch (err) {
        console.warn(`[spore-loader] Failed to load ${manifestPath}: ${err.message}`);
      }
    }
  } catch {
    // spores/ directory doesn't exist or is unreadable
  }
  return spores;
}

/**
 * Mount spore Express routes onto the app.
 * Each spore's routes are mounted at /portal/<spore-id>/*
 *
 * @param {import('express').Application} app
 */
export async function loadSporeRoutes(app) {
  const spores = listSpores();
  let loaded = 0;

  for (const spore of spores) {
    if (!spore.routes) continue;

    const routePath = join(spore._dir, spore.routes);
    if (!existsSync(routePath)) {
      console.warn(`[spore-loader] Routes file not found: ${routePath}`);
      continue;
    }

    try {
      const module = await import(routePath);
      const router = module.default || module.router;
      if (router) {
        app.use(`/portal/${spore.id}`, router);
        console.log(`[spore-loader] Mounted routes: /portal/${spore.id}/* (${spore.name})`);
        loaded++;
      }
    } catch (err) {
      console.warn(`[spore-loader] Failed to load routes for ${spore.id}: ${err.message}`);
    }
  }

  if (loaded > 0) {
    console.log(`[spore-loader] ${loaded} spore route(s) loaded`);
  }
  return loaded;
}

/**
 * Get all hook functions registered by spores for a given hook name.
 * Hooks are declared in manifest.json: { "hooks": { "runner.afterRun": true } }
 *
 * @param {string} hookName - e.g., "runner.afterRun"
 * @returns {Array<Function>} Array of hook handler functions
 */
export async function getSporeHooks(hookName) {
  const spores = listSpores();
  const hooks = [];

  for (const spore of spores) {
    if (!spore.hooks?.[hookName]) continue;

    // Convention: hook handler is exported from the routes file or a hooks.js file
    const hookFile = join(spore._dir, 'hooks.js');
    const routeFile = spore.routes ? join(spore._dir, spore.routes) : null;
    const target = existsSync(hookFile) ? hookFile : routeFile;

    if (!target || !existsSync(target)) continue;

    try {
      const module = await import(target);
      if (typeof module[hookName] === 'function') {
        hooks.push(module[hookName]);
      }
    } catch (err) {
      console.warn(`[spore-loader] Failed to load hook ${hookName} from ${spore.id}: ${err.message}`);
    }
  }

  return hooks;
}
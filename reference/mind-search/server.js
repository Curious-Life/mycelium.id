/**
 * Mind-search server-side wiring.
 *
 * Two responsibilities, both small:
 *
 *   1. `bootstrapMindSearch(deps)` — at agent boot, build a LocalBackend
 *      instance when `MIND_SEARCH_BACKEND=local`, run init() to load any
 *      persisted snapshot, and return the instance. Returns null when the
 *      flag is off or required deps are missing — agent stays running
 *      either way.
 *
 *   2. `createMindSearchRouter({ mindSearch })` — Express router exposing
 *      `GET /health/mind-search`. Returns the backend's health() report,
 *      or `{ status: 'disabled' }` when no backend is configured.
 *
 * Why both live in one file: they share the runtime invariant that the
 * backend is optional. Bootstrap returns null when flag-off; the router
 * tolerates null by reporting "disabled". Both behaviors must move
 * together when we change them.
 *
 * What this is NOT:
 *
 *   • Not a swap of `db-d1/search.js`. The existing search namespace
 *     stays unchanged. Callers continue using `db.search.matchTerritories`
 *     etc. Mind-search is exposed in parallel via runtime state for
 *     opt-in use (shadow comparator in PR 12, hot-path migration later).
 *
 *   • Not the bench harness wiring. PR 2 ships a CLI that takes a
 *     backend-module path; the agent-server wiring here is independent.
 *
 * Failure modes (per CLAUDE.md §3, fail-closed):
 *
 *   • Flag on, no master key   → bootstrap logs, returns null. Agent up.
 *   • Flag on, no embedder     → bootstrap logs, returns null. Agent up.
 *   • Flag on, init() throws   → bootstrap logs, returns instance with
 *                                 empty index. Agent up. Tier 4 floor still
 *                                 works if D1 is reachable.
 *   • Flag off                  → bootstrap returns null silently.
 *
 * No content ever flows through these helpers. Logs carry only flag
 * state, error class names, and instance presence flags.
 */

import { createMindSearch } from './index.js';

const LOG_MOD = 'mind-search.server';

/**
 * Whether the local-backend flag is enabled in the given env.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {boolean}
 */
export function shouldEnableMindSearch(env = process.env) {
  return env.MIND_SEARCH_BACKEND === 'local';
}

/**
 * @typedef {object} BootstrapDeps
 * @property {{ embed: (text: string) => Promise<Float32Array>, health: () => Promise<boolean> }} [embedder]
 * @property {CryptoKey | null | undefined} [masterKey]
 * @property {string[]} [scopes]                allowed scopes; defaults to ['personal']
 * @property {string} [userId]                  tenant id; defaults to env AGENT_ID
 * @property {string} [persistPath]             path to encrypted snapshot
 * @property {object} [logger]                  logger.child({ mod: LOG_MOD })
 * @property {Record<string, string|undefined>} [env=process.env]
 *
 * @typedef {import('./backend/interface.js').MindBackend & {
 *   init: () => Promise<{ loaded: boolean }>,
 *   checkpoint: () => Promise<{ saved: boolean, bytes?: number }>,
 *   _internal?: () => object,
 * }} MindBackendInstance
 */

/**
 * Build and initialize a mind-search backend if the flag is on AND all
 * required deps are present. Returns null on any reason to skip.
 *
 * @param {BootstrapDeps} deps
 * @returns {Promise<MindBackendInstance | null>}
 */
export async function bootstrapMindSearch(deps = {}) {
  const env = deps.env ?? process.env;
  const logger = deps.logger ?? null;

  if (!shouldEnableMindSearch(env)) {
    emit(logger, 'debug', 'bootstrap.skipped', { reason: 'flag_off' });
    return null;
  }
  if (!deps.embedder
      || typeof deps.embedder.embed !== 'function'
      || typeof deps.embedder.health !== 'function') {
    emit(logger, 'warn', 'bootstrap.skipped', { reason: 'no_embedder' });
    return null;
  }
  if (!deps.masterKey) {
    emit(logger, 'warn', 'bootstrap.skipped', { reason: 'no_master_key' });
    return null;
  }

  const scopes = Array.isArray(deps.scopes) && deps.scopes.length > 0
    ? deps.scopes
    : ['personal'];
  const userId = typeof deps.userId === 'string' && deps.userId.length > 0
    ? deps.userId
    : (env.AGENT_ID || env.MYA_AGENT_ID);
  if (!userId) {
    emit(logger, 'warn', 'bootstrap.skipped', { reason: 'no_user_id' });
    return null;
  }

  let mindSearch;
  try {
    mindSearch = createMindSearch({
      embedder: deps.embedder,
      masterKey: deps.masterKey,
      scopes,
      userId,
      persistPath: deps.persistPath,
      logger,
    });
  } catch (err) {
    emit(logger, 'error', 'bootstrap.failed', {
      errorClass: err && err.class ? err.class : 'unknown',
    });
    return null;
  }

  // init() loads any persisted snapshot. A failure here is recoverable —
  // the backend is still usable, just with an empty index. The init
  // method itself logs the failure; we just surface a tag here.
  try {
    const { loaded } = await mindSearch.init();
    emit(logger, 'info', 'bootstrap.ready', {
      loadedFromSnapshot: loaded,
      scope: scopes[0],
    });
  } catch (err) {
    emit(logger, 'warn', 'bootstrap.init_threw', {
      errorClass: err && err.class ? err.class : 'unknown',
    });
  }

  return mindSearch;
}

/**
 * Pure handler: derive the health body from a backend (or absence of one).
 * Exported for direct testing without express.
 *
 * @param {MindBackendInstance | null | undefined} mindSearch
 * @returns {Promise<object>}
 */
export async function getMindSearchHealth(mindSearch) {
  if (!mindSearch || typeof mindSearch.health !== 'function') {
    return { status: 'disabled' };
  }
  try {
    const report = await mindSearch.health();
    return report;
  } catch (err) {
    return {
      status: 'down',
      error: err && err.class ? err.class : 'unknown',
    };
  }
}

/**
 * Express router factory exposing /health/mind-search.
 *
 * `mindSearch` may be a value or a getter function. The getter form lets
 * callers swap the backend after the router is mounted (e.g., on a
 * runtime-state change). Tests can pass any value-or-getter shape.
 *
 * @param {object} deps
 * @param {MindBackendInstance | null | (() => MindBackendInstance | null)} deps.mindSearch
 * @returns {{ get: (route: string, handler: Function) => any, mount: (app: any) => void }}
 *   Returns an Express Router. Caller mounts at root.
 */
export function createMindSearchRouter(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createMindSearchRouter: deps required');
  }
  if (deps.mindSearch === undefined) {
    throw new TypeError('createMindSearchRouter: deps.mindSearch (value or getter) required');
  }

  const resolve = typeof deps.mindSearch === 'function'
    ? deps.mindSearch
    : () => deps.mindSearch;

  // Lazy-import express so this module loads in environments that don't
  // have express (tests of pure functions, the bench harness, etc.).
  return {
    /**
     * Returns the route definition for callers that want to attach to an
     * existing Express router (e.g., the agent-server's /health domain).
     */
    routes() {
      return [
        {
          method: 'GET',
          path: '/health/mind-search',
          handler: async (req, res) => {
            const inst = resolve();
            const body = await getMindSearchHealth(inst);
            res.status(200).json(body);
          },
        },
      ];
    },
    /**
     * Mount onto an Express app or router. Convenience for callers that
     * just want to `app.use(router)`.
     *
     * @param {{ get: (route: string, handler: Function) => any }} app
     */
    mount(app) {
      if (!app || typeof app.get !== 'function') {
        throw new TypeError('createMindSearchRouter.mount: app must expose .get()');
      }
      for (const r of this.routes()) {
        app[r.method.toLowerCase()](r.path, r.handler);
      }
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function emit(logger, level, event, labels) {
  if (!logger) return;
  const child = typeof logger.child === 'function'
    ? logger.child({ mod: LOG_MOD })
    : logger;
  const fn = child[level] ?? child.info ?? null;
  if (typeof fn !== 'function') return;
  fn.call(child, { evt: `mind_search.${event}`, ...labels });
}

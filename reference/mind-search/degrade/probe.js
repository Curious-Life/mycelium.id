/**
 * Health probes for the tier orchestrator.
 *
 * Three boolean signals drive tier selection:
 *
 *   • embedHealthy   — embed-service responds within timeout
 *   • indexLoaded    — local inverted index has documents
 *   • d1Healthy      — D1 reachable for the SQL-LIKE floor (Tier 4)
 *
 * Probes are cached for `ttlMs` (default 1000ms). Each query batch
 * within that window pays at most one health-check round trip; calls
 * arriving in tight succession all see the same answer.
 *
 * Embed and D1 probes have hard timeouts. A hung downstream must not
 * stall the query critical path — if the probe doesn't return in
 * `embedTimeoutMs`, treat the service as unhealthy. Better to degrade
 * to a working tier than block waiting on a flaky service.
 *
 * The `invalidate(name)` method lets the orchestrator drop a cached
 * "healthy" verdict after a tier op throws — so the very next query
 * re-probes rather than reusing a now-stale answer.
 *
 * No content ever flows through these probes. Embedder.health() should
 * be a content-free check (HEAD or stub-text). The probe only sees
 * booleans.
 */

const DEFAULT_TTL_MS = 1000;
const DEFAULT_EMBED_TIMEOUT_MS = 500;
const DEFAULT_D1_TIMEOUT_MS = 1000;

/**
 * @typedef {object} HealthSnapshot
 * @property {boolean} embedHealthy
 * @property {boolean} indexLoaded
 * @property {boolean} d1Healthy
 * @property {number}  observedAt        unix-ms when the snapshot was assembled
 *
 * @typedef {object} HealthProbeDeps
 * @property {{ health: () => Promise<boolean> }} embedder
 * @property {() => (object|null)} getIndex                    returns InvertedIndex or null
 * @property {{ ping?: () => Promise<boolean> } | null} [db]   optional; null/missing → assumed healthy
 * @property {object} [logger]
 * @property {number} [ttlMs=1000]
 * @property {number} [embedTimeoutMs=500]
 * @property {number} [d1TimeoutMs=1000]
 */

/**
 * @param {HealthProbeDeps} deps
 */
export function createHealthProbe(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createHealthProbe: deps required');
  }
  const { embedder, getIndex, db = null, logger = null } = deps;
  if (!embedder || typeof embedder.health !== 'function') {
    throw new TypeError('createHealthProbe: deps.embedder.health() required');
  }
  if (typeof getIndex !== 'function') {
    throw new TypeError('createHealthProbe: deps.getIndex must be a function');
  }
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const embedTimeoutMs = deps.embedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
  const d1TimeoutMs = deps.d1TimeoutMs ?? DEFAULT_D1_TIMEOUT_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new TypeError('createHealthProbe: ttlMs must be non-negative finite number');
  }

  /** @type {Map<string, { value: boolean, expiresAt: number }>} */
  const cache = new Map();

  function now() { return Date.now(); }

  function getCached(name) {
    const entry = cache.get(name);
    if (!entry) return undefined;
    if (entry.expiresAt < now()) {
      cache.delete(name);
      return undefined;
    }
    return entry.value;
  }

  function setCached(name, value) {
    // ttlMs=0 disables caching entirely. Date.now() has 1ms resolution,
    // so a non-zero ttl with both calls in the same millisecond would
    // otherwise produce a phantom cache hit.
    if (ttlMs === 0) return;
    cache.set(name, { value, expiresAt: now() + ttlMs });
  }

  /**
   * Wrap a promise with a hard timeout. The losing side never resolves
   * the original promise, but the embedder/db can choose to clean up
   * itself — we just don't wait. Returns false on timeout.
   */
  async function withTimeout(promise, ms, label) {
    return await Promise.race([
      promise.catch((err) => {
        logger?.debug?.({ evt: `mind_search.probe.${label}_threw`, error: err?.class || err?.message });
        return false;
      }),
      new Promise((resolve) => setTimeout(() => {
        logger?.debug?.({ evt: `mind_search.probe.${label}_timeout`, ms });
        resolve(false);
      }, ms)),
    ]);
  }

  return {
    /**
     * @returns {Promise<boolean>}
     */
    async embedHealthy() {
      const cached = getCached('embed');
      if (cached !== undefined) return cached;
      const value = !!(await withTimeout(
        Promise.resolve(embedder.health()),
        embedTimeoutMs,
        'embed',
      ));
      setCached('embed', value);
      return value;
    },

    /**
     * Synchronous in spirit (no I/O), but kept async to match the
     * uniform shape of probe methods. Cached briefly so repeated
     * snapshot() calls in a tight loop return identical results.
     * @returns {Promise<boolean>}
     */
    async indexLoaded() {
      const cached = getCached('index');
      if (cached !== undefined) return cached;
      const idx = getIndex();
      const value = !!(idx && typeof idx.totalDocs === 'function' && idx.totalDocs() > 0);
      setCached('index', value);
      return value;
    },

    /**
     * Returns true when D1 is reachable, OR when no `db.ping` is
     * provided (assume reachable; the actual call will fail loud).
     * @returns {Promise<boolean>}
     */
    async d1Healthy() {
      const cached = getCached('d1');
      if (cached !== undefined) return cached;
      let value;
      if (!db || typeof db.ping !== 'function') {
        value = true;
      } else {
        value = !!(await withTimeout(
          Promise.resolve(db.ping()),
          d1TimeoutMs,
          'd1',
        ));
      }
      setCached('d1', value);
      return value;
    },

    /**
     * @returns {Promise<HealthSnapshot>}
     */
    async snapshot() {
      const [embedHealthy, indexLoaded, d1Healthy] = await Promise.all([
        this.embedHealthy(),
        this.indexLoaded(),
        this.d1Healthy(),
      ]);
      return {
        embedHealthy,
        indexLoaded,
        d1Healthy,
        observedAt: now(),
      };
    },

    /**
     * Drop a cached probe so the next call re-checks. Called by the
     * tier orchestrator after a tier op throws.
     *
     * @param {'embed'|'index'|'d1'|undefined} name  undefined = drop all
     */
    invalidate(name) {
      if (name === undefined) {
        cache.clear();
        return;
      }
      cache.delete(name);
    },

    /**
     * Inspection accessor for tests. Not for production callers.
     */
    _cacheSize() {
      return cache.size;
    },
  };
}

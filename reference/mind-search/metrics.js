/**
 * Structured-event emission for mind-search.
 *
 * Wraps the existing JSON logger ([packages/server/lib/logger.js]) with
 * a stable event-name prefix and a redaction guard. We do NOT introduce
 * a metrics system (Prometheus, OpenTelemetry, etc.). Instead, every
 * observable event is a log line — operators aggregate via the existing
 * pm2 logs / Sentry pipeline.
 *
 * Why this exists rather than calling logger directly:
 *
 *   1. Single seam to enforce CLAUDE.md §1: never log content. The
 *      `redactSafeFields` function strips any field whose name matches
 *      a content-shaped key (`text`, `query`, `content`, `tokens`,
 *      `embedding`, `vectors`, `body`, `payload`).
 *
 *   2. Stable event-name namespace: every event is `mind_search.<name>`.
 *      Makes filtering in pm2 / Sentry trivial.
 *
 *   3. Caller doesn't need to know whether logger is present. If the
 *      logger dep is missing (tests, no-op contexts), emit() is a no-op.
 *
 * Allowed payload fields: numbers, booleans, short string IDs, error
 * class names, tier numbers, byte counts, timing measurements. Anything
 * starting to look like content is dropped.
 */

const FORBIDDEN_KEYS = new Set([
  'text', 'query', 'content', 'tokens', 'token',
  'embedding', 'embeddings', 'vector', 'vectors',
  'body', 'payload', 'message', 'snippet', 'plaintext',
]);

/**
 * Strip forbidden fields. Mutates the returned object only; input is
 * untouched. Recursive into nested objects (one level).
 */
function redactSafeFields(labels) {
  if (!labels || typeof labels !== 'object') return labels;
  const out = {};
  for (const [k, v] of Object.entries(labels)) {
    if (FORBIDDEN_KEYS.has(k)) {
      out[k] = `<redacted:${k}>`;
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactSafeFields(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * @param {object|null} [logger]   parent logger; missing = no-op emitter
 * @param {object} [staticLabels]  labels added to every event (e.g. agent, scope)
 * @returns {{ emit: (evt: string, labels?: object, level?: string) => void }}
 */
export function createMetrics(logger = null, staticLabels = {}) {
  // No logger → no-op. Returns a shape-compatible stub so callers don't
  // need to null-check.
  if (!logger || typeof logger !== 'object') {
    return { emit: () => {} };
  }

  // Prefer logger.child if present (existing convention in
  // packages/server/lib/logger.js); falls back to using parent directly.
  const child = typeof logger.child === 'function'
    ? logger.child({ mod: 'mind-search', ...staticLabels })
    : logger;

  return {
    /**
     * Emit a structured log event.
     *
     * @param {string} evt      event name; will be prefixed with `mind_search.`
     * @param {object} [labels] redaction-safe labels
     * @param {'debug'|'info'|'warn'|'error'} [level='info']
     */
    emit(evt, labels = {}, level = 'info') {
      const fn = child[level] ?? child.info;
      if (typeof fn !== 'function') return;
      const safe = redactSafeFields(labels);
      fn.call(child, { evt: `mind_search.${evt}`, ...safe });
    },
  };
}

// Exported for testing the redactor directly.
export { redactSafeFields, FORBIDDEN_KEYS };

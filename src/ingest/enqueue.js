// Enrichment hand-off (D7). A freshly-captured message is durably queued the
// moment it lands (schema default nlp_processed=0 + the idx_messages_nlp_pending
// work-queue index). This module is the *nudge*: a best-effort POST to the
// build-new :8095 enrichment service so it drains the queue promptly.
//
// CONTRACT (reference/server-routes/portal-enrichment.js:158): POST /enrich-all
// { userId } to the loopback enrichment service. The service itself is build-new
// and Tier-2-gated (needs the :8091 embed model). Its ABSENCE must be non-fatal:
// the row is already durably queued, so a failed/empty nudge just means the
// queue drains whenever the service next runs. We NEVER throw out of this path
// and NEVER block the capture write.
//
// The real inline embed-on-write fallback (embed at capture time when :8091 is
// up) is deferred to the embed-service unit — it needs a messages.update path +
// a Float32→envelope encoder + a running model, none of which exist yet.

const DEFAULT_URL = 'http://127.0.0.1:8095';
const TIMEOUT_MS = 2000;

/**
 * Build a fire-and-forget enqueueEnrichment(id) bound to a userId. Safe to call
 * synchronously from captureMessage — it schedules the nudge and returns at once.
 * @param {object} [opts]
 * @param {string} [opts.userId='local-user']
 * @param {string} [opts.url]   enrichment service base (default 127.0.0.1:8095)
 * @param {typeof fetch} [opts.fetchImpl]  injectable for tests
 * @returns {(id: string) => void}
 */
export function createEnqueueEnrichment(opts = {}) {
  const userId = opts.userId || 'local-user';
  const url = opts.url || process.env.MYCELIUM_ENRICH_URL || DEFAULT_URL;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;

  return function enqueueEnrichment(id) {
    // Fully detached: never block or throw into the caller's write path.
    Promise.resolve().then(async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
          await fetchImpl(`${url}/enrich-all`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userId, messageId: id }),
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(t);
        }
      } catch {
        // Service down / absent / timeout — expected until :8095 ships.
        // The row is already queued at nlp_processed=0; nothing to do.
      }
    }).catch(() => { /* never surfaces */ });
  };
}

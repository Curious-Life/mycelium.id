/**
 * Mind-search client — typed-error surface for the documents domain.
 *
 * V1 status: mind-search is a later-Wave subsystem (Nomic v1.5 ONNX embeddings
 * via embed-service.py + the search backend). It is NOT wired in V1, so the
 * documents domain is built with `searchClient: null` and its `findDocuments`
 * tool is simply not registered (see src/tools/documents.js — the tool and its
 * handler are both gated on `searchClient`).
 *
 * `src/tools/documents.js` nonetheless imports these four error classes at
 * module load. They are the typed errors the `findDocuments` handler maps to
 * actionable agent-facing messages. We provide them here so the import resolves
 * and the contract is preserved verbatim; when the real search client lands it
 * will export the same four classes plus the `searchMindscape` transport.
 *
 * Each error carries the same fields the documents handler reads:
 *   - SearchValidationError.detail
 *   - SearchClientError.reason
 */

export class SearchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SearchError';
  }
}

/** Index is still warming (cold start / snapshot load in progress). Retryable. */
export class SearchWarmingError extends SearchError {
  constructor(message = 'search index is warming up') {
    super(message);
    this.name = 'SearchWarmingError';
  }
}

/** Embed service unavailable — similarity search cannot run. */
export class SearchEmbedderError extends SearchError {
  constructor(message = 'embed service unavailable') {
    super(message);
    this.name = 'SearchEmbedderError';
  }
}

/** Request rejected by the search server (bad query, over-limit, etc.). */
export class SearchValidationError extends SearchError {
  constructor(message = 'search request rejected', detail = null) {
    super(message);
    this.name = 'SearchValidationError';
    this.detail = detail;
  }
}

/** Transport / unexpected failure talking to the search backend. */
export class SearchClientError extends SearchError {
  constructor(message = 'search unavailable', reason = null) {
    super(message);
    this.name = 'SearchClientError';
    this.reason = reason;
  }
}

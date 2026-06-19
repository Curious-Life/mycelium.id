/**
 * Search-client typed errors — minimal shim.
 *
 * The full search-client (an HTTP shim over the mind-search service's
 * /internal/v1/search/mindscape endpoint) lands with the mind-search Wave-2
 * unit. Until then, the documents domain only references these four typed
 * error classes for `instanceof` checks inside the OPTIONAL `findDocuments`
 * handler — and that handler is only registered when a `searchClient` dep is
 * injected into createDocumentsDomain. V1 does not inject one, so these are
 * import-time-only today. Defining them here keeps tools/documents.js loadable
 * without pulling in the unbuilt mind-search surface.
 *
 * When the real search-client is ported, replace this file with it (it must
 * export these same four names) — the documents domain needs no change.
 */

export class SearchClientError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'SearchClientError';
    this.reason = reason;
  }
}

export class SearchWarmingError extends SearchClientError {
  constructor(message) {
    super(message, 'warming');
    this.name = 'SearchWarmingError';
  }
}

export class SearchEmbedderError extends SearchClientError {
  constructor(message) {
    super(message, 'embedder');
    this.name = 'SearchEmbedderError';
  }
}

export class SearchValidationError extends SearchClientError {
  constructor(message, detail) {
    super(message, 'validation');
    this.name = 'SearchValidationError';
    this.detail = detail;
  }
}

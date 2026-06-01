// Mind-search — typed error hierarchy.
//
// Ported from reference/mind-search/errors.js. Every error thrown out of
// mind-search is a MindSearchError or subclass. Each carries a stable string
// `class` for log tagging and a degradation-tier hint.
//
// Per CLAUDE.md §1 ("zero plaintext leakage"): `message` and `cause` MUST NOT
// contain query text, content snippets, vector values, or decrypted tokens.

export class MindSearchError extends Error {
  constructor(message, { cls = 'mind_search_error', tier = null, meta = null, cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MindSearchError';
    this.class = cls;
    this.tier = tier;
    this.meta = meta;
  }
}

/** Public API called before deps were wired. Refuses to degrade. */
export class NotImplementedError extends MindSearchError {
  constructor(method) {
    super(`mind-search: ${method} not implemented`, {
      cls: 'not_implemented', tier: null, meta: { method },
    });
    this.name = 'NotImplementedError';
  }
}

/** Embed service did not respond / timed out. Triggers BM25-only fallback. */
export class EmbedDownError extends MindSearchError {
  constructor(message, meta = null, cause = undefined) {
    super(message, { cls: 'embed_down', tier: 2, meta, cause });
    this.name = 'EmbedDownError';
  }
}

/** In-memory index unavailable (not warm / rebuilding). */
export class IndexUnavailableError extends MindSearchError {
  constructor(message, meta = null) {
    super(message, { cls: 'index_unavailable', tier: 3, meta });
    this.name = 'IndexUnavailableError';
  }
}

/** A vector / index blob failed to decrypt. Degrades the row, not the request. */
export class DecryptError extends MindSearchError {
  constructor(message, meta = null, cause = undefined) {
    super(message, { cls: 'decrypt_failure', tier: null, meta, cause });
    this.name = 'DecryptError';
  }
}

/** Caller scopes do not intersect the envelope scope. Refuses to degrade. */
export class ScopeMismatchError extends MindSearchError {
  constructor(message, meta = null) {
    super(message, { cls: 'scope_mismatch', tier: null, meta });
    this.name = 'ScopeMismatchError';
  }
}

/** Master key not loaded. Search refuses entirely. Refuses to degrade. */
export class MasterKeyMissingError extends MindSearchError {
  constructor(message = 'mind-search: master key not loaded') {
    super(message, { cls: 'master_key_missing', tier: null });
    this.name = 'MasterKeyMissingError';
  }
}

/** A configured performance budget was exceeded. */
export class BudgetExceededError extends MindSearchError {
  constructor(message, meta = null) {
    super(message, { cls: 'budget_exceeded', tier: null, meta });
    this.name = 'BudgetExceededError';
  }
}

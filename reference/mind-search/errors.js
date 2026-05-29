/**
 * Mind Search — typed error hierarchy.
 *
 * Every error thrown out of `mind-search` is a `MindSearchError` or one of
 * its subclasses. Each carries a stable string `class` for log/Sentry tagging
 * and a degradation-tier hint so the orchestrator (degrade/tiers.js, PR 9)
 * can decide whether to retry, fall back, or surface.
 *
 * Rules (per CLAUDE.md §1, "zero plaintext leakage"):
 *   • `message` and `cause` MUST NOT contain query text, content snippets,
 *     vector values, decrypted tokens, or human-readable identifiers.
 *   • Identifiers, when included, must be redacted via log-redact.js
 *     (callers' responsibility before constructing).
 *   • Numeric counts, table names, scope tags, error class strings — safe.
 *
 * The `tier` field documents which degradation tier kicks in when this
 * error is caught upstream. Pure correctness errors (ScopeMismatch,
 * MasterKeyMissing) refuse to degrade — they fail the request loudly.
 */

/**
 * Base class. All mind-search errors extend this.
 *
 * @property {string} class      stable identifier for log/Sentry tagging
 * @property {number|null} tier  degradation tier this error should trigger,
 *                               or `null` when the error must surface
 * @property {object} [meta]     redaction-safe context (counts, table names,
 *                               scope tag) — never content
 */
export class MindSearchError extends Error {
  constructor(message, { cls = 'mind_search_error', tier = null, meta = null, cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MindSearchError';
    this.class = cls;
    this.tier = tier;
    this.meta = meta;
  }
}

/**
 * Public API was called before its dependencies were wired. Indicates a
 * deployment or boot-order bug, never a runtime failure to recover from.
 * Refuses to degrade.
 */
export class NotImplementedError extends MindSearchError {
  constructor(method) {
    super(`mind-search: ${method} not implemented`, {
      cls: 'not_implemented',
      tier: null,
      meta: { method },
    });
    this.name = 'NotImplementedError';
  }
}

/**
 * Embed service (port 8091) did not respond, returned a non-2xx, or
 * timed out. Triggers Tier 2 (BM25 + temporal, no semantic).
 */
export class EmbedDownError extends MindSearchError {
  constructor(message, meta = null, cause = undefined) {
    super(message, { cls: 'embed_down', tier: 2, meta, cause });
    this.name = 'EmbedDownError';
  }
}

/**
 * In-memory inverted index is unavailable: not yet warm, currently
 * rebuilding from D1, or persisted snapshot was corrupt and recovery is
 * in progress. Triggers Tier 3 (hot-subset BM25) or Tier 4 (SQL LIKE).
 */
export class IndexUnavailableError extends MindSearchError {
  constructor(message, meta = null) {
    super(message, { cls: 'index_unavailable', tier: 3, meta });
    this.name = 'IndexUnavailableError';
  }
}

/**
 * A vector or persisted index blob failed to decrypt — auth tag invalid,
 * envelope truncated, version-byte mismatch. Logs an event but does NOT
 * fail the whole request: the caller drops the bad row and continues.
 *
 * Refuses to degrade the *request*; degrades the *row*.
 */
export class DecryptError extends MindSearchError {
  constructor(message, meta = null, cause = undefined) {
    super(message, { cls: 'decrypt_failure', tier: null, meta, cause });
    this.name = 'DecryptError';
  }
}

/**
 * Caller's allowed scopes do not intersect the envelope's scope tag.
 * Refuses to degrade — this is a correctness guarantee (CLAUDE.md §5,
 * tenant isolation).
 */
export class ScopeMismatchError extends MindSearchError {
  constructor(message, meta = null) {
    super(message, { cls: 'scope_mismatch', tier: null, meta });
    this.name = 'ScopeMismatchError';
  }
}

/**
 * Master key not loaded (tmpfs miss, env unset). Search refuses entirely;
 * caller must surface to the operator. Refuses to degrade.
 */
export class MasterKeyMissingError extends MindSearchError {
  constructor(message = 'mind-search: master key not loaded') {
    super(message, { cls: 'master_key_missing', tier: null });
    this.name = 'MasterKeyMissingError';
  }
}

/**
 * A configured performance budget was exceeded (latency, memory, batch
 * size). Used by perf tests and runtime guards to fail loudly rather than
 * silently regress.
 */
export class BudgetExceededError extends MindSearchError {
  constructor(message, meta = null) {
    super(message, { cls: 'budget_exceeded', tier: null, meta });
    this.name = 'BudgetExceededError';
  }
}

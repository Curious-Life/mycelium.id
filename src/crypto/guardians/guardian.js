/**
 * Guardian — a named enforcement point at a trust boundary.
 *
 * Every guardian has stable identity, metrics, a bounded ring buffer of
 * recent denies, and a self-describing contract. Guardians wrap existing
 * middleware — they do NOT replace it. Adoption is additive.
 *
 * Invariants:
 *   - check() NEVER throws. Exceptions become fail-closed denies.
 *   - Deny events pass through scrubByKind() before ring-buffer insertion.
 *   - metrics.byReason uses stable enum-ish keys (never raw strings from users).
 */

import { scrubByKind } from './scrubbers.js';

export const GuardianKind = Object.freeze({
  PERIMETER: 'perimeter',       // identity at trust boundary entry
  TENANT: 'tenant',             // per-tenant data isolation
  SCOPE: 'scope',               // intra-tenant access control
  PROTOCOL: 'protocol',         // structural invariants (CSRF, sigs, rate limits)
  SANITIZATION: 'sanitization', // outbound leak prevention
});

const VALID_KINDS = new Set(Object.values(GuardianKind));

export class Guardian {
  /**
   * @param {object} spec
   * @param {string} spec.id               — stable identity (e.g., 'vps.portal-auth')
   * @param {string} spec.kind             — one of GuardianKind
   * @param {string} spec.boundary         — human-readable boundary name
   * @param {string} spec.description      — one-line purpose
   * @param {(ctx:any)=>Promise<object>} spec.check
   * @param {()=>Array} [spec.contract]    — returns health-check specs
   * @param {boolean} [spec.failClosed=true]
   * @param {string} [spec.process]        — 'vps' | 'worker' | ...
   * @param {number} [spec.maxDenyEvents=100]
   */
  constructor(spec) {
    if (!spec || typeof spec !== 'object') throw new TypeError('Guardian spec required');
    const {
      id, kind, boundary, description, check, contract,
      failClosed = true, process: proc = 'unknown', maxDenyEvents = 100,
    } = spec;

    if (typeof id !== 'string' || !id) throw new TypeError('Guardian.id must be a non-empty string');
    if (!VALID_KINDS.has(kind)) throw new TypeError(`Guardian.kind must be one of ${[...VALID_KINDS].join(',')}`);
    if (typeof boundary !== 'string' || !boundary) throw new TypeError('Guardian.boundary required');
    if (typeof description !== 'string' || !description) throw new TypeError('Guardian.description required');
    if (typeof check !== 'function') throw new TypeError('Guardian.check must be a function');

    this.id = id;
    this.kind = kind;
    this.boundary = boundary;
    this.description = description;
    this.failClosed = failClosed !== false;
    this.process = proc;

    this._check = check;
    this._contract = typeof contract === 'function' ? contract : () => [];
    this._maxDenyEvents = Math.max(10, Math.min(1000, maxDenyEvents));

    this.metrics = {
      allows: 0,
      denies: 0,
      errors: 0,
      byReason: Object.create(null),
      // Every check() call is counted here, keyed on result.reason if present.
      // byReason only fires on denies; byOutcome also covers the allow-with-
      // reason case (e.g. `vps.kms-client` emits `cache_hit`, `stale_cached`,
      // `rate_limited` as observability-only allow paths — operator needs the
      // per-outcome rate without treating every cache-hit as a deny).
      byOutcome: Object.create(null),
      last_allow_at: null,
      last_deny_at: null,
      last_error_at: null,
    };
    this._recentDenies = [];

    this.createdAt = Date.now();
  }

  /**
   * Run the check. Never throws. Returns { allow, reason?, principal?, severity? }.
   */
  async check(ctx) {
    let result;
    try {
      result = await this._check(ctx);
      // Defensive: guard against badly-shaped returns.
      if (!result || typeof result.allow !== 'boolean') {
        this.metrics.errors++;
        this.metrics.last_error_at = Date.now();
        result = { allow: false, reason: 'invalid_guardian_result', severity: 'critical' };
      }
    } catch (err) {
      this.metrics.errors++;
      this.metrics.last_error_at = Date.now();
      result = this.failClosed
        ? { allow: false, reason: 'check_error', severity: 'critical' }
        : { allow: true, reason: 'check_error_open', severity: 'warn' };
    }

    if (result.allow) {
      this.metrics.allows++;
      this.metrics.last_allow_at = Date.now();
    } else {
      this.metrics.denies++;
      this.metrics.last_deny_at = Date.now();
      const reason = stableReason(result.reason);
      this.metrics.byReason[reason] = (this.metrics.byReason[reason] || 0) + 1;

      // Ring buffer insertion — scrub first, then push.
      this._pushDenyEvent({
        t: Date.now(),
        reason,
        severity: result.severity || 'info',
        ctx_summary: scrubByKind(this.kind, ctx),
      });
    }

    // byOutcome fires on every call that declared a reason, regardless of
    // allow/deny. See comment on this.metrics.byOutcome for rationale.
    if (result.reason) {
      const outcome = stableReason(result.reason);
      this.metrics.byOutcome[outcome] = (this.metrics.byOutcome[outcome] || 0) + 1;
    }

    return result;
  }

  /** Returns the guardian's contract specs (for auto-generated Layer 3 checks). */
  contract() {
    try {
      const specs = this._contract();
      return Array.isArray(specs) ? specs : [];
    } catch {
      return [];
    }
  }

  _pushDenyEvent(evt) {
    this._recentDenies.push(evt);
    if (this._recentDenies.length > this._maxDenyEvents) {
      this._recentDenies.shift();
    }
  }

  /** Privacy-safe snapshot for /admin/guardians + fleet reports. */
  snapshot() {
    return {
      id: this.id,
      kind: this.kind,
      boundary: this.boundary,
      description: this.description,
      process: this.process,
      fail_closed: this.failClosed,
      created_at: this.createdAt,
      metrics: {
        allows: this.metrics.allows,
        denies: this.metrics.denies,
        errors: this.metrics.errors,
        by_reason: { ...this.metrics.byReason },
        by_outcome: { ...this.metrics.byOutcome },
        last_allow_at: this.metrics.last_allow_at,
        last_deny_at: this.metrics.last_deny_at,
        last_error_at: this.metrics.last_error_at,
      },
      // Only the last 20 go into a snapshot to keep JSON small.
      recent_denies: this._recentDenies.slice(-20),
    };
  }

  /** Slim snapshot for fleet reports — metrics only, no events. */
  metricsSnapshot() {
    return {
      id: this.id,
      kind: this.kind,
      process: this.process,
      allows: this.metrics.allows,
      denies: this.metrics.denies,
      errors: this.metrics.errors,
      by_reason: { ...this.metrics.byReason },
      by_outcome: { ...this.metrics.byOutcome },
    };
  }
}

/** Normalize free-form reason strings to stable metric dimensions. */
function stableReason(raw) {
  if (typeof raw !== 'string' || !raw) return 'unspecified';
  // Lowercase, strip whitespace, replace non-alphanumeric with _, cap length.
  return raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 48) || 'unspecified';
}

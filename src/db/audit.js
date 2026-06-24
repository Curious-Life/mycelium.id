/**
 * Audit namespace — append-only operator event log (Phase 11 PR 2).
 *
 * First namespace extracted from db-d1.js as a decomposition pilot. The
 * factory pattern mirrors the router extraction from Phase 10 — the
 * namespace receives its D1 helper via DI so tests can stub it.
 *
 * audit_log is infrastructure state, not tenant data: `d1QueryAdmin`
 * bypasses the per-tenant WHERE-user_id injection because we need to
 * write events across tenants (scope violations, auth failures, etc.).
 * Every write is fire-and-forget — an audit write that fails should
 * NEVER block the caller's response.
 *
 * Observability: every write outcome feeds a process-local counter
 * exposed via getAuditStatus(). inv.audit-log-writes on the VPS side
 * alerts when the success rate drops or the log stops flowing — which
 * matters because the failure itself is swallowed here by design.
 *
 * @typedef {object} AuditNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1QueryAdmin
 *   — admin-scoped D1 query, bypasses tenant injection
 * @property {() => string} [randomUUID] — test seam; defaults to crypto.randomUUID
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';

const WINDOW_MS = 5 * 60 * 1000;

// Process-local write stats. Single audit_log per process so module scope is fine.
const stats = {
  writes_ok: 0,
  writes_failed: 0,
  last_success_at: null,
  last_failure_at: null,
  last_failure_reason: null,
  window: { ok: 0, failed: 0, started_at: Date.now() },
};

function recordWrite(ok, errMsg = null) {
  const now = Date.now();
  if (now - stats.window.started_at > WINDOW_MS) {
    stats.window = { ok: 0, failed: 0, started_at: now };
  }
  if (ok) {
    stats.writes_ok++;
    stats.last_success_at = now;
    stats.window.ok++;
  } else {
    stats.writes_failed++;
    stats.last_failure_at = now;
    // Store short tag, not full SQL — keeps /internal/audit-status body small and PII-free.
    stats.last_failure_reason = classifyFailure(errMsg);
    stats.window.failed++;
  }
}

function classifyFailure(msg) {
  if (!msg) return 'unknown';
  const s = String(msg).toLowerCase();
  if (s.includes('no such column') || s.includes('no such table')) return 'schema_drift_or_replica_lag';
  if (s.includes('timeout') || s.includes('timed out')) return 'timeout';
  if (s.includes('unauthorized') || s.includes('401')) return 'auth';
  if (s.includes('503') || s.includes('not available')) return 'worker_unavailable';
  if (s.includes('500')) return 'worker_500';
  return 'other';
}

/**
 * Snapshot of audit write stats. Consumed by /internal/audit-status and
 * inv.audit-log-writes. Never throws — returning a stable shape matters
 * even if no writes have happened yet.
 */
export function getAuditStatus() {
  const now = Date.now();
  const windowTotal = stats.window.ok + stats.window.failed;
  return {
    writes_ok: stats.writes_ok,
    writes_failed: stats.writes_failed,
    last_success_at: stats.last_success_at,
    last_success_age_ms: stats.last_success_at ? now - stats.last_success_at : null,
    last_failure_at: stats.last_failure_at,
    last_failure_reason: stats.last_failure_reason,
    window_5min: {
      ok: stats.window.ok,
      failed: stats.window.failed,
      fail_rate: windowTotal > 0 ? stats.window.failed / windowTotal : 0,
      started_at: stats.window.started_at,
      age_ms: now - stats.window.started_at,
    },
  };
}

export function createAuditNamespace(deps) {
  if (!deps) throw new TypeError('createAuditNamespace: deps required');
  const { d1QueryAdmin, randomUUID = nodeRandomUUID } = deps;
  if (typeof d1QueryAdmin !== 'function') {
    throw new TypeError('createAuditNamespace: d1QueryAdmin required');
  }

  return {
    /**
     * Fire-and-forget audit log entry — never blocks the caller.
     * Errors are logged to stderr + counted, not re-thrown.
     */
    async log({ action, agentId, userId, ip, resourceType, resourceId, details }) {
      try {
        await d1QueryAdmin(
          `INSERT INTO audit_log (id, event_type, agent_id, user_id, ip_address, endpoint, method, details, success, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`,
          [
            randomUUID(),
            action,
            agentId || process.env.AGENT_ID,
            userId,
            ip,
            resourceType,
            resourceId,
            details ? JSON.stringify(details) : null,
          ],
        );
        recordWrite(true);
      } catch (e) {
        recordWrite(false, e.message);
        console.error('[audit] Write failed:', e.message);
      }
    },

    /**
     * Query recent audit events (admin-scoped — shows events across all
     * tenants). Capped at the caller's `limit`, no internal ceiling here
     * — the route handler enforces a 500 max via Math.min().
     */
    async recent({ limit = 50, eventType, userId } = {}) {
      let sql = 'SELECT * FROM audit_log WHERE 1=1';
      const params = [];
      if (eventType) { sql += ' AND event_type = ?'; params.push(eventType); }
      if (userId)    { sql += ' AND user_id = ?';    params.push(userId); }
      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);
      const result = await d1QueryAdmin(sql, params);
      return result.results || [];
    },
  };
}

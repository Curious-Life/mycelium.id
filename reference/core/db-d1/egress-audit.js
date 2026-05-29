/**
 * Egress audit namespace — append-only record of every text sent to a person-
 * visible channel (Telegram, Discord, WhatsApp, Email).
 *
 * Phase 0 of EGRESS-PROVENANCE-PLAN-2026-05-06: pure observability before any
 * behavior change. Caller-side instrumentation (six caller classes) feeds this
 * namespace; the data shapes Phase 1+ design.
 *
 * Pattern mirrors `audit.js` (Phase 11 PR 2) — fire-and-forget, process-local
 * stats, factory-injected DI. Differences:
 *
 *   - Tenant-scoped (`d1Query`, not `d1QueryAdmin`): every tenant has its own
 *     egress_audit table. Operator inspects per-tenant.
 *   - INTEGER PRIMARY KEY AUTOINCREMENT (mirrors migration 150 conventions),
 *     so we don't pass an id — D1 assigns.
 *   - Content stored as sha256 hex + length only. The audit must not recreate
 *     the leak surface it's measuring.
 *
 * @typedef {object} EgressAuditNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 *   — tenant-scoped D1 query
 */

const WINDOW_MS = 5 * 60 * 1000;

// Process-local write stats. Single egress_audit per process so module scope is fine.
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
 * Snapshot of egress audit write stats. Same shape as getAuditStatus() so
 * portal/operator dashboards can render either with one component.
 */
export function getEgressAuditStatus() {
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

export function createEgressAuditNamespace(deps) {
  if (!deps) throw new TypeError('createEgressAuditNamespace: deps required');
  const { d1Query } = deps;
  if (typeof d1Query !== 'function') {
    throw new TypeError('createEgressAuditNamespace: d1Query required');
  }

  return {
    /**
     * Fire-and-forget egress audit row — never blocks the caller.
     * Errors are logged + counted, never thrown. Phase 0 contract: an audit
     * write that fails MUST NOT cause a delivery failure.
     *
     * @param {object} entry
     * @param {string} entry.agentId
     * @param {string} entry.provenanceKind   — see migration 151 enumeration
     * @param {string} entry.sourceModule     — e.g. 'chat.fallback', 'agent-egress.notifyArtifactsCreated'
     * @param {string} entry.channelKind      — 'telegram' | 'telegram-group' | 'discord' | 'discord-thread' | 'whatsapp' | 'email' | 'other'
     * @param {string} entry.channelId
     * @param {string} entry.contentHash      — sha256 hex
     * @param {number} entry.contentLength
     * @param {string} entry.decision         — 'allowed' | 'denied'
     * @param {string} [entry.taskId]
     * @param {string} [entry.templateId]
     * @param {string} [entry.channelLabel]
     * @param {string} [entry.inboundKind]
     * @param {string} [entry.inboundId]
     * @param {boolean} [entry.crossChannel]
     * @param {string} [entry.crossChannelReason]
     * @param {string} [entry.reason]
     * @param {boolean} [entry.delivered]
     * @param {number} [entry.httpStatus]
     */
    async record(entry) {
      try {
        await d1Query(
          `INSERT INTO egress_audit (
             agent_id, task_id, provenance_kind, source_module, template_id,
             channel_kind, channel_id, channel_label,
             inbound_kind, inbound_id, cross_channel, cross_channel_reason,
             content_hash, content_length, decision, reason,
             delivered, http_status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.agentId,
            entry.taskId || null,
            entry.provenanceKind,
            entry.sourceModule,
            entry.templateId || null,
            entry.channelKind,
            String(entry.channelId),
            entry.channelLabel || null,
            entry.inboundKind || null,
            entry.inboundId ? String(entry.inboundId) : null,
            entry.crossChannel ? 1 : 0,
            entry.crossChannelReason || null,
            entry.contentHash,
            entry.contentLength,
            entry.decision,
            entry.reason || null,
            entry.delivered === true ? 1 : entry.delivered === false ? 0 : null,
            entry.httpStatus ?? null,
          ],
        );
        recordWrite(true);
      } catch (e) {
        recordWrite(false, e.message);
        // Console only — never propagate. The caller is delivering a message;
        // audit must not block or alter that.
        console.error('[egress-audit] Write failed:', e.message);
      }
    },

    /**
     * Recent audit rows. Caller (operator endpoint) enforces a hard upper
     * bound; this method just clamps to a sane local default.
     *
     * @param {object} [filter]
     * @param {number} [filter.limit=100]
     * @param {string} [filter.provenanceKind]
     * @param {string} [filter.channelKind]
     * @param {string} [filter.channelId]
     * @param {string} [filter.agentId]
     * @param {number} [filter.crossChannel]   — 0 or 1
     */
    async recent(filter = {}) {
      const limit = Math.max(1, Math.min(500, filter.limit ?? 100));
      let sql = 'SELECT * FROM egress_audit WHERE 1=1';
      const params = [];
      if (filter.provenanceKind) { sql += ' AND provenance_kind = ?'; params.push(filter.provenanceKind); }
      if (filter.channelKind)    { sql += ' AND channel_kind = ?';    params.push(filter.channelKind); }
      if (filter.channelId)      { sql += ' AND channel_id = ?';      params.push(String(filter.channelId)); }
      if (filter.agentId)        { sql += ' AND agent_id = ?';        params.push(filter.agentId); }
      if (filter.crossChannel === 0 || filter.crossChannel === 1) {
        sql += ' AND cross_channel = ?';
        params.push(filter.crossChannel);
      }
      sql += ' ORDER BY ts DESC, id DESC LIMIT ?';
      params.push(limit);
      const result = await d1Query(sql, params);
      return result.results || [];
    },
  };
}

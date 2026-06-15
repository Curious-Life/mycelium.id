/**
 * LLM token-usage namespace — append-only accounting of every generation call's
 * input/output token consumption, by source/area/provider/model. Powers the
 * /portal/usage transparency surface. @see migrations/0014_llm_usage.sql,
 * docs/TEXT-GENERATION-ABSTRACTION-DESIGN-2026-06-15.md §12.
 *
 * COUNTS + DIMENSIONS ONLY — never any prompt/completion text (§1). Plaintext
 * metadata, same boundary as audit_log / background_jobs / cycle_metrics. Writes
 * are fire-and-forget: a usage-accounting failure must NEVER break a generation.
 *
 * @typedef {object} LlmUsageDeps
 * @property {(sql:string, params:any[]) => Promise<{results:any[]}>} d1Query
 * @property {() => string} [randomUUID]
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';

const VALID_SOURCES = new Set(['chat', 'gateway', 'enrichment', 'ingest']);
const intOr0 = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

export function createLlmUsageNamespace(deps) {
  if (!deps) throw new TypeError('createLlmUsageNamespace: deps required');
  const { d1Query, randomUUID = nodeRandomUUID } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createLlmUsageNamespace: d1Query required');

  /** Run a grouped SUM query, returning normalized rows. */
  async function grouped(userId, since, col) {
    const r = await d1Query(
      `SELECT ${col} AS key,
              COALESCE(SUM(input_tokens),0)  AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              COUNT(*) AS events
         FROM llm_usage
        WHERE user_id = ? AND at >= ?
        GROUP BY ${col}
        ORDER BY (COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0)) DESC`,
      [userId, since],
    );
    return (r.results || []).map((x) => ({
      key: x.key ?? '(none)',
      inputTokens: x.input_tokens || 0,
      outputTokens: x.output_tokens || 0,
      events: x.events || 0,
    }));
  }

  return {
    /**
     * Record one generation call's usage. Fire-and-forget — never throws.
     * @param {string} userId
     * @param {object} e  { source, area, provider?, model?, jurisdiction?, isLocal?, inputTokens, outputTokens, estimated?, durationMs? }
     */
    async record(userId, e = {}) {
      try {
        if (!userId) return;
        const source = VALID_SOURCES.has(e.source) ? e.source : 'enrichment';
        const area = (typeof e.area === 'string' && e.area) ? e.area : 'complex';
        await d1Query(
          `INSERT INTO llm_usage (id, user_id, source, area, provider, model, jurisdiction, is_local, input_tokens, output_tokens, estimated, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(), userId, source, area,
            e.provider || null, e.model || null, e.jurisdiction || null,
            e.isLocal ? 1 : 0,
            intOr0(e.inputTokens), intOr0(e.outputTokens),
            e.estimated ? 1 : 0,
            Number.isFinite(e.durationMs) ? Math.round(e.durationMs) : null,
          ],
        );
      } catch (err) {
        // Accounting must never break generation; surface to stderr only.
        console.error('[llm-usage] record failed:', err?.message);
      }
    },

    /**
     * Aggregate usage over the last `sinceDays` days for the transparency page.
     * @returns {Promise<{ totals, byArea, bySource, byProvider, byModel, byDay }>}
     */
    async summary(userId, { sinceDays = 30 } = {}) {
      const since = new Date(Date.now() - Math.max(1, sinceDays) * 86400000).toISOString();
      const empty = { totals: { inputTokens: 0, outputTokens: 0, events: 0 }, byArea: [], bySource: [], byProvider: [], byModel: [], byDay: [] };
      try {
        const t = await d1Query(
          `SELECT COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COUNT(*) AS events
             FROM llm_usage WHERE user_id = ? AND at >= ?`,
          [userId, since],
        );
        const tot = (t.results || [])[0] || {};
        const [byArea, bySource, byProvider, byModel] = await Promise.all([
          grouped(userId, since, 'area'),
          grouped(userId, since, 'source'),
          grouped(userId, since, "COALESCE(provider,'(none)')"),
          grouped(userId, since, "COALESCE(model,'(none)')"),
        ]);
        const dr = await d1Query(
          `SELECT substr(at,1,10) AS key,
                  COALESCE(SUM(input_tokens),0)  AS input_tokens,
                  COALESCE(SUM(output_tokens),0) AS output_tokens,
                  COUNT(*) AS events
             FROM llm_usage WHERE user_id = ? AND at >= ?
            GROUP BY substr(at,1,10) ORDER BY key ASC`,
          [userId, since],
        );
        const byDay = (dr.results || []).map((x) => ({ key: x.key, inputTokens: x.input_tokens || 0, outputTokens: x.output_tokens || 0, events: x.events || 0 }));
        return {
          totals: { inputTokens: tot.input_tokens || 0, outputTokens: tot.output_tokens || 0, events: tot.events || 0 },
          byArea, bySource, byProvider, byModel, byDay,
        };
      } catch (err) {
        console.error('[llm-usage] summary failed:', err?.message);
        return empty;
      }
    },

    /** Last `limit` raw events (newest first) for the detail table. */
    async recent(userId, limit = 50) {
      try {
        const r = await d1Query(
          `SELECT at, source, area, provider, model, jurisdiction, is_local, input_tokens, output_tokens, estimated, duration_ms
             FROM llm_usage WHERE user_id = ? ORDER BY at DESC LIMIT ?`,
          [userId, Math.min(Math.max(1, limit), 500)],
        );
        return (r.results || []).map((x) => ({
          at: x.at, source: x.source, area: x.area, provider: x.provider, model: x.model,
          jurisdiction: x.jurisdiction, isLocal: !!x.is_local,
          inputTokens: x.input_tokens || 0, outputTokens: x.output_tokens || 0,
          estimated: !!x.estimated, durationMs: x.duration_ms ?? null,
        }));
      } catch { return []; }
    },
  };
}

export default createLlmUsageNamespace;

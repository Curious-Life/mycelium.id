// src/inference/usage.js — the token-usage accounting sink (§12). Wires a
// generation path's `onUsage` callback to db.usage.record, tagging every event
// with its SOURCE (the entry path). Mirrors createEgressAuditSink (egress.js):
// fire-and-forget, returns undefined when the db has no usage namespace (→ the
// caller simply skips accounting), and NEVER throws into a generation.
//
// COUNTS + DIMENSIONS ONLY — the event carries token counts + provider/model/
// area, never any prompt or completion text (§1).

import { estimateTokens } from './token-budget.js';

/**
 * Record an ESTIMATED token-flow event for content that did NOT pass through a
 * model (bulk imports, ingest, …) — so the Usage transparency surface shows how
 * much is flowing through each area even where no provider reports counts. The
 * volume is a chars/4 estimate of the content; output is 0; `estimated` is true.
 * Fire-and-forget — never throws. Counts only, never the content itself.
 * @param {object} db
 * @param {string} userId
 * @param {{source?:string, area:string, content?:string|string[], tokens?:number, provider?:string}} e
 */
export function recordContentFlow(db, userId, { source = 'ingest', area = 'import', content, tokens, provider = null } = {}) {
  if (typeof db?.usage?.record !== 'function' || !userId) return;
  let t = Number.isFinite(tokens) ? tokens : 0;
  if (!t && content != null) {
    const parts = Array.isArray(content) ? content : [content];
    for (const p of parts) t += estimateTokens(p);
  }
  if (!(t > 0)) return;
  try { db.usage.record(userId, { source, area, provider, isLocal: true, inputTokens: t, outputTokens: 0, estimated: true }); }
  catch { /* accounting must never break ingest */ }
}

/**
 * Build an onUsage sink bound to a vault db + user + source.
 * @param {object} db       assembled vault db (needs db.usage.record)
 * @param {string} userId
 * @param {{source?: 'chat'|'gateway'|'enrichment'}} [opts]
 * @returns {((e: object) => void) | undefined}
 */
export function createUsageSink(db, userId, { source = 'enrichment' } = {}) {
  if (typeof db?.usage?.record !== 'function' || !userId) return undefined;
  return (e) => {
    try { db.usage.record(userId, { source, ...e }); }
    catch { /* accounting must never break generation */ }
  };
}

export default createUsageSink;

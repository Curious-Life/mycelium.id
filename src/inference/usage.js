// src/inference/usage.js — the token-usage accounting sink (§12). Wires a
// generation path's `onUsage` callback to db.usage.record, tagging every event
// with its SOURCE (the entry path). Mirrors createEgressAuditSink (egress.js):
// fire-and-forget, returns undefined when the db has no usage namespace (→ the
// caller simply skips accounting), and NEVER throws into a generation.
//
// COUNTS + DIMENSIONS ONLY — the event carries token counts + provider/model/
// area, never any prompt or completion text (§1).

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

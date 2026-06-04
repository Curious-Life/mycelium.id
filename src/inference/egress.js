// src/inference/egress.js — the inference-egress audit sink (§4e). Wires the
// router's `onEgress` callback to the general `db.audit` log: every cloud egress
// decision (allowed/denied) is recorded with the provider, jurisdiction, a
// sha256 content hash + length — NEVER the prompt. Fire-and-forget; an audit
// write failure never blocks inference (db.audit.log swallows its own errors).
//
// Used by every caller that gives the router a db (describe-chronicles today, the
// /v1 gateway next), so the egress boundary — §4e audit + §4g hard-block, both
// enforced in router.js — records what it gates. We deliberately use the general
// audit_log table, NOT the channel-shaped egress_audit table (telegram/discord,
// CHECK-constrained), which is a poor fit for LLM egress.

/**
 * Build an onEgress sink bound to a vault db + user. Returns undefined when the
 * db has no audit namespace (→ the router simply skips auditing).
 * @param {object} db       assembled vault db (needs db.audit.log)
 * @param {string} userId
 * @returns {((e: object) => void) | undefined}
 */
export function createEgressAuditSink(db, userId) {
  if (typeof db?.audit?.log !== "function") return undefined;
  return (e) => {
    try {
      db.audit.log({
        action: "inference-egress",
        userId,
        resourceType: e.provider,      // which provider received (or was denied) the prompt
        resourceId: e.model || null,   // the model
        details: {
          jurisdiction: e.jurisdiction,
          decision: e.decision,        // 'allowed' | 'denied'
          reason: e.reason || null,    // e.g. 'sensitive_us_block'
          content_hash: e.contentHash, // sha256 hex — never the plaintext
          content_length: e.contentLength,
        },
      });
    } catch { /* audit must never break inference */ }
  };
}

export default createEgressAuditSink;

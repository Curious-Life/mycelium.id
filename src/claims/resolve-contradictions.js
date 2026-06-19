// src/claims/resolve-contradictions.js — bi-temporal contradiction resolution (Phase 2b).
//
// When a fresh proposal lands, find the RELATED-but-not-duplicate active claims (embedding cosine in
// a band — below it = unrelated, above it = the same claim → an UPDATE, not a conflict), validate the
// proposal against each, and on a strong conflict decide a RETRACT under source-priority:
//   user-stated  >  agent-inferred.
// An agent-inferred proposal may NEVER silently override a user-stated claim (SSGM governance). Nothing
// is deleted here — it returns the retractions for db.claims.retract (close valid_to + link
// superseded_by). `validate` and the cosine `similarity` fn are injected (unit-testable; the real
// wiring decrypts the embedding envelopes in-app where the key lives).

const DEFAULT_BAND = [0.50, 0.90]; // related-but-not-duplicate (Ada §4; matches the spec)

/**
 * @param {object} o
 * @param {object}   o.db          needs db.claims.listForMatch(userId)
 * @param {string}   o.userId
 * @param {{content:string, embedding768:any, source:string, validFrom?:string}} o.proposal
 * @param {(a:any,b:any)=>(number|null)} o.similarity   cosine of two embedding envelopes (null if unknown)
 * @param {(text:string, claim:object)=>Promise<{relation:string}>} o.validate  (validator.js)
 * @param {[number,number]} [o.band]
 * @returns {Promise<{retractions: Array<{oldId,validTo,supersededBy,reason}>, blocked: boolean, related: number}>}
 */
export async function resolveContradictions({ db, userId, proposal, similarity, validate, band = DEFAULT_BAND } = {}) {
  if (!db?.claims?.listForMatch) throw new TypeError('resolveContradictions: db.claims.listForMatch required');
  if (typeof similarity !== 'function' || typeof validate !== 'function') {
    throw new TypeError('resolveContradictions: similarity + validate required');
  }
  const [lo, hi] = band;
  let pool = [];
  try { pool = await db.claims.listForMatch(userId); } catch { pool = []; }

  // related = active claims whose embedding is in the band (not a dup, not unrelated)
  const related = [];
  for (const c of pool || []) {
    if (c.status !== 'active') continue;
    const sim = similarity(proposal.embedding768, c.embedding768);
    if (sim != null && sim >= lo && sim <= hi) related.push(c);
  }

  const retractions = [];
  let blocked = false;
  for (const claim of related) {
    let v;
    try { v = await validate(proposal.content, claim); } catch { v = { relation: 'unrelated' }; }
    if (v.relation !== 'strong_conflict') continue;

    const existingSource = claim.support?.source || 'agent-inferred';
    const proposalSource = proposal.source || 'agent-inferred';
    if (existingSource === 'user-stated' && proposalSource !== 'user-stated') {
      blocked = true; // an inferred claim cannot override the user's own statement
      continue;
    }
    // proposal wins (user-stated, or both inferred → the fresher belief supersedes) → retract the old
    retractions.push({
      oldId: claim.id,
      validTo: proposal.validFrom || null, // close at the successor's valid_from (db fills now if null)
      supersededBy: null,                  // the caller links the successor id after it's upserted
      reason: (v.rationale || 'contradicted by a newer observation').slice(0, 160),
    });
  }
  return { retractions, blocked, related: related.length };
}

export default resolveContradictions;

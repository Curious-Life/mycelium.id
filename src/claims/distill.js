// src/claims/distill.js — turn a day-card-justified proposal into a governed bi-temporal claim (2c).
//
// The agent (integration cycle) PROPOSES a claim by synthesizing model.md + the day-cards; THIS
// governs it deterministically: identity-match → contradiction-resolve → decideOp → upsert/promote/
// retract + a per-change record. The reviewer's C rule is structural here: confidence accrues from
// the DAY-CARD OBSERVATIONS cited in support (source='day-card'), NOT from the agent's synthesis
// (the claim's provenance is 'agent-inferred', used only for source-priority in contradictions). So
// the belief can never corroborate itself. Deps injected → unit-testable without a live model/vault.
import { decideOp, distinctDays, validFrom, shouldPromote, updateConfidence, evidenceWeight } from './lifecycle.js';
import { resolveContradictions } from './resolve-contradictions.js';

const DUP_THRESHOLD = 0.92;       // ≥ this = the SAME claim (an UPDATE, above the contradiction band)
const OBS_OMEGA = 0.6;            // per-distinct-day observation weight (a day-card)
const secs = (a, b) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000 || 0);

export function createDistiller({ db, userId, embed, validate, similarity, now = () => new Date().toISOString() } = {}) {
  if (!db?.claims) throw new TypeError('createDistiller: db.claims required');

  // the same-claim match: a pool claim whose embedding is ≥ DUP_THRESHOLD to the proposal.
  async function matchExisting(embedding768, proposal) {
    let pool = [];
    try { pool = await db.claims.listForMatch(userId); } catch { pool = []; }
    let best = null;
    for (const c of (pool || [])) {
      if (c.status !== 'active' && c.status !== 'pending') continue;
      const sim = similarity ? similarity(embedding768, c.embedding768) : null;
      if (sim != null && sim >= DUP_THRESHOLD && (!best || sim > best.sim)) best = { claim: c, sim };
    }
    return best?.claim || null;
  }

  async function distill(proposal) {
    // proposal: { claimType, content, domain, decayClass, source='agent-inferred',
    //             dayCardDates:[iso…], contexts:[…], variability, contextPrimary }
    const support = {
      day_card_dates: proposal.dayCardDates || [],
      source: proposal.source || 'agent-inferred',
      contexts: proposal.contexts || [],
    };
    const days = distinctDays(support);
    const vf = validFrom(support) || now();
    let embedding768 = null;
    try { embedding768 = embed ? await embed(proposal.content) : null; } catch { embedding768 = null; }

    const existing = await matchExisting(embedding768, proposal);

    // contradiction resolution (related-but-not-dup, under source-priority)
    let retractions = [];
    if (embedding768 && similarity && validate) {
      try {
        const r = await resolveContradictions({
          db, userId, similarity, validate,
          proposal: { content: proposal.content, embedding768, source: support.source, validFrom: vf },
        });
        retractions = r.retractions || [];
      } catch { retractions = []; }
    }

    const op = decideOp({ relation: existing ? 'strong_support' : 'unrelated', isNew: !existing });
    let claimId;

    if (!existing) {
      // ADD — born PENDING. Confidence comes from the day-card OBSERVATIONS (C), not the synthesis.
      const logodds = Math.min(days * evidenceWeight({ omega: OBS_OMEGA, source: 'day-card' }), 4);
      ({ id: claimId } = await db.claims.upsert({
        userId, content: proposal.content, claimType: proposal.claimType ?? null, decayClass: proposal.decayClass ?? 'fact',
        confidenceLogodds: logodds, support, status: 'pending', domain: proposal.domain ?? null,
        variability: proposal.variability ?? null, contextPrimary: proposal.contextPrimary ?? null,
        validFrom: vf, lastEvidenceAt: now(), embedding768,
      }));
      await db.claims.recordChange({ userId, claimId, confidenceLogodds: logodds, deltaKind: 'added' });
      if (shouldPromote({ confidenceLogodds: logodds, decayClass: proposal.decayClass, distinctDays: days })) {
        await db.claims.promote(userId, claimId);
        await db.claims.recordChange({ userId, claimId, confidenceLogodds: logodds, deltaKind: 'promoted' });
      }
    } else {
      // UPDATE — corroborate. Only the NEW day-cards (observations) move confidence (C).
      claimId = existing.id;
      const merged = {
        day_card_dates: [...new Set([...(existing.support?.day_card_dates || []), ...support.day_card_dates])],
        source: existing.support?.source || support.source,
        contexts: support.contexts.length ? support.contexts : (existing.support?.contexts || []),
      };
      const newDays = Math.max(0, distinctDays(merged) - distinctDays(existing.support || {}));
      const ev = { omega: OBS_OMEGA * newDays, source: 'day-card' };
      const upd = updateConfidence({
        priorLogodds: existing.confidenceLogodds || 0,
        dtSeconds: secs(existing.lastEvidenceAt || existing.updatedAt || now(), now()),
        decayClass: existing.decayClass, evidence: ev,
      });
      await db.claims.upsert({
        userId, id: existing.id, content: existing.content, claimType: existing.claimType, decayClass: existing.decayClass,
        confidenceLogodds: upd.logodds, support: merged, status: existing.status, domain: existing.domain,
        variability: proposal.variability ?? existing.variability ?? null,
        contextPrimary: proposal.contextPrimary ?? existing.contextPrimary ?? null,
        lastEvidenceAt: now(), embedding768: existing.embedding768 ?? embedding768,
      });
      await db.claims.recordChange({ userId, claimId, confidenceLogodds: upd.logodds, deltaKind: 'corroborated' });
      if (existing.status === 'pending' && shouldPromote({ confidenceLogodds: upd.logodds, decayClass: existing.decayClass, distinctDays: distinctDays(merged) })) {
        await db.claims.promote(userId, claimId);
        await db.claims.recordChange({ userId, claimId, confidenceLogodds: upd.logodds, deltaKind: 'promoted' });
      }
    }

    // apply retractions — close the old, link THIS claim as successor (never delete)
    for (const r of retractions) {
      if (r.oldId === claimId) continue;
      await db.claims.retract(userId, r.oldId, { validTo: r.validTo || vf, supersededBy: claimId });
      await db.claims.recordChange({ userId, claimId: r.oldId, deltaKind: 'superseded' });
    }

    return { claimId, op, retracted: retractions.map((r) => r.oldId).filter((x) => x !== claimId) };
  }

  return { distill };
}

export default createDistiller;

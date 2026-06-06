// src/claims/discovery.js — per-window claim discovery (PersonaTree §3.2-3.5
// lifecycle). Given a window of evidence, propose typed person-level claims,
// reconcile each against existing claims (identity-match → validate → confidence
// update), and write a per-window snapshot so the claim's trajectory is visible
// over time.
//
// The LOGIC lives here as an injectable function (deps: infer, validate, db) so
// it is unit-testable without a live model — the same pattern as validator.js.
// The process glue that runs it (pipeline/discover-claims.mjs child + the REST
// heartbeat) is thin and sits on top.
//
// SECURITY: the proposal `infer` call carries plaintext evidence and MUST be
// sensitive:true (on-box local only). v1 identity-match uses content_hash +
// lexical similarity over DECRYPTED claim text (no embedding decryption needed);
// embedding_768 is reserved for retrieval. See docs/PERSONA-CLAIMS-DESIGN-2026-06-06.md §3.5.
import { createHash } from 'node:crypto';
import { update as updateConfidence, fromConfidence, toConfidence } from './confidence.js';

// claim_type → decay_class (how fast the confidence fades without re-evidence).
const TYPE_DECAY = Object.freeze({
  boundary: 'boundary',   // never fades
  identity: 'identity',
  personality: 'identity',
  value: 'fact',
  principle: 'fact',
});
const CLAIM_TYPES = ['personality', 'value', 'principle', 'identity', 'boundary'];
const L_NEW = fromConfidence(0.6); // a fresh single-window claim starts modestly confident

export function normalizeText(s) {
  return (s ?? '').toString().toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
export function contentHash(s) {
  return createHash('sha256').update(normalizeText(s)).digest('hex');
}
/** Token-set Jaccard similarity over normalized text (cheap, no embeddings). */
export function similarity(a, b) {
  const ta = new Set(normalizeText(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Parse the model's proposal output into typed claim candidates. */
export function parseProposals(text) {
  if (typeof text !== 'string') return [];
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((c) => c && typeof c.content === 'string' && c.content.trim())
    .map((c) => ({
      type: CLAIM_TYPES.includes(c.type) ? c.type : 'personality',
      content: c.content.trim(),
      support: Array.isArray(c.support) ? c.support.filter((x) => typeof x === 'string') : [],
    }));
}

function buildProposalPrompt(evidence) {
  const lines = evidence.map((e, i) => `[${e.id || i}] ${e.content}`).join('\n');
  return [
    'You are a psychological profiler. From the interaction evidence below, state the durable, well-supported claims about this person.',
    'Only claim what the evidence supports. Each claim cites the evidence ids it rests on.',
    '',
    'EVIDENCE:',
    lines,
    '',
    'Reply with ONLY a JSON array, no prose:',
    '[{"type": one of ["personality","value","principle","identity","boundary"], "content": "<calm third-person sentence>", "support": ["<evidence id>", ...]}]',
  ].join('\n');
}

function deltaFor(isNew, omega) {
  if (isNew) return 'new';
  if (omega > 0.01) return 'strengthened';
  if (omega < -0.5) return 'contradicted';
  if (omega < -0.01) return 'weakened';
  return 'stable';
}

/**
 * Discover/reconcile claims for one window.
 * @param {object} p
 * @param {object} p.db                 the db namespace (uses db.claims)
 * @param {string} p.userId
 * @param {(req:object)=>Promise<string>} p.infer   sensitive:true caller
 * @param {(evidenceText:string, claim:object)=>Promise<{omega:number, relation:string}>} p.validate
 * @param {Array<{id:string, content:string, ts?:string}>} p.evidence  window evidence (messages)
 * @param {string} p.windowStart
 * @param {string} p.windowEnd          also the snapshot key + decay reference time
 * @param {'day'|'week'|'month'|'quarter'} p.granularity
 * @param {number} [p.simThreshold=0.6]
 * @returns {Promise<{created:number, updated:number, skipped:number, claims:string[]}>}
 */
export async function discoverWindow({ db, userId, infer, validate, evidence, windowStart, windowEnd, granularity, simThreshold = 0.6 }) {
  const out = { created: 0, updated: 0, skipped: 0, claims: [] };
  if (!Array.isArray(evidence) || evidence.length === 0) return out; // no evidence → no snapshot (honest gap)

  let raw;
  try {
    raw = await infer({ prompt: buildProposalPrompt(evidence), task: 'narrate', sensitive: true, maxTokens: 700 });
  } catch {
    return out; // Tier-3 fail-open: no local model → no claims, not an error
  }
  const proposals = parseProposals(raw);
  if (!proposals.length) return out;

  const existing = await db.claims.listForMatch(userId);
  const endMs = Date.parse(windowEnd) || Date.now();

  for (const p of proposals) {
    if (!p.support.length) { out.skipped++; continue; } // never write a claim with no support
    const hash = contentHash(p.content);

    // Identity-match: exact hash, else best lexical match over decrypted content.
    let match = existing.find((c) => c.contentHash === hash);
    if (!match) {
      let best = null, bestSim = 0;
      for (const c of existing) {
        const s = similarity(p.content, c.content);
        if (s > bestSim) { bestSim = s; best = c; }
      }
      if (best && bestSim >= simThreshold) match = best;
    }

    // Tombstone: a rejected claim must NOT be resurrected.
    if (match && match.status === 'rejected') { out.skipped++; continue; }

    const decayClass = TYPE_DECAY[p.type] || 'preference';
    let claimId, L, omegaForDelta = 0;
    const isNew = !match;

    if (match) {
      const evidenceText = evidence.filter((e) => p.support.includes(e.id)).map((e) => e.content).join(' ');
      const { omega } = await validate(evidenceText || p.content, match);
      const dt = Math.max(0, (endMs - (Date.parse(match.lastEvidenceAt) || endMs)) / 1000);
      const prevL = match.confidenceLogodds != null ? match.confidenceLogodds : L_NEW;
      ({ L } = updateConfidence({ L: prevL, dtSeconds: dt, decayClass, omega }));
      await db.claims.upsert({
        id: match.id, userId, subject: 'self', claimType: p.type, content: p.content,
        confidenceLogodds: L, decayClass, support: mergeSupport(match.support, p.support),
        contentHash: hash, status: 'active', lastEvidenceAt: windowEnd,
      });
      claimId = match.id;
      omegaForDelta = omega;
      out.updated++;
    } else {
      L = L_NEW;
      const res = await db.claims.upsert({
        userId, subject: 'self', claimType: p.type, content: p.content,
        confidenceLogodds: L, decayClass, support: { messages: p.support, territories: [] },
        contentHash: hash, status: 'active', lastEvidenceAt: windowEnd,
      });
      claimId = res.id;
      out.created++;
    }

    await db.claims.writeSnapshot({
      userId, claimId, windowStart, windowEnd, granularity,
      confidenceLogodds: L, content: p.content, evidenceCount: p.support.length,
      deltaKind: deltaFor(isNew, omegaForDelta),
    });
    out.claims.push(claimId);
  }
  return out;
}

/** Union of message/territory id sets across the old and new support. */
function mergeSupport(prev, fresh) {
  const messages = new Set([...(prev?.messages || []), ...(Array.isArray(fresh) ? fresh : [])]);
  const territories = new Set([...(prev?.territories || [])]);
  return { messages: [...messages], territories: [...territories] };
}

export default { discoverWindow, parseProposals, similarity, contentHash, normalizeText };

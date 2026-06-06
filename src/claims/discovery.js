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
import { cosine } from '../search/ann/cosine.js';

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
    'You are a careful psychological profiler. From the interaction evidence below, state only the DURABLE, WELL-SUPPORTED claims about this person. Quality over quantity — a few solid claims beat many speculative ones.',
    '',
    'Rules:',
    '- Every claim must cite the evidence ids that directly support it. Prefer claims backed by MORE THAN ONE observation.',
    '- Do NOT over-infer from a single ambiguous act (e.g. declining one loud party does NOT make someone introverted, especially if other evidence shows them seeking out people).',
    '- Weigh the WHOLE evidence set together; do not let one message contradict the pattern in the others.',
    '- SAFETY-CRITICAL facts — allergies, intolerances, medical limits, hard prohibitions, trauma triggers — are ALWAYS type "boundary" (never "principle" or "personality"). State the specific constraint (e.g. the food).',
    '',
    'Types: "boundary" (hard limits / safety constraints, incl. allergies), "value" (what they care about), "principle" (a rule they live by), "identity" (a durable role/self-description), "personality" (a stable trait).',
    '',
    'EVIDENCE:',
    lines,
    '',
    'Reply with ONLY a JSON array, no prose. Use calm third-person sentences:',
    '[{"type": "...", "content": "...", "support": ["<evidence id>", ...]}]',
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
 * @param {(texts:string[])=>Promise<number[][]>} [p.embed]  batch embedder for
 *   SEMANTIC claim matching (so paraphrases of one claim across windows/cadences
 *   merge into ONE row). Omit → lexical Jaccard fallback (Tier-1).
 * @param {number} [p.cosineThreshold=0.62]  semantic-match cutoff. Calibrated
 *   against Nomic v1.5 on short claim fragments (2026-06-06): same-concept
 *   paraphrases scored 0.68–0.78, distinct concepts 0.38–0.49 — 0.62 sits in
 *   the gap (catches paraphrases, never merges distinct claims).
 * @param {number} [p.simThreshold=0.6]      lexical-fallback cutoff
 * @returns {Promise<{created:number, updated:number, skipped:number, claims:string[]}>}
 */
export async function discoverWindow({ db, userId, infer, validate, evidence, windowStart, windowEnd, granularity, embed, cosineThreshold = 0.62, simThreshold = 0.6 }) {
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

  // The match POOL = existing active/rejected claims, GROWING as this window
  // creates new ones — so a paraphrase later in the same window (or in a later
  // cadence of the same run) merges into the claim made earlier instead of
  // forking a duplicate row.
  const pool = (await db.claims.listForMatch(userId)).map((c) => ({ ...c }));
  const endMs = Date.parse(windowEnd) || Date.now();

  // Embed proposals + pool contents once (task 'query' on BOTH sides → symmetric
  // Nomic prefix) for SEMANTIC matching. Any failure → vectors stay null and we
  // fall back to lexical Jaccard (Tier-1, no embedder).
  let propVecs = null;
  if (typeof embed === 'function') {
    try {
      const texts = [...proposals.map((p) => p.content), ...pool.map((c) => c.content)];
      const vecs = texts.length ? await embed(texts) : [];
      if (Array.isArray(vecs) && vecs.length === texts.length) {
        propVecs = vecs.slice(0, proposals.length);
        pool.forEach((c, i) => { c.vec = vecs[proposals.length + i]; });
      }
    } catch { /* embedder hiccup → lexical fallback */ }
  }

  // Find the existing claim a proposal refers to: exact content hash, else the
  // nearest by cosine (when embedded) or token-Jaccard (fallback). null = new.
  const findMatch = (p, hash, vec) => {
    const exact = pool.find((c) => c.contentHash === hash);
    if (exact) return exact;
    let best = null, bestSim = 0;
    if (vec) {
      for (const c of pool) { if (!c.vec) continue; const s = cosine(vec, c.vec); if (s > bestSim) { bestSim = s; best = c; } }
      return best && bestSim >= cosineThreshold ? best : null;
    }
    for (const c of pool) { const s = similarity(p.content, c.content); if (s > bestSim) { bestSim = s; best = c; } }
    return best && bestSim >= simThreshold ? best : null;
  };

  for (let pi = 0; pi < proposals.length; pi++) {
    const p = proposals[pi];
    if (!p.support.length) { out.skipped++; continue; } // never write a claim with no support
    const hash = contentHash(p.content);
    const vec = propVecs ? propVecs[pi] : null;
    const match = findMatch(p, hash, vec);

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
      const support = mergeSupport(match.support, p.support);
      await db.claims.upsert({
        id: match.id, userId, subject: 'self', claimType: p.type, content: p.content,
        confidenceLogodds: L, decayClass, support, contentHash: hash, status: 'active', lastEvidenceAt: windowEnd,
      });
      claimId = match.id;
      omegaForDelta = omega;
      // Refresh the pool entry so a later paraphrase in this run matches the merged claim.
      Object.assign(match, { content: p.content, contentHash: hash, confidenceLogodds: L, lastEvidenceAt: windowEnd, support, vec: vec ?? match.vec });
      out.updated++;
    } else {
      L = L_NEW;
      const res = await db.claims.upsert({
        userId, subject: 'self', claimType: p.type, content: p.content,
        confidenceLogodds: L, decayClass, support: { messages: p.support, territories: [] },
        contentHash: hash, status: 'active', lastEvidenceAt: windowEnd,
      });
      claimId = res.id;
      // Add to the pool so a later paraphrase in the same run merges into it.
      pool.push({ id: claimId, content: p.content, contentHash: hash, status: 'active',
        confidenceLogodds: L, lastEvidenceAt: windowEnd, support: { messages: p.support, territories: [] }, vec });
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

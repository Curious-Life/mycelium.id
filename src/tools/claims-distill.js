// src/tools/claims-distill.js — Context Engine L3 ("distill"): the agent-facing seam that turns a
// day-card-justified observation into a GOVERNED bi-temporal claim (Phase 2c-wire).
//
// proposeClaim wraps createDistiller (src/claims/distill.js) — the deterministic governance:
// embed → identity-match → decideOp → ADD (born pending) / UPDATE (corroborate) / promote, plus a
// per-change record. The reviewer's C rule lives in the orchestration: confidence accrues ONLY from
// the day-card OBSERVATIONS cited in support, never from the agent's synthesis — so a belief can
// never corroborate itself. The integration cycle calls this once per theme-cluster of recent day
// cards, phrased as a TENDENCY ("leans toward…", with how it varies + which contexts it shifts
// with), never "is X" — Whole-Trait Theory: a stable claim is a DISTRIBUTION of states.
//
// WIRING NOTES (verified 2026-06-19, this is a PIVOT from the build-handoff recipe):
//   - Vectors: the proposal is embedded to a RAW little-endian float32 Buffer (encodeVectorRaw) and
//     stored verbatim in person_claims.embedding_768 (NEVER_AUTO_DECRYPT). At-rest confidentiality
//     is the whole-file SQLCipher vault — the sanctioned post-"Stage A" vector format (no wrapped-DEK
//     envelope, no base64). decode is SYNCHRONOUS (no master key), which is REQUIRED: distill.js and
//     resolve-contradictions.js call similarity() UN-AWAITED, so an async decryptVector there was
//     structurally impossible. Legacy/absent vectors decode to null → treated as "skip" (fail-safe:
//     never a false dup or false contradiction).
//   - Contradiction `validate` is OPTIONAL: it needs a sensitive-aware infer (§4g: NEVER egress these
//     abstractions to US cloud), which belongs as reusable inference-layer plumbing, not hand-rolled
//     here. distill.js cleanly skips contradiction-resolution when validate is absent (no destructive
//     retraction can happen without it — the safe default). Pass `infer` to enable it as a drop-in.
//
// Security (CLAUDE.md §1-13): claims are the highest-value memory. This proposes; promotion is the
// CVP gate (pending excluded from getContext until the SPRT bar clears); merges are human-reviewed.

import { createDistiller } from '../claims/distill.js';
import { createValidator } from '../claims/validator.js';
import { createEmbedClient } from '../embed/client.js';
import { encodeVectorRaw } from '../search/ann/decode.js';
import { cosine } from '../search/ann/cosine.js';

const DIM = 768;
const BYTES_PER_FLOAT32 = 4;
const KNOWN_TYPES = new Set(['identity', 'value', 'principle', 'boundary', 'personality']);
const KNOWN_DECAY = new Set(['boundary', 'identity', 'fact', 'preference', 'mood']);
const KNOWN_SOURCES = new Set(['agent-inferred', 'user-stated']);

/** Sync decode of a stored vector value → Float32Array, or null (fail-safe).
 *  Raw LE-float32 Buffer/Uint8Array (the Stage-A at-rest form) only; anything else → null. */
function decodeVec(v) {
  if (v == null) return null;
  let buf = null;
  if (Buffer.isBuffer(v)) buf = v;
  else if (v instanceof Uint8Array) buf = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  else return null; // legacy envelope string / unexpected shape → never a false match
  if (buf.length !== DIM * BYTES_PER_FLOAT32) return null;
  const out = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) out[i] = buf.readFloatLE(i * BYTES_PER_FLOAT32);
  return out;
}

const sig = (x) => (x == null ? null : 1 / (1 + Math.exp(-x))); // log-odds → confidence in (0,1)

/**
 * @param {object}   o
 * @param {object}   o.db                 the keyed vault (needs db.claims)
 * @param {string}   o.userId
 * @param {(content:string)=>Promise<Buffer|null>} [o.embed]  content → storable raw-vector Buffer.
 *   Defaults to the local Nomic embed-service (:8091) encoded to encodeVectorRaw bytes.
 * @param {(a:any,b:any)=>(number|null)} [o.similarity]  sync cosine over two stored vector values.
 * @param {(text:string, claim:object)=>Promise<{relation:string}>} [o.validate]  contradiction judge.
 * @param {(req:object)=>Promise<string>} [o.infer]  if given (and no validate), builds the validator.
 * @param {{embed:Function}} [o.embedClient]  injectable embed client (tests).
 * @param {()=>string} [o.now]
 */
export function createClaimsDistillDomain({ db, userId, embed, similarity, validate, infer, embedClient, now } = {}) {
  if (!db?.claims) throw new TypeError('createClaimsDistillDomain: db.claims required');

  // embed → a storable raw-vector Buffer. Symmetric task with the match pool (discovery convention:
  // 'query' on both sides → matched Nomic prefix). Any embed-service hiccup → distill catches → the
  // claim is still added, just without a vector (no dedup that round) — fail-soft, never fatal.
  const client = embedClient || (() => { try { return createEmbedClient(); } catch { return null; } })();
  const embedToBuffer = embed || (async (content) => {
    if (!client) return null;
    const vec = await client.embed(String(content), 'query');
    return encodeVectorRaw(Float32Array.from(vec));
  });

  // sync similarity over two stored vector values (proposal's fresh Buffer + a pool Buffer).
  const sim = similarity || ((a, b) => {
    const va = decodeVec(a), vb = decodeVec(b);
    if (!va || !vb) return null; // unknown vector → skip (never a false dup / false contradiction)
    return cosine(va, vb);
  });

  // Contradiction validation is opt-in: only when a sensitive-aware infer (or a ready validate) is
  // supplied. Absent → distill skips contradiction-resolution (no destructive retraction) — safe.
  const validateFn = validate || (typeof infer === 'function' ? createValidator({ infer }).validate : undefined);

  const distiller = createDistiller({ db, userId, embed: embedToBuffer, similarity: sim, validate: validateFn, ...(now ? { now } : {}) });

  const tools = [
    {
      name: 'proposeClaim',
      description:
        'Propose a durable claim about your person, justified by recent reflection records (day cards). '
        + 'Phrase it as a TENDENCY, never a fixed label — "leans toward solo deep work", not "is an introvert" — '
        + 'and say how it VARIES and which contexts it shifts with. It is governed automatically: born pending, '
        + 'it earns its place only after enough distinct days of evidence (it never auto-promotes from one read), '
        + 'and the confidence comes from the day cards you cite, not from restating it. Use this in the integration '
        + 'cycle after you have clustered the recent day cards by theme. One call per stable tendency.',
      inputSchema: {
        type: 'object',
        properties: {
          content:        { type: 'string', description: 'the tendency, phrased as a distribution of states (e.g. "tends to ship hardest under deadline pressure, less so in open-ended weeks")' },
          claim_type:     { type: 'string', description: 'identity | value | principle | boundary | personality' },
          decay_class:    { type: 'string', description: 'how fast it can change: boundary | identity | fact | preference | mood (sets how many distinct days it needs to promote)' },
          domain:         { type: 'string', description: 'the life domain (e.g. "Work & Creativity", "People & Relationships")' },
          day_card_dates: { type: 'array', items: { type: 'string' }, description: 'the dates (YYYY-MM-DD) of the day cards that evidence this — the DISTINCT days drive promotion + confidence' },
          variability:    { type: 'number', description: 'optional 0..1 — how much it swings (0 = rock-steady, 1 = highly state-dependent); keep the distribution, do not flatten it' },
          context_primary:{ type: 'string', description: 'optional — the context it shifts with most (e.g. "energy level", "who is present")' },
          contexts:       { type: 'array', items: { type: 'string' }, description: 'optional — the conditioning contexts you observed it across' },
          source:         { type: 'string', description: "provenance: 'agent-inferred' (your synthesis — the default) or 'user-stated' (the person said it directly)" },
        },
        required: ['content', 'day_card_dates'],
      },
    },
    {
      name: 'listClaimsHistory',
      description:
        'Look at the claims believed about your person. With no argument: the current tendencies (what is true now), '
        + 'grouped by domain. With a claimId: that claim\'s belief history — every change (added, corroborated, '
        + 'promoted, superseded) with the date and confidence — the audit trail of how the belief moved over time.',
      inputSchema: {
        type: 'object',
        properties: {
          claimId: { type: 'string', description: 'optional — a specific claim id to replay its belief history' },
          limit:   { type: 'number', description: 'max rows (default 50)' },
        },
      },
    },
  ];

  const handlers = {
    proposeClaim: async (args = {}) => {
      const content = String(args.content || '').trim();
      if (!content) return 'Error: content is required (phrase the tendency).';
      const dates = Array.isArray(args.day_card_dates)
        ? args.day_card_dates.filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim())
        : [];
      if (!dates.length) return 'Error: day_card_dates is required — a claim must be evidenced by the day cards that justify it.';

      const claimType = KNOWN_TYPES.has(args.claim_type) ? args.claim_type : null;
      const decayClass = KNOWN_DECAY.has(args.decay_class) ? args.decay_class : 'preference';
      const source = KNOWN_SOURCES.has(args.source) ? args.source : 'agent-inferred';
      let variability = null;
      if (typeof args.variability === 'number' && Number.isFinite(args.variability)) {
        variability = Math.min(1, Math.max(0, args.variability));
      }
      const contexts = Array.isArray(args.contexts)
        ? args.contexts.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim().slice(0, 80)).slice(0, 12)
        : [];

      let res;
      try {
        res = await distiller.distill({
          content: content.slice(0, 2000),
          claimType,
          decayClass,
          domain: (typeof args.domain === 'string' && args.domain.trim()) ? args.domain.trim().slice(0, 80) : null,
          source,
          dayCardDates: dates,
          variability,
          contextPrimary: (typeof args.context_primary === 'string' && args.context_primary.trim()) ? args.context_primary.trim().slice(0, 80) : null,
          contexts,
        });
      } catch { return 'Error: could not process the claim.'; }

      let status = null;
      try { status = (await db.claims.getById(userId, res.claimId))?.status ?? null; } catch { status = null; }
      const opWord = res.op === 'ADD' ? 'added' : res.op === 'UPDATE' ? 'corroborated' : (res.op || 'recorded').toLowerCase();
      const tail = status === 'active'
        ? ' — it has earned its place (active).'
        : status === 'pending'
          ? ' — held pending until enough distinct days of evidence accrue.'
          : '.';
      const sup = res.retracted?.length ? ` Superseded ${res.retracted.length} prior claim${res.retracted.length === 1 ? '' : 's'}.` : '';
      return `Claim ${opWord} (id ${res.claimId})${tail}${sup}`;
    },

    listClaimsHistory: async (args = {}) => {
      const limit = Number(args.limit) || 50;
      try {
        if (typeof args.claimId === 'string' && args.claimId.trim()) {
          const id = args.claimId.trim();
          const series = await db.claims.readSeries(userId, id, 'change', { limit });
          if (!series.length) return `No belief-history records for claim ${id}.`;
          return series
            .map((s) => `• [${(s.windowEnd || '').slice(0, 16)}] ${s.deltaKind || 'change'}  (confidence ${s.confidence == null ? '—' : s.confidence.toFixed(2)})${s.content ? `: ${s.content}` : ''}`)
            .join('\n');
        }
        const at = (now ? now() : new Date().toISOString());
        const claims = await db.claims.asOf(userId, at);
        if (!claims.length) return 'No current claims about your person yet.';
        const byDomain = new Map();
        for (const c of claims) {
          const k = c.domain || '(unsorted)';
          if (!byDomain.has(k)) byDomain.set(k, []);
          byDomain.get(k).push(c);
        }
        const lines = [];
        for (const [dom, cs] of byDomain) {
          lines.push(`## ${dom}`);
          for (const c of cs.slice(0, limit)) {
            const conf = sig(c.confidenceLogodds);
            const vary = c.variability == null ? '' : `, varies ${c.variability < 0.34 ? 'little' : c.variability > 0.66 ? 'widely' : 'some'}${c.contextPrimary ? ` with ${c.contextPrimary}` : ''}`;
            lines.push(`• ${c.content}  (${conf == null ? '—' : conf.toFixed(2)}${vary})`);
          }
        }
        return lines.join('\n');
      } catch { return 'Error: could not read the claim history.'; }
    },
  };

  return { tools, handlers };
}

export default createClaimsDistillDomain;

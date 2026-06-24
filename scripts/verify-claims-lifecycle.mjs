// scripts/verify-claims-lifecycle.mjs — Context Engine Phase 2b gate.
//
// The AGM belief-revision lifecycle + contradiction resolution, with the two reviewer rules:
//   C — confidence moves ONLY on observation evidence; agent-inferred restatement weighs ZERO.
//   A — promotion bar is config-default + decay_class-scaled; named retraction floor; boundary exempt.
import {
  decideOp, evidenceWeight, distinctDays, validFrom, shouldPromote, shouldRetire,
  updateConfidence, promoteLogodds, MIN_DISTINCT_DAYS,
} from '../src/claims/lifecycle.js';
import { resolveContradictions } from '../src/claims/resolve-contradictions.js';

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); } else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); } };

// ── AGM op selection ─────────────────────────────────────────────────────────
ok(decideOp({ relation: 'strong_conflict' }) === 'RETRACT', 'strong_conflict → RETRACT (close+open)');
ok(decideOp({ relation: 'weak_conflict' }) === 'WEAKEN', 'weak_conflict → WEAKEN (contraction)');
ok(decideOp({ relation: 'strong_support', isNew: true }) === 'ADD', 'new claim → ADD (born pending)');
ok(decideOp({ relation: 'strong_support', isNew: false }) === 'UPDATE', 'corroboration → UPDATE');
ok(decideOp({ relation: 'unrelated', isNew: false }) === 'NOOP', 'unrelated existing → NOOP');

// ── C — the propose/corroborate role split (THE one not to ship without) ─────
ok(evidenceWeight({ omega: 1.0, source: 'agent-inferred' }) === 0, 'agent-inferred evidence weighs ZERO (anti-self-anchoring)');
ok(evidenceWeight({ omega: 1.0, source: 'day-card' }) === 1.0, 'a day-card observation carries its weight');
ok(evidenceWeight({ omega: 1.0, source: 'user-stated' }) > 1.0, 'user-stated outweighs (source-priority)');
// the confidence update cannot move on the agent restating model.md:
const selfRestate = updateConfidence({ priorLogodds: 1.0, dtSeconds: 0, decayClass: 'identity', evidence: { omega: 1.0, source: 'agent-inferred' } });
ok(selfRestate.logodds === 1.0, 'updateConfidence: a self-restatement does NOT raise confidence');
const realObs = updateConfidence({ priorLogodds: 1.0, dtSeconds: 0, decayClass: 'identity', evidence: { omega: 1.0, source: 'day-card' } });
ok(realObs.logodds === 2.0, 'updateConfidence: a real observation DOES raise confidence');

// ── A — scaled promotion bar + named retraction floor ────────────────────────
ok(MIN_DISTINCT_DAYS.identity > MIN_DISTINCT_DAYS.mood, 'a trait (identity) needs MORE distinct days than a state (mood)');
// an identity claim at high confidence but only 3 days does NOT promote; a mood claim at 2 days does
ok(!shouldPromote({ confidenceLogodds: 2.0, decayClass: 'identity', distinctDays: 3 }), 'identity needs ≥5 days — 3 is not enough');
ok(shouldPromote({ confidenceLogodds: 2.0, decayClass: 'identity', distinctDays: 5 }), 'identity promotes at ≥5 days + over the bar');
ok(shouldPromote({ confidenceLogodds: 2.0, decayClass: 'mood', distinctDays: 2 }), 'a mood promotes on fewer days');
ok(!shouldPromote({ confidenceLogodds: 0.5, decayClass: 'mood', distinctDays: 9 }), 'under the log-odds bar → no promote regardless of days');
ok(shouldRetire({ confidenceLogodds: -1.0, decayClass: 'preference' }), 'a decayed preference retires below the floor');
ok(!shouldRetire({ confidenceLogodds: -5.0, decayClass: 'boundary' }), 'a boundary NEVER auto-retires (safety, λ=0)');
// config override
process.env.MYCELIUM_CLAIM_PROMOTE_LOGODDS = '3.0';
ok(promoteLogodds() === 3.0 && !shouldPromote({ confidenceLogodds: 2.0, decayClass: 'mood', distinctDays: 9 }), 'promotion bar is env-calibratable');
delete process.env.MYCELIUM_CLAIM_PROMOTE_LOGODDS;

// ── support helpers ──────────────────────────────────────────────────────────
const support = { day_card_dates: ['2026-06-18T20:00:00Z', '2026-06-18T08:00:00Z', '2026-06-19T03:00:00Z', null] };
ok(distinctDays(support) === 2, 'distinctDays counts distinct calendar days (two 6-18 entries = 1)');
ok(validFrom(support) === '2026-06-18T08:00:00Z', 'validFrom = earliest observation');

// ── contradiction resolution + source-priority ──────────────────────────────
function poolDb(claims) { return { claims: { listForMatch: async () => claims } }; }
const sim = (a, b) => (a === b ? 1.0 : (a && b ? 0.7 : 0)); // in-band when both present & different
const validateConflict = async () => ({ relation: 'strong_conflict', rationale: 'contradicts' });
{
  // an agent-inferred proposal conflicts with a user-stated claim → BLOCKED, no retraction
  const db = poolDb([{ id: 'x', status: 'active', embedding768: 'E', support: { source: 'user-stated' } }]);
  const r = await resolveContradictions({ db, userId: 'u', proposal: { content: 'p', embedding768: 'P', source: 'agent-inferred' }, similarity: sim, validate: validateConflict });
  ok(r.blocked === true && r.retractions.length === 0, 'agent-inferred cannot override a user-stated claim (source-priority)');
}
{
  // a user-stated proposal conflicts with an agent-inferred claim → RETRACT the old
  const db = poolDb([{ id: 'y', status: 'active', embedding768: 'E', support: { source: 'agent-inferred' } }]);
  const r = await resolveContradictions({ db, userId: 'u', proposal: { content: 'p', embedding768: 'P', source: 'user-stated', validFrom: '2026-06-19' }, similarity: sim, validate: validateConflict });
  ok(r.retractions.length === 1 && r.retractions[0].oldId === 'y', 'user-stated proposal retracts the conflicting inferred claim');
}
{
  // out-of-band (too similar = same claim, or too far = unrelated) → not "related", no conflict scan
  const db = poolDb([{ id: 'z', status: 'active', embedding768: 'P', support: {} }]); // sim=1.0 (dup, above band)
  const r = await resolveContradictions({ db, userId: 'u', proposal: { content: 'p', embedding768: 'P', source: 'agent-inferred' }, similarity: sim, validate: validateConflict });
  ok(r.related === 0 && r.retractions.length === 0, 'a duplicate (sim>band) is not treated as a contradiction');
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);

// scripts/verify-claims-distill.mjs — Context Engine Phase 2c gate.
//
// The day-card → claim distillation orchestration, end-to-end over the REAL db.claims (in-memory),
// with stubbed embed/validate/similarity. Proves: ADD born pending; promotion on enough distinct days
// scaled by decay_class; corroboration raises confidence ONLY from day-cards (C); contradiction
// retracts the old + links the successor (never deletes); the per-change log records each step.
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { createClaimsNamespace } from '../src/db/claims.js';
import { createDistiller } from '../src/claims/distill.js';

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); } else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); } };

function freshDb() {
  const db = new Database(':memory:'); applyMigrations(db);
  let n = 0;
  const d1Query = async (sql, params = []) => {
    const stmt = db.prepare(sql);
    if (/^\s*select/i.test(sql) || /returning/i.test(sql)) return { results: stmt.all(...params) };
    stmt.run(...params); return { results: [] };
  };
  const firstRow = (res) => (Array.isArray(res) ? res : res?.results || [])[0] || null;
  return { _db: db, claims: createClaimsNamespace({ d1Query, firstRow, randomUUID: () => `c${++n}` }) };
}
const days = (...d) => d.map((x) => `${x}T12:00:00Z`);
const embed = async (content) => content; // content IS the embedding key

// ── 1. ADD: a fact with 3 distinct days → pending then PROMOTED (3×0.6=1.8 ≥ bar, fact needs 3) ──
{
  const db = freshDb();
  const distiller = createDistiller({ db, userId: 'u', embed, similarity: () => 0, validate: async () => ({ relation: 'unrelated' }) });
  const r = await distiller.distill({ claimType: 'principle', decayClass: 'fact', content: 'tends to ship hardest when physically unwell', domain: 'Work & Creativity', source: 'agent-inferred', dayCardDates: days('2026-06-17', '2026-06-18', '2026-06-19') });
  const c = await db.claims.getById('u', r.claimId);
  ok(c && c.status === 'active', 'a fact backed by 3 distinct days is added + promoted to active');
  ok((await db.claims.believedAsOf('u', r.claimId, '2026-12-01')).deltaKind === 'promoted', 'the per-change log recorded the promotion');
}

// ── 2. ADD: an identity claim needs 5 distinct days — 3 → stays PENDING (CVP-gated) ─────────────
{
  const db = freshDb();
  const distiller = createDistiller({ db, userId: 'u', embed, similarity: () => 0, validate: async () => ({ relation: 'unrelated' }) });
  const r = await distiller.distill({ claimType: 'identity', decayClass: 'identity', content: 'is fundamentally a teacher', source: 'agent-inferred', dayCardDates: days('2026-06-17', '2026-06-18', '2026-06-19') });
  const c = await db.claims.getById('u', r.claimId);
  ok(c.status === 'pending', 'an identity claim with only 3 days stays pending (trait needs more states)');
  ok(!(await db.claims.asOf('u', '2026-06-19T00:00:00Z')).some((x) => x.id === r.claimId), 'the pending identity claim is excluded from getContext (CVP gate)');
}

// ── 3. UPDATE: corroborate a pending claim with more day-cards → confidence up → promote ────────
{
  const db = freshDb();
  // similarity: the same content = 1.0 (dup → UPDATE); else 0
  const sim = (a, b) => (a === b ? 1.0 : 0);
  const distiller = createDistiller({ db, userId: 'u', embed, similarity: sim, validate: async () => ({ relation: 'unrelated' }) });
  const a = await distiller.distill({ claimType: 'identity', decayClass: 'identity', content: 'is a teacher', source: 'agent-inferred', dayCardDates: days('2026-06-15', '2026-06-16') });
  ok((await db.claims.getById('u', a.claimId)).status === 'pending', 'first pass: pending (2/5 days)');
  // corroborate with 4 more distinct days → 6 total ≥ 5 → promote
  const b = await distiller.distill({ claimType: 'identity', decayClass: 'identity', content: 'is a teacher', source: 'agent-inferred', dayCardDates: days('2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20') });
  ok(b.claimId === a.claimId, 'the corroboration matched the SAME claim (UPDATE, not a new row)');
  ok((await db.claims.getById('u', a.claimId)).status === 'active', 'after enough corroborating days, it promotes');
}

// ── 4. CONTRADICTION: a user-stated proposal conflicts an inferred active claim → RETRACT old ───
{
  const db = freshDb();
  // seed an active, agent-inferred claim
  const seed = await db.claims.upsert({ userId: 'u', content: 'avoids conflict', claimType: 'personality', decayClass: 'identity', confidenceLogodds: 1.5, status: 'active', embedding768: 'avoids conflict', support: { source: 'agent-inferred' }, validFrom: '2026-01-01T00:00:00Z' });
  // proposal is RELATED-but-not-dup (sim 0.7, in band) and conflicts; source user-stated
  const sim = (a, b) => (a === b ? 1.0 : 0.7);
  const distiller = createDistiller({ db, userId: 'u', embed, similarity: sim, validate: async () => ({ relation: 'strong_conflict', rationale: 'opposite now' }) });
  const r = await distiller.distill({ claimType: 'personality', decayClass: 'identity', content: 'now names conflict directly', source: 'user-stated', dayCardDates: days('2026-06-18', '2026-06-19') });
  const old = await db.claims.getById('u', seed.id);
  ok(old.status === 'superseded' && old.supersededBy === r.claimId && old.validTo, 'the conflicting inferred claim is retracted + linked to the successor (never deleted)');
  ok(r.retracted.includes(seed.id), 'distill reports the retraction');
  ok((await db.claims.asOf('u', '2026-03-01T00:00:00Z')).some((x) => x.id === seed.id), 'the old claim WAS true in March (valid-time history preserved)');
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);

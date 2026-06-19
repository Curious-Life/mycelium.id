// scripts/verify-claims-bitemporal.mjs — Context Engine Phase 2a gate.
//
// Extends person_claims to a bi-temporal, distribution-aware claim. Verifies migration 0040, the
// structured distribution fields (B: variability + context_primary are real columns, not prose),
// valid-time asOf (incl. historical "what was true then"), per-change transaction-time + believedAsOf
// (D: gapless, not periodic), retract (close+link, never delete), promote, and the CVP pending gate.
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { createClaimsNamespace } from '../src/db/claims.js';

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); } else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); } };

const db = new Database(':memory:');
applyMigrations(db); applyMigrations(db); // idempotent

// ── 1. migration shape ───────────────────────────────────────────────────────
const cols = db.prepare('PRAGMA table_info(person_claims)').all().map((r) => r.name);
ok(['valid_from', 'valid_to', 'superseded_by', 'domain', 'variability', 'context_primary'].every((c) => cols.includes(c)), 'migration 0040 adds the 6 bi-temporal + distribution columns');
const variabilityType = db.prepare('PRAGMA table_info(person_claims)').all().find((r) => r.name === 'variability')?.type;
ok(variabilityType === 'REAL', 'variability is a structured REAL (queryable, not prose)', `(${variabilityType})`);
const idxs = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_claim%'").all().map((r) => r.name);
ok(idxs.includes('idx_claims_validity') && idxs.includes('idx_claim_changes'), 'validity + per-change indexes created');

// ── DAL over the real schema (raw d1Query; encryption is the adapter's job) ───
let n = 0;
const d1Query = async (sql, params = []) => {
  const stmt = db.prepare(sql);
  if (/^\s*select/i.test(sql) || /returning/i.test(sql)) return { results: stmt.all(...params) };
  stmt.run(...params); return { results: [] };
};
const firstRow = (res) => (Array.isArray(res) ? res : res?.results || [])[0] || null;
const claims = createClaimsNamespace({ d1Query, firstRow, randomUUID: () => `c${++n}` });

// ── 2. upsert stores the distribution fields ─────────────────────────────────
const a = await claims.upsert({ userId: 'u', content: 'tends to build under pressure', claimType: 'personality', decayClass: 'identity', confidenceLogodds: 1.4, domain: 'Work & Creativity', variability: 0.18, contextPrimary: 'Work & Creativity', validFrom: '2026-01-01T00:00:00Z', support: { day_cards: ['d1', 'd2', 'd3'], contexts: [{ domain: 'Work & Creativity', share: 0.7 }, { domain: 'Self & Inner Life', share: 0.3 }], source: 'agent-inferred' } });
const got = await claims.getById('u', a.id);
ok(got.variability === 0.18 && got.contextPrimary === 'Work & Creativity' && got.domain === 'Work & Creativity', 'distribution fields persist as structured values');
ok(got.validFrom === '2026-01-01T00:00:00Z', 'valid_from persists');
ok(Array.isArray(got.support.contexts) && got.support.contexts.length === 2, 'full context distribution rides support.contexts (structured, not prose)');

// ── 3. valid-time asOf ───────────────────────────────────────────────────────
ok((await claims.asOf('u', '2026-06-19T00:00:00Z')).some((c) => c.id === a.id), 'asOf(now) includes a currently-valid claim');
ok(!(await claims.asOf('u', '2025-06-01T00:00:00Z')).some((c) => c.id === a.id), 'asOf(before valid_from) excludes it');

// ── 4. CVP pending gate ──────────────────────────────────────────────────────
const p = await claims.upsert({ userId: 'u', content: 'maybe prefers mornings', claimType: 'preference', decayClass: 'preference', confidenceLogodds: 0.3, status: 'pending', validFrom: '2026-06-01T00:00:00Z' });
ok(!(await claims.asOf('u', '2026-06-19T00:00:00Z')).some((c) => c.id === p.id), 'pending claim is excluded from asOf (CVP gate)');
ok(!(await claims.listActive('u')).some((c) => c.id === p.id), 'pending claim is excluded from listActive');
await claims.promote('u', p.id);
ok((await claims.asOf('u', '2026-06-19T00:00:00Z')).some((c) => c.id === p.id), 'after promote, the claim surfaces');

// ── 5. retract = close + link, never delete ──────────────────────────────────
const succ = await claims.upsert({ userId: 'u', content: 'builds under pressure AND now rests deliberately', claimType: 'personality', decayClass: 'identity', confidenceLogodds: 1.5, validFrom: '2026-06-10T00:00:00Z' });
await claims.retract('u', a.id, { validTo: '2026-06-10T00:00:00Z', supersededBy: succ.id });
const retracted = await claims.getById('u', a.id);
ok(retracted.status === 'superseded' && retracted.validTo === '2026-06-10T00:00:00Z' && retracted.supersededBy === succ.id, 'retract closes valid_to + links superseded_by (row preserved)');
ok(!(await claims.asOf('u', '2026-06-19T00:00:00Z')).some((c) => c.id === a.id), 'the superseded claim is no longer true now');
ok((await claims.asOf('u', '2026-03-01T00:00:00Z')).some((c) => c.id === a.id), "but it WAS true in March (valid-time history preserved)");

// ── 6. per-change transaction-time (the D fix) ───────────────────────────────
await claims.recordChange({ userId: 'u', claimId: a.id, at: '2026-01-01T00:00:00Z', confidenceLogodds: 0.4, deltaKind: 'added' });
await claims.recordChange({ userId: 'u', claimId: a.id, at: '2026-04-01T00:00:00Z', confidenceLogodds: 1.4, deltaKind: 'corroborated' });
await claims.recordChange({ userId: 'u', claimId: a.id, at: '2026-06-10T00:00:00Z', confidenceLogodds: 0.0, deltaKind: 'retracted' });
const believedFeb = await claims.believedAsOf('u', a.id, '2026-02-15T00:00:00Z');
ok(believedFeb && believedFeb.deltaKind === 'added' && believedFeb.confidenceLogodds === 0.4, 'believedAsOf(Feb) replays the early belief (gapless, per-change)');
const believedMay = await claims.believedAsOf('u', a.id, '2026-05-01T00:00:00Z');
ok(believedMay && believedMay.deltaKind === 'corroborated', 'believedAsOf(May) replays the corroborated belief — intermediate state NOT lost');

db.close();
console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);

// scripts/verify-claims-distill-tool.mjs — Context Engine Phase 2c-wire gate.
//
// Proves the proposeClaim / listClaimsHistory TOOLS — the agent-facing wrapper around
// createDistiller — over the REAL db.claims (in-memory). The orchestration itself is already proven
// by verify-claims-distill; THIS gate proves the wiring that is new + risky:
//   - input validation (no content / no day cards → a clean error, no row written),
//   - the vector round-trip: embed → store a raw-float32 Buffer → DEFAULT sync similarity decodes it
//     back + cosines (same content → dup → UPDATE; orthogonal → ADD), with NO master key,
//   - born-pending + promote-on-distinct-days surfaced in the tool's reply,
//   - listClaimsHistory replays the per-change belief log + the current-tendencies view,
//   - validate stays OPTIONAL: absent → no retraction; supplied → a conflicting user-stated proposal
//     supersedes an inferred claim (never deletes), and the reply reports it.
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { createClaimsNamespace } from '../src/db/claims.js';
import { createClaimsDistillDomain } from '../src/tools/claims-distill.js';
import { encodeVectorRaw } from '../src/search/ann/decode.js';

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
const FIXED_NOW = '2026-07-01T00:00:00Z';

// A deterministic fake embedder: content → a one-hot raw-float32 Buffer (the at-rest format). Identical
// content → identical index → cosine 1.0 (a dup → UPDATE); different content → (almost surely) a
// different index → cosine 0.0 (→ ADD). This drives the REAL default similarity (Buffer decode+cosine).
function hashIdx(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 768; }
const oneHotBuf = (content) => { const v = new Float32Array(768); v[hashIdx(content)] = 1; return encodeVectorRaw(v); };
const embedOneHot = async (content) => oneHotBuf(content);
// A multi-hot embedder for the contradiction band test: content → indices → unit-ish vector so two
// claims can land in the related-but-not-duplicate cosine band (0.5–0.9).
const multiHot = (idxs) => { const v = new Float32Array(768); for (const i of idxs) v[i] = 1; return encodeVectorRaw(v); };

// ── 1. input validation: no content / no day cards → error, no row ──────────────────────────────
{
  const db = freshDb();
  const { tools, handlers } = createClaimsDistillDomain({ db, userId: 'u', embed: embedOneHot, now: () => FIXED_NOW });
  ok(tools.length === 2 && tools.map((t) => t.name).sort().join(',') === 'listClaimsHistory,proposeClaim', 'the domain registers proposeClaim + listClaimsHistory');
  const r1 = await handlers.proposeClaim({ content: '   ', day_card_dates: days('2026-06-19') });
  ok(/^Error/.test(r1), 'empty content → error', r1);
  const r2 = await handlers.proposeClaim({ content: 'tends to ship under pressure', day_card_dates: [] });
  ok(/^Error/.test(r2) && /day_card/.test(r2), 'no day cards → error (a claim must be evidenced)', r2);
  ok((await db.claims.asOf('u', FIXED_NOW)).length === 0, 'nothing was written on a rejected input');
}

// ── 2. ADD a fact w/ 3 distinct days → promotes; the reply says it earned its place ─────────────
{
  const db = freshDb();
  const { handlers } = createClaimsDistillDomain({ db, userId: 'u', embed: embedOneHot, now: () => FIXED_NOW });
  const r = await handlers.proposeClaim({
    content: 'tends to ship hardest under deadline pressure', claim_type: 'principle', decay_class: 'fact',
    domain: 'Work & Creativity', day_card_dates: days('2026-06-17', '2026-06-18', '2026-06-19'), source: 'agent-inferred',
  });
  const m = r.match(/id (c\d+)/); const id = m && m[1];
  ok(/added/.test(r) && /earned its place|active/.test(r), 'a fact with 3 distinct days is added + active', r);
  ok(id && (await db.claims.getById('u', id)).status === 'active', 'the claim row is active');
  ok((await db.claims.getById('u', id)).domain === 'Work & Creativity', 'the structured domain persisted');
}

// ── 3. identity needs 5 days → pending; corroborating with NEW days (real Buffer-cosine dup) promotes ──
{
  const db = freshDb();
  const { handlers } = createClaimsDistillDomain({ db, userId: 'u', embed: embedOneHot, now: () => FIXED_NOW });
  const a = await handlers.proposeClaim({ content: 'leans toward solo deep work', claim_type: 'identity', decay_class: 'identity', day_card_dates: days('2026-06-15', '2026-06-16', '2026-06-17') });
  const id = a.match(/id (c\d+)/)[1];
  ok(/pending/.test(a), 'identity with 3 days is held pending (trait needs more states)', a);
  ok(!(await db.claims.asOf('u', FIXED_NOW)).some((x) => x.id === id), 'the pending claim is excluded from the current view (CVP gate)');
  // same content → one-hot dup (cosine 1.0) → UPDATE the SAME row, +3 new days → 6 ≥ 5 → promote
  const b = await handlers.proposeClaim({ content: 'leans toward solo deep work', claim_type: 'identity', decay_class: 'identity', day_card_dates: days('2026-06-18', '2026-06-19', '2026-06-20') });
  ok(b.includes(`id ${id}`), 'corroboration matched the SAME claim via the Buffer-cosine round-trip (UPDATE, not a dup row)', b);
  ok((await db.claims.getById('u', id)).status === 'active', 'after enough corroborating distinct days, it promotes', b);
}

// ── 4. orthogonal content → a NEW claim (the default similarity does not false-match) ───────────
{
  const db = freshDb();
  const { handlers } = createClaimsDistillDomain({ db, userId: 'u', embed: embedOneHot, now: () => FIXED_NOW });
  const a = await handlers.proposeClaim({ content: 'finds energy in the early morning', decay_class: 'preference', day_card_dates: days('2026-06-18', '2026-06-19') });
  const b = await handlers.proposeClaim({ content: 'avoids scheduling calls back to back', decay_class: 'preference', day_card_dates: days('2026-06-18', '2026-06-19') });
  ok(a.match(/id (c\d+)/)[1] !== b.match(/id (c\d+)/)[1], 'two unrelated tendencies are distinct claims (no false dedup)');
}

// ── 5. listClaimsHistory: per-claim belief log + current-tendencies view ────────────────────────
{
  const db = freshDb();
  const { handlers } = createClaimsDistillDomain({ db, userId: 'u', embed: embedOneHot, now: () => FIXED_NOW });
  const r = await handlers.proposeClaim({ content: 'gravitates to hands-on building over planning', decay_class: 'fact', domain: 'Work & Creativity', day_card_dates: days('2026-06-17', '2026-06-18', '2026-06-19') });
  const id = r.match(/id (c\d+)/)[1];
  const hist = await handlers.listClaimsHistory({ claimId: id });
  // NB: add+promote stamp the same wall-clock ms in this in-memory burst, so the snapshot unique key
  // (…window_end…) collapses them to the latest — the documented same-ms DO-UPDATE (claims.js:218).
  // In production they land on different cycle runs/days. We assert the log reads + records the change.
  ok(/promoted|added/.test(hist) && /confidence/.test(hist), 'listClaimsHistory(claimId) replays the per-change belief log', hist.replace(/\n/g, ' | '));
  const cur = await handlers.listClaimsHistory({});
  ok(/Work & Creativity/.test(cur) && /gravitates to hands-on/.test(cur), 'listClaimsHistory() groups current tendencies by domain', cur.replace(/\n/g, ' | '));
}

// ── 6. validate is OPTIONAL — absent: no retraction; supplied: user-stated supersedes inferred ──
{
  // 6a — no validate (no infer): a conflicting proposal does NOT retract anything (safe default)
  const db = freshDb();
  const seedBuf = multiHot([10, 20, 30]);
  await db.claims.upsert({ userId: 'u', content: 'avoids conflict', claimType: 'personality', decayClass: 'identity', confidenceLogodds: 1.5, status: 'active', embedding768: seedBuf, support: { source: 'agent-inferred' }, validFrom: '2026-01-01T00:00:00Z' });
  const embedBand = async (content) => (content === 'names conflict directly now' ? multiHot([10, 20, 40]) : oneHotBuf(content)); // cosine 2/3 with the seed → in band
  const noValidate = createClaimsDistillDomain({ db, userId: 'u', embed: embedBand, now: () => FIXED_NOW });
  const rNo = await noValidate.handlers.proposeClaim({ content: 'names conflict directly now', claim_type: 'personality', decay_class: 'identity', day_card_dates: days('2026-06-18', '2026-06-19'), source: 'user-stated' });
  ok(!/Superseded/.test(rNo), 'without validate, a conflict supersedes nothing (no destructive retraction)', rNo);
  ok((await db.claims.getById('u', (await db.claims.listForMatch('u')).find((c) => c.content === 'avoids conflict').id)).status === 'active', 'the prior claim stays active when validate is off');

  // 6b — with validate: the same conflict, user-stated, supersedes the inferred claim (linked, not deleted)
  const db2 = freshDb();
  await db2.claims.upsert({ userId: 'u', content: 'avoids conflict', claimType: 'personality', decayClass: 'identity', confidenceLogodds: 1.5, status: 'active', embedding768: seedBuf, support: { source: 'agent-inferred' }, validFrom: '2026-01-01T00:00:00Z' });
  const seedId = (await db2.claims.listForMatch('u'))[0].id;
  const withValidate = createClaimsDistillDomain({ db: db2, userId: 'u', embed: embedBand, validate: async () => ({ relation: 'strong_conflict', rationale: 'opposite now' }), now: () => FIXED_NOW });
  const rYes = await withValidate.handlers.proposeClaim({ content: 'names conflict directly now', claim_type: 'personality', decay_class: 'identity', day_card_dates: days('2026-06-18', '2026-06-19'), source: 'user-stated' });
  const old = await db2.claims.getById('u', seedId);
  const newId = rYes.match(/id (c\d+)/)[1];
  ok(old.status === 'superseded' && old.supersededBy === newId && old.validTo, 'with validate, the inferred claim is superseded + linked to the user-stated successor (never deleted)', rYes);
  ok(/Superseded 1 prior/.test(rYes), 'the reply reports the supersession', rYes);
  ok((await db2.claims.asOf('u', '2026-03-01T00:00:00Z')).some((x) => x.id === seedId), 'the old claim WAS true in March (valid-time history preserved)');
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);

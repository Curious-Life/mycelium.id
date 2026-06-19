// scripts/verify-core-context.mjs — Context Engine 1c-B gate.
//
// getContext recompose: the bounded Core (self.md) LEADS the briefing; today's domain/register
// mix renders from the 1b labels; the claims block is kept but DEMOTED below the Core; a runaway
// Core is defensively trimmed. Plus: the domainMix GROUP BY is valid against the real 0031 schema.
import Database from 'better-sqlite3';
import { createContextDomain } from '../src/tools/context.js';
import { applyMigrations } from '../src/db/migrate.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

// ── getContext recompose (fake deps) ─────────────────────────────────────────
function makeDomain(files, { domainRows = [], claims = [] } = {}) {
  const db = {
    users: { getTimezone: async () => 'UTC' },
    messages: {
      domainMix: async () => domainRows,
      selectRecent: async () => [],
    },
    // Phase 2d: getContext reads the bi-temporal AS-OF view (currently-true claims), not listActive.
    claims: { asOf: async () => claims, listActive: async () => claims },
  };
  return createContextDomain({
    getDb: () => db,
    readMindFile: async (f) => files[f] ?? null,
    userId: 'u1',
  });
}

{
  const { handlers } = makeDomain(
    { 'self.md': '# Self (core)\n## Identity\n- Alice, founder.', 'model.md': '# My Understanding\n## Observations\n- lots of detail' },
    {
      domainRows: [
        { domain: 'Work & Creativity', register: 'Agency', count: 12 },
        { domain: 'Self & Inner Life', register: 'Resonance', count: 5 },
        { domain: '(unclassified)', register: '(unclassified)', count: 3 },
      ],
      claims: [{ id: 'c1', claimType: 'identity', domain: 'Work & Creativity', content: 'leans into building over planning', confidenceLogodds: 1.2, variability: 0.2 }],
    },
  );
  const out = await handlers.getContext({});
  const iCore = out.indexOf('# WHO YOU ARE (core');
  const iModel = out.indexOf('# YOUR INTERNAL MODEL');
  const iClaims = out.indexOf("WHAT YOU'VE NOTICED — TENDENCIES");
  ok(iCore !== -1, 'Core section renders');
  ok(iCore !== -1 && iModel !== -1 && iCore < iModel, 'Core LEADS the full internal model');
  ok(/TODAY'S SHAPE/.test(out) && /Work & Creativity \(12\)/.test(out), "today's shape renders the domain mix");
  ok(!/\(unclassified\) \(3\)/.test(out), 'unclassified noise dropped from the mix');
  ok(iClaims !== -1, 'claims rendered as bi-temporal TENDENCIES (asOf view)');
  ok(/leans into building over planning/.test(out) && /varies little/.test(out), 'a tendency renders with its variability, never as "is X"');
  ok(iCore < iClaims, 'claims block DEMOTED below the Core');
}

// missing self.md → no crash, no Core section (cold start)
{
  const { handlers } = makeDomain({ 'model.md': '# model' });
  const out = await handlers.getContext({});
  ok(!/# WHO YOU ARE/.test(out) && /# YOUR INTERNAL MODEL/.test(out), 'cold start: no self.md → briefing still works');
}

// runaway Core is defensively trimmed
{
  const huge = '# Self (core)\n' + 'x '.repeat(12000); // ~24k chars ≈ 6k tok, over the 1200 cap
  const { handlers } = makeDomain({ 'self.md': huge });
  const out = await handlers.getContext({ include: ['core'] });
  ok(/# WHO YOU ARE/.test(out), 'huge Core still renders');
  ok(out.length < huge.length / 2, 'huge Core is defensively trimmed', `(${out.length} < ${Math.round(huge.length / 2)})`);
}

// ── domainMix SQL is valid against the real 0031 schema ──────────────────────
{
  const db = new Database(':memory:');
  applyMigrations(db);
  const ins = db.prepare("INSERT INTO messages (id, user_id, content, created_at, domain, register) VALUES (?,?,?,?,?,?)");
  const now = new Date().toISOString();
  ins.run('m1', 'u1', 'a', now, 'Work & Creativity', 'Agency');
  ins.run('m2', 'u1', 'b', now, 'Work & Creativity', 'Agency');
  ins.run('m3', 'u1', 'c', now, 'Self & Inner Life', 'Resonance');
  ins.run('m4', 'u1', 'd', now, null, null); // unclassified
  const rows = db.prepare(
    `SELECT COALESCE(domain,'(unclassified)') AS domain, COALESCE(register,'(unclassified)') AS register, COUNT(*) AS count
       FROM messages WHERE user_id = ? AND forgotten_at IS NULL AND created_at >= ?
       GROUP BY domain, register ORDER BY count DESC`,
  ).all('u1', '2000-01-01T00:00:00Z');
  ok(rows[0].domain === 'Work & Creativity' && rows[0].count === 2, 'domainMix groups + counts (Work=2)');
  ok(rows.some((r) => r.domain === '(unclassified)' && r.count === 1), 'domainMix surfaces unclassified');
  db.close();
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);

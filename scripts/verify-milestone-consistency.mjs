// verify:milestone-consistency — regression guard for the 2026-06-19 live
// METRICS-AUDIT findings #1 (phantom `indeterminate` phase) and #2 (duplicate /
// contradictory milestones). Reproduces the EXACT shape seen on the live vault —
// header phase `cycling` while the milestone list carries 3 identical
// `phase_shift cycling→indeterminate` + 2 identical `sustained_cycling` across
// distinct clustering runs — and asserts the FIXED read path (src/db/fisher.js
// dedup + src/tools/fisher-tools.js consistency guard) collapses and reconciles
// them. Also asserts the FIXED compute path (pipeline/compute-fisher.py) never
// emits the phantom enum and never fires a phase_shift across a NULL gap.
// PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createFisherToolsDomain } from '../src/tools/fisher-tools.js';

const DB = 'data/verify-milestone-consistency.db', KCV = 'data/verify-milestone-consistency-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';
const PY = 'pipeline/.venv/bin/python3';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// ── Seed: the live "now" — realm weekly_step row reporting `cycling`. The
//    latest run-id here is what getCurrentPhase resolves the header phase from. ──
const RUN_NOW = 'era-2026-06-18T00:00:00.000Z';
const WIN = ['2026-06-08T00:00:00Z', '2026-06-15T00:00:00Z'];
await db.rawQuery(
  `INSERT INTO fisher_trajectory
     (user_id, level, window_type, window_start, window_end, activation_vector,
      phase, phase_recent, message_count, active_territory_count,
      clustering_run_id, low_confidence)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  [U, 'realm', 'weekly_step', WIN[0], WIN[1], JSON.stringify({ '1': 1 }),
   'cycling', 'cycling', 42, 3, RUN_NOW, 0],
);

// ── Seed milestones in the live shape. The fisher_milestones UNIQUE key
//    includes clustering_run_id, so each clustering run re-inserted the same
//    logical alert → N copies. detected_at DESC must keep the newest. ──
async function seedMilestone(rule, ws, pf, pt, run, detected, headline) {
  await db.rawQuery(
    `INSERT INTO fisher_milestones
       (user_id, rule_type, level, window_start, window_end, phase_from, phase_to,
        detail, headline, clustering_run_id, detected_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [U, rule, 'realm', ws, WIN[1], pf, pt, '{}', headline, run, detected],
  );
}
// 3 identical phantom phase_shifts (cycling → indeterminate) across 3 runs.
for (let k = 0; k < 3; k++) {
  await seedMilestone('phase_shift', WIN[0], 'cycling', 'indeterminate',
    `era-2026-06-1${5 + k}T00:00:00.000Z`, `2026-06-18 0${k}:00:00`,
    "You've moved from cycling into indeterminate.");
}
// 2 identical sustained_cycling across 2 runs.
for (let k = 0; k < 2; k++) {
  await seedMilestone('sustained_cycling', WIN[0], null, null,
    `era-2026-06-1${5 + k}T00:00:00.000Z`, `2026-06-18 0${k}:30:00`,
    'Cycling pattern starting — 2 consecutive weeks of high movement, low net displacement.');
}
// A real-but-contradictory phase_shift (→ exploring, while now = cycling).
await seedMilestone('phase_shift', '2026-05-25T00:00:00Z', 'cycling', 'exploring',
  RUN_NOW, '2026-06-10 00:00:00', "You've moved from cycling into exploring.");
// A real, consistent phase_shift (→ cycling, matching the current phase).
await seedMilestone('phase_shift', '2026-06-01T00:00:00Z', 'exploring', 'cycling',
  RUN_NOW, '2026-06-12 00:00:00', "You've moved from exploring into cycling.");

// ── Read path: db.fisher.getActiveMilestones must dedup across run-id. ──
const rawDeduped = await db.fisher.getActiveMilestones(U, { limit: 20 });
const phantomCount = rawDeduped.filter((m) => m.phase_to === 'indeterminate').length;
const phaseShiftPhantom = rawDeduped.filter((m) => m.rule_type === 'phase_shift' && m.phase_to === 'indeterminate').length;
const sustainedCount = rawDeduped.filter((m) => m.rule_type === 'sustained_cycling').length;
rec('M1. db dedup collapses run-id duplicates (3 phantom + 2 sustained → 1 each)',
  phaseShiftPhantom === 1 && sustainedCount === 1,
  `phantom_phase_shift=${phaseShiftPhantom} sustained=${sustainedCount} total=${rawDeduped.length}`);

// ── Tool formatter: the surfaced view drops phantom + contradictory shifts. ──
const fisher = createFisherToolsDomain({ db, userId: U });

const milestonesOut = await fisher.handlers.getActiveMilestones({});
rec('M2. surfaced milestones contain NO phantom `indeterminate`',
  !/indeterminate/i.test(milestonesOut), `hasPhantom=${/indeterminate/i.test(milestonesOut)}`);
rec('M3. surfaced milestones drop the contradictory cycling→exploring shift (now=cycling)',
  !/cycling → exploring/.test(milestonesOut), `hasContradiction=${/cycling → exploring/.test(milestonesOut)}`);
rec('M4. the consistent exploring→cycling shift survives (phase_to == current)',
  /exploring → cycling/.test(milestonesOut), `kept=${/exploring → cycling/.test(milestonesOut)}`);
rec('M5. sustained_cycling survives and appears exactly once',
  (milestonesOut.match(/sustained_cycling/g) || []).length === 1,
  `count=${(milestonesOut.match(/sustained_cycling/g) || []).length}`);

// ── getCurrentPhase: header phase must never contradict its own milestone. ──
const phaseOut = await fisher.handlers.getCurrentPhase({ level: 'realm' });
const headerCycling = /\*\*Phase\*\*: cycling/.test(phaseOut);
rec('M6. getCurrentPhase header is cycling AND its single milestone never says indeterminate',
  headerCycling && !/indeterminate/i.test(phaseOut),
  `header_cycling=${headerCycling} hasPhantom=${/indeterminate/i.test(phaseOut)}`);

// ── Compute path (pipeline/compute-fisher.py): the source of the phantom. ──
const pyScript = `
import importlib.util
spec = importlib.util.spec_from_file_location('cf', 'pipeline/compute-fisher.py')
cf = importlib.util.module_from_spec(spec); spec.loader.exec_module(cf)
assert cf.REAL_PHASES == frozenset({'stable','cycling','exploring','transforming'}), cf.REAL_PHASES
# A NULL recent-phase row between two cycling rows is a GAP — no phase_shift
# into/out of it, and certainly no 'indeterminate' anywhere.
gap = [
  {'phase':'cycling','low_confidence':False,'window_start':'2026-05-01','window_end':'2026-05-08','level':'realm','clustering_run_id':'r','fisher_velocity':0.1},
  {'phase':None,     'low_confidence':True, 'window_start':'2026-05-08','window_end':'2026-05-15','level':'realm','clustering_run_id':'r','fisher_velocity':0.1},
  {'phase':'cycling','low_confidence':False,'window_start':'2026-05-15','window_end':'2026-05-22','level':'realm','clustering_run_id':'r','fisher_velocity':0.1},
]
d_gap = cf.apply_milestone_rules(gap)
assert [d for d in d_gap if d['rule_type']=='phase_shift'] == [], d_gap
assert 'indeterminate' not in repr(d_gap), d_gap
# A real transition between two real phases still fires.
real = [
  {'phase':'cycling',  'low_confidence':False,'window_start':'2026-05-01','window_end':'2026-05-08','level':'realm','clustering_run_id':'r'},
  {'phase':'exploring','low_confidence':False,'window_start':'2026-05-08','window_end':'2026-05-15','level':'realm','clustering_run_id':'r'},
]
d_real = cf.apply_milestone_rules(real)
assert any(d['rule_type']=='phase_shift' and d['phase_from']=='cycling' and d['phase_to']=='exploring' for d in d_real), d_real
print('PYOK')
`;
const py = spawnSync(PY, ['-c', pyScript], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: 'pipeline' } });
rec('M7. compute-fisher.py: REAL_PHASES gate blocks gap shifts; real transitions still fire; no phantom',
  py.status === 0 && /PYOK/.test(py.stdout || ''),
  (py.stdout || '').trim().split('\n').pop() + (py.status !== 0 ? `\n      STDERR: ${(py.stderr || '').trim().split('\n').slice(-3).join(' | ')}` : ''));

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — phantom phase eliminated; milestones deduped + reconciled with current phase' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

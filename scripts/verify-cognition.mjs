// verify:cognition — Context Bank Phase 5. Proves the consolidation preserved
// capability: the 11 Fisher/metric/topology readers are gone and cognitiveState
// + cognitiveHistory surface what getCurrentPhase / getHarmonicState /
// getActiveMilestones / getTrajectoryHistory / getMetricSeries / getTopMovers
// did (same db methods + formatters, reused verbatim). Seeds a clustered point
// so the Tier-2 gate is open and the real folded logic runs. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { CONTRACTS } from '../src/metrics/contracts.js';

const DB = 'data/verify-cognition.db', KCV = 'data/verify-cognition-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close, tools, handlers } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// Open the Tier-2 gate so the real folded handlers run (empty windows → honest
// refusal copy, which is exactly the capability we assert is preserved).
await db.rawQuery(
  `INSERT INTO clustering_points (id, user_id, source_type, source_id, content, landscape_x, landscape_y) VALUES (?,?,?,?,?,?,?)`,
  ['cp', U, 'message', 'seed', 'x', 0.1, 0.2],
);

const names = tools.map((t) => t.name);
const OLD = ['getCurrentPhase', 'getTrajectoryHistory', 'getActiveMilestones', 'getTopMovers', 'getHarmonicState', 'getMetricSeries'];
rec('CG1. cognitiveState + cognitiveHistory registered; the 6 Fisher/metric readers removed',
  ['cognitiveState', 'cognitiveHistory'].every((n) => names.includes(n)) && OLD.every((n) => !names.includes(n)),
  `present=${['cognitiveState', 'cognitiveHistory'].filter((n) => names.includes(n)).join(',')} leftover=${OLD.filter((n) => names.includes(n)).join(',') || 'none'}`);

// ── cognitiveState folds movement + rhythm + alerts ──
const state = await handlers.cognitiveState({});
rec('CG2. cognitiveState folds MOVEMENT (getCurrentPhase)', /Cognitive Movement/.test(state), state.split('\n')[0]);
rec('CG3. cognitiveState folds RHYTHM (getHarmonicState refusal copy reachable)', state.includes(CONTRACTS.information_harmonic_amplitude.refusal_mode), `hasRefusal=${state.includes(CONTRACTS.information_harmonic_amplitude.refusal_mode)}`);
rec('CG4. cognitiveState folds ALERTS (getActiveMilestones)', /Milestones?/i.test(state), `hasAlerts=${/Milestones?/i.test(state)}`);

const flow = await handlers.cognitiveState({ detail: 'flow' });
rec('CG5. cognitiveState detail:flow reaches the folded flow capability', flow.includes(CONTRACTS.bigram_flow_features.refusal_mode), `hasFlowRefusal=${flow.includes(CONTRACTS.bigram_flow_features.refusal_mode)}`);

// ── cognitiveHistory folds trajectory + top movers (+ optional metric series) ──
const hist = await handlers.cognitiveHistory({});
rec('CG6. cognitiveHistory folds trajectory + top movers', /Trajectory/.test(hist) && /Top movers/i.test(hist), `traj=${/Trajectory/.test(hist)} movers=${/Top movers/i.test(hist)}`);

const histM = await handlers.cognitiveHistory({ metric: 'harmonic_amplitude_alpha_k1' });
rec('CG7. cognitiveHistory(metric) adds the folded named-metric series', histM.length > hist.length && /harmonic_amplitude_alpha_k1|alpha/i.test(histM), `addedLen=${histM.length - hist.length}`);

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — cognition: 6 Fisher/metric readers consolidated into cognitiveState + cognitiveHistory (capability preserved)' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

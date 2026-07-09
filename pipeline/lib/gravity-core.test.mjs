// Run: node pipeline/lib/gravity-core.test.mjs   (also: npm run verify:gravity)
import {
	ymToIndex, latestMonth, recencyScore, combineGravity, clamp
} from './gravity-core.js';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : (fail++, console.error(`  ✗ ${n} ${e}`)); };
const approx = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

// --- ymToIndex / latestMonth ---
ok('ymToIndex diff = 12 for a year', ymToIndex('2025-01') - ymToIndex('2024-01') === 12);
ok('ymToIndex malformed → 0', ymToIndex('nope') === 0);
ok('latestMonth picks max', latestMonth([[{month:'2020-03',count:1}], [{month:'2024-11',count:1}]]) === '2024-11');
ok('latestMonth empty → null', latestMonth([]) === null);

// --- recencyScore ---
// all activity at the ref month → recency 1
ok('recency all-recent = 1', approx(recencyScore([{month:'2025-06',count:10}], '2025-06', 12), 1));
// all activity 12 months old → exp(-1) ≈ 0.3679
ok('recency 12mo old ≈ e^-1', approx(recencyScore([{month:'2024-06',count:5}], '2025-06', 12), Math.exp(-1), 1e-3));
// empty timeline → 0
ok('recency empty = 0', recencyScore([], '2025-06') === 0);
// split: half now, half 12mo old → (1 + e^-1)/2
ok('recency split', approx(recencyScore([{month:'2025-06',count:5},{month:'2024-06',count:5}], '2025-06', 12), (1+Math.exp(-1))/2, 1e-3));
// recent-heavy scores higher than old-heavy (same mass)
const rNew = recencyScore([{month:'2025-05',count:8},{month:'2025-06',count:8}], '2025-06', 12);
const rOld = recencyScore([{month:'2019-01',count:8},{month:'2019-02',count:8}], '2025-06', 12);
ok('recent > old', rNew > rOld && rNew > 0.9 && rOld < 0.1, `new=${rNew} old=${rOld}`);

// --- combineGravity: mass primary, recency/centrality modulate; normalization ---
// Two territories, equal mass, but A is recent+central, B is old+isolated.
const terrs = [
	{ id: 1, realmId: 10, themeId: 100, mass: 0.5, recency: 1.0, centrality: 1.0 },
	{ id: 2, realmId: 10, themeId: 101, mass: 0.5, recency: 0.0, centrality: 0.0 },
];
const g = combineGravity(terrs);
const A = g.territory.get(1), B = g.territory.get(2);
// A raw = 0.5·1·1 = 0.5 ; B raw = 0.5·0.4·0.4 = 0.08
ok('A gravity = 1 (max)', approx(A.gravity, 1), `${A.gravity}`);
ok('B gravity = 0.16 (0.08/0.5)', approx(B.gravity, 0.16), `${B.gravity}`);
ok('shares sum to 1', approx(A.gravity_share + B.gravity_share, 1), `${A.gravity_share+B.gravity_share}`);
ok('A share > B share', A.gravity_share > B.gravity_share);
ok('A heavier despite equal mass', A.gravity > B.gravity);

// --- realm aggregation: both territories in realm 10 → realm mass 1.0 ---
ok('one realm aggregated', g.realm.size === 1);
const R = g.realm.get(10);
ok('realm gravity = 1 (only realm)', approx(R.gravity, 1));
ok('realm share = 1', approx(R.gravity_share, 1));
// realm recency = mass-weighted mean = (1·0.5 + 0·0.5)/1 = 0.5 ; same centrality
// realm raw = 1.0 · (0.4+0.6·0.5) · (0.4+0.6·0.5) = 1 · 0.7 · 0.7 = 0.49 (only realm → gravity 1)
ok('two themes aggregated', g.theme.size === 2);

// --- mass dominates: a huge-mass isolated old cluster still outweighs a tiny recent hub ---
const terrs2 = [
	{ id: 1, realmId: 1, themeId: 1, mass: 0.9, recency: 0.1, centrality: 0.1 }, // huge, stale, isolated
	{ id: 2, realmId: 2, themeId: 2, mass: 0.1, recency: 1.0, centrality: 1.0 }, // tiny, hot, central
];
const g2 = combineGravity(terrs2);
// raw1 = 0.9·0.46·0.46 = 0.1904 ; raw2 = 0.1·1·1 = 0.1
ok('mass stays primary (big-stale > tiny-hot)', g2.territory.get(1).gravity > g2.territory.get(2).gravity,
	`${g2.territory.get(1).gravity} vs ${g2.territory.get(2).gravity}`);

// --- degenerate: empty input ---
const g3 = combineGravity([]);
ok('empty → empty maps', g3.territory.size === 0 && g3.realm.size === 0 && g3.theme.size === 0);

// --- null realm/theme ids are skipped in aggregation, kept at territory level ---
const g4 = combineGravity([{ id: 1, realmId: null, themeId: null, mass: 1, recency: 1, centrality: 1 }]);
ok('null-group territory still scored', g4.territory.get(1).gravity === 1);
ok('null realm not grouped', g4.realm.size === 0);

// --- cross-realm theme collision: realm-local theme_id must NOT merge across realms ---
const g5 = combineGravity([
	{ id: 1, realmId: 1, themeId: 5, mass: 0.6, recency: 1, centrality: 1 },
	{ id: 2, realmId: 2, themeId: 5, mass: 0.4, recency: 1, centrality: 1 },
]);
ok('cross-realm same theme_id stays separate', g5.theme.size === 2, `size=${g5.theme.size}`);
const themeVals = [...g5.theme.values()];
ok('theme entries carry realmId + themeId', themeVals.every((v) => v.themeId === 5 && (v.realmId === 1 || v.realmId === 2)));
ok('both realms represented once', new Set(themeVals.map((v) => v.realmId)).size === 2);
// same realm, distinct theme_ids → two themes; same realm+theme across territories → merged
const g6 = combineGravity([
	{ id: 1, realmId: 7, themeId: 1, mass: 0.3, recency: 1, centrality: 1 },
	{ id: 2, realmId: 7, themeId: 1, mass: 0.3, recency: 1, centrality: 1 },
	{ id: 3, realmId: 7, themeId: 2, mass: 0.4, recency: 1, centrality: 1 },
]);
ok('same realm+theme merges, distinct theme splits', g6.theme.size === 2, `size=${g6.theme.size}`);

console.log(`\ngravity-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

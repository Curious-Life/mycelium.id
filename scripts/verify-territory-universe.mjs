// verify:territory-universe — the renderer, the naming counter and the naming writer must resolve
// the SAME set of territories.
//
// THE DEFECT (QA9, operator 2026-07-27): "naming territories is still getting territory 1089 etc
// as the names … looks like there is some error in the name saving."
//
// There was no error in the name saving. Three code paths asked "which territories exist?" and
// the RENDERER disagreed with the other two:
//
//   naming-status (the count)   DISTINCT territory_id FROM clustering_points   portal-mindscape.js:786-792
//   describe-clusters (writer)  DISTINCT territory_id FROM clustering_points   describe-clusters.js:214-217
//   the renderer                territory_profiles WHERE dissolved_at IS NULL  db/mindscape.js:80 — NO JOIN
//
// A profile row that is not dissolved but has no surviving points was RENDERED, never visited by
// the naming job, and never counted by naming-status. It displayed as `Territory {id}` forever
// while the naming card truthfully reported "all named" — both statements true, about different
// sets. The operator's id (1089, against ~50 areas) is an orphan from an earlier clustering
// generation.
//
// ⚠️ WHY NOT FIXED IN cluster.py. That was the first plan, and reading the code refuted it:
// cluster.py ALREADY dissolves point-less territories (:1951-1970) — but DEFERS the whole prune
// whenever a re-embed backlog exists (:1946-1950), deliberately, so a re-import window cannot
// dissolve a territory whose points are transiently absent. On an importing vault that deferral
// can hold indefinitely. Dissolution is correct AND permanently incomplete; the renderer cannot
// rely on it. Nor can such a territory simply be NAMED: describe-clusters samples members from
// clustering_points, so a territory with no points has nothing to describe.
//
//   T1  an orphan profile (no live points) is NOT rendered, and the count is reported
//   T2  a healthy territory IS rendered — the filter must not eat real areas
//   T3  §3.2a: an EMPTY points bundle does not delete the user's territories (we cannot tell
//       "no map" from "failed read")
//   T4  §3.2a: a TRUNCATED bundle (points hit POINTS_LIMIT) does not delete them either — a
//       territory may be absent only because the fetch stopped
//   T5  POINTS_LIMIT has ONE definition, shared by the fetcher and the filter
//
// MUTATION-TESTED: removed the orphan filter (restoring the shipped bug) → T1 REDs, the orphan is
//   rendered.
// MUTATION-TESTED: dropped the `bundleUsable` guard so the filter also ran on an empty bundle →
//   T3 REDs (every territory deleted from a vault whose points failed to load).
// MUTATION-TESTED: dropped the truncation half of the guard → T4 REDs.
// MUTATION-TESTED: weakened `count > 0` to `entry != null` → T6 REDs.
//   ⚠️ This mutation initially caught NOTHING: every fixture gave the orphan a MISSING entry, so
//   both readings agreed on every case tested, and the gate applauded a weakened predicate. T6
//   (a centroid entry with count 0) is the case that separates them, and it exists because the
//   mutation round found the hole — not because it was designed in.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { readFileSync } from 'node:fs';
import { POINTS_LIMIT } from '../src/db/mindscape.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// Drives the REAL predicates (src/mindscape-territory-universe.js) directly — behaviour, not a
// string match on the route. The first version of this gate extracted the expressions from
// portal-mindscape.js with a regex, which meant ANY edit to the filter REDed it with "extraction
// failed" while proving nothing about what the filter does. Pure functions are what make a
// behavioural gate possible; that is why they were lifted out.
import { isBundleUsable, isRenderableTerritory } from '../src/mindscape-territory-universe.js';
import { readFileSync as _rf } from 'node:fs';

function render({ profiles, centroids, total }) {
  const bundleUsable = isBundleUsable(centroids, total, POINTS_LIMIT);
  const rendered = [];
  let orphaned = 0;
  for (const tp of profiles) {
    if (!isRenderableTerritory(centroids[tp.territory_id], bundleUsable)) { orphaned++; continue; }
    rendered.push(tp.territory_id);
  }
  return { rendered, orphaned, bundleUsable };
}

// The route must actually USE them — a pure predicate nothing calls is decoration.
const routeSrc = _rf('src/portal-mindscape.js', 'utf8');
const wired = /isBundleUsable\(territoryCentroids/.test(routeSrc)
  && /if \(!isRenderableTerritory\(c, bundleUsable\)\)/.test(routeSrc);

const HEALTHY = { territory_id: 7 };
const ORPHAN = { territory_id: 1089 };            // the operator's id
const LIVE = { 7: { x: 1, y: 1, z: 1, count: 42 } };

// ── T1: the orphan is not rendered ───────────────────────────────────────────
{
  const r = render({ profiles: [HEALTHY, ORPHAN], centroids: LIVE, total: 42 });
  rec('T1. a profile with NO live points is not rendered, and the count is reported',
    !r.rendered.includes(1089) && r.orphaned === 1,
    `rendered=[${r.rendered}] orphaned=${r.orphaned}`);
}

// ── T2: a healthy territory survives ─────────────────────────────────────────
{
  const r = render({ profiles: [HEALTHY, ORPHAN], centroids: LIVE, total: 42 });
  rec('T2. a territory WITH live points is still rendered (the filter does not eat real areas)',
    r.rendered.includes(7),
    `rendered=[${r.rendered}]`);
}

// ── T3: an empty bundle must not delete everything ───────────────────────────
// The §3.2a rule, one surface over: a failed READ is "couldn't look", never "it's empty".
{
  const r = render({ profiles: [HEALTHY, ORPHAN], centroids: {}, total: 0 });
  rec('T3. an EMPTY points bundle does not delete the user\'s territories (failed read ≠ empty map)',
    r.rendered.length === 2 && r.bundleUsable === false,
    `rendered=[${r.rendered}] bundleUsable=${r.bundleUsable}`);
}

// ── T4: a truncated bundle must not delete anything either ───────────────────
{
  const r = render({ profiles: [HEALTHY, ORPHAN], centroids: LIVE, total: POINTS_LIMIT });
  rec('T4. a TRUNCATED bundle (points hit POINTS_LIMIT) does not delete territories',
    r.rendered.length === 2 && r.bundleUsable === false,
    `total=${POINTS_LIMIT} rendered=[${r.rendered}] bundleUsable=${r.bundleUsable}`);
}

// ── T6: a centroid ENTRY with a zero count is not evidence of life ───────────
// ⚠️ ADDED BECAUSE THE MUTATION ROUND EXPOSED A HOLE. Weakening the predicate from
// `count > 0` to `entry != null` did NOT RED any check: the fixtures only ever had a MISSING
// entry for the orphan, so the two readings agreed on every case tested. The distinction is
// D-014's exactly — presence of a record is not evidence of liveness — and defensive code that
// no check exercises is the code that rots. This is the case that separates them.
{
  const r = render({ profiles: [HEALTHY, ORPHAN], centroids: { ...LIVE, 1089: { x: 0, y: 0, z: 0, count: 0 } }, total: 42 });
  rec('T6. a centroid ENTRY with count 0 does not count as alive (presence ≠ liveness)',
    !r.rendered.includes(1089) && r.rendered.includes(7) && r.orphaned === 1,
    `rendered=[${r.rendered}] orphaned=${r.orphaned}`);
}

// ── T5: one definition of the cap, and the route really uses the predicates ──
const dbSrc = readFileSync('src/db/mindscape.js', 'utf8');
const src = routeSrc;
const exported = /export const POINTS_LIMIT = (\d+);/.exec(dbSrc)?.[1];
const usesConst = /getPoints\(userId, limit = POINTS_LIMIT\)/.test(dbSrc);
const importsConst = /import \{ POINTS_LIMIT \} from '\.\/db\/mindscape\.js';/.test(src);
rec('T5. POINTS_LIMIT has ONE definition, and the aggregate really calls the shared predicates',
  exported && usesConst && importsConst && Number(exported) === POINTS_LIMIT && wired,
  `exported=${exported} fetcherUses=${usesConst} aggregateImports=${importsConst} predicatesWired=${wired}`);

const allPass = ledger.every(Boolean);
console.log('');
console.log(allPass
  ? 'VERDICT: GO — the renderer resolves the same territory universe as the naming counter and the\n'
    + '        naming writer: a profile with no live points is not shown, real areas are untouched,\n'
    + '        and neither an empty nor a truncated bundle can delete a user\'s territories.\n'
    + '        NOT PROVEN: that any territory is correctly NAMED — verify:illuminate-naming owns that.'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(allPass ? 0 : 1);

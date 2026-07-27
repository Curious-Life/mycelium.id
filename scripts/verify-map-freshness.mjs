// verify:map-freshness — P8b. The MapFreshness card is retired, and all THREE of the things the
// operator asked for shipped together.
//
// THE DEFECT (operator, QA9 v0.1.14), which was three asks in one breath:
//   1. "it shouldnt say conversations, it should say points"
//   2. "i want us to not have that section"
//   3. "and to instead rebuild it automatically when there are new points"
//
// ⚠️ THIS GATE EXISTS BECAUSE (2) ALONE IS A REGRESSION. Deleting the card without (3) removes the
// user's only manual rebuild trigger — which is D-004 symptom 2 verbatim ("it shows me a text
// saying map already built; pass ?force=1 to rebuild. this i cant do from the UI as a user"), a
// defect that already recurred once. The three are therefore asserted as ONE unit: a tree where
// the section is gone but the auto-rebuild or the ↻ is missing must be RED, not green.
//
// The underlying bug behind (1) was a CATEGORY ERROR, not a contradiction. The card rendered
// "{embedded} conversations ready · {mapped} on the map" — `messages` with an embedding_768 next to
// `clustering_points` with a landscape_x, two different tables in one sentence. cluster.py does not
// emit one point per embedded message, so "0 conversations ready · 1014 on the map" was two correct
// numbers that must never have been printed side by side as if comparable.
//
//   F1  the section is GONE — no component, no import, no mount
//   F2  the cluster row names its unit ("points"), and the old fused sentence exists nowhere
//   F3  ⭐ the REMEDY SURVIVED the deletion: a ↻ rebuild control on every BUILT map (not only a
//       stale one), wired to the generate lifecycle rather than the enrichment routes
//   F4  ⭐ the auto-rebuild is EDGE-triggered off the server's `stale`, and seeded so it cannot
//       double-fire with the load-path auto-generate
//   F5  ⭐ TERMINATION: the client keys on the SAME evaluateFreshness() the generate route's
//       debounce uses. A second, drifting notion of "stale" would fire rebuilds the route skips
//   F6  the server emits the freshness on the cluster stage, and pays NO new query for it
//   F7  drift is described in its own words — never subtracted from or paired with the point count
//
// ⚠️ THIS GATE'S OWN F2 WAS GREEN FOR THE WRONG REASON, AND MUTATION-TESTING IS THE ONLY REASON
// ANYONE KNOWS. The first version asserted "a STAGE_UNIT map exists in the component" and
// "stage.key is passed to countText". Gutting the function body to `return done;` left BOTH true:
// the row rendered a bare "1,014" — precisely the ambiguity the operator asked us to remove — and
// the gate reported GO. That is D-014's defect (a substring test standing in for a behavioural one)
// committed inside the gate written to prevent it, which is the third time this repo has produced
// that exact shape. The fix was to extract countText/driftNote to $lib/stage-count so F2 and F7 can
// IMPORT and DRIVE them. A source that mentions a unit and a function that returns one are
// different claims, and only a gate that runs the code can tell them apart.
//
// MUTATION-TESTED: re-added `<MapFreshness />` to MindscapeDetail → F1 REDs.
// MUTATION-TESTED: re-added the `import MapFreshness from './MapFreshness.svelte'` line → F1 REDs.
// MUTATION-TESTED: gutted countText's body to `return done;` → F2 REDs. (Under the ORIGINAL
//   source-matching F2 this same mutation was GREEN — see the note above.)
// MUTATION-TESTED: dropped the singular case so a one-point map reads "1 points" → F2 REDs.
// MUTATION-TESTED: narrowed canRebuild to `stage.stale === true` (the tempting "only show it when
//   it is needed") → F3 REDs. That is the shape of the original D-004 defect: a remedy behind a
//   condition the user cannot verify.
// MUTATION-TESTED: deleted the whole canRebuild block → F3 REDs — this is the exact
//   delete-the-section-without-the-escape-hatch regression the sprint handoff warned about.
// MUTATION-TESTED: changed the auto-rebuild guard from the false→true edge to a bare level test
//   (`if (!stale) return;`) → F4 REDs. On a vault whose pipeline cannot cluster, a level test
//   re-fires on every poll forever; the edge test fires once and stops.
// MUTATION-TESTED: dropped the `prev === null` seeding return → F4 REDs (a stale-on-open page would
//   POST generate twice — once from the load path, once from here).
// MUTATION-TESTED: made `staleSeen` a reactive `$state` → F4 REDs. A latch the effect writes becomes
//   a dependency of that effect — the literal D-028 re-entry mechanism, 18,000 renders a second.
// MUTATION-TESTED: replaced readiness.js's evaluateFreshness() call with an inline
//   `stale: embedded > points, drift: embedded - points` → F5 AND F6 RED. This is the one that
//   matters most: it LOOKS right, it even sets the flag more often, and it would arm an automatic
//   rebuild that POST /generate then declines to run — an invisible loop of no-op requests on every
//   poll, plus a "drift" subtracting two different tables from each other.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { readFileSync, existsSync } from 'node:fs';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
/** Strip HTML/JS comments so a RATIONALE comment can never satisfy a MARKUP assertion.
 *  (verify:mindscape-loading L4 went red on a clean tree for exactly this — its own comment
 *  named the component it was forbidding.) */
const stripComments = (s) => s
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const DETAIL = 'portal-app/src/lib/components/mindscape/MindscapeDetail.svelte';
const STATUS = 'portal-app/src/lib/components/mindscape/PipelineStatus.svelte';
const VIEW = 'portal-app/src/lib/views/MindscapeView.svelte';
const READINESS = 'src/readiness.js';

const detail = stripComments(read(DETAIL));
const status = read(STATUS);
const statusCode = stripComments(status);
const view = stripComments(read(VIEW));
const readiness = stripComments(read(READINESS));

// ── F1: the section is gone ──────────────────────────────────────────────────
{
  const componentGone = !existsSync('portal-app/src/lib/components/mindscape/MapFreshness.svelte');
  const importGone = !/import\s+MapFreshness/.test(detail);
  const mountGone = !/<MapFreshness\s*\/?>/.test(detail);
  rec('F1. the MapFreshness section is gone — component, import and mount',
    componentGone && importGone && mountGone,
    `component=${componentGone} import=${importGone} mount=${mountGone}`);
}

// ── F2: ⭐ the row names its unit — DRIVEN, not pattern-matched ─────────────
// ⚠️ THIS CHECK WAS A SUBSTRING TEST AND MUTATION-TESTING KILLED IT. The first version asserted
// "a STAGE_UNIT map exists" and "stage.key is passed to countText" — both of which stayed true
// when the function body was gutted to `return done;`. The row rendered a bare "1,014", i.e. the
// exact ambiguity the operator asked us to remove, and the gate said GO. A source that MENTIONS a
// unit and a function that RETURNS one are different claims; only the second one is the fix.
// countText/driftNote were extracted to $lib/stage-count for this reason, so the gate can run them.
{
  const { countText, driftNote, STAGE_UNIT } = await import('../portal-app/src/lib/stage-count.ts');
  const cases = [
    [{ done: 1014 }, 'cluster', '1,014 points'],
    [{ done: 1 }, 'cluster', '1 point'],           // singular, because "1 points" is a tell
    [{ done: 0 }, 'cluster', '0 points'],
    [{ done: 3200, total: 76000 }, 'embed', '3,200 / 76,000'],  // a ratio takes no noun
    [{ done: 42 }, 'embed', '42'],                 // no unit registered ⇒ bare count, unchanged
    [undefined, 'cluster', ''],
  ];
  const bad = cases.filter(([c, k, want]) => countText(c, k) !== want);
  const unitMapped = STAGE_UNIT.cluster === 'point';
  const passesKey = /countText\(stage\.count,\s*stage\.key\)/.test(statusCode);
  rec('F2. ⭐ countText really RETURNS the unit — driven with real inputs, not matched in source',
    bad.length === 0 && unitMapped && passesKey,
    bad.length
      ? bad.map(([c, k, w]) => `${JSON.stringify(c)}/${k} → ${JSON.stringify(countText(c, k))} (want ${JSON.stringify(w)})`).join(' · ')
      : `${cases.length} cases · unitMapped=${unitMapped} keyPassed=${passesKey}`);
}

// ── F2b: the retired sentence is gone from the tree ─────────────────────────
{
  const stale = /conversations?\s+ready/i;
  const offenders = [DETAIL, STATUS, VIEW].filter((f) => stale.test(stripComments(read(f))));
  rec('F2b. the fused "N conversations ready · N on the map" sentence survives nowhere',
    offenders.length === 0,
    offenders.length ? offenders.join(',') : 'none');
}

// ── F3: ⭐ the remedy survived the deletion ──────────────────────────────────
{
  // Present on every BUILT map — keyed on state === 'done', NOT on staleness.
  const predicate = /const canRebuild = \(stage: Stage\) =>\s*stage\.key === 'cluster' && stage\.state === 'done'/.test(statusCode);
  const notStaleGated = !/canRebuild[\s\S]{0,160}stage\.stale/.test(statusCode);
  const rendered = /\{#if canRebuild\(stage\)\}/.test(statusCode);
  const wired = /onclick=\{onRebuild\}/.test(statusCode) && /await rebuild\(\)/.test(statusCode);
  // and it must be the GENERATE lifecycle, not an enrichment route that has no cluster arm
  const rightRoute = !/enrichment\/\$\{?['"]?cluster/.test(statusCode);
  rec('F3. ⭐ the ↻ rebuild survived the deletion — on every BUILT map, wired to the generate lifecycle',
    predicate && notStaleGated && rendered && wired && rightRoute,
    `predicate=${predicate} notStaleGated=${notStaleGated} rendered=${rendered} wired=${wired} route=${rightRoute}`);
}

// ── F4: ⭐ edge-triggered auto-rebuild, seeded ───────────────────────────────
{
  const readsStale = /const stale = cluster\?\.stale === true/.test(view);
  // The edge test: fire only when it WAS false and IS now true.
  const edge = /if \(!stale \|\| prev\) return;/.test(view);
  const seeded = /if \(prev === null\) return;/.test(view);
  const plainLet = /let staleSeen: boolean \| null = null;/.test(view) && !/\$state[^\n]*staleSeen/.test(view);
  const guardsInFlight = /phase === 'running'[\s\S]{0,80}return;[\s\S]{0,120}rebuildGen\(\)/.test(view);
  const fires = /void rebuildGen\(\)/.test(view);
  rec('F4. ⭐ the auto-rebuild is EDGE-triggered, seeded from the first observation, and skips a run in flight',
    readsStale && edge && seeded && plainLet && fires && guardsInFlight,
    `stale=${readsStale} edge=${edge} seeded=${seeded} plainLet=${plainLet} fires=${fires} inFlight=${guardsInFlight}`);
}

// ── F5: ⭐ ONE notion of stale, shared with the route that acts on it ────────
// If the flag arming the client's rebuild ever diverges from the flag the generate route's
// debounce reads, the client asks for runs the route silently declines — forever.
{
  const imports = /import \{ evaluateFreshness \} from '\.\/mindscape-freshness\.js';/.test(readiness);
  const uses = /const fresh = evaluateFreshness\(\{[\s\S]{0,220}builtAtEmbedded: readGenerateStats\(\)\?\.lastEmbedded/.test(readiness);
  // No second, hand-rolled staleness anywhere in the slice.
  const noHandRolled = !/stale:\s*(embedded|points|drift)\s*[<>!=]/.test(readiness);
  // and the route the client calls must read the SAME function (it already did — assert it stays)
  const route = stripComments(read('src/portal-mindscape.js'));
  const routeShares = /evaluateFreshness\(\{/.test(route) && /import \{ evaluateFreshness, countMappedPoints \}/.test(route);
  rec('F5. ⭐ client and route share ONE staleness predicate — the flag cannot ask for a run the route skips',
    imports && uses && noHandRolled && routeShares,
    `imports=${imports} uses=${uses} noHandRolled=${noHandRolled} routeShares=${routeShares}`);
}

// ── F6: the server emits it, and pays no new query ──────────────────────────
{
  const emits = /stages\.push\(\{ key: 'cluster', state: 'done', count: \{ done: points \}, stale: fresh\.stale, drift: fresh\.drift \}\)/.test(readiness);
  // `points` must still come from the memoized mindscape slice — not a fresh COUNT in the cluster arm.
  const reusesMemo = /const points = Number\(ms\?\.pointCount \|\| 0\);/.test(readiness);
  const noNewQuery = !/cluster[\s\S]{0,400}countMappedPoints\(/.test(readiness)
    && !/SELECT COUNT\(\*\)[\s\S]{0,80}clustering_points/.test(readiness);
  // and the predicates really are the same one, which is what makes the reuse sound
  const mindscapeDb = read('src/db/mindscape.js');
  const freshness = read('src/mindscape-freshness.js');
  const norm = (s) => s.replace(/\s+/g, ' ');
  const samePredicate = norm(mindscapeDb).includes('FROM clustering_points WHERE user_id = ? AND landscape_x IS NOT NULL')
    && norm(freshness).includes('FROM clustering_points WHERE user_id = ? AND landscape_x IS NOT NULL');
  rec('F6. the cluster stage carries the freshness, reusing the memoized count (no new scan)',
    emits && reusesMemo && noNewQuery && samePredicate,
    `emits=${emits} reusesMemo=${reusesMemo} noNewQuery=${noNewQuery} samePredicate=${samePredicate}`);
}

// ── F7: drift is its own fact — DRIVEN ──────────────────────────────────────
// The whole point of ask (1): messages and points come from different tables. The copy must never
// present them as a subtractable pair, which is what made "0 ready · 1014 on the map" read as
// broken. Driven through the real function for the same reason F2 is — and F7 caught the
// extraction on its own (the phrase left this file for $lib/stage-count and the source match went
// false), which is the check behaving exactly as intended.
{
  const { driftNote } = await import('../portal-app/src/lib/stage-count.ts');
  const cases = [
    [2141, '2,141 new to place'],
    [1, '1 new to place'],
    [0, ''],            // no drift ⇒ NO note at all, not "0 new to place"
    [undefined, ''],    // absent ⇒ not a claim
  ];
  const bad = cases.filter(([d, want]) => driftNote(d) !== want);
  // and the row must render it as a SEPARATE fact, never as arithmetic against the point count
  const noArithmetic = !/\{[^}]*stage\.count[^}]*-[^}]*stage\.drift[^}]*\}/.test(statusCode)
    && !/\{[^}]*drift[^}]*-[^}]*count[^}]*\}/.test(statusCode);
  const noFusedPhrase = !/on the map/i.test(statusCode);
  rec('F7. ⭐ drift states its own quantity in its own words — never subtracted from or paired with points',
    bad.length === 0 && noArithmetic && noFusedPhrase,
    bad.length
      ? bad.map(([d, w]) => `${d} → ${JSON.stringify(driftNote(d))} (want ${JSON.stringify(w)})`).join(' · ')
      : `${cases.length} cases · noArithmetic=${noArithmetic} noFusedPhrase=${noFusedPhrase}`);
}

const allPass = ledger.every(Boolean);
console.log('');
console.log(allPass
  ? 'VERDICT: GO — the MapFreshness section is retired and all three of the operator\'s asks shipped\n'
    + '        together: the row says POINTS, the section is gone, and a stale map rebuilds itself on\n'
    + '        the false→true edge — with the manual ↻ preserved on every built map so the deletion\n'
    + '        did not take the remedy with it. Client and server share ONE staleness predicate.\n'
    + '        NOT PROVEN: that a rebuild SUCCEEDS on the operator\'s vault (verify:pipeline-runs-\n'
    + '        through owns that), nor that the auto-rebuild fires in a real browser — F4 asserts\n'
    + '        the trigger\'s SHAPE, and a mount test is the next rung.'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(allPass ? 0 : 1);

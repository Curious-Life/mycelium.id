// verify:generate-phase — the client generate store's phase mapping AND its render, by RUNNING
// both: G1-G5 drive the real store; D2a-D2e MOUNT the two components that show its outcome.
//
// WHY THIS EXISTS: the store (portal-app/src/lib/generate.ts) was UNGATED, and the route's
// skip branch was ungated too — which is exactly how "Illuminate does nothing" survived.
// POST /mycelium/generate returns 200 {jobId:null,status:'skipped'} when topology already
// exists (portal-mindscape.js:626 — a debounce added because the mindscape view re-POSTs on
// every load). That is a SUCCESS: nothing to do. The client called it an ERROR, and since
// $generate.error is rendered in ZERO places app-wide, the error became SILENCE. Illuminate's
// render condition (realms exist) IS the route's skip condition ⇒ it failed 100% of the time
// it was visible, with no feedback at all.
// @see docs/DISTILLATION-SURFACE-DESIGN-2026-07-16.md §2/§2a.
//
// NOTHING HERE IS GREPPED. G1-G5 drive the REAL module (esbuild strips types; only `./api` is
// stubbed); D2a-D2e mount the REAL components against the REAL route responses. A source grep is
// a PROJECTION, and projections have been satisfied by their own comments twice in this build —
// D2 itself was a regex until a reviewer dead-coded the CTA and it still said GO. The store's
// mapping and the user's screen are two different claims, and this file must make both.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
function t(n, fn) { try { fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } }

const drive = (scenario) => {
  const out = execFileSync('node', ['test/drive-generate-store.mjs'], {
    cwd: 'portal-app', encoding: 'utf8', timeout: 120000,
    env: { ...process.env, SCENARIO: scenario },
  }).trim().split('\n').pop();
  return JSON.parse(out);
};

// D2's harness: MOUNTS the component (real Svelte compiler + jsdom + the REAL store driven by
// the REAL route responses) and reports what a user can actually READ. See the D2 block below
// for why a source regex could not do this job.
const mountRender = (probe) => {
  const out = execFileSync('node', ['--conditions', 'browser', 'test/mount-generate-render.mjs'], {
    cwd: 'portal-app', encoding: 'utf8', timeout: 120000,
    env: { ...process.env, PROBE: probe },
  }).trim().split('\n').pop();
  return JSON.parse(out);
};

const skipped = drive('skipped');
const started = drive('started');
const malformed = drive('malformed');
const unavailable = drive('unavailable');

t("G1. ⭐ the server's 'skipped' is a SUCCESS — 'up-to-date', never an error", () => {
  // THE regression. The route says "your map is already built"; the client used to answer
  // "Server did not return a job id." and render it nowhere.
  assert.equal(skipped.phase, 'up-to-date',
    `200 {jobId:null,status:'skipped'} must map to 'up-to-date', got '${skipped.phase}'. `
    + 'It is the route telling us there is nothing to do — a success. Mapping it to `error` is '
    + 'what made Illuminate a silent no-op: its render condition IS the route\'s skip condition.');
  assert.equal(skipped.error, '', 'and it must carry NO error string');
  assert.ok(skipped.message, 'and it must say something — a state with no message is the silence again');
});

t('G2. a genuinely malformed 200 is STILL an error — the fix did not over-broaden', () => {
  // The failure mode of fixing G1 carelessly: treat every jobId-less 200 as fine, and a real
  // server bug becomes invisible too. `skipped` is a NAMED status, not the absence of a field.
  assert.equal(malformed.phase, 'error',
    'a 200 with no jobId AND no status:skipped is a broken server response, not "up to date"');
  assert.match(malformed.error, /job id/i);
});

t('G3. a real start still runs', () => {
  assert.equal(started.phase, 'running');
  assert.equal(started.jobId, 'job-123');
});

t('G4. a 503 surfaces the REAL server reason', () => {
  assert.equal(unavailable.phase, 'error');
  assert.match(unavailable.error, /unavailable/i, 'never a generic mask over the server\'s own message');
});

t('G5. start() POSTs exactly once per call in every outcome', () => {
  for (const [name, r] of [['skipped', skipped], ['started', started], ['malformed', malformed], ['unavailable', unavailable]]) {
    assert.equal(r.postCount, 1, `${name}: expected exactly 1 POST, got ${r.postCount}`);
  }
});

// ── D2: THE RENDER, PROVEN BY RENDERING ─────────────────────────────────────────────────────
// ⚠️ HONEST REACH, stated because a gate that overclaims is a false guarantee.
// D2 USED TO BE A SOURCE REGEX over MindscapeDetail.svelte. It caught DELETION (the reviewer's
// M2 removed the button ⇒ FAIL) but was blind to NEUTERING: `{#if false && anyUndescribed…}`
// left every asserted string in the file, showed the user NOTHING, and the suite still said GO
// (their M4). "Dead-coded" is an OPEN SET — a literal `false`, an always-false variable, an
// unreachable branch, a parent `{#if}` that never holds — and no regex closes an open set. That
// is the same trap that beat P6 and P6e (see gate-projection-vs-property).
// ⇒ These probes MOUNT the component and read host.textContent. Only rendering proves rendering.
//
// WHAT THEY DRIVE: the REAL store, through the REAL start(), against the REAL route responses —
// so the chain proven is server response → store phase → pixel, which is the chain the bug lived
// in. G1-G5 above pin the store's MAPPING; D2 pins that a user can SEE it. Both halves are load-
// bearing: the mapping was right and the screen was still silent, which is the whole defect.
//
// THE ASSERTED PROPERTY is `text.includes(store's own message/error)` — not a copy match. The
// invariant that matters is "whatever the store holds for this phase, the user can read it",
// and that survives a rewording of the sentence. Pinning the exact copy would gate the words.
//
// ⚠️ AN EARLIER VERSION OF THIS COMMENT RATIONALIZED A LIVE BUG. It read: "MindscapeInvite does
// NOT render `up-to-date` … that is by DESIGN — the invite is mounted ONLY on the empty vault,
// and 'skipped' means topology_exists, which cannot be true of a vault with no points." That is
// FALSE. It conflates two different point counts:
//   · the route skips iff the SERVER has clustering_points > 0 (portal-mindscape.js:627)
//   · the invite mounts iff the CLIENT has msState.points.length === 0 (MindscapeView:502)
// They diverge whenever the client's load fails: mindscape.ts:486's catch leaves `points: []` +
// `loading: false` while the server's topology still exists; `hasImportedData` comes from
// messageCount, not points (MindscapeView:31), so the auto-gen effect (:94) fires → 200 skipped
// → 'up-to-date' → a block that didn't list it → SILENCE, on a fully built map. So the invite
// DID have a live instance of the original bug, and this gate's own comment was the thing
// keeping it alive (independent review of #194). MindscapeInvite:266 now renders it, and D2e
// asserts it. ⇒ A "by design" in a gate comment is a claim like any other. Verify it or drop it.
//
// ⚠️ KNOWN REACH — what these probes genuinely do NOT prove, stated rather than papered over:
//   1. They mount the components in ISOLATION. They prove each renders the outcome; they do not
//      prove MindscapeView mounts the right one. That is MindscapeView's own gate.
//   2. VISIBILITY is checked via getComputedStyle over the ancestor chain — display, visibility,
//      [hidden], aria-hidden, opacity:0, font-size:0. jsdom does NO LAYOUT, so hiding by GEOMETRY
//      (zero-height clip, off-screen transform, a parent's overflow) still reads as shown; only a
//      real browser closes that. ⚠️ An earlier version of this note claimed the gap was
//      "geometry-based hiding" and that display:none was "the one a careless edit actually
//      causes" — while a ONE-LINE `.cta-note { opacity: 0 }` sailed straight through it. opacity
//      is not geometry, and jsdom reads it fine: it was closable, and the reach note was an
//      excuse dressed as a limit. State a limit only after trying to close it.
//   3. They assert THE RENDER SITE (.cta-note / .gen-status), not that the class names are right.
//      Rename the class and this goes red — a false red, fail-closed, the correct direction.

const detailSkipped = mountRender('detail:skipped');
const detailError = mountRender('detail:unavailable');
const detailEmbedding = mountRender('detail:embedding');
// ALL SIX non-idle phases on the invite. Every omission here has turned out to be a real bug.
const inviteSkipped = mountRender('invite:skipped');
const inviteError = mountRender('invite:unavailable');
const inviteEmbedding = mountRender('invite:embedding');
const inviteRunning = mountRender('invite:started');
const inviteDone = mountRender('invite:finished');
const inviteStarting = mountRender('invite:hang');
// The two ETA probes. Neither is redundant, and that is a MEASURED claim, not a design intent:
// each one is the only probe that fails when its guard is deleted (see D2f's mutation log).
const inviteOverrun = mountRender('invite:overrun');   // elapsed > priorDurationMs ⇒ negative projection
const inviteEarly = mountRender('invite:early');        // elapsed = 1s ⇒ positive, fabricated projection

const mounted = (r) => { assert.ok(r.ok, `the harness itself failed to mount: ${r.error}`); };

// THE assertion. Four claims, each earned by a mutation that beat an earlier version:
//   1. the SITE exists          — exactly one `.cta-note`/`.gen-status`. Dead-code the block and
//                                 it is 0.
//   2. it SAYS the store's text — or, for a phase the store has no text for (`starting`), that it
//                                 says SOMETHING. `text.includes('')` is ALWAYS true, so an empty
//                                 needle must never reach includes(): vacuous GOs are this repo's
//                                 most-repeated failure.
//   3. it is VISIBLE            — display/visibility/[hidden]/aria-hidden/opacity/font-size over
//                                 the whole ancestor chain. `.cta-note{display:none}` and
//                                 `{opacity:0}` each passed (2) and showed the user nothing.
//   4. (detail) it is ON the CTA — asserted separately in D2d.
// It asserts against THE RENDER SITE, not `body.textContent`: a visible DECOY elsewhere in the
// document made an earlier D2a pass while the real note was hidden inside the CTA.
// And it asserts the PROPERTY (whatever the store holds, the user reads) rather than the copy, so
// rewording the sentence doesn't red the gate.
// WHAT EACH PHASE MUST SHOW, and WHERE that text comes from — explicit, because they are two
// different questions and conflating them HID A REAL BUG. The needle used to be
// `message || stageLabel` — THE SAME EXPRESSION AS THE RENDER — so for `done` it asserted "the
// site shows whatever the store holds", which was satisfied by the user reading the bare word
// "Complete" (generate.ts:115's internal stage label), while the arm's authored copy was dead
// code. An assert whose expected value is computed the same way as the actual value proves only
// that the code equals itself (independent review of #194 r3, finding 2).
// ⇒ For store-derived phases, name WHICH field. For authored-copy phases, say so and assert
// presence + that no internal label leaks through as user copy.
const EXPECT = {
  error: (r) => ({ needle: r.storeError }),
  'up-to-date': (r) => ({ needle: r.storeMessage }),
  embedding: (r) => ({ needle: r.storeMessage }),
  running: (r) => ({ needle: r.storeStageLabel }),   // the server's own stage copy — user-facing
  // The store holds nothing user-facing for these; the component's own copy IS the message.
  done: (r) => ({ needle: null, forbid: 'Complete' }),
  starting: (r) => ({ needle: null }),
};

const shows = (r, why) => {
  mounted(r);
  assert.equal(r.siteCount, 1,
    `${why}: expected exactly 1 ${r.siteSelector} in the mounted DOM, got ${r.siteCount} `
    + `(scenario ${r.scenario}, phase ${r.phase}). The surface is silent.`);
  // Deny-by-default, mirroring the component's `{:else}` arm: a phase with no expectation is a
  // phase this gate would silently skip, which is how omissions became bugs twice already.
  const spec = EXPECT[r.phase];
  assert.ok(spec,
    `${why}: no expectation is defined for phase '${r.phase}'. A phase added to GenPhase must be `
    + 'given one HERE — being unlisted must never mean being unchecked.');
  const { needle, forbid } = spec(r);
  if (needle != null && needle !== '') {
    assert.ok(r.siteText.includes(needle),
      `${why}: the store says "${needle}" and ${r.siteSelector} does NOT show it. It renders: `
      + `"${r.siteText}"`);
  } else {
    // No store text ⇒ the authored fallback is the whole message. Assert it says SOMETHING —
    // `includes('')` is always true, so a needle-based assert here would be pure vacuity.
    assert.ok(r.siteText && r.siteText.length > 0,
      `${why}: phase '${r.phase}' has no store text and ${r.siteSelector} is EMPTY — the user `
      + 'gets a blank box. The authored fallback is the only thing standing here.');
  }
  if (forbid) {
    assert.notEqual(r.siteText, forbid,
      `${why}: ${r.siteSelector} shows the raw internal stage label "${forbid}" as user copy. `
      + 'generate.ts sets it unconditionally, so a `message || stageLabel || <copy>` chain makes '
      + 'the authored copy dead code and ships an internal marker to the user.');
  }
  assert.ok(r.siteVisible,
    `${why}: ${r.siteSelector} renders "${r.siteText}" but is NOT VISIBLE (display / visibility / `
    + '[hidden] / aria-hidden / opacity:0 / font-size:0 / transparent colour, on it or an '
    + 'ancestor). Rendered-but-hidden is the same silence as not rendered. ⚠️ NB this check is an '
    + 'OPEN SET — see the harness note; a pass is "none of these mechanisms hid it", not "the user '
    + 'can see it".');
  return needle;
};

t("D2a. \u2b50 MindscapeDetail RENDERS 'up-to-date' — the user reads \"nothing to do\"", () => {
  assert.equal(detailSkipped.phase, 'up-to-date', 'the store did not even reach the phase under test');
  // ⭐ THE ASSERT M4 BEAT. Dead-code the CTA and this FAILS: the text is simply not there.
  const needle = shows(detailSkipped, 'the server said "your map is already built"');
  assert.ok(!detailSkipped.textBefore.includes(needle),
    'the message was on screen BEFORE start() — this probe proves nothing about the click.');
});

t('D2b. \u2b50 MindscapeDetail RENDERS the error — verbatim from the server', () => {
  assert.equal(detailError.phase, 'error');
  // An unrendered error is why "Illuminate does nothing" survived: the store knew, and nothing
  // told the user.
  shows(detailError, '$generate.error');
});

t('D2c. MindscapeDetail RENDERS the embedding wait', () => {
  assert.equal(detailEmbedding.phase, 'embedding');
  shows(detailEmbedding, 'the 409 "still processing" message');
});

t('D2d. \u2b50 the Illuminate CTA is MOUNTED, and the outcome renders ON it', () => {
  // The renders above hang off this button. Asserting it from the LIVE DOM sees both M2
  // (deleted) and M4 (dead-coded); the old source regex saw neither. `disabled` is fine — a
  // disabled button still renders.
  for (const r of [detailSkipped, detailError, detailEmbedding]) {
    mounted(r);
    assert.equal(r.ctaCount, 1,
      `expected exactly 1 live button.realm-cta.illuminate in the mounted DOM, got ${r.ctaCount} `
      + `(scenario ${r.scenario}). A reviewer deleted this button and the old gate said GO; another `
      + 'dead-coded its `{#if}` guard and it said GO again. That is what D2 is here to stop.');
    // ⭐ LOCATION. body.textContent is body-WIDE: a reviewer moved the note out of the CTA into a
    // hidden box elsewhere in the component and the gate still said GO (#194, finding 3). Feedback
    // that isn't next to the button the user clicked is not feedback for that click.
    assert.equal(r.siteWithCta, true,
      `(scenario ${r.scenario}) the outcome text rendered OUTSIDE the CTA's container `
      + `(site: ${r.siteSelector} → "${r.siteText}"). The user clicks Illuminate and the answer `
      + 'must appear there.');
  }
});

t('D2e. \u2b50 MindscapeInvite speaks on a fresh vault — EVERY non-idle phase', () => {
  // The invite is the ONLY generate surface mounted when points.length === 0 (MindscapeView:502)
  // — i.e. the FIRST RUN, the most common path. MindscapeDetail lives inside
  // `{#if points.length > 0}` (:459) and is NOT mounted there, so a phase this block omits is a
  // phase that is SILENT on a fresh vault (MED-1, 2026-07-16).
  // ⚠️ ALL SIX, because the guard was an ENUMERATION twice and BOTH omissions were real bugs:
  //   · up-to-date — omitted because "topology_exists cannot be true of a vault with no points".
  //                  False (see header). Live silence on a fully built map.
  //   · done       — omitted as "transient: MindscapeView reloads ⇒ this unmounts". False: that
  //                  reload is mindscape.ts:486's, whose catch leaves `points: []` ⇒ still
  //                  mounted, `done` unrendered, resetGen → idle → silent forever. And `done` is
  //                  the HAPPY PATH: the invite is mounted for the whole fresh-vault run.
  //   · starting   — omitted as "one await". Lasts as long as the POST; unbounded if it hangs.
  //   · running    — the LONGEST-LIVED phase (clustering runs minutes).
  //   · error / embedding — MED-1's original motivating cases.
  // The component now guards on `!== 'idle'` with a DEFAULT arm, so this list can only grow.
  for (const r of [inviteSkipped, inviteError, inviteEmbedding, inviteRunning, inviteDone, inviteStarting]) {
    shows(r, `the invite on phase '${r.phase}'`);
  }
  // Pin the phases themselves: a probe that silently stopped reaching its phase would assert
  // nothing while still passing (it would just be re-testing whichever phase it landed in).
  assert.equal(inviteSkipped.phase, 'up-to-date');
  assert.equal(inviteRunning.phase, 'running');
  assert.equal(inviteDone.phase, 'done');
  assert.equal(inviteStarting.phase, 'starting');
  assert.equal(inviteEmbedding.phase, 'embedding');
  assert.equal(inviteError.phase, 'error');
});

t('D2f. ⭐ a run that just started says nothing about the ETA — never "~0s left"', () => {
  // OBSERVED, not theorised: PROBE=invite:started rendered
  // "Clustering your conversations… · ~0s left" (independent review of #194, finding 3).
  // run() ticks IMMEDIATELY, so the first pollStatus lands at elapsed≈0, and computeEta's
  // `elapsed / frac - elapsed` is then 0 — a clustering run that takes MINUTES announced it was
  // finished the instant it started. priorDurationMs masks this on second+ runs ⇒ it was worst on
  // the FIRST run, the fresh vault, where this invite is the ONLY generate surface
  // (MindscapeView:502) and the user has the least context for disbelieving it.
  //
  // TWO independent halves, because either alone is satisfiable while the bug is on screen: the
  // store must not FABRICATE a countdown it cannot know, and the template must not RENDER one the
  // store doesn't hold.
  assert.equal(inviteRunning.phase, 'running', 'the probe did not reach the phase under test');
  assert.equal(inviteRunning.etaSeconds, null,
    `at elapsed≈0 the honest ETA is UNKNOWN, so the store must hold null — got `
    + `${inviteRunning.etaSeconds}. 0 is not "unknown": it is a claim that the run is over. null `
    + 'is a supported, rendering-safe state (the templates guard with `!= null`), not a blank.');

  // ⚠️ THE PIXEL. `~0s` is a NAMED SHAPE, not the property — a projection, and this repo has been
  // beaten by projections repeatedly. It is paired with the store-consistency check below (no eta
  // ⇒ no countdown, whatever its wording) so that evading the regex means disagreeing with the
  // store instead. Neither closes "the number is plausible"; that is not computable here.
  // THE OTHER END OF THE SAME LIE: a run that has outlived priorDurationMs (a second run, on more
  // data — the common case). `prior - elapsed` goes negative and the old `Math.max(0, …)` floored
  // it to 0 ⇒ "~0s left" for the REST of a multi-minute run.
  assert.equal(inviteOverrun.phase, 'running', 'the overrun probe did not reach the phase under test');
  assert.equal(inviteOverrun.etaSeconds, null,
    `a run that has already outlived the last run's duration has an UNKNOWN ETA, not `
    + `${inviteOverrun.etaSeconds}. Flooring a negative projection to 0 says "any moment now" for `
    + 'as long as the run lasts.');

  // ⭐ THE GUARD THE OTHER PROBES CANNOT SEE, and the reason this probe exists at all.
  // MUTATION LOG — measured, not assumed: deleting `if (elapsed < ETA_MIN_ELAPSED_S) return null`
  // outright left this gate at 11/11 GO. Every other probe sits at elapsed≈0.03s, where the
  // projection rounds to 0 and `eta > 0` catches it FIRST — so the two guards tested as
  // equivalent when they are not, and I had already written "both guards are load-bearing" into
  // the source as an unverified claim. At elapsed=1s the projection is a POSITIVE, plausible
  // "~4s left" for a multi-minute run: no zero-check reaches it. A guard no probe can fail is not
  // gated, however true its comment is.
  assert.equal(inviteEarly.phase, 'running', 'the early probe did not reach the phase under test');
  assert.equal(inviteEarly.etaSeconds, null,
    `1s into a run, step 1/5 projects a confident "~4s left" — got ${inviteEarly.etaSeconds}. `
    + 'A non-zero number is not a real projection: dividing by ~no elapsed time is noise, and the '
    + 'user reads it as a promise. Withhold until the projection means something.');

  for (const r of [inviteRunning, inviteStarting, inviteEmbedding, inviteOverrun, inviteEarly]) {
    mounted(r);
    assert.doesNotMatch(r.siteText, /~\s*0s\b/,
      `phase '${r.phase}' renders "${r.siteText}" — work is IN FLIGHT and the line claims it has `
      + '~0s left. Withhold the estimate (null) rather than announce a false one.');
    if (r.etaSeconds == null) {
      assert.doesNotMatch(r.siteText, /\bleft\b/,
        `phase '${r.phase}': the store holds NO eta and the site still renders a countdown — `
        + `"${r.siteText}". The template invented a number the store refused to.`);
    }
  }
});

const allPass = ledger.every(Boolean);
console.log(`\n${ledger.filter(Boolean).length}/${ledger.length} checks passed`);
console.log(`VERDICT: ${allPass ? "GO — the generate store: 'skipped' is a success, a malformed 200 is still an error" : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);

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
// @see the distillation-surface design §2/§2a.
//
// NOTHING HERE IS GREPPED. G1-G5 drive the REAL module (esbuild strips types; only `./api` is
// stubbed); D2a-D2e mount the REAL components against the REAL route responses. A source grep is
// a PROJECTION, and projections have been satisfied by their own comments twice in this build —
// D2 itself was a regex until a reviewer dead-coded the CTA and it still said GO. The store's
// mapping and the user's screen are two different claims, and this file must make both.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
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

// The embedding-poll cap: drives the REAL pollEmbedding loop under a MOCK clock so a persistent
// `unknown` (SQLCipher scan failure) is exercised to its terminal. One process emits every field.
const embed = (() => {
  const out = execFileSync('node', ['test/drive-generate-embedding.mjs'], {
    cwd: 'portal-app', encoding: 'utf8', timeout: 120000, env: { ...process.env },
  }).trim().split('\n').pop();
  return JSON.parse(out);
})();

// The two remaining generate spinners, driven to their terminals under a MOCK CLOCK: a hung POST
// (`starting`) and a wedged `running` job. Same technique as `embed` above.
const caps = (() => {
  const out = execFileSync('node', ['test/drive-generate-caps.mjs'], {
    cwd: 'portal-app', encoding: 'utf8', timeout: 120000, env: { ...process.env },
  }).trim().split('\n').pop();
  return JSON.parse(out);
})();

// MindscapeView's "Checking your mind…" probe bound (mind-probe-cap.ts), driven directly.
const probeCap = (() => {
  const out = execFileSync('node', ['test/drive-probe-cap.mjs'], {
    cwd: 'portal-app', encoding: 'utf8', timeout: 120000, env: { ...process.env },
  }).trim().split('\n').pop();
  return JSON.parse(out);
})();

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
const inviteRetryable = mountRender('invite:retryable'); // the capped-`unknown` retryable error render

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

t('E1. ⭐ a persistent `unknown` count is CAPPED — never the infinite "Checking your conversations…" spinner', () => {
  // THE live-test hang (2026-07-18): pollEmbedding's `unknown` branch was the ONLY one without a
  // terminal, so a fresh machine whose vault the server could not COUNT spun forever. It now
  // bounds the wait with the unknownSince clock and transitions to a RETRYABLE error.
  assert.ok(embed.ok, `the embedding-cap harness itself failed: ${embed.error}`);

  // While transient it KEEPS POLLING with calm copy — not a dead error, and NOT the old
  // clinical "Checking your conversations…".
  assert.equal(embed.transient.phase, 'embedding',
    `before the cap the store must still be waiting (embedding), got '${embed.transient.phase}'`);
  assert.equal(embed.transient.message, 'Reading your vault…',
    `the transient copy must be the calm "Reading your vault…", got "${embed.transient.message}"`);
  assert.doesNotMatch(embed.transient.message, /checking your (conversations|mind)/i,
    'the old infinite-spinner copy must be gone');
  assert.equal(embed.transient.retryable, false, 'a still-transient wait is not yet retryable');

  // Past the bound: a RETRYABLE error that does NOT assert an empty vault ("could not read",
  // never "import some conversations first").
  assert.equal(embed.capped.phase, 'error',
    `a persistent unknown must terminate the spinner, got phase '${embed.capped.phase}'`);
  assert.equal(embed.capped.retryable, true,
    'the capped state must be RETRYABLE — unknown is "could not look", the honest next move is Retry');
  assert.match(embed.capped.error, /read your vault/i,
    `the capped copy must be an honest "couldn't read your vault", got "${embed.capped.error}"`);
  assert.doesNotMatch(embed.capped.error, /import|no (messages|conversations|data)|empty/i,
    'the capped error must NOT claim an empty vault — that is the §3.2a lie this fixes');

  // And it actually STOPPED polling — a still-armed interval keeps hitting /processing-status.
  assert.equal(embed.callsAfterCap, embed.callsAtCap,
    `after the cap the poll must be stopped — /processing-status calls went ${embed.callsAtCap} → ${embed.callsAfterCap}`);
});

t('E2. ⭐ a good count between unknowns CLEARS the clock — no false cap on a recovering scan', () => {
  // The cap must trip only on PERSISTENT unknowns. A single successful count in between resets
  // the clock, so a scan that recovers (even long after the first unknown) is never capped —
  // mirrors embedStallSince, where ANY forward progress resets the plateau clock.
  assert.equal(embed.recovered.phase, 'embedding',
    `a successful count after an unknown must NOT be an error (the clock cleared), got '${embed.recovered.phase}'`);
  assert.equal(embed.recoveredThenUnknown.phase, 'embedding',
    `and a later unknown restarts a FRESH clock (not a paused one) — it must not instantly re-cap, `
    + `got '${embed.recoveredThenUnknown.phase}'`);
});

t('E3. ⭐ P1-C — a `total:0` count does NOT hard-error mid-import; only a PERSISTENT 0 is empty-vault', () => {
  // The false "Import some conversations first" fired whenever /processing-status returned total:0
  // WITHOUT `unknown` — including the transient 0 of an active import (a stale SWR backlog snapshot,
  // or the first rows not yet committed). The fix bounds it like unknownSince: a 0 keeps polling
  // calmly, a non-zero total clears the clock, and only a 0 that PERSISTS past EMPTY_CONFIRM_MS is
  // the honest empty-vault terminal.
  assert.ok(embed.ok, `the embedding harness itself failed: ${embed.error}`);

  // A single 0 must NOT be an error — it stays embedding with calm copy, never "import first".
  assert.equal(embed.zeroTransient.phase, 'embedding',
    `a transient total:0 must keep waiting, not hard-error mid-import — got '${embed.zeroTransient.phase}'`);
  assert.doesNotMatch(embed.zeroTransient.error || '', /import|nothing to map/i,
    'a transient 0 must NOT claim an empty vault — that is the P1-C false error');
  assert.equal(embed.zeroTransient.message, 'Preparing your conversations…',
    `the transient-0 copy must be the calm "Preparing your conversations…", got "${embed.zeroTransient.message}"`);

  // A non-zero total between clears the clock ⇒ the race resolved, still embedding (never the error).
  assert.equal(embed.zeroThenPopulated.phase, 'embedding',
    `a 0 followed by real counts must clear the clock and keep embedding, got '${embed.zeroThenPopulated.phase}'`);
  assert.doesNotMatch(embed.zeroThenPopulated.error || '', /import|nothing to map/i,
    'a populated import must NOT be told its vault is empty');

  // A PERSISTENT 0 past the bound IS a genuinely-empty vault ⇒ the honest terminal (and NOT retryable —
  // Retry cannot conjure conversations; the user must import first).
  assert.equal(embed.zeroPersistent.phase, 'error',
    `a persistent total:0 must terminate to the empty-vault error, got '${embed.zeroPersistent.phase}'`);
  assert.match(embed.zeroPersistent.error, /import|nothing to map/i,
    `the persistent-0 terminal must be the honest "import first" copy, got "${embed.zeroPersistent.error}"`);
  assert.notEqual(embed.zeroPersistent.retryable, true,
    'the empty-vault error is not retryable — importing conversations is the next move, not Retry');
});

t('D2g. ⭐ the invite RENDERS the retryable error AND a Retry affordance — never a dead end', () => {
  // The capped `unknown` is actionable: the user sees the honest message and a way FORWARD. An
  // unrendered error, or an error with no Retry, is the silence/hang this whole surface fixes.
  assert.equal(inviteRetryable.phase, 'error', 'the probe did not reach the retryable-error state');
  shows(inviteRetryable, 'the capped-unknown retryable error');   // error text present + visible
  assert.equal(inviteRetryable.retryCount, 1,
    `exactly one Retry button must render when the error is retryable, got ${inviteRetryable.retryCount}`);
  assert.ok(inviteRetryable.retryVisible, 'the Retry button must be VISIBLE, not rendered-and-hidden');
  // The NON-retryable errors must NOT grow a Retry button (it cannot help "import first" /
  // "embedder down"): the 503 error probe holds retryable:false.
  assert.equal(inviteError.retryCount, 0,
    `a non-retryable error must show NO Retry button, got ${inviteError.retryCount}`);
});

t('D2h. the gen-status row TOP-aligns the dot to the first text line (the live-test misalignment)', () => {
  // `align-items: center` floated the 6px dot against a multi-line block's vertical middle,
  // visibly detached from the first line. The fix top-aligns the row (+ a dot offset). jsdom
  // does no layout, so this asserts the computed cascade value — a projection of the fix, paired
  // with the mutation log in the handoff; it goes RED if the rule reverts to center.
  for (const r of [inviteRetryable, inviteEmbedding, inviteError]) {
    assert.equal(r.genStatusAlign, 'flex-start',
      `.gen-status must align-items:flex-start so the dot pins to the first line, got '${r.genStatusAlign}' (phase ${r.phase})`);
  }
});

t('C1. ⭐ a hung POST /generate CAPS the `starting` spinner — retryable, never infinite', () => {
  // Pipeline-transparency Unit 1: `starting` had NO client timeout, so a POST the server accepted
  // but never answered spun the spinner forever. start() now arms the poll before the await and
  // checkStarting bounds it at START_TIMEOUT_MS.
  assert.ok(caps.ok, `the caps harness itself failed: ${caps.error}`);
  assert.equal(caps.startingTransient.phase, 'starting',
    `before the bound the store must still be starting, got '${caps.startingTransient.phase}'`);
  assert.equal(caps.startingCapped.phase, 'error',
    `a POST that never answers must TERMINATE the 'starting' spinner, got '${caps.startingCapped.phase}'`);
  assert.equal(caps.startingCapped.retryable, true,
    'the capped start must be RETRYABLE — the server may just be slow; the honest next move is Retry');
  assert.match(caps.startingCapped.error, /taking too long|hasn.t responded|try again/i,
    `the copy must be an actionable "taking too long — try again", got "${caps.startingCapped.error}"`);
});

t('C2. ⭐ a run the server never advances past `running` CAPS at the client ceiling — ABOVE the server MAX', () => {
  // `running` polled forever if the server wedged at status:'running'. pollStatus now terminates at
  // RUN_CEILING_MS measured from the job's own startedAt. That ceiling is a BACKSTOP set ABOVE the
  // server's own MAX_MS (45 min): a healthy run is ended by the server's cap, so the client ceiling
  // only ever fires on a server so wedged it blew past its own cap without self-terminating. The
  // harness jumps to +51 min to prove the terminal is reached — a 15-min ceiling (the original bug)
  // would have torn down a healthy 20-min run long before here.
  assert.equal(caps.runningBefore.phase, 'running', 'the run must actually be running before the ceiling');
  assert.equal(caps.runningCeiling.phase, 'error',
    `a wedged 'running' must terminate at RUN_CEILING_MS, got '${caps.runningCeiling.phase}'`);
  assert.equal(caps.runningCeiling.retryable, true, 'the capped run must be RETRYABLE');
});

t('C3. ⭐ `stalled` is a SOFT HINT, never a terminal — a stalled-but-healthy run KEEPS running; a healthy long run is NOT capped', () => {
  // FINDING F2: the old client hard-killed a run the instant the server flagged `stalled`. But the
  // server sets `stalled` only after ≥5 min of stdout silence as a SOFT hint that KEEPS the run
  // alive to MAX_MS (a legit quiet measure step trips it routinely). So a stalled run below the
  // ceiling must STAY running — and carry the flag so the UI shows "taking longer than usual".
  // ⚠️ WIRE FIDELITY: the harness now injects `stalled:true` at 20 min elapsed (a shape the server
  // CAN emit); the previous harness injected it at 4 min, which the server can NEVER produce
  // (needs ≥5 min silence) — it was blessing an unreachable wire while masking a live over-kill.
  assert.equal(caps.runningStalledSoft.phase, 'running',
    `a server-flagged 'stalled' run below the ceiling must KEEP RUNNING (soft hint, not a terminal), `
    + `got '${caps.runningStalledSoft.phase}' — hard-killing on 'stalled' tears down a run the server `
    + 'is still nursing');
  assert.equal(caps.runningStalledSoft.stalled, true,
    'and it must carry the stalled flag through to the store so the UI can say "taking longer than usual"');

  // THE HEALTHY-LONG-RUN GUARD (F2's regression sentinel): 20 min elapsed, NO stalled flag — the
  // 76k-message vault (clustering + LLM describe + 16 Python measure steps). It must NOT be capped
  // by the client ceiling; only the server's 45-min cap ends a healthy run. Restore RUN_CEILING_MS
  // to 15 min (the original bug) and THIS goes red at 20 min elapsed.
  assert.equal(caps.runningHealthyLong.phase, 'running',
    `a healthy 20-min run (no stalled) must NOT be capped by the client ceiling, got `
    + `'${caps.runningHealthyLong.phase}' — the ceiling must sit ABOVE the server's own MAX_MS so the `
    + 'server, not the client, ends a healthy run');
});

t('C5. ⭐ pollStatus does NOT resurrect `running` after a terminal (the un-cap race, F3)', () => {
  // FINDING F3: pollStatus reads the store, then awaits (api + json). In that window an overlapping
  // poll, a cancel(), or a reset() can write a TERMINAL and clear the timer. Without a post-await
  // guard, the late poll patches `phase:'running'` back over that terminal → a FROZEN spinner with
  // no live poll. The harness hangs a /status GET, calls reset() (→ idle) while it hangs, then
  // releases it; with the guard the resumed poll drops its stale response. Remove the
  // `if (get(generate).phase !== 'running') return;` guard from pollStatus and this goes red.
  assert.equal(caps.raceAfterTerminal.phase, 'idle',
    `a poll resolving AFTER a terminal was written must not patch 'running' back — got `
    + `'${caps.raceAfterTerminal.phase}'. That is the frozen-spinner race F3 closes.`);
});

t('C4. ⭐ the "Checking your mind…" probe bound is FINITE and caps at it — never an infinite retry', () => {
  // MindscapeView's readiness probe retried every ~4s forever on a persistent /readiness failure.
  // The bound (mind-probe-cap.ts) turns that into a finite retry → a "couldn't read your map"
  // retryable state. Reach: this gates the DECISION, not MindscapeView's render (THREE.js-heavy to
  // mount) — see drive-probe-cap.mjs's honest-reach note.
  assert.ok(probeCap.ok, `the probe-cap harness itself failed: ${probeCap.error}`);
  assert.ok(Number.isFinite(probeCap.max) && probeCap.max > 0,
    `the retry bound must be a finite, positive count, got ${probeCap.max} — Infinity IS the hang this caps`);
  assert.equal(probeCap.belowBound, false,
    `below the bound the probe must keep checking (not yet exhausted), got exhausted=${probeCap.belowBound}`);
  assert.equal(probeCap.atBound, true,
    `at the bound the probe must be EXHAUSTED so the view shows a retryable state, got exhausted=${probeCap.atBound}`);
});

const allPass = ledger.every(Boolean);
console.log(`\n${ledger.filter(Boolean).length}/${ledger.length} checks passed`);
console.log(`VERDICT: ${allPass ? "GO — the generate store: 'skipped' is a success, a malformed 200 is still an error" : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);

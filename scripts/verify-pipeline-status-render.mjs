// verify:pipeline-status-render — the PipelineStatus COMPONENT actually RENDERS every stage state
// (PIPELINE-TRANSPARENCY-DESIGN-2026-07-19 §"Module shape", §"Filling the gaps", §"Test strategy").
//
// The SERVER stage machine has its own gate (verify:pipeline-status / verify-pipeline-status.mjs).
// THIS gate is the other half: it MOUNTS the real PipelineStatus.svelte (real Svelte compiler →
// real jsdom → the REAL src/lib/pipeline.ts store, driven with the wire shape readiness.js emits)
// and asserts on what a user can SEE — because the design's motivating bug is a RENDER bug ("$
// generate.error renders in ZERO places app-wide" — generate.ts:29-37), and a source regex passes
// with the render dead-coded / never-mounted / never-subscribed ([[render-must-be-mounted-not-grepped]]).
//
//   R1  ORDER — the six stages render top-to-bottom in the SERVER order, never re-sorted.
//   R2  EACH STATE renders its expected element: done→✓, blocked→! + action, running→spinner,
//       pending→muted "Waiting". A state that renders NOTHING is the silence the design deletes.
//   R3  a RUNNING stage shows COUNTS + ETA (the reused fmtSeconds) — measure/embed progress visible.
//   R4  a BLOCKED stage shows the REASON text AND the action LABEL as a visible button (the inline
//       remedy) — the button exists and is reachable (Unit 4 wires its route; Unit 3 shows the label).
//   R4b a blocked action renders LIVE (ENABLED) in Unit 4 — the remedy is clickable, not "soon".
//   W1  intelligence wiring: clicking a `target:'intelligence'` action navigates to the Intelligence
//       settings screen (goto('/settings?tab=intelligence')) — and fires NOTHING else.
//   W2  generate wiring: clicking a `target:'generate'` action fires the generate store's start()
//       (the existing POST /mycelium/generate path) — and fires NOTHING else.
//   W3  resume wiring: clicking a `target:'resume'` action POSTs the existing resume route
//       (/portal/enrichment/processing/resume) — and fires NOTHING else.
//   W4  busy-guard: a double-click fires the remedy EXACTLY ONCE (no double-POST / double-start),
//       and the button reads disabled (busy) while its own action is in-flight.
//   R5  overall:'error' RENDERS (not silent) — the "$generate.error in ZERO places" fix.
//   R6  overall:'up-to-date'/'skipped' RENDERS — the "Illuminate does nothing" class, deleted.
//   R7  a caught-up vault: EVERY stage done (settled ✓), NO spinner anywhere (the models-slice /
//       restart trap — a mature vault must show no in-progress state).
//   R8  an empty vault: overall idle renders, NO spinner (idle is not a fabricated running).
//   R-CTRL  the harness can SEE ABSENCE — a sentinel the component never contains is reported absent
//       AND a real stage is present, so every "must NOT contain" above is non-vacuous.
//
//   ── D-025 (QA7 P4.1) — the card COLLAPSES when the pipeline is up to date ──────────────────
//   C1  a SETTLED pipeline (done / up-to-date / skipped, no blocked, no running) renders its
//       overall line and NO stage rows — collapsed, mirroring the header vault-pill's quiet
//       healthy state (StatusPopover.svelte:291-348). The operator's report is that it stayed
//       expanded: "when it is up to date, it should collapse the same way as it does in the
//       activity monitor."
//   C2  an UNSETTLED pipeline (blocked / running / error / unknown / idle) renders its stages
//       AND offers NO toggle — the card cannot be collapsed over a problem. This is the
//       safety asymmetry; without it "collapse when fine" degrades into "hide anything".
//   C3  the collapse is REACHABLE, not a dead end: clicking the settled card's disclosure
//       reveals the full stage list (EXPAND=1). A collapse the user cannot open would trade
//       one QA defect for another.
//   C4  the settled predicate is not merely `overall`: a `done` overall that still carries a
//       BLOCKED stage stays EXPANDED. A pipeline cannot go quiet while a stage needs a hand.
//
// Each load-bearing render assertion is mutation-falsified in scripts/mutate-pipeline-status-render.sh
// (mutate the component so a state renders nothing → this gate reds → restore from a cp snapshot).
//
// MUTATION-TESTED (D-025, 2026-07-23): PipelineStatus.svelte `const expanded = $derived(true)` — i.e.
//   the card is always expanded, the EXACT pre-fix behaviour the operator reported → C1 REDs
//   ("probe caughtup must render COLLAPSED when settled"). C2/C3/C4 stayed green, so C1 is the
//   check that actually owns this behaviour.
// MUTATION-TESTED (D-025, 2026-07-23): `settled` dropped its per-stage guard (the
//   `.every(s => s.state !== 'blocked' && s.state !== 'running')` term replaced by `true`), so
//   `overall` alone buys quiet → C4 REDs ("a `done` overall with a blocked stage must NOT be judged
//   settled") and C2 REDs on the same run ("probe doneblocked must NOT be judged settled").
// MUTATION-TESTED (D-025, 2026-07-23): the `.pipe-toggle` button rendered under `{#if true}` instead of
//   `{#if settled}`, so a blocked card could be collapsed away → C2 REDs ("probe midflight must offer
//   NO collapse toggle").
// MUTATION-TESTED (D-025, 2026-07-23): the toggle's `onclick` replaced with a no-op, making the
//   disclosure a dead control → C3 REDs ("clicking the disclosure must EXPAND the card").
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const t = (n, fn) => { try { fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } };

const ORDER = ['import', 'embed', 'categorize', 'cluster', 'describe', 'measure'];
const SENTINEL = 'ZZZ_STRING_PIPELINE_STATUS_NEVER_CONTAINS';

function run(probe, opts = {}) {
  const env = { ...process.env, PROBE: probe, MYCELIUM_SKIP_WRITER_LOCK: '1' };
  if (opts.click) env.CLICK = opts.click;
  if (opts.ctrl) env.CTRL = opts.ctrl;   // click the co-located per-stage control (R2/R3), not the generic action
  if (opts.double) env.DOUBLE = '1';
  if (opts.expand) env.EXPAND = '1';     // D-025: click the settled card's disclosure before reporting
  const line = execFileSync('node', ['--conditions', 'browser', 'test/mount-pipeline-status.mjs'],
    { cwd: 'portal-app', encoding: 'utf8', timeout: 120000, env })
    .trim().split('\n').pop();
  const o = JSON.parse(line);
  if (!o.ok) throw new Error(`probe ${probe} did not mount: ${String(o.error).slice(0, 400)}`);
  return o;
}
const byKey = (o) => Object.fromEntries(o.stages.map((s) => [s.key, s]));

let midflight, caughtup, toofew, paused, embedderdown, idle, error, uptodate, waitingembed;
// D-025: the settled probes are now COLLAPSED at rest, so the stage-level assertions (R4c, R7)
// read the OPENED card. Keeping both reports is deliberate — the collapsed one proves the
// collapse, the opened one proves the collapse hid nothing.
let caughtupOpen, doneblocked;
try {
  midflight = run('midflight');
  caughtup = run('caughtup');
  caughtupOpen = run('caughtup', { expand: true });
  toofew = run('toofew');
  paused = run('paused');
  embedderdown = run('embedderdown');
  idle = run('idle');
  error = run('error');
  uptodate = run('uptodate');
  waitingembed = run('waitingembed');
  doneblocked = run('doneblocked');
} catch (e) {
  console.log(`FAIL  R0. the component MOUNTS and every probe runs — ${String(e?.message || e).slice(0, 400)}`);
  console.log('\nVERDICT: NO-GO — a probe failed to run  EXIT=1');
  process.exit(1);
}
rec('R0. PipelineStatus mounts and all eleven probes run', true);

t('R1. the six stages render TOP-TO-BOTTOM in the server order (never re-sorted)', () => {
  assert.deepEqual(midflight.order, ORDER, `expected the six keys in order. Got: ${JSON.stringify(midflight.order)}`);
  assert.equal(midflight.rootCount, 1, 'the component root must mount exactly once');
  // Every stage element must be visible — a mounted-but-hidden stage is the silence this gate forbids.
  for (const s of midflight.stages) assert.ok(s.visible, `stage ${s.key} rendered but is HIDDEN`);
});

t('R2. EACH state renders its own element — done ✓, blocked !, running spinner, pending muted', () => {
  const s = byKey(midflight);
  assert.equal(s.import.state, 'done'); assert.ok(s.import.icon.includes('✓'), 'a done stage shows the settled ✓');
  assert.equal(s.embed.state, 'running'); assert.ok(s.embed.hasSpinner, 'a running stage shows a spinner');
  assert.equal(s.categorize.state, 'blocked'); assert.ok(s.categorize.icon.includes('!'), 'a blocked stage shows the ! marker');
  // pending stages render SOMETHING (not empty) — the "waiting" muted text, never a blank row.
  assert.ok(/waiting/i.test(s.describe.text), `a pending stage must render its waiting copy. Got: "${s.describe.text}"`);
  assert.ok(/waiting/i.test(s.measure.text), `a pending stage must render its waiting copy. Got: "${s.measure.text}"`);
});

t('R3. ⭐ a RUNNING stage shows COUNTS + ETA (the reused fmtSeconds) — measure/embed progress is visible', () => {
  const embed = byKey(midflight).embed;
  assert.equal(embed.state, 'running');
  assert.ok(embed.text.includes('3,200') && embed.text.includes('76,000'),
    `the running stage must show its counts (3,200 / 76,000). Got: "${embed.text}"`);
  // etaSeconds 90 → fmtSeconds → "1m 30s". If the component dropped the ETA (or re-derived it) this
  // exact formatted string would not appear.
  assert.ok(/1m 30s/.test(embed.text), `the running stage must show the fmtSeconds ETA "1m 30s". Got: "${embed.text}"`);
});

t('R4. ⭐ a BLOCKED stage shows the REASON text AND the action LABEL as a visible button', () => {
  const cat = byKey(midflight).categorize;
  assert.ok(/no labeling model/i.test(cat.text), `the block must show its reason text. Got: "${cat.text}"`);
  assert.equal(cat.actionLabel, 'Approve a labeling model', `the action LABEL must render as a button. Got: ${JSON.stringify(cat.actionLabel)}`);
  assert.ok(cat.actionVisible, 'the action button must be VISIBLE — a remedy the user cannot see is the "empty rail with words" the design forbids');
  // Every NON-pause blocked stage carries a visible, labelled generic action — no naked block. A
  // PAUSED stage instead shows its Resume in the co-located control cluster (R4c), never a duplicate
  // generic button — so it is excluded here (asserted separately below + in R4c).
  for (const o of [toofew, embedderdown]) {
    for (const s of o.stages.filter((x) => x.state === 'blocked')) {
      assert.ok(s.actionLabel && s.actionVisible, `naked block: ${o.probe}/${s.key} has no visible action button (label=${JSON.stringify(s.actionLabel)})`);
    }
  }
  // toofew → a Generate button; embedderdown → a Check button.
  assert.equal(byKey(toofew).cluster.actionLabel, 'Generate', 'a sub-floor vault must offer Generate, never be stranded');
  // A paused stage must NOT render a generic action button (its Resume lives in the control cluster).
  // The harness reports no `reason`, so a paused stage is identified by its rendered Resume control.
  for (const s of paused.stages.filter((x) => x.controls.some((c) => c.kind === 'resume'))) {
    assert.equal(s.actionLabel, null, `a paused stage must NOT render a generic action button (${s.key}) — Resume is the co-located control`);
  }
});

t('R4b. ⭐ a blocked action renders LIVE (ENABLED) in Unit 4 — the remedy is clickable, not "soon"', () => {
  // Unit 4 wires each action to its route, so the button must be ENABLED at rest (disabled only
  // while ITS OWN action is in-flight — proven separately in W4). A button stuck disabled here would
  // reinstate the "soon" dead control Unit 4 deletes. Paused stages carry NO generic action (their
  // remedy is the Resume control — R4c), so only the generic-action blocks are checked here.
  const blocked = [midflight, toofew, embedderdown]
    .flatMap((o) => o.stages.filter((s) => s.state === 'blocked' && s.reason !== 'paused'));
  assert.ok(blocked.length >= 1, 'the scenarios must include at least one blocked stage to check');
  for (const s of blocked) {
    assert.ok(s.actionLabel && s.actionVisible, `blocked action must render its visible label (${s.key})`);
    assert.ok(!s.actionDisabled, `blocked action "${s.actionLabel}" (${s.key}) must render ENABLED — Unit 4 made it live; a disabled-at-rest button is the "soon" dead control it deletes`);
  }
});

t('R4c. ⭐ co-located per-stage controls (R2/R3/N9): a RUNNING stage shows a ⏸ Pause toggle + ↻ Restart; a PAUSED stage shows a ▶ Resume toggle + ↻ Restart — ONE two-state ICON toggle, not three text buttons', () => {
  // The pipeline overview owns ONE two-state icon toggle (⏸ running → pause · ▶ paused → resume) +
  // a small Restart (↻) for embed & categorize (the global toggle split into two; N9 collapses the
  // Pause/Resume/Restart text trio into the icon toggle + one restart icon). A running stage's toggle
  // performs Pause; a paused stage's performs Resume — each an ICON-ONLY button whose accessible name
  // (aria-label) states the ACTION, beside its own Restart, and ONLY on embed/categorize.
  const rEmbed = byKey(midflight).embed;
  assert.equal(rEmbed.state, 'running');
  const rCtrls = Object.fromEntries(rEmbed.controls.map((c) => [c.kind, c]));
  // A running stage's toggle is the PAUSE side: accessible name "Pause …", icon-only, enabled.
  assert.ok(rCtrls.pause && /pause/i.test(rCtrls.pause.label) && rCtrls.pause.hasIcon && rCtrls.pause.visible && !rCtrls.pause.disabled,
    `a running embed must show a visible, enabled, ICON Pause toggle (aria-label "Pause …"). Got: ${JSON.stringify(rEmbed.controls)}`);
  assert.ok(rCtrls.restart && /restart/i.test(rCtrls.restart.label) && rCtrls.restart.hasIcon && rCtrls.restart.visible && !rCtrls.restart.disabled,
    `a running embed must show a visible, enabled, ICON Restart control. Got: ${JSON.stringify(rEmbed.controls)}`);
  // The toggle is truly TWO-STATE: a running stage shows the Pause side and NOT a Resume button.
  assert.ok(!rCtrls.resume, `a running stage must NOT show a Resume control — the toggle shows Pause. Got: ${JSON.stringify(rEmbed.controls)}`);

  // Both paused stages (embed + categorize) show the ▶ Resume side + Restart, all enabled at rest.
  // Identified by the rendered Resume control (the harness reports no `reason`).
  const pausedStages = paused.stages.filter((s) => s.controls.some((c) => c.kind === 'resume'));
  assert.equal(pausedStages.length, 2, 'the paused probe must have two paused stages (embed + categorize) each offering Resume');
  for (const s of pausedStages) {
    const c = Object.fromEntries(s.controls.map((x) => [x.kind, x]));
    assert.ok(c.resume && /resume/i.test(c.resume.label) && c.resume.hasIcon && c.resume.visible && !c.resume.disabled,
      `paused ${s.key} must show a visible, enabled, ICON Resume toggle (aria-label "Resume …"). Got: ${JSON.stringify(s.controls)}`);
    assert.ok(c.restart && c.restart.hasIcon && c.restart.visible && !c.restart.disabled,
      `paused ${s.key} must show a visible, enabled, ICON Restart control. Got: ${JSON.stringify(s.controls)}`);
    // The toggle is two-state: a paused stage shows Resume and NOT a Pause button.
    assert.ok(!c.pause, `a paused stage must NOT show a Pause control — the toggle shows Resume. Got: ${JSON.stringify(s.controls)}`);
  }
  // ⚠️ SCOPED TO THE STOP/RESUME/RESTART TRIO, NOT TO "ANY CONTROL" (P8b). This check used to count
  // EVERY `.pipe-ctrl` and require zero, which was equivalent while those three were the only
  // controls that existed. P8b adds a REBUILD (↻) to the cluster row of a built map — a different
  // verb on a different route — and the blunt count REDded on it. The assertion's INTENT was always
  // "a settled vault has nothing to stop and nothing paused"; that intent is unchanged and still
  // exactly asserted here. The rebuild control gets its own assertion in R4e rather than an
  // exemption, so it is proven, not merely tolerated.
  const RUN_CTRLS = new Set(['pause', 'resume', 'restart']);
  const runCtrls = (s) => s.controls.filter((c) => RUN_CTRLS.has(c.kind));

  // Controls are EMBED/CATEGORIZE only — a derived stage (cluster/describe/measure) never carries
  // a pause/resume/restart, because there is no per-stage drainer behind it to control.
  for (const s of midflight.stages.filter((x) => x.key !== 'embed' && x.key !== 'categorize')) {
    assert.equal(runCtrls(s).length, 0, `a derived stage (${s.key}) must carry NO Stop/Resume/Restart controls`);
  }
  // A caught-up (all-done) vault shows no run controls — nothing to stop, nothing paused. Read the
  // OPENED card (D-025 collapses it at rest), so this stays a real assertion about the stage
  // rows rather than a vacuous 0 from a card that renders no stages at all.
  assert.ok(caughtupOpen.stageCount === 6, `the opened caught-up card must render its six stages (got ${caughtupOpen.stageCount})`);
  const settledRunCtrls = caughtupOpen.stages.flatMap(runCtrls);
  assert.equal(settledRunCtrls.length, 0,
    `a settled vault must show no Stop/Resume/Restart controls. Got: ${JSON.stringify(settledRunCtrls)}`);
});

t('R4e. ⭐ P8b: a BUILT map carries a Rebuild (↻) on its cluster row, and clicking it really fires rebuild()', () => {
  // THE REGRESSION THIS GUARDS. P8b deletes the MapFreshness card, whose "Rebuild map" button was
  // the user's only manual trigger — D-004 symptom 2 was precisely a rebuild that existed with no
  // reachable control ("pass ?force=1 to rebuild. this i cant do from the UI as a user"). Deleting
  // the section without preserving the verb re-creates that defect, so the verb is asserted HERE,
  // mounted and clicked, not merely present in the source.
  const cluster = byKey(caughtupOpen).cluster;
  assert.equal(cluster.state, 'done', 'the caught-up probe must have a BUILT map (cluster done)');
  const rebuildCtrl = cluster.controls.find((c) => c.kind === 'rebuild');
  assert.ok(rebuildCtrl, `a built map's cluster row must carry a Rebuild control. Got: ${JSON.stringify(cluster.controls)}`);
  assert.ok(rebuildCtrl.hasIcon && rebuildCtrl.visible && !rebuildCtrl.disabled,
    `the Rebuild control must be a visible, enabled ICON button. Got: ${JSON.stringify(rebuildCtrl)}`);
  assert.ok(/rebuild/i.test(rebuildCtrl.label),
    `its accessible name must state the ACTION. Got: ${JSON.stringify(rebuildCtrl.label)}`);

  // ⚠️ IT IS ON EVERY BUILT MAP, NOT ONLY A STALE ONE. `caughtup` is the UP-TO-DATE probe — no
  // drift, nothing to catch up on — and the control must still be there. Gating it on staleness is
  // the tempting "only show it when it's needed", which is the original defect's exact shape.
  assert.ok(!cluster.stale, 'the caught-up probe must be a NON-stale map (that is what makes this assertion bite)');

  // And it is WIRED: the harness clicks it and records the spy call. A rendered-but-inert button is
  // the same dead end as no button ([[render-must-be-mounted-not-grepped]]).
  const clicked = run('caughtup', { expand: true, click: 'cluster', ctrl: 'rebuild' });
  assert.ok(clicked.calls.includes('rebuild'),
    `clicking Rebuild must call rebuild() from the generate lifecycle. Got calls: ${JSON.stringify(clicked.calls)}`);
});

t('R4d. ⭐ QA6: a DEFERRED categorize (waiting_embed) renders its reason + Pause control, NO generic action, and NOT "waiting on you"', () => {
  const cat = byKey(waitingembed).categorize;
  assert.equal(cat.state, 'blocked', 'a deferred categorize renders as blocked (! marker), never a lying running/done');
  assert.ok(/waiting for embedding/i.test(cat.text),
    `the deferral must show its reason text ("Waiting for embedding to finish"). Got: "${cat.text}"`);
  // NO generic action button — a deferral has no user remedy (this is the ACTIONLESS block). A
  // regression that attached an action to waiting_embed would render a dead button here.
  assert.ok(!cat.actionLabel, `a deferred stage must render NO generic action button. Got: ${JSON.stringify(cat.actionLabel)}`);
  // The Pause control STAYS reachable during the deferral (paused:false ⇒ the ⏸ Pause side), so a
  // user can pre-empt the labeling pass during a long import — the whole reason hasControls treats
  // waiting_embed as controllable.
  const ctrls = Object.fromEntries(cat.controls.map((c) => [c.kind, c]));
  assert.ok(ctrls.pause && ctrls.pause.visible && !ctrls.pause.disabled,
    `a deferred categorize must still show its ⏸ Pause control. Got: ${JSON.stringify(cat.controls)}`);
  assert.ok(!ctrls.resume, 'not paused ⇒ the toggle shows Pause, not Resume');
  // overall stays running (embed is healthy) — the deferral must NOT paint the pipeline as blocked-on-you.
  assert.ok(!/waiting on you/i.test(waitingembed.overallText),
    `a deferral behind a healthy embed must NOT render "Waiting on you". Got overall: "${waitingembed.overallText}"`);
});

t('W1. ⭐ intelligence wiring — clicking a target:"intelligence" action navigates to Intelligence, and NOTHING else', () => {
  // midflight.categorize is blocked no_model → Approve a labeling model (target:'intelligence').
  const o = run('midflight', { click: 'categorize' });
  assert.deepEqual(o.calls, ['goto:/settings?tab=intelligence'],
    `an intelligence action must fire exactly the settings navigation and nothing else. Got: ${JSON.stringify(o.calls)}`);
});

t('W2. ⭐ generate wiring — clicking a target:"generate" action fires start(), and NOTHING else', () => {
  // toofew.cluster is blocked too_few_embedded → Generate (target:'generate').
  const o = run('toofew', { click: 'cluster' });
  assert.deepEqual(o.calls, ['start'],
    `a generate action must fire the generate store's start() and nothing else (no goto, no ad-hoc POST). Got: ${JSON.stringify(o.calls)}`);
});

t('W3. ⭐ resume wiring — clicking a stage Resume control POSTs its PER-STAGE resume route, and NOTHING else', () => {
  // paused.embed shows a per-stage Resume control (R2) → POST /portal/enrichment/embed/resume.
  const oe = run('paused', { click: 'embed', ctrl: 'resume' });
  assert.deepEqual(oe.calls, ['apiPost:/portal/enrichment/embed/resume'],
    `the embed Resume control must POST the per-stage embed route and nothing else. Got: ${JSON.stringify(oe.calls)}`);
  // …and categorize's Resume hits the categorize route — the two stages resume INDEPENDENTLY.
  const oc = run('paused', { click: 'categorize', ctrl: 'resume' });
  assert.deepEqual(oc.calls, ['apiPost:/portal/enrichment/categorize/resume'],
    `the categorize Resume control must POST the per-stage categorize route and nothing else. Got: ${JSON.stringify(oc.calls)}`);
});

t('W5. ⭐ stop + restart wiring (R2/R3) — a running stage Stop/Restart POST their per-stage routes, and NOTHING else', () => {
  // midflight.embed is running → Stop hits /embed/pause, Restart hits /embed/restart.
  const oStop = run('midflight', { click: 'embed', ctrl: 'pause' });
  assert.deepEqual(oStop.calls, ['apiPost:/portal/enrichment/embed/pause'],
    `the embed Stop control must POST the per-stage pause route and nothing else. Got: ${JSON.stringify(oStop.calls)}`);
  const oRestart = run('midflight', { click: 'embed', ctrl: 'restart' });
  assert.deepEqual(oRestart.calls, ['apiPost:/portal/enrichment/embed/restart'],
    `the embed Restart control must POST the per-stage restart route and nothing else. Got: ${JSON.stringify(oRestart.calls)}`);
  // The busy-guard applies to controls too: a double-click on Stop fires exactly ONCE.
  const oDouble = run('midflight', { click: 'embed', ctrl: 'pause', double: true });
  assert.deepEqual(oDouble.calls, ['apiPost:/portal/enrichment/embed/pause'],
    `a double-click on Stop must fire the pause POST exactly ONCE (busy-guard). Got: ${JSON.stringify(oDouble.calls)}`);
  assert.equal(oDouble.clickedDisabledAfter, true, 'the Stop control must read disabled (busy) while its own POST is in-flight');
});

t('W4. ⭐ busy-guard — a double-click fires the remedy EXACTLY ONCE, and the button reads busy in-flight', () => {
  // Two synchronous clicks (no microtask yield between) — the second must be dropped so a generate
  // run can never be started twice by an impatient user. And the button is disabled while in-flight.
  const o = run('toofew', { click: 'cluster', double: true });
  assert.deepEqual(o.calls, ['start'],
    `a double-click must fire start() exactly ONCE (the busy-guard drops the second). Got: ${JSON.stringify(o.calls)}`);
  assert.equal(o.clickedDisabledAfter, true,
    'the button must read disabled (busy) while its own action is in-flight, so it cannot double-fire');
});

t('R5. ⭐ overall:"error" RENDERS (not silent) — the "$generate.error in ZERO places" fix', () => {
  assert.ok(error.overallVisible && error.overallText.length > 0, 'the error overall must render a visible line');
  assert.ok(/wrong|error/i.test(error.overallText),
    `overall:'error' must render an error message, not fall through to silence or a generic label. Got: "${error.overallText}"`);
});

t('R6. ⭐ overall:"up-to-date"/"skipped" RENDERS — the "Illuminate does nothing" class, deleted', () => {
  assert.ok(uptodate.overallVisible && uptodate.overallText.length > 0, 'the up-to-date overall must render a visible line');
  assert.ok(/already built/i.test(uptodate.overallText),
    `overall:'up-to-date' must render its own message. Got: "${uptodate.overallText}"`);
});

t('R7. ⭐ a caught-up vault: EVERY stage done (settled ✓), NO spinner anywhere (the restart trap)', () => {
  // Read the OPENED card — D-025 collapses a settled pipeline, and this assertion is about what
  // the stage rows SAY, not about whether they are on screen (that is C1/C3).
  assert.ok(caughtupOpen.stages.length === 6, `the opened caught-up card must expose six stages (got ${caughtupOpen.stages.length})`);
  for (const s of caughtupOpen.stages) {
    assert.equal(s.state, 'done', `${s.key} must be done on a caught-up vault`);
    assert.ok(s.icon.includes('✓'), `${s.key} must show the settled ✓, not a spinner`);
    assert.ok(!s.hasSpinner, `${s.key} must NOT spin on a caught-up vault`);
  }
  assert.equal(caughtupOpen.spinnerCount, 0, 'a mature vault must show NO spinner anywhere (the caught-up trap)');
  // The overall line is the ONE thing a collapsed card still says — assert it on the COLLAPSED
  // report, because that is the state the operator actually looks at.
  assert.ok(/up to date/i.test(caughtup.overallText), `and the overall says so. Got: "${caughtup.overallText}"`);
});

// ── D-025 (QA7 P4.1) — the card collapses when the pipeline is up to date ────────────────────
t('C1. ⭐ D-025: a SETTLED pipeline renders its overall line and NO stage rows (collapsed, like the vault-pill)', () => {
  for (const o of [caughtup, uptodate]) {
    assert.equal(o.settled, true, `probe ${o.probe} must be judged settled (overall=${o.overallText})`);
    assert.equal(o.expanded, false, `probe ${o.probe} must render COLLAPSED when settled — the operator's report is that it stayed expanded`);
    assert.equal(o.stageCount, 0, `a settled pipeline must render NO stage rows (collapsed). Got ${o.stageCount} in probe ${o.probe}`);
    // Collapsed is not silent: the ONE summary line survives, so the card still says where it is.
    assert.ok(o.overallVisible && o.overallText.length > 0,
      `a collapsed card must STILL render its overall line — collapse must not become silence. Got: "${o.overallText}"`);
    assert.ok(o.toggleVisible, `a collapsed card must offer a visible disclosure so it can be opened (probe ${o.probe})`);
  }
});

t('C2. ⭐ D-025: an UNSETTLED pipeline renders its stages and offers NO collapse toggle (a problem cannot be hidden)', () => {
  // blocked (midflight/toofew/embedderdown/paused), running (waitingembed), error, idle — every
  // non-settled shape stays open, and none of them exposes a way to shut it.
  for (const o of [midflight, toofew, embedderdown, paused, waitingembed, error, idle, doneblocked]) {
    assert.equal(o.settled, false, `probe ${o.probe} must NOT be judged settled`);
    assert.equal(o.expanded, true, `probe ${o.probe} must render EXPANDED — an unsettled pipeline is never collapsed`);
    assert.equal(o.stageCount, 6, `probe ${o.probe} must render all six stage rows. Got ${o.stageCount}`);
    assert.equal(o.toggleVisible, false,
      `probe ${o.probe} must offer NO collapse toggle — "collapse when fine" must not degrade into "hide anything"`);
  }
});

t('C3. ⭐ D-025: the collapse is REACHABLE — clicking the settled card\'s disclosure reveals the full stage list', () => {
  assert.equal(caughtupOpen.toggleExisted, true, 'the settled card must expose a disclosure button to click');
  assert.equal(caughtupOpen.expanded, true, 'clicking the disclosure must EXPAND the card');
  assert.equal(caughtupOpen.stageCount, 6,
    `clicking the disclosure must reveal the stage list — a collapse the user cannot open is a new dead end. Got stageCount ${caughtupOpen.stageCount}`);
  // …and the revealed content is the real stage machine, in order (not an empty shell).
  assert.deepEqual(caughtupOpen.order, ORDER, `the revealed stages must be the six server stages in order. Got: ${JSON.stringify(caughtupOpen.order)}`);
});

t('C4. ⭐ D-025: `overall` alone never buys quiet — a done overall carrying a BLOCKED stage stays EXPANDED', () => {
  // The predicate must read the STAGES, not just the summary. A pipeline that reports itself
  // done while one stage still needs a hand is exactly the dishonest-quiet this gate forbids.
  assert.equal(doneblocked.settled, false,
    'a `done` overall with a blocked stage must NOT be judged settled — the collapse predicate must inspect the stages');
  assert.equal(doneblocked.stageCount, 6, 'and its stage rows stay on screen');
  const cat = byKey(doneblocked).categorize;
  assert.equal(cat.state, 'blocked', 'the blocked stage is still rendered as blocked');
  assert.ok(cat.actionLabel && cat.actionVisible, 'and its remedy is still reachable — the whole point of refusing to collapse');
});

t('R8. an empty vault: overall idle renders, NO spinner (idle is not a fabricated running)', () => {
  assert.ok(idle.overallVisible && /waiting for data/i.test(idle.overallText),
    `an empty vault must render an idle overall. Got: "${idle.overallText}"`);
  assert.equal(idle.spinnerCount, 0, 'idle must not spin — it is not a fabricated running');
});

t('R-CTRL. the harness sees ABSENCE (a sentinel the component never contains) AND a real stage is present', () => {
  // If "absence" could pass on a blank page, every "must NOT" above would be vacuous. So: the
  // sentinel is absent AND the genuine render is present.
  assert.ok(!midflight.text.includes(SENTINEL), 'a string the component never contains must be reported ABSENT');
  assert.ok(midflight.text.includes('Categorize') && midflight.actionCount >= 1,
    'and the genuine render (a stage + its action) must be present — otherwise absence is vacuous');
});

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — PipelineStatus renders every stage state (done/running/blocked/pending) IN ORDER, running counts+ETA, blocked reason+visible action, overall error/up-to-date, and a caught-up vault with no spinner' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

// verify:intelligence-functions — the Intelligence screen's FUNCTION spine (design §3.11).
//
// The screen is "organized by function". §3.11b's own table mapped only 3 of the 6
// INFERENCE_TASKS; the handoff flagged the gap. This pins that EVERY inference task belongs to
// exactly one function (no orphan can silently have no home + no surface — the enrich-dormancy
// class), that Understanding owns categorize AND enrich (operator decision 2026-07-16), that
// the per-function recommendations are single-sourced from ROLE_RECOMMENDATIONS (badge ==
// default, never drift), and that Descriptions carries the §4g eu-or-local limit.
import assert from 'node:assert/strict';
import { INFERENCE_TASKS, ONBOX_TASKS } from '../src/inference/resolve.js';
import { INTELLIGENCE_FUNCTIONS, functionForTask, tasksForFunction, labelingRecommendedModel, descriptionsRecommendedPreset, voiceRecommendedModel } from '../src/inference/role-models.js';
import { isSensitiveTask, SENSITIVE_TASKS } from '../src/inference/sensitivity.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const t = (n, fn) => { try { fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } };

t('F1. EVERY inference task maps to exactly one function — no orphan (the §3.11b gap)', () => {
  const unmapped = INFERENCE_TASKS.filter((task) => !functionForTask(task));
  assert.equal(unmapped.length, 0,
    `every INFERENCE_TASK must have a function or it has no screen surface: orphans = [${unmapped.join(', ')}]`);
  // …and no task claims two functions.
  for (const task of INFERENCE_TASKS) {
    const owners = INTELLIGENCE_FUNCTIONS.filter((f) => f.tasks.includes(task));
    assert.equal(owners.length, 1, `${task} must belong to exactly one function, got ${owners.map((f) => f.key).join('+') || 'none'}`);
  }
});

t('F2. Understanding owns BOTH categorize and enrich — one approval, no dormancy split', () => {
  const u = INTELLIGENCE_FUNCTIONS.find((f) => f.key === 'understanding');
  assert.ok(u, 'the understanding function must exist');
  assert.deepEqual([...u.tasks].sort(), ['categorize', 'enrich'],
    'categorize + enrich must be ONE function — splitting them let a vault approve labeling and leave enrich silently dead');
  assert.deepEqual([...tasksForFunction('understanding')].sort(), ['categorize', 'enrich']);
});

t('F3. the recommendations are single-sourced from ROLE_RECOMMENDATIONS (badge == default)', () => {
  const u = INTELLIGENCE_FUNCTIONS.find((f) => f.key === 'understanding');
  assert.equal(u.recommend, labelingRecommendedModel(),
    'Understanding must recommend exactly the pinned label model — a screen badge that diverges from the drainer default is the drift this pattern exists to prevent');
  const d = INTELLIGENCE_FUNCTIONS.find((f) => f.key === 'descriptions');
  assert.equal(d.recommend, descriptionsRecommendedPreset(), 'Descriptions must recommend exactly the pinned narrate preset');
});

t('F4. Descriptions is jurisdiction "any" (limit lifted), and any eu-or-local function owns ONLY §4g-sensitive tasks (⇐)', () => {
  // Descriptions must NOT carry the eu-or-local limit anymore — narrate left SENSITIVE_TASKS on
  // 2026-07-19, so the router runs it on the user's chosen provider (US included) and the screen
  // must offer them all. A stray 'eu-or-local' here would HIDE valid choices and re-print the
  // "stays in the EU" copy the operator removed (§3.11d inverted: withholding a choice the router
  // allows).
  const d = INTELLIGENCE_FUNCTIONS.find((f) => f.key === 'descriptions');
  assert.equal(d.jurisdiction, 'any',
    `Descriptions must be 'any' now that narrate is non-sensitive — got '${d.jurisdiction}'`);
  // The ⇐ half of the biconditional, kept GENERAL for the future: any function that DOES claim
  // 'eu-or-local' must own only §4g-sensitive tasks, or the screen restricts a choice the router
  // happily allows. Vacuous today (no eu-or-local function), live the moment one returns —
  // hardcoding this to `descriptions` once let a reviewer set Conversation to 'eu-or-local' and
  // pass every gate (independent review ×4, 2026-07-16).
  for (const f of INTELLIGENCE_FUNCTIONS) {
    if (f.jurisdiction !== 'eu-or-local') continue;
    for (const task of f.tasks) {
      assert.ok(isSensitiveTask(task),
        `function '${f.key}' claims the eu-or-local §4g limit, but its task '${task}' is NOT sensitive in the router — the screen would restrict a choice the router happily allows`);
    }
  }
});

t('F4b. ⭐ SENSITIVE_TASKS is EMPTY (narrate lifted), and any §4g-sensitive task lives under an eu-or-local function (⇒)', () => {
  // The affirmative check that the 2026-07-19 change is IN PLACE: no task defaults to §4g-
  // sensitive. narrate was the only member; removing it is the whole point of this change, so
  // pin the state directly — a reviewer who re-added narrate to the router while leaving the
  // screen 'any' would fail here, catching exactly the "screen offers US but router refuses"
  // silent lie the OLD gate guarded against, now inverted.
  assert.equal(SENSITIVE_TASKS.size, 0,
    `narrate was removed from SENSITIVE_TASKS (2026-07-19). A non-empty set means a task now defaults to §4g-sensitive: [${[...SENSITIVE_TASKS].join(', ')}] — if that is intentional, its function must be 'eu-or-local' (checked below) AND the screen/router must agree.`);
  // The ⇒ half, kept GENERAL: IF a task rejoins SENSITIVE_TASKS, its function must be
  // 'eu-or-local' or the screen would OFFER a US model the router will refuse. Vacuous while the
  // set is empty, live the moment it grows — this is the guard that keeps the router (authority
  // on WHAT is sensitive) and the screen in step.
  for (const task of SENSITIVE_TASKS) {
    const owner = INTELLIGENCE_FUNCTIONS.find((f) => f.tasks.includes(task));
    assert.ok(owner, `§4g-sensitive task '${task}' has NO function — it would have no screen surface at all`);
    assert.equal(owner.jurisdiction, 'eu-or-local',
      `§4g-sensitive task '${task}' sits under function '${owner.key}' whose jurisdiction is '${owner.jurisdiction}' — the screen would OFFER a US model the router will refuse (§3.11d: a choice the system overrides is worse than no choice)`);
  }
});

t('F6. ⭐ every function is KIND-HOMOGENEOUS w.r.t. ONBOX_TASKS — the fan-out depends on it', () => {
  // The `{function}` fan-out (portal-providers.js) applies ONE rule to every task a function
  // owns: on-box tasks take a local model NAME, cloud tasks take a providerId. That is sound
  // ONLY because no function mixes the two — and until now NOTHING pinned that. It was
  // asserted in a commit message ("homogeneous… sound rather than lucky") and maintained by
  // review, i.e. it was exactly lucky (independent review, 2026-07-16).
  //
  // Demonstrated failure it now blocks: add a third on-box task and home it under Conversation
  // ⇒ every other F-gate stays GO ⇒ `PUT {function:'conversation', providerId, model:'gpt-4o'}`
  // silently writes `{model:'gpt-4o'}` into an ON-BOX slot, and the drainer tries to
  // `ollama pull gpt-4o`. That is M7d's bug class inverted.
  for (const f of INTELLIGENCE_FUNCTIONS) {
    if (!f.tasks.length) continue;                       // transcription/voice own no inference task
    const onbox = f.tasks.filter((t2) => ONBOX_TASKS.has(t2));
    assert.ok(onbox.length === 0 || onbox.length === f.tasks.length,
      `function '${f.key}' MIXES on-box and cloud tasks (${f.tasks.join(', ')}) — the fan-out would apply the wrong rule to half of them`);
  }
});

t('F6b. ⭐ Understanding IS exactly the on-box task set — two sources of truth, pinned equal', () => {
  // ONBOX_TASKS (resolve.js) and Understanding.tasks (role-models.js) are two independent
  // lists of "the on-box message tasks". If one gains a task and the other doesn't, the new
  // task either loses its screen surface (dormancy — the bug this round exists to end) or gets
  // the wrong write rule. Pin them equal so the drift is impossible rather than reviewed-for.
  const u = INTELLIGENCE_FUNCTIONS.find((f) => f.key === 'understanding');
  assert.deepEqual([...u.tasks].sort(), [...ONBOX_TASKS].sort(),
    `Understanding must own EXACTLY the on-box tasks: understanding=[${[...u.tasks].sort()}] vs ONBOX_TASKS=[${[...ONBOX_TASKS].sort()}]`);
});

t('F8. ⭐ a BUNDLED function is never approvable — presenting a non-choice as consent is the lie §3.10 kills', () => {
  // §3.10d-c: the embedder ships INSIDE the app. It cannot be declined, cannot be downloaded,
  // and has no rail. It must render as "Included — runs on your device", NEVER as a card with a
  // pre-ticked box. Nothing pinned that, and the spine omitted Search entirely until 2026-07-16
  // — which would have forced the component to hardcode the row (independent review).
  const bundled = INTELLIGENCE_FUNCTIONS.filter((f) => f.kind === 'bundled');
  assert.ok(bundled.length > 0, 'Search is a §3.11b function row — the spine must carry it, or the screen hardcodes a row and drifts');
  for (const f of bundled) {
    // No tasks ⇒ PUT {function:'search'} 400s in portal-providers.js: it is structurally
    // unapprovable, not merely un-rendered. That is the guarantee, not the copy.
    assert.equal(f.tasks.length, 0,
      `bundled function '${f.key}' must own NO task — a task is the thing an approval writes, and a bundled model cannot be approved`);
    assert.equal(f.jurisdiction, 'on-device', `bundled '${f.key}' runs on the device by construction`);
    assert.ok(f.recommend, `bundled '${f.key}' still names its model — "Included" should say WHAT is included`);
  }
});

t('F5. every function has a label, a sub and a why — the "recommendation + reason" contract', () => {
  for (const f of INTELLIGENCE_FUNCTIONS) {
    assert.ok(f.label && f.sub, `${f.key} needs a label + sub`);
    assert.ok(typeof f.why === 'string' && f.why.length > 0, `${f.key} needs a reason (recommendation-first, §3.11c)`);
  }
  // Voice now HAS a recommendation with EVIDENCE: Qwen3-TTS won the live listening test
  // (2026-07-15). The badge must be single-sourced from ROLE_RECOMMENDATIONS.voice so it can
  // never drift from the model catalog's default (the LOCAL-TTS-EVAL §6.2 requirement).
  const voice = INTELLIGENCE_FUNCTIONS.find((f) => f.key === 'voice');
  assert.equal(voice.recommend, voiceRecommendedModel(),
    'Voice must recommend exactly the pinned voice model — the winner of the live listening test, single-sourced so the badge == the model default');
});

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — the function spine: every task has a home, Understanding is one approval, badges are single-sourced, Descriptions is "any" (§4g limit lifted) and the sensitive⟺eu-or-local biconditional still holds' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

// verify:intelligence-screen — THE Intelligence screen, driven for real (design §3.11).
//
// It MOUNTS the component (real Svelte compiler → real jsdom → real change events) via
// portal-app/test/mount-intelligence-screen.mjs and asserts on what it actually rendered and
// actually SENT. Nothing here reads the source.
//
// ⚠️ WHY NOTHING CHEAPER WOULD DO — both proven on this branch, not assumed:
//   • A source regex passes with the thing commented out (M6b did exactly that, independent
//     review 2026-07-16).
//   • `vite build` passed with a deliberate SYNTAX ERROR in this component, because an
//     unimported component is not in the build graph. "The build is green" proved NOTHING until
//     SettingsView imported it.
// So: drive the control, or you are not testing the screen.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const t = (n, fn) => { try { fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } };

// `--conditions browser` is REQUIRED: without it Node resolves svelte's SERVER build via the
// exports map and mount() throws lifecycle_function_unavailable.
let out;
try {
  out = JSON.parse(
    execFileSync('node', ['--conditions', 'browser', 'test/mount-intelligence-screen.mjs'],
      { cwd: 'portal-app', encoding: 'utf8', timeout: 120000 }).trim().split('\n').pop(),
  );
} catch (e) {
  console.log(`FAIL  S0. the screen MOUNTS at all — ${String(e?.message || e).slice(0, 300)}`);
  console.log('\nVERDICT: NO-GO — the component did not mount  EXIT=1');
  process.exit(1);
}
rec('S0. the screen mounts and renders', out.ok === true, out.error ? String(out.error).slice(0, 200) : '');

// The subscription opt-in ON, driven as its own mount (the opt-in is read at load). Since
// narrate is no longer §4g-sensitive (2026-07-19), this flag no longer GATES Descriptions —
// S4b uses this probe to prove the row offers every provider whether the flag is on or off.
let exempt = {};
try {
  exempt = JSON.parse(
    execFileSync('node', ['--conditions', 'browser', 'test/mount-intelligence-screen.mjs'],
      { cwd: 'portal-app', encoding: 'utf8', timeout: 120000, env: { ...process.env, PROBE: 'exempt' } }).trim().split('\n').pop(),
  );
} catch (e) { exempt = { error: String(e?.message || e) }; }
rec('S0b. the screen also mounts with the subscription opt-in ON', exempt.ok === true, exempt.error ? String(exempt.error).slice(0, 160) : '');

t('S1. every §3.11b function row renders — FROM THE SERVED SPINE, not a hardcoded list', () => {
  assert.equal(out.renderedKeys, 6,
    `all six rows must render (Conversation, Understanding, Descriptions, Search, Transcription, Voice) — got ${out.renderedKeys}: ${out.labels?.join(', ')}`);
  // A hardcoded taxonomy is map §5.2's bug (three implementations, each drifting). The screen
  // renders whatever /providers/presets serves; P10b pins that the route serves it intact.
  assert.ok(out.labels.includes('Labeling') && out.labels.includes('Search'));
});

t('S2. ⭐ approving Understanding sends {function} — NOT {task} (the dormancy fix, end to end)', () => {
  // Assert on the UNDERSTANDING write specifically. This used to deepEqual the WHOLE sent array,
  // which coupled it to how many other controls the harness happens to drive — adding the
  // provider-button coverage (S2b) broke it for a reason that had nothing to do with its claim.
  // A check should fail for ITS OWN reason or it will be "fixed" by loosening the wrong thing.
  const u = out.sentBodies.filter((b) => b.function === 'understanding');
  assert.deepEqual(u, [{ function: 'understanding', model: 'qwen3.5:4b' }],
    `the screen must approve BY FUNCTION so the route fans out to categorize AND enrich. Sending {task} would approve one and leave L2 silently dead — the exact bug this round exists to end. Got: ${JSON.stringify(out.sentBodies)}`);
  // …and no write anywhere may use the per-task shape: that is the split, whichever row does it.
  assert.ok(!out.sentBodies.some((b) => 'task' in b),
    `NO write may use {task} — every row approves by function. Got: ${JSON.stringify(out.sentBodies)}`);
});

t('S2b. ⭐ a PROVIDER button SENDS ITS PROVIDER — it does not clear the assignment', () => {
  // The bug this catches SHIPPED and no gate saw it: every provider button called
  // approve(f, '') with no providerId, and the route deletes the assignment when providerId is
  // null — so clicking "Regolo" CLEARED narrate, and "Regolo" vs "OpenAI" were byte-identical
  // on the wire. S2 only ever drove the on-box <select>: 4 of 6 rows had no coverage on their
  // write path (independent review, 2026-07-16). Drive what you ship.
  assert.deepEqual(out.providerSent, [{ function: 'descriptions', providerId: 1 }],
    `a provider button must send {function, providerId}. Sending {model:''} DELETES the assignment (portal-providers.js: providerId == null → delete). Got: ${JSON.stringify(out.providerSent)}`);
});

t('S4b. ⭐ the subscription opt-in no longer GATES Descriptions — every provider offered either way', () => {
  // Before 2026-07-19, Descriptions (eu-or-local) hid US providers and offered the subscription
  // ONLY under the §4g exemption. Now Descriptions is jurisdiction 'any', so the opt-in is
  // irrelevant to this row: with it OFF (the default probe, `out`) AND ON (PROBE=exempt) the
  // subscription and every other provider are offered. This is the regression guard that the
  // lifted limit did not quietly re-attach itself to the exemption flag.
  assert.equal(out.descriptionsOffersSubscription, true,
    `opt-in OFF: the subscription must still be offered (narrate is no longer §4g-sensitive). Got: ${JSON.stringify(out.descriptionsButtonLabels)}`);
  assert.equal(exempt.descriptionsOffersSubscription, true,
    `opt-in ON: the subscription must be offered too. Got: ${JSON.stringify(exempt.descriptionsButtonLabels)}`);
  // …and a plain US API key + a US lookalike are ALSO offered now — no client-side filtering.
  assert.ok(out.descriptionsButtonLabels.some((l) => /OpenAI \(US\)/.test(l)),
    `a plain US provider must now be offered for Descriptions. Got: ${JSON.stringify(out.descriptionsButtonLabels)}`);
  assert.ok(out.descriptionsButtonLabels.some((l) => /Ollama \(local\)/.test(l)),
    'and a genuine local provider is still offered');
});

t('S3. the recommendation is SELECTABLE, and "" is Off (the consent gate has an off-ramp)', () => {
  assert.ok(out.understandingHasSelect, 'Understanding needs a real control');
  // The bug that shipped once: "Recommended · qwen3.5:4b" carried value="", and "" means
  // UN-APPROVE — so the UI labelled the disable button "Recommended" and the one model the app
  // recommends was the one model it could not store.
  assert.ok(out.recommendationSelectable, 'the recommended model MUST be emittable, or the consent gate has no off-ramp');
  assert.ok(out.offOptionIsEmpty, '"" must be an explicit, labelled Off — declining is a supported choice, not an accident');
});

t('S4. ⭐ Descriptions offers EVERY provider (limit lifted 2026-07-19) and prints NO false-privacy copy', () => {
  // The inverse of what this gate used to assert. narrate left SENSITIVE_TASKS, so the router
  // runs Descriptions on the user's chosen provider (US included) — the screen must OFFER them
  // all. Offering US while the router refused it was the old "silent lie"; now HIDING US (and
  // re-printing "stays in the EU") would be the lie, because the router happily runs it.
  assert.equal(out.descriptionsOffersUS, true,
    `Descriptions must now offer a US provider — narrate is no longer §4g-sensitive, so the router runs it there. Got: ${JSON.stringify(out.descriptionsButtonLabels)}`);
  assert.equal(out.descriptionsOffersEU, true, 'and the EU recommendation is still offered (Regolo, the sovereign default)');
  assert.equal(out.descriptionsStatesLimit, false,
    'the "stay in the EU or on your device" limit copy must be GONE — the operator removed the limit, so printing it would be a false privacy statement');
  assert.equal(out.descriptionsPrintsDeadEnd, false,
    'and there is no "Connect an EU or on-device model" dead-end — every configured provider is offerable');
});

t('S5. ⭐ §3.10d-c — the BUNDLED embedder renders as "Included", never as a choice', () => {
  assert.ok(out.searchSaysIncluded, 'Search must say what is included and that it runs on-device');
  assert.equal(out.searchHasNoControl, true,
    'the embedder ships INSIDE the app: it cannot be declined or downloaded. A picker (or a pre-ticked box) would present a non-choice as consent — the dishonesty §3.10 exists to remove.');
});

t('S6. §3.11c — recommendation-FIRST: every card carries its reason', () => {
  assert.ok(out.everyCardHasWhy, 'a recommendation without a WHY is the raw dump QA item 11 names');
});

t('S7. ⭐ Understanding shows the WORSE of labeler+enricher — one approval, both must work', () => {
  // The fixture is labeler=ok, enricher=no_model. Showing "Labeling with qwen" over a vault
  // whose L2 is dead is EXACTLY the dormancy this round exists to end — and #164 added the
  // enricher member precisely so it could be seen. Mutating HEALTH_OF to ['labeler'] used to
  // leave S7 green (independent review, 2026-07-16); now it cannot.
  assert.match(String(out.understandingHealth || ''), /No enrich model approved/i,
    `Understanding must surface the WORSE member: with labeler=ok and enricher=no_model it must report the ENRICHER. Got: ${out.understandingHealth}`);
  // …and a CHOICE is still not a fault: "no model approved" is a legitimate steady state (§3.5).
  assert.ok(!/error|fail/i.test(String(out.understandingHealth || '')),
    `an unapproved model must read as status, never as an error. Got: ${out.understandingHealth}`);
});

// ── §5.2 anti-duplication: the invite HOSTS the screen, it does not re-implement it ─────
t('S8. ⭐ MindscapeInvite hosts THE screen and hand-rolls no second connect-AI', () => {
  // §3.11 is "ONE component, TWO hosts". Before this, MindscapeInvite carried a FOURTH
  // connect-AI — its own recommender, preset chips, cloud form — and it had NO §4g limit:
  // it offered `us-standard` for every function with an amber "US" pill. So the screen a
  // COLD USER ACTUALLY SEES could hand them a config where narrate is sensitive, the
  // provider is US, and the router then silently refuses (sensitive && /^us/ && !exempt).
  // Deleting it once is worth little; this fails if it grows back.
  const src = readFileSync('portal-app/src/lib/components/mindscape/MindscapeInvite.svelte', 'utf8');

  // ⚠️ STRIP COMMENTS PROPERLY — BLOCK comments included. The first version of this gate
  // filtered only lines STARTING with // or * or <!--, so a block-comment CONTINUATION line
  // survived. My own CSS comment — "…a cloud form that <IntelligenceScreen> now owns" —
  // satisfied the "is it rendered?" assert, and the gate went GREEN with the render commented
  // OUT. That is P6e verbatim: I wrote the warning about comment-satisfied gates INTO this
  // function and then shipped the bug three lines below it (mutation sweep, 2026-07-16).
  // Strip block comments as REGIONS, not as line prefixes.
  const code = src
    .replace(/<!--[\s\S]*?-->/g, '')   // html block comments (multi-line)
    .replace(/\/\*[\s\S]*?\*\//g, '')  // css/js block comments (multi-line)
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))  // line comments
    .join('\n');

  assert.ok(/import\s+IntelligenceScreen\s+from/.test(code), 'it must IMPORT the shared screen…');
  // Anchored to line-start: a real ELEMENT, not the token appearing in prose.
  assert.ok(/^\s*<IntelligenceScreen\b/m.test(code),
    '…and RENDER it as an element (an unrendered import is not a host, and a comment that '
    + 'mentions the component is not a render — this assert was satisfied by exactly that)');

  // ⭐ AND THE LADDER. This is the assert whose absence let a REAL regression ship: S8's first
  // version proved "the screen is hosted" and called that success, while the invite could not
  // connect an AI AT ALL. IntelligenceScreen's only writes are /providers/task-models
  // (ASSIGNMENT); AISettings owns the CONNECT ladder (POST /providers/models, the #133 Claude
  // flow). readiness.ai.connected means an ACTIVE PROVIDER ROW exists — so screen-only ⇒ four
  // rows point at a "Connect an AI" section that isn't there, no provider can be created, and
  // the Intelligence tick can never go green. Settings mounts BOTH (SettingsView :739 + :761);
  // a second host that mounts one is not a host, it is a dead end.
  assert.ok(/^\s*<AISettings\b/m.test(code),
    'MindscapeInvite renders <IntelligenceScreen> but NOT <AISettings> — so onboarding can '
    + 'ASSIGN models it can never CONNECT. The screen\'s copy says "Connect one under \'Connect '
    + 'an AI\' below"; without AISettings there is no below. Mount the PAIR Settings mounts, or '
    + 'move the ladder into the screen (§3.11) — but never ship the host without it.');

  // Assert the USAGE, not the identifier: a second connect-AI is defined by the ROUTES it calls.
  // ⚠️ HONEST SCOPE — this catches a re-implementation under new VARIABLE names, NOT under a
  // computed URL. A reviewer refuted the original claim ("any new variable names") by building
  // the URL as '/portal/' + 'providers' and walking straight through, VERDICT GO (2026-07-16).
  // A substring check over source cannot follow concatenation; claiming otherwise is the same
  // overclaim as the comment-satisfied assert above. This is a REGRESSION fence against the
  // lane coming back the way it left, not a proof of impossibility. The real guarantee is S8's
  // pair assert + code review.
  const FORBIDDEN = [
    ['/portal/providers', 'provider CRUD — the screen owns assignment, AISettings owns connect'],
    ['/portal/hardware/recommend', 'the hardware recommender'],
    ['/portal/hardware/pull', 'model pulling — consent lives in the screen (§3.10)'],
    ['/portal/providers/presets', 'the served spine'],
    ['/portal/providers/models', 'provider creation — the ladder AISettings owns'],
    ['/portal/auth/claude', 'the #133 Claude ladder — a connect flow by any other name'],
  ];
  for (const [route, why] of FORBIDDEN) {
    assert.ok(!code.includes(route),
      `MindscapeInvite calls ${route} (${why}) — that is a SECOND connect-AI growing back. `
      + 'Onboarding must host <IntelligenceScreen>, not re-derive it: the duplicate is how the '
      + '§4g limit reached Settings and missed the surface a new user actually sees.');
  }
});

// ── The stale-badge fix (2026-07-18), driven at its own timescale (PROBE=poll) ─────────────
// THE BUG: the screen read `?slices=models` once in onMount; approve()/assign() never
// refetched, so "Understanding → qwen3.5:4b" left the badge saying "No labeling model
// approved" until remount — the operator read that as "selecting the model doesn't work".
// The fixture is a phase machine (settled-unapproved → busy → settled-approved) advanced by
// the driver; the mount records every readiness URL, so these asserts count actual fetches.
let poll = {};
try {
  poll = JSON.parse(
    execFileSync('node', ['--conditions', 'browser', 'test/mount-intelligence-screen.mjs'],
      { cwd: 'portal-app', encoding: 'utf8', timeout: 120000, env: { ...process.env, PROBE: 'poll' } }).trim().split('\n').pop(),
  );
} catch (e) { poll = { error: String(e?.message || e) }; }
rec('S9a. the poll probe mounts', poll.ok === true, poll.error ? String(poll.error).slice(0, 200) : '');

t('S9. ⭐ approving REFETCHES the models slice — the badge reflects the write, not the mount snapshot', () => {
  const p = poll.poll || {};
  assert.equal(p.afterApprove - p.preApprove, 1,
    `a successful approve must buy exactly ONE immediate models refetch. Removing it re-ships the stale badge (mount-time snapshot forever). Got ${p.preApprove}→${p.afterApprove}`);
  assert.ok((p.urls || []).every((u) => /slices=models(&|$)/.test(u)),
    `every readiness fetch this screen makes must buy ONLY the models slice (SYNC, zero-DB — C1's priced set). Got: ${JSON.stringify(p.urls)}`);
});

t('S10. the poll TICKS while a member is busy — a live download is tracked, not frozen', () => {
  const p = poll.poll || {};
  assert.ok(p.afterBusyWindow - p.afterApprove >= 2,
    `with the labeler 'downloading', a ~5s window must see ≥2 poll ticks (2s cadence). Got ${p.afterApprove}→${p.afterBusyWindow}`);
});

t('S11. ⭐ the poll STOPS when everything settles — zero fetches across two windows (the COST gate)', () => {
  // Gates must assert COST, not shape (#200: a 4s poll ran 2,700 scans/hour past 300 gates).
  // The server side of this poll is priced by verify-readiness C1 (`models` ∈ POLLED, zero DB
  // touches); THIS pins the client side: the poll's interval only EXISTS while unsettled.
  const p = poll.poll || {};
  assert.equal(p.preApprove - p.afterMount, 0,
    `settled at mount ⇒ NO poll may start: a 2.5s window after mount must buy zero fetches. Got ${p.afterMount}→${p.preApprove}`);
  assert.equal(p.w2 - p.w1, 0,
    `once the fixture settles, two further would-be tick windows (~4.5s) must buy ZERO fetches — an unconditional/never-stop poll fails here. Got ${p.w1}→${p.w2}`);
});

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — the Intelligence screen: by function, from the served spine, approves by FUNCTION, offers every provider for Descriptions (§4g limit lifted), and never dresses a non-choice as consent' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

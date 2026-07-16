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

// The §4g EXEMPTION configuration, driven as its own mount (the opt-in is read at load).
let exempt = {};
try {
  exempt = JSON.parse(
    execFileSync('node', ['--conditions', 'browser', 'test/mount-intelligence-screen.mjs'],
      { cwd: 'portal-app', encoding: 'utf8', timeout: 120000, env: { ...process.env, PROBE: 'exempt' } }).trim().split('\n').pop(),
  );
} catch (e) { exempt = { error: String(e?.message || e) }; }
rec('S0b. the screen also mounts with §4g\'s subscription exemption ON', exempt.ok === true, exempt.error ? String(exempt.error).slice(0, 160) : '');

// The SOFT-FAIL configuration: the one read that decides the §4g guarantee returns 503.
let softfail = {};
try {
  softfail = JSON.parse(
    execFileSync('node', ['--conditions', 'browser', 'test/mount-intelligence-screen.mjs'],
      { cwd: 'portal-app', encoding: 'utf8', timeout: 120000, env: { ...process.env, PROBE: 'softfail' } }).trim().split('\n').pop(),
  );
} catch (e) { softfail = { error: String(e?.message || e) }; }
rec('S0c. the screen mounts when the §4g read FAILS (it must degrade, not crash)', softfail.ok === true, softfail.error ? String(softfail.error).slice(0, 160) : '');

// The ONLY configuration that reaches the dead-end: §4g read failed AND the vault's sole
// provider is the subscription. Without it, "no dead-end" asserts a branch that never runs —
// the fixture always had EU/local providers (independent review ×6, 2026-07-16).
let noeu = {};
try {
  noeu = JSON.parse(
    execFileSync('node', ['--conditions', 'browser', 'test/mount-intelligence-screen.mjs'],
      { cwd: 'portal-app', encoding: 'utf8', timeout: 120000, env: { ...process.env, PROBE: 'softfail-noeu' } }).trim().split('\n').pop(),
  );
} catch (e) { noeu = { error: String(e?.message || e) }; }
rec('S0d. …and mounts for a vault whose ONLY provider is the subscription', noeu.ok === true, noeu.error ? String(noeu.error).slice(0, 160) : '');

// The flag reads FINE and says not-exempt, and there is no EU/local provider: the ONE state
// where the dead-end is the TRUE thing to say. Without this, "no dead-end" was only ever
// asserted negatively — deleting the guidance entirely passed (independent review ×7).
let noeuKnown = {};
try {
  noeuKnown = JSON.parse(
    execFileSync('node', ['--conditions', 'browser', 'test/mount-intelligence-screen.mjs'],
      { cwd: 'portal-app', encoding: 'utf8', timeout: 120000, env: { ...process.env, PROBE: 'noeu-known' } }).trim().split('\n').pop(),
  );
} catch (e) { noeuKnown = { error: String(e?.message || e) }; }
rec('S0e. …and for a KNOWN not-exempt vault with no EU/local provider', noeuKnown.ok === true, noeuKnown.error ? String(noeuKnown.error).slice(0, 160) : '');

t('S1. every §3.11b function row renders — FROM THE SERVED SPINE, not a hardcoded list', () => {
  assert.equal(out.renderedKeys, 6,
    `all six rows must render (Conversation, Understanding, Descriptions, Search, Transcription, Voice) — got ${out.renderedKeys}: ${out.labels?.join(', ')}`);
  // A hardcoded taxonomy is map §5.2's bug (three implementations, each drifting). The screen
  // renders whatever /providers/presets serves; P10b pins that the route serves it intact.
  assert.ok(out.labels.includes('Understanding your messages') && out.labels.includes('Search'));
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

t('S4b. ⭐ §4g uses the SERVER\'s jurisdiction — a lookalike host is NOT offered as EU-safe', () => {
  // The first version classified providers client-side with an unanchored regex and offered
  // `https://localhost.attacker.io/v1` to a §4g-limited function — re-introducing, verbatim, the
  // anti-pattern presets.js:40-49 documents deleting. 9 of 13 URLs disagreed with the server.
  // The fixture carries that exact host; if the client ever guesses again, this fails.
  assert.ok(!out.descriptionsButtonLabels.some((l) => /Lookalike/i.test(l)),
    `a US host whose NAME contains "localhost" must not be offered to an eu-or-local function — ask the server, never substring the URL. Offered: ${JSON.stringify(out.descriptionsButtonLabels)}`);
  assert.ok(out.descriptionsButtonLabels.some((l) => /Ollama \(local\)/.test(l)),
    'and a genuine local provider must still be offered — the old regex hid real EU/local hosts too');
});

t('S4c. ⭐ §4g\'s EXEMPTION clause — the subscription is offered ONLY when opted in, and the copy says so', () => {
  // The router's rule is `sensitive && /^us/.test(jurisdiction) && !cfg.sensitiveUsExempt`.
  // Filtering on jurisdiction ALONE made this screen print "…stay in the EU or on your device"
  // over a vault where narrate DEMONSTRABLY ran on us-standard — a FALSE PRIVACY STATEMENT
  // (independent review ×2, 2026-07-16). Half the rule is not the rule.
  assert.equal(out.descriptionsOffersSubscription, false,
    `with the opt-in OFF the subscription is US and the router REFUSES it — it must not be offered. Got: ${JSON.stringify(out.descriptionsButtonLabels)}`);
  assert.equal(out.limitMentionsException, false, 'and with it off, the plain EU/on-device statement is the true one');
  // The exempt half runs as its own process (PROBE=exempt) — see below.
  assert.deepEqual(exempt.descriptionsButtonLabels.filter((l) => /Claude \(subscription\)/.test(l)), ['Claude (subscription)'],
    `with the opt-in ON the router DOES send narrate to the subscription, so hiding it would be a different lie. Got: ${JSON.stringify(exempt.descriptionsButtonLabels)}`);
  assert.ok(exempt.limitMentionsException,
    'and the copy must state the exception — claiming "EU or on your device" while narrate runs on US is the §3.11d silent lie, inverted');
  // Never a plain US API key, exactly as resolve.js applies the exemption.
  assert.ok(!exempt.descriptionsButtonLabels.some((l) => /OpenAI|Lookalike/.test(l)),
    `the exemption is SUBSCRIPTION-ONLY — a plain US API key must never be offered. Got: ${JSON.stringify(exempt.descriptionsButtonLabels)}`);
});

t('S4d. ⭐ flipping §4g LIVE re-renders the guarantee — the promise cannot go stale in-pane', () => {
  // THE REGRESSION THIS CATCHES WAS INTRODUCED BY THE FIX FOR ITS OWN PARENT BUG. The §4g toggle
  // lives in AISettings, mounted as a SIBLING in this same pane. While the flag was a private
  // onMount snapshot, flipping it twenty lines below left THIS screen printing "…stay in the EU
  // or on your device" while the router already sent narrate to us-standard — a false privacy
  // statement, one scroll away, no navigation (independent review ×3, 2026-07-16).
  //
  // The rule that generalises: "the server is the source of truth, so a stale display is ugly
  // but harmless" is TRUE of a model picker and FALSE here — HERE THE DISPLAY IS THE PROMISE.
  const { beforeFlip, afterFlip } = out.liveToggle;
  assert.equal(beforeFlip.descOffersSubscription, false, 'opt-in OFF: the subscription is US and the router refuses it');
  assert.equal(beforeFlip.saysException, false, 'opt-in OFF: the plain EU/on-device statement is the true one');
  assert.equal(afterFlip.descOffersSubscription, true,
    'after a LIVE flip the subscription must appear WITHOUT a remount — the router already honours it');
  assert.ok(afterFlip.saysException, 'and the copy must state the exception immediately');
  assert.equal(afterFlip.stillClaimsEuOnly, false,
    'and it must STOP claiming "EU or on your device" — that is the false privacy statement this whole gate exists to prevent');
});

t('S4e. ⭐ an UNVERIFIED §4g flag claims NOTHING — not the EU promise, not the exception', () => {
  // THE FIX FOR THIS WAS WRITTEN AND NEVER WIRED. The store carried a `loaded` flag whose own
  // doc said "consumers should not claim anything before then" — and nothing read it. Because
  // `allowed` defaults to false, an UNREAD flag was indistinguishable from "opted out", so the
  // screen printed "…stay in the EU or on your device" on an EXEMPT vault. Transient on first
  // paint; PERMANENT when the read soft-fails, because the setter never fired at all
  // (independent review ×4, 2026-07-16). A guarantee you have not verified must not be printed.
  assert.equal(softfail.claimsWhileUnknown.printsEuOnly, false,
    'with the §4g read FAILED the screen must NOT print the opt-in-OFF guarantee — it does not know it, and on this path it never will');
  // ⚠️ NO LYING SPINNER (§3.5, this component's own rule at the health line). With options
  // available the honest render is to OFFER them and SAY NOTHING about the limit. "Checking…"
  // belongs ONLY to the case where there is nothing to offer — anywhere else it claims work is
  // in flight when the read has already failed and nothing is retrying.
  // This line WAS a verbatim duplicate of the assertion five lines above (printsEuOnly, twice),
  // so the property half this fix's rationale rests on was pinned by NOTHING: re-adding the
  // spinner alongside the list left the gate GREEN (independent review ×7, 2026-07-16). I wrote
  // the comment, held the field, and asserted the wrong thing.
  assert.equal(softfail.claimsWhileUnknown.printsChecking, false,
    'with providers offerable, "Checking…" is a spinner claiming work that is NOT in flight — the read already failed and nothing retries. Offer the options and say nothing about the limit.');
  // …and it must not swing the other way either: no exception copy without knowing.
  // ⚠️ THE PREVIOUS VERSION OF THIS LINE WAS A TAUTOLOGY I WROTE:
  //     assert.ok(!/except…/.test(String(softfail.limitMentionsException ? 'x' : '')))
  // — it tested the regex against the literal 'x' or '', which it can never match, so it always
  // passed. A vacuous assertion, in the gate added to catch unverified claims. Assert the FIELD.
  assert.equal(softfail.claimsWhileUnknown.printsException, false,
    'nor may it assert the exception it has not verified');
  // ⭐ AND THE BEHAVIOUR — but ONLY the part that is actually false.
  // ⚠️ THIS ASSERTION USED TO SAY "a filtered list IS an assertion about §4g" and require ZERO
  // buttons. That reason was FALSE, and freezing it here made the correct, narrower fix a gate
  // regression — the gate itself carrying the overclaim (independent review ×6, 2026-07-16).
  // The truth: with the flag unknown the list is exactly {eu-zdr, local}, and the router allows
  // every one of those for narrate REGARDLESS of the exemption (it refuses only us-* AND
  // not-exempt). The exemption only ADDS the subscription. So the list is a sound
  // UNDER-approximation — fail-closed and useful — and demanding it be empty cost a real
  // capability: a single 503 froze this row forever, with no buttons, no assignment shown and no
  // retry, under a "Checking…" spinner that claimed work was in flight when none was.
  // What IS false while unknown is the dead-end: "Connect an EU or on-device model" is a lie to
  // an exempt vault whose subscription would qualify. Assert exactly that.
  // ⚠️ ASSERTED IN THE noeu CONFIG, not softfail: the dead-end only renders when offerable() is
  // EMPTY, and softfail's fixture has Regolo + Ollama — so asserting it there tested a branch
  // that never ran (independent review ×6). This is the vault the lie was written about.
  assert.equal(noeu.claimsWhileUnknown.printsDeadEnd, false,
    'with the §4g flag unknown and only a subscription connected, the screen must NOT say "Connect an EU or on-device model" — that subscription might already qualify, so it is telling the user to connect what they have');
  assert.ok(noeu.claimsWhileUnknown.printsChecking,
    'it must say it is still checking instead — an empty list with no explanation is its own dishonesty');
  // The eu-zdr/local options must STILL be offered: the router allows them either way, and
  // withholding them buys no honesty (the fixture has Regolo + Ollama).
  assert.ok(softfail.claimsWhileUnknown.descButtonCount > 0,
    `withholding eu-zdr/local providers while the flag is unknown costs capability and buys nothing — the router allows them regardless. Got ${softfail.claimsWhileUnknown.descButtonCount}`);
  // …and the subscription must NOT appear: THAT is the part the unknown flag genuinely gates.
  assert.ok(!softfail.claimsWhileUnknown.descButtonLabels.some((l) => /Claude \(subscription\)/.test(l)),
    `the subscription is the ONLY thing the exemption changes, so an unverified flag must not offer it. Got: ${JSON.stringify(softfail.claimsWhileUnknown.descButtonLabels)}`);
});

t('S4f. ⭐ when the §4g limit IS known and nothing qualifies, the screen says so — no silent dead row', () => {
  // The POSITIVE case. Every other probe asserts the dead-end must NOT appear; none reached the
  // state where it SHOULD, so deleting the guidance outright left the gate green — reinstating
  // exactly the dead row this work exists to prevent (independent review ×7, 2026-07-16).
  // Assert what must be there, not only what must not.
  assert.ok(noeuKnown.claimsWhileUnknown.printsDeadEnd,
    'flag known + not exempt + no EU/local provider ⇒ the user genuinely has nothing usable for Descriptions, and must be told where to fix it — an empty row with no explanation is its own dishonesty');
  assert.equal(noeuKnown.claimsWhileUnknown.printsChecking, false,
    'and it must NOT say "Checking…" — the flag IS known; that would be a spinner over a settled answer');
});

t('S3. the recommendation is SELECTABLE, and "" is Off (the consent gate has an off-ramp)', () => {
  assert.ok(out.understandingHasSelect, 'Understanding needs a real control');
  // The bug that shipped once: "Recommended · qwen3.5:4b" carried value="", and "" means
  // UN-APPROVE — so the UI labelled the disable button "Recommended" and the one model the app
  // recommends was the one model it could not store.
  assert.ok(out.recommendationSelectable, 'the recommended model MUST be emittable, or the consent gate has no off-ramp');
  assert.ok(out.offOptionIsEmpty, '"" must be an explicit, labelled Off — declining is a supported choice, not an accident');
});

t('S4. ⭐ §3.11d — an eu-or-local function does NOT offer a US provider, and says why', () => {
  assert.equal(out.descriptionsOffersUS, false,
    'Descriptions must not offer a US model: narrate is §4g-sensitive, the router REFUSES it, and something else runs. Offering a choice the system overrides is a silent lie.');
  assert.equal(out.descriptionsOffersEU, true, 'but an EU provider must still be offered — the limit is not "no cloud"');
  assert.ok(out.descriptionsStatesLimit, 'and the limit must state its REASON — hiding options unexplained is its own dishonesty');
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

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — the Intelligence screen: by function, from the served spine, approves by FUNCTION, §4g-limited, and never dresses a non-choice as consent' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);

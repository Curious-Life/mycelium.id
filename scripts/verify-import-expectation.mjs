// verify:import-expectation — §3.9/R2: the cost is stated BEFORE the user commits to an import.
//
// C7: the old copy was "Bring your data from other platforms into Mycelium" — which implies FREE.
// It isn't: embedding runs on the user's own CPU at ~40 messages a minute, so a large history is
// hours of a hot, awake Mac. §3.9's position is that a user who was told cannot be betrayed by the
// cost; a user who wasn't, is. This gate holds that promise to the ONE moment it can be kept — the
// last moment they can still decline.
//
//   R2a  the expectation renders on the REAL mounted view (not a grep of the source)
//   R2b  each CLAIM is present — locality, rate, wakefulness, pausability
//   R2c  the C7 framing ("runs in the background") has not crept back
//   R2d  the CONTROL: the harness can actually SEE text disappear
//
// ⚠️ MOUNTED, NOT GREPPED. The failure mode is that the copy stops being SHOWN — deleted, collapsed
// behind a disclosure, or wrapped in an `{#if}` false on a new user's path. A source-grep cannot
// tell any of those from a rendered paragraph, because `{#if false && …}` keeps every asserted
// string (verify-readiness MED-2, 2026-07-16).
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { execFileSync } from 'node:child_process';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

function mountText(env = {}) {
  const out = execFileSync('node', ['--conditions', 'browser', 'test/mount-import-view.mjs'], {
    cwd: 'portal-app', encoding: 'utf8', env: { ...process.env, ...env },
  });
  return JSON.parse(out);
}

let r;
try {
  r = mountText();
} catch (e) {
  console.log(`FAIL  R2a. the import view mounts\n      ${String(e?.message || e).slice(0, 300)}`);
  console.log('\n================================================================');
  console.log('VERDICT: NO-GO — the harness could not mount ImportView  EXIT=1');
  console.log('================================================================');
  process.exit(1);
}

rec('R2a. the expectation renders on the REAL mounted ImportView', r.mounted === true && r.text.length > 0,
  `mounted=${r.mounted}${r.error ? ` error=${r.error}` : ''} · ${r.text.length} chars of rendered text`);

// Assert the CLAIMS, not the sentence. Prose gets reworded; the promises must survive rewording —
// and each one is a fact the app now keeps, so each is falsifiable against the code.
// ⚠️ NO LITERAL NUMBER IS ASSERTED HERE, AND THAT IS THE FIX, NOT A GAP.
// This list used to contain /40 messages a minute/i — the design's figure. Two things were wrong
// with that, and the second is worse than the first:
//   1. THE NUMBER IS FALSE. Measured on an M1 (the FLOOR of supported hardware, shipped config,
//      real /batch endpoint): 313/min on a realistic chat mix — ~8x the design's ~40. The design's
//      own evidence table says so: A37 reads "rate never measured".
//   2. THE GATE ENFORCED IT. Correcting the copy to the truth made this gate RED, so the gate whose
//      whole contract is honesty mechanically defended the one clause that was dishonest. That is
//      PROJECTION vs PROPERTY: it asserted the FORM the honesty happened to take, not the honesty.
// The property is "the user is given a DURATION EXPECTATION they can act on" — and since the real
// rate varies 18x with message length (25/min for long messages, 466/min for short), any single
// number would be false for most users. The honest expectation is the SHAPE of the cost; the real
// number arrives from R1's live measurement once the work starts.
const claims = [
  ['locality (no cloud)', /on your device|no cloud/i],
  ['a duration expectation, in ANY honest form — never a hardcoded rate', /hours|overnight|days|minutes/i],
  ['it depends on the data (why no single number is honest)', /depend(s|ing) on (your messages|how long)/i],
  ['a real estimate is promised once it can be measured (R1)', /real estimate/i],
  // ⚠️ THE STAGE SCOPE — the claim that cost me two rounds. The copy priced EMBEDDING (313/min
  // measured ⇒ ~4h for 76k) and called it the whole import. It isn't: a user who takes the
  // RECOMMENDED local model also waits on L1 categorize (41/min ⇒ 31h) and L2 nlp (8/min ⇒ 153h)
  // — ~188 hours, ~8 days, versus the "couple of hours to overnight" the copy promised. The design
  // said so in C1 ("≈29 HOURS of embedding ALONE, before L1 + L2") and it was dropped from R2's
  // copy. So the copy must not describe reading as the whole cost.
  ['the LATER stages are disclosed, not just reading (the 20x understatement)', /tag and understand|takes considerably longer|runs afterwards/i],
  ['wakefulness (the Mac stays awake)', /stay awake|awake and busy/i],
  ['pausability — MADE TRUE by R3 (#202)', /pause\b[^.]{0,20}\bany time/i],
  ['resumability (picks up where it left off)', /picks up where it left off/i],
];
const missing = claims.filter(([, re]) => !re.test(r.text)).map(([n]) => n);
rec('R2b. every CLAIM is stated — locality · rate · duration · wakefulness · pause · resume',
  missing.length === 0, missing.length ? `MISSING: ${missing.join(' · ')}` : `all ${claims.length} present`);

// ⚠️ "runs in the background" is the EXACT C7 wording the design names as the lie: it implies free.
// This is a blocklist of ONE phrase and therefore weak by construction — R2b's claim list is the
// real assertion. It exists because that phrase is the specific thing a well-meaning edit reaches
// for when trimming "scary" copy.
rec('R2c. the C7 framing ("runs in the background") has not crept back',
  !/runs in the background/i.test(r.text), `text ${/runs in the background/i.test(r.text) ? 'CONTAINS it' : 'is clean'}`);

// ⚠️ THE CONTROL. Without it, R2a/R2b prove only that SOME text exists — a harness that always
// returned the whole file's strings would pass them just as happily. This asserts the harness can
// SEE a difference: a phrase that is NOT in the view must be absent. (P4a's lesson: a fixture that
// compares undefined to undefined passes everything.)
rec('R2d. CONTROL — the harness reports absence too (it is not just echoing the source)',
  !/this sentence is not in the import view/i.test(r.text) && /Start an import/i.test(r.text),
  `a phrase that is not in the view is absent, and a phrase that IS in it ("Start an import") is present`);

// ⚠️ R2e — THE GATE MUST REJECT THE DEFECT IT ONCE ENFORCED. A hardcoded "~N messages a minute" is
// false for ~everyone: the measured rate spans 25-466/min with message length, so any single figure
// misleads by up to 18x. The app already knows the real rate at the only moment it is real (R1's
// measured ETA), so the pre-import copy must describe the SHAPE of the cost, never assert a rate.
// This is the one blocklist worth having here, because the wrong version is the tempting one — it
// reads as precise and it shipped once.
// ⚠️ WIDENED, AND STILL A BLOCKLIST — SAID SO RATHER THAN OVERSOLD. The first version matched only
// `\d+ (messages|msgs) (a|per) (minute…)`, and a reviewer walked THREE of the five most natural
// spellings straight through it: "~40 msg/min", "about 40/min", "forty messages a minute". The PR
// body called it "no hardcoded rate may appear AT ALL", which was false — the gate caught the
// PRIOR wording and one neighbour. A blocklist cannot be complete over an open set of spellings
// (this repo's memory: assert the USAGE, not the FORM). R2b's property assertion is the real gate;
// this exists because "~N a minute" is the specific shape a well-meaning edit reaches for when it
// wants the copy to sound precise — and it shipped once.
const ratePattern = /\b(\d+|forty|thirty|fifty|sixty|hundred)\s*(m(sg|essage)s?)?\s*(a|per|\/)\s*(minute|min|second|sec|hour|hr)\b/i;
const hardcoded = r.text.match(ratePattern);
rec('R2e. no HARDCODED rate — the measured rate varies 18x with message length, so any single number lies',
  !hardcoded, hardcoded ? `FOUND: "${hardcoded[0]}" — the copy asserts a rate it cannot know before the import`
    : 'the copy describes the SHAPE of the cost; the real number comes from R1 once measured');

// ⚠️ R2f — ORDER, WHICH IS THE ENTIRE POINT AND WAS NEVER CHECKED. This gate's own verdict says
// "before the user can commit", and a reviewer moved the paragraph BELOW the source picker and the
// upload control — it still said GO. Presence in `body.textContent` says nothing about position;
// `textContent` is DOM order, so the check costs one indexOf. A cost disclosure under the button
// that spends it is not a disclosure. My verdict string was making a claim my assertions did not.
const iCopy = r.text.search(/no cloud/i);
const iCommit = r.text.search(/Start an import/i);
rec('R2f. the expectation comes BEFORE the source picker — a disclosure under the button is not one',
  iCopy >= 0 && iCommit >= 0 && iCopy < iCommit,
  `copy at char ${iCopy} · "Start an import" at char ${iCommit} · ${iCopy < iCommit ? 'copy is FIRST' : 'copy is AFTER the commit point'}`);

// ── R2g — THE DROP PATH DISCLOSES TOO (review HIGH-3: the identical import, zero copy) ──
// ImportDropZone is mounted once in the app layout and takes a file dropped ANYWHERE over the
// window into the same pipeline ImportView drives — so this was a way to start hours of on-device
// work having never seen the expectation copy, and the ImportView-only harness was structurally
// blind to it. The overlay renders WHILE DRAGGING (before the drop = this path's last moment to
// decline); the harness drives a real window drag with dataTransfer.types = ['Files'].
let dz;
try {
  dz = JSON.parse(execFileSync('node', ['--conditions', 'browser', 'test/mount-drop-zone.mjs'], {
    cwd: 'portal-app', encoding: 'utf8',
  }));
} catch (e) {
  dz = { mounted: false, error: String(e?.message || e).slice(0, 200) };
}
rec('R2g. a FILES drag shows the cost disclosure BEFORE the drop commits',
  dz.mounted === true && /hours of work on your Mac/i.test(dz.filesDrag || '') && /pause/i.test(dz.filesDrag || ''),
  `mounted=${dz.mounted}${dz.error ? ` error=${dz.error}` : ''} · filesDrag="${(dz.filesDrag || '').slice(0, 110)}…"`);

// The CONTROL, two ways: a text-only drag must show NOTHING (proves the harness sees absence and
// the overlay is genuinely drag-gated, not always-rendered), and the overlay must not be
// aria-hidden (the review's LOW: the drop path's ONLY disclosure was invisible to screen readers).
rec('R2g-control. a text-only drag shows NO overlay, and the disclosure is not aria-hidden',
  dz.textDrag === '' && dz.beforeDrag === '' && dz.overlayAriaHidden === null && dz.overlayRole === 'status',
  `textDrag="${dz.textDrag}" beforeDrag="${dz.beforeDrag}" role=${dz.overlayRole} aria-hidden=${dz.overlayAriaHidden}`);

const passed = ledger.filter(Boolean).length;
const failed = ledger.length - passed;
console.log('\n================================================================');
console.log(failed === 0
  ? 'VERDICT: GO — the cost of an import is stated, in full, before the user can commit  EXIT=0'
  : 'VERDICT: NO-GO — see FAIL rows  EXIT=1');
console.log('================================================================');
process.exit(failed === 0 ? 0 : 1);

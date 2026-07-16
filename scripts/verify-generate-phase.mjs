// verify:generate-phase — the client generate store's phase mapping, by RUNNING it.
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
// G1-G4 drive the REAL module (esbuild strips types; only `./api` is stubbed) rather than
// grepping it — a source grep is a projection, and projections have been satisfied by their
// own comments twice in this build.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

t('D2. ⭐ the outcome has a render SITE and a CTA to hang it on (source-level)', () => {
  // ⚠️ HONEST REACH, stated because a gate that overclaims is a false guarantee. This is a
  // SOURCE assert. It catches DELETION (the reviewer's M2 removed the button; it now FAILs) and
  // a missing render (M5). It CANNOT see REACHABILITY: dead-code the CTA —
  // `{#if false && anyUndescribed…}` — and D2 still PASSES (their M4), because "dead-coded" is
  // an OPEN SET (a literal false, an always-false var, an unreachable branch…) and no regex
  // closes an open set. That is the same trap that beat P6.
  // ⇒ The real proof is a MOUNT: compile MindscapeDetail, mount with phase:'up-to-date',
  // assert host.textContent. The pattern is already in-repo — portal-app/test/
  // mount-intelligence-screen.mjs. Filed, not pretended: see the PR's follow-ups.
  // ⚠️ THIS GATE EXISTS BECAUSE ITS ABSENCE LET THE SAME BUG SHIP TWICE. G1 proves the store
  // MAPS `skipped` to 'up-to-date'. It proves nothing about the USER, and the user is the whole
  // point: $generate had NO render site anywhere in the app, so both `error` and "already
  // built" were SILENCE — click, nothing, forever. An independent reviewer deleted the entire
  // Illuminate button and this suite still said GO (mutation M2, 2026-07-16): it gated the
  // store while the user-visible line went unchecked. My own design says it —
  // DISTILLATION-SURFACE-DESIGN §5.4: "Adding a state to a machine nobody displays fixes
  // nothing. representable ≠ shown."
  const src = readFileSync('portal-app/src/lib/components/mindscape/MindscapeDetail.svelte', 'utf8');

  // Strip comments as REGIONS, not line-prefixes: a block-comment continuation line survives a
  // prefix filter, and my own prose satisfied an assert exactly that way in verify:intelligence-screen.
  const code = src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  assert.ok(/\$generate\.phase\s*===\s*'up-to-date'/.test(code),
    "MindscapeDetail does not RENDER 'up-to-date'. The server says \"nothing to do\"; if no "
    + 'surface says it, the click is silence — which is the original bug wearing a new phase name.');
  assert.ok(/\{\$generate\.error\}/.test(code),
    'MindscapeDetail does not render $generate.error. An unrendered error is why "Illuminate '
    + 'does nothing" survived: the store knew, and nothing told the user.');
  // …and the surface those renders hang off must exist. M2 deleted the button and the suite
  // still passed; assert the CTA, not just the strings near it.
  assert.ok(/class="realm-cta illuminate"/.test(code),
    'the Illuminate CTA is gone — the renders above have no surface to appear on. A reviewer '
    + 'deleted this button and this gate said GO; that is what D2 is here to stop.');
});

const allPass = ledger.every(Boolean);
console.log(`\n${ledger.filter(Boolean).length}/${ledger.length} checks passed`);
console.log(`VERDICT: ${allPass ? "GO — the generate store: 'skipped' is a success, a malformed 200 is still an error" : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);

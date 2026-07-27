// verify:pipeline-attribution — when a pipeline stage fails, the report must name THAT stage.
//
// THE DEFECT (measured 2026-07-27; the pipeline-sprint design §2.4).
// run-clustering.sh emits three banners whose step token is not a bare integer — "Step 7b/16"
// (:194), "Step 9.5/16" (:218), "Step 10b/16" (:230). src/jobs.js parsed progress with
// `^Step (\d+)/(\d+)`, which matches NONE of them, so `state.step` stayed at the PREVIOUS numbered
// step for the whole of that stage's run. When one of the three failed, the failure was attributed
// to a different, HEALTHY stage:
//
//     embedding-trajectory (7b)  fails → "Step 7/16 (Compute Fisher trajectory) failed"
//     gravity              (9.5) fails → "Step 9/16 (Compute territory vitality) failed"
//     embedding-novelty    (10b) fails → "Step 10/16 (Lempel-Ziv complexity) failed"
//
// Three stages that, on failure, send whoever reads the message to the wrong file. This is the
// attribution half of the operator's "step 5/16 failed exit 1": the number is not trustworthy, so
// neither is any conclusion drawn from it.
//
//   A1  the parser matches EVERY banner run-clustering.sh actually emits — read out of the real
//       script, not a hardcoded list, so a banner added later is covered or this gate REDs
//   A2  a sub-step failure names ITSELF, not the numbered step before it
//   A3  classifyPipelineFailure stays CONTENT-FREE: it echoes a token only after finding it in
//       STAGE_LABELS, so an unknown/hostile token degrades to the constant 'pipeline failed'
//   A4  the progress ORDINAL is still an integer (7b → 7) — the bar must not regress while
//       identity moves to the token
//
// WHAT A GREEN VERDICT CLAIMS: the failure REPORT names the stage that failed. It claims nothing
// about whether any stage works — verify:pipeline-runs-through owns that.
//
// MUTATION-TESTED: restored the old `^Step\s+(\d+)\/(\d+)` regex → A1 REDs on all three sub-step
//   banners, and A2 REDs (7b attributed to step 7).
// MUTATION-TESTED: reported state.step instead of state.stepToken in the failure string → A2 REDs.
// MUTATION-TESTED: removed the STAGE_LABELS allowlist check from classifyPipelineFailure (echoing
//   the token unconditionally) → A3 REDs on the injected content-bearing token.
// MUTATION-TESTED: made stepOrdinal return the token verbatim → A4 REDs (bar ordinal non-integer).
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { readFileSync } from 'node:fs';
import { STEP_LINE_RE, stepOrdinal, classifyPipelineFailure } from '../src/jobs.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// ── A1: every banner the REAL script emits is parseable ──────────────────────
// Derived from run-clustering.sh itself. A hardcoded list would silently stop covering a banner
// someone adds later — the drift this whole sprint is about.
const sh = readFileSync('pipeline/run-clustering.sh', 'utf8');
const banners = [...sh.matchAll(/^echo "(Step [^"]+)"/gm)].map((m) => m[1]);
const unparsed = banners.filter((b) => !STEP_LINE_RE.test(b));
rec('A1. every "Step …" banner in run-clustering.sh is parseable by the progress parser',
  banners.length >= 16 && unparsed.length === 0,
  unparsed.length ? `${banners.length} banners, UNPARSED: ${unparsed.join(' · ')}`
    : `${banners.length} banners, all parse (incl. sub-steps ${banners.filter((b) => /Step \d+(\.\d+|[a-z])\//.test(b)).map((b) => b.match(/Step (\S+?)\//)[1]).join(', ')})`);

// ── A2: a sub-step names ITSELF ──────────────────────────────────────────────
// The three real sub-steps, with the numbered step each USED to be misattributed to.
const SUBSTEPS = [['7b', '7'], ['9.5', '9'], ['10b', '10']];
const misattributed = [];
for (const [token, blamed] of SUBSTEPS) {
  const line = `Step ${token}/16: something`;
  const m = STEP_LINE_RE.exec(line);
  const got = m?.[1] ?? null;
  if (got !== token) misattributed.push(`${token} → ${got === null ? 'UNMATCHED (stays at ' + blamed + ')' : got}`);
  // and the classified reason must carry the token, not the blamed integer
  const reason = classifyPipelineFailure({ failedStep: token, totalSteps: 16 });
  if (!reason.includes(`${token}/16`)) misattributed.push(`reason for ${token} = "${reason}"`);
}
rec('A2. a sub-step failure names ITSELF, not the numbered step before it',
  misattributed.length === 0,
  misattributed.length ? `MISATTRIBUTED: ${misattributed.join(' · ')}`
    : SUBSTEPS.map(([t]) => `${t}→${t}`).join(' · '));

// ── A3: the classified reason stays content-free ─────────────────────────────
// The feed row is content-free BY CONTRACT (db/activity-feed.js). The reason is built from a token
// + fixed literals, and the token is echoed ONLY after it is found in STAGE_LABELS. Anything else
// must degrade to the constant — otherwise a crafted stdout line could push text into the feed.
const HOSTILE = ['99', '4x', "1'; DROP TABLE", 'realm-name-leak', '', null, undefined, '__proto__', 'constructor'];
const leaked = HOSTILE.filter((t) => classifyPipelineFailure({ failedStep: t, totalSteps: 16 }) !== 'pipeline failed');
rec('A3. an unknown or hostile step token degrades to the constant (feed stays content-free)',
  leaked.length === 0,
  leaked.length ? `LEAKED: ${leaked.map((t) => `${JSON.stringify(t)} → "${classifyPipelineFailure({ failedStep: t, totalSteps: 16 })}"`).join(' · ')}`
    : `${HOSTILE.length} unknown/hostile tokens all → 'pipeline failed'`);

// ── A4: the progress ordinal is still an integer ─────────────────────────────
const ordinals = [['7b', 7], ['9.5', 9], ['10b', 10], ['16', 16]];
const badOrd = ordinals.filter(([t, want]) => stepOrdinal(t) !== want || !Number.isInteger(stepOrdinal(t)));
rec('A4. the progress ordinal stays an integer (the bar does not regress when identity moves to the token)',
  badOrd.length === 0,
  badOrd.length ? `WRONG: ${badOrd.map(([t, w]) => `${t} → ${stepOrdinal(t)} (want ${w})`).join(' · ')}`
    : ordinals.map(([t, w]) => `${t}→${w}`).join(' · '));

const allPass = ledger.every(Boolean);
console.log('');
console.log(allPass
  ? 'VERDICT: GO — every banner the pipeline emits is parseable, a sub-step failure names itself\n'
    + '        rather than the healthy stage before it, an unknown token cannot push text into the\n'
    + '        content-free feed, and the progress ordinal is still an integer.\n'
    + '        NOT PROVEN: that any stage works. verify:pipeline-runs-through owns that.'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(allPass ? 0 : 1);

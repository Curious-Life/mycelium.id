// verify:describe-surfaces — P8c. Three surfaces run "describe" jobs. Each says which one it is.
//
// THE DEFECT (operator, QA9): the mindscape's describe-ish controls were indistinguishable, and
// the confusion was real rather than cosmetic — they write DIFFERENT THINGS at DIFFERENT SCOPES:
//
//   surface                        job                    writes            scope
//   ─────────────────────────────  ─────────────────────  ────────────────  ──────────
//   pipeline `Describe` stage      BOTH of the below      names + prose     whole map
//   "Name your areas" card         describe-clusters.js   NAMES             whole map
//   per-area "Add more detail"     describe-chronicles.js PROSE (keeps      ONE area
//                                                         the name)
//
// A user looking at "Describe" and "Describe more" had no way to know that one of them would
// rename their areas and the other would refuse to. That is a consent-shaped ambiguity, not a
// wording nit: `describe-clusters` is the ONLY writer of realm/territory names.
//
// ⚠️ THE OBVIOUS FIX WAS WRONG AND THIS GATE ENCODES WHY. Renaming the pipeline row to "Name" —
// on the reasoning that describe-clusters is the sole name-writer — is a FALSE CLAIM: Step 3 of
// run-clustering.sh runs describe-clusters.js (:177) AND, conditionally, describe-chronicles.js
// (:185). The stage really does do both. D2 asserts that against the SCRIPT, so the day someone
// "simplifies" the label to Name, this REDs with the reason attached.
//
//   D1  the per-area control names its SCOPE and its OUTPUT, and states the preserve guarantee
//   D2  ⭐ the pipeline row does NOT claim to be the naming job — checked against run-clustering.sh,
//       which is the thing that decides what the stage actually does
//   D3  the stage declares what it PRODUCES, and producesText really returns it (driven, not grepped)
//   D4  the naming card still states ITS guarantee — the two guarantees are the pair that makes
//       the distinction legible; one without the other is half an answer
//   D5  the retired collision phrase "Describe more" is gone from the mindscape tree
//
// MUTATION-TESTED: reverted the button label to "Describe more" → D1 and D5 RED.
// MUTATION-TESTED: dropped the "Keeps its name." note from the per-area control → D1 REDs (the
//   label alone does not tell you whether your names survive).
// MUTATION-TESTED: renamed the pipeline stage label to 'Name' → D2 REDs, citing that Step 3 runs
//   both jobs. This is the tempting simplification and it is a lie about the stage.
// MUTATION-TESTED: emptied STAGE_PRODUCES.describe → D3 REDs.
// MUTATION-TESTED: made producesText return '' for every key while leaving the map populated
//   → D3 REDs (the map is data; the function is the behaviour — grepping the map would have
//   passed, which is the same substring-test trap verify:map-freshness F2 fell into first).
// MUTATION-TESTED: removed "Keeps every name you already have" from the naming card → D4 REDs.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { readFileSync, existsSync } from 'node:fs';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const stripComments = (s) => s
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const DETAIL = 'portal-app/src/lib/components/mindscape/MindscapeDetail.svelte';
const STATUS = 'portal-app/src/lib/components/mindscape/PipelineStatus.svelte';
const SCRIPT = 'pipeline/run-clustering.sh';

const detail = stripComments(read(DETAIL));
const status = stripComments(read(STATUS));

// ── D1: the per-area control names scope + output + the guarantee ───────────
{
  const label = /Add more detail/.test(detail);
  const busy = /Adding detail…/.test(detail);
  const note = /Writes more about this area\. Keeps its name\./.test(detail);
  rec('D1. the per-area control names what it writes, for ONE area, and that it keeps the name',
    label && busy && note, `label=${label} busyLabel=${busy} guarantee=${note}`);
}

// ── D2: ⭐ the pipeline row does not claim to be the naming job ─────────────
{
  const sh = read(SCRIPT);
  // The stage genuinely runs BOTH — assert that against the script, so the claim is anchored to
  // the thing that decides it rather than to this gate's memory of it.
  const runsClusters = /node pipeline\/describe-clusters\.js/.test(sh);
  const runsChronicles = /node pipeline\/describe-chronicles\.js/.test(sh);
  const bothInStep3 = runsClusters && runsChronicles;
  // Given both, the row must NOT be labelled as the naming job.
  const label = (status.match(/describe:\s*'([^']+)'/) || [])[1] || '';
  const honest = label === 'Describe';
  rec('D2. ⭐ the pipeline row does not claim to be the naming job — Step 3 runs BOTH jobs',
    bothInStep3 && honest,
    `script runs clusters=${runsClusters} chronicles=${runsChronicles} · row label=${JSON.stringify(label)}`);
}

// ── D3: the stage declares its output — DRIVEN ─────────────────────────────
{
  const { producesText, STAGE_PRODUCES } = await import('../portal-app/src/lib/stage-count.ts');
  const declared = producesText('describe');
  const other = producesText('embed');
  const missing = producesText(undefined);
  const wired = /producesText\(stage\.key\)/.test(status);
  rec('D3. the describe stage declares what it PRODUCES, and the function really returns it',
    declared === 'Names and descriptions' && STAGE_PRODUCES.describe === declared
      && other === '' && missing === '' && wired,
    `describe→${JSON.stringify(declared)} embed→${JSON.stringify(other)} wired=${wired}`);
}

// ── D4: the naming card still states ITS guarantee ─────────────────────────
// The two guarantees are a PAIR: "keeps every name you already have" (naming, gap-fill) beside
// "keeps its name" (chronicles, never writes names). Either alone leaves the other ambiguous.
{
  const keepsNames = /Keeps every name you already have/.test(detail);
  rec('D4. the naming card still states its own preserve guarantee — the pair is what disambiguates',
    keepsNames, `namingGuarantee=${keepsNames}`);
}

// ── D5: the colliding phrase is gone ───────────────────────────────────────
{
  const files = [DETAIL, STATUS];
  const offenders = files.filter((f) => /Describe more/.test(stripComments(read(f))));
  rec('D5. the colliding "Describe more" label survives nowhere in the mindscape tree',
    offenders.length === 0, offenders.length ? offenders.join(', ') : 'none');
}

const allPass = ledger.every(Boolean);
console.log('');
console.log(allPass
  ? 'VERDICT: GO — the three describe surfaces each state what they write and over what scope:\n'
    + '        the stage declares its output, the whole-map naming run promises to keep existing\n'
    + '        names, and the per-area control promises to keep the one it deepens. The row is NOT\n'
    + '        mislabelled as the naming job, asserted against run-clustering.sh itself.\n'
    + '        NOT PROVEN: that a user reads them as distinct — that is the operator QA pass.'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(allPass ? 0 : 1);

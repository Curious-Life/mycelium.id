#!/usr/bin/env node
/**
 * verify:defect-ledger — teeth for the defect-tracking discipline.
 *
 * WHY THIS GATE EXISTS
 * --------------------
 * the QA defect ledger is the permanent status record for every QA defect. Its whole value
 * is that it CANNOT quietly drift: sprint plans renumber defects every cycle (QA6 `P1.6` became
 * QA7 `P3.1` — same defect, second appearance, one failed fix in between, invisible in both
 * plans), and a status doc nobody checks is a status doc that lies.
 *
 * This gate asserts the MECHANICAL invariants only. It cannot judge whether a defect is genuinely
 * fixed — that is what the CLOSED bar (operator confirmation) is for. What it CAN do is make the
 * bookkeeping impossible to fake by accident:
 *
 *   L1  Every defect id is unique. Ids are permanent, so a duplicate means a renumber happened.
 *   L2  The scoreboard counts match the actual rows. A defect cannot be added to a section
 *       without the headline number moving — which is what makes the numbers worth reading.
 *   L3  No row in the CLOSED section has an empty evidence cell. "Closed" requires evidence.
 *   L4  Every D-id referenced by a sprint plan resolves to a real ledger row. Sprint plans
 *       reference status; they never invent it.
 *   L5  The CLOSED bar itself is still stated in the file. This is the one rule whose deletion
 *       would silently undo the discipline (QA6 closed the compute-crash item on "no crash
 *       observed yet" — absence of evidence — and it crashed the machine one release later).
 *
 * WHAT A GREEN VERDICT CLAIMS — exactly this, no more: the ledger's own bookkeeping is internally
 * consistent, its counts are honest, nothing is marked closed without written evidence, and no
 * sprint plan points at a defect that does not exist. It claims NOTHING about whether any defect
 * is actually fixed.
 */
// MUTATION-TESTED: D-011's id changed to D-010 (a renumber) → L1 REDs
// MUTATION-TESTED: "Escaped to a public release" scoreboard count 7 → 6 → L2 REDs
// MUTATION-TESTED: D-030's "fixed by" + "confirmed" cells blanked → L3 REDs
// MUTATION-TESTED: the QA7 plan repointed at a non-existent D-999 → L4 REDs
// MUTATION-TESTED: "operator confirmation" stripped from the ledger → L5 REDs
// All five were restored afterwards; the suite returns GREEN on the restored files.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DOCS = 'docs';
const LEDGER = join(DOCS, 'QA-DEFECT-LEDGER.md');

const fails = [];
const passes = [];
const check = (id, ok, detail) => (ok ? passes : fails).push(`${ok ? '  ✓' : '  ✗'} ${id} — ${detail}`);

// The QA defect ledger + sprint plans are DEV-INTERNAL — the public release scrub
// deletes them (they are not on the docs/ keep-list). On the derived PUBLIC tree the
// ledger is absent by design, so this gate has nothing to validate: SKIP, don't FATAL.
// (Guard-at-source, the verify-claude-sync.mjs pattern — a hand-patch of the public
// tree would be lost on the next re-derive. On DEV the ledger always exists, so this
// gate still runs in full: the guard only trips on the scrubbed tree.)
if (!existsSync(LEDGER)) {
  console.log(`SKIP verify:defect-ledger — ${LEDGER} absent (public/scrubbed tree; dev-internal gate).`);
  process.exit(0);
}

let src;
try {
  src = readFileSync(LEDGER, 'utf8');
} catch {
  console.error(`FATAL: ${LEDGER} is missing. The ledger is the permanent status record — it is not optional.`);
  process.exit(1);
}

const lines = src.split('\n');

// A defect row: a table row whose first cell is a bare id, optionally bolded.
const ROW = /^\|\s*\*{0,2}([DM]-\d{3})\*{0,2}\s*\|/;

// Section heading → the scoreboard label that must count it. A section with no scoreboard
// counterpart (e.g. "Reversed decisions") is still parsed for L1/L4 but exempt from L2.
const SECTIONS = [
  { match: /^###.*Recurring/,           score: 'Recurring (fixed, came back)' },
  { match: /^###.*Carried/,             score: 'Carried (never attempted)' },
  { match: /^###.*Escaped/,             score: 'Escaped to a public release' },
  { match: /^###.*Closed/,              score: 'Closed with evidence', closed: true },
  { match: /^###.*Merged, unconfirmed/, score: 'Merged-unconfirmed' },
  { match: /^###.*Reversed decisions/,  score: null },
  { match: /^##\s.*Meta-defects/,       score: 'Meta-defects open' },
  { match: /^##\s.*Scoreboard/,         score: null, stop: true },
];

// ── Parse ────────────────────────────────────────────────────────────────────
const bySection = new Map();   // scoreboard label (or null key) → rows
const allIds = [];
let current = null;
let stopped = false;

for (const line of lines) {
  const hit = SECTIONS.find((s) => s.match.test(line));
  if (hit) {
    if (hit.stop) { stopped = true; current = null; continue; }
    current = hit;
    if (!bySection.has(hit)) bySection.set(hit, []);
    continue;
  }
  if (stopped) continue;
  const m = ROW.exec(line);
  if (!m) continue;
  allIds.push(m[1]);
  if (current) bySection.get(current).push({ id: m[1], line });
}

// ── L1: ids are unique (a duplicate means a renumber) ────────────────────────
const seen = new Map();
const dupes = [];
for (const id of allIds) {
  seen.set(id, (seen.get(id) || 0) + 1);
  if (seen.get(id) === 2) dupes.push(id);
}
check('L1', dupes.length === 0 && allIds.length > 0,
  dupes.length ? `duplicate ids: ${dupes.join(', ')} — ids are PERMANENT; a duplicate means a defect was renumbered`
    : `${allIds.length} defect ids, all unique`);

// ── L2: scoreboard counts match the rows ─────────────────────────────────────
// Scoreboard row shape: | Recurring (fixed, came back) | **4** | ...
const scoreOf = (label) => {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\|\\s*${esc}\\s*\\|\\s*\\*{0,2}(\\d+)\\*{0,2}\\s*(?:\\((?:all )?[^)]*\\))?\\s*\\|`, 'm');
  const m = re.exec(src);
  return m ? Number(m[1]) : null;
};

let countedSections = 0;
for (const [sec, rows] of bySection) {
  if (!sec.score) continue;
  countedSections++;
  const claimed = scoreOf(sec.score);
  check(`L2·${sec.score}`, claimed === rows.length,
    claimed === null ? `no scoreboard row found for "${sec.score}"`
      : `scoreboard says ${claimed}, section has ${rows.length}`);
}
check('L2·coverage', countedSections >= 5,
  `${countedSections} sections reconciled against the scoreboard (expected >= 5)`);

// ── L3: nothing CLOSED without written evidence ──────────────────────────────
const closedSec = [...bySection.keys()].find((s) => s.closed);
const closedRows = closedSec ? bySection.get(closedSec) : [];
const evidenceless = closedRows.filter((r) => {
  // Cells: | id | defect | fixed by | confirmed |
  const cells = r.line.split('|').slice(1, -1).map((c) => c.trim());
  return cells.length < 4 || cells.slice(2).some((c) => c === '' || c === '—' || c === '-' || c === 'TBD');
});
check('L3', evidenceless.length === 0,
  evidenceless.length
    ? `CLOSED without evidence: ${evidenceless.map((r) => r.id).join(', ')} — CLOSED needs a fix AND a confirmation, never a blank`
    : `all ${closedRows.length} CLOSED row(s) carry both a fix and a confirmation`);

// ── L4: sprint-plan references resolve ───────────────────────────────────────
const known = new Set(allIds);
const planFiles = readdirSync(DOCS).filter((f) => /^QA.*SPRINT-PLAN.*\.md$/.test(f));
const dangling = [];
for (const f of planFiles) {
  const text = readFileSync(join(DOCS, f), 'utf8');
  for (const m of text.matchAll(/\b([DM]-\d{3})\b/g)) {
    if (!known.has(m[1])) dangling.push(`${f}:${m[1]}`);
  }
}
check('L4', dangling.length === 0,
  dangling.length ? `sprint plans reference unknown ids: ${[...new Set(dangling)].join(', ')}`
    : `${planFiles.length} sprint plan(s) scanned; every referenced id resolves`);

// ── L5: the CLOSED bar is still stated ───────────────────────────────────────
const hasBar = /merged PR/i.test(src) && /operator confirmation/i.test(src)
  && /absence of evidence/i.test(src);
check('L5', hasBar,
  hasBar ? 'the CLOSED bar (merged PR + failing gate + operator confirmation) and the absence-of-evidence rule are both stated'
    : 'the CLOSED bar or the absence-of-evidence rule has been removed from the ledger — that deletion silently undoes the discipline');

// ── Report ───────────────────────────────────────────────────────────────────
for (const p of passes) console.log(p);
for (const f of fails) console.log(f);
console.log('');
console.log(fails.length
  ? 'VERDICT: NO-GO'
  : 'VERDICT: GO — the defect ledger is internally consistent: ids are unique and therefore permanent,\n'
    + '        the scoreboard counts match the rows they summarize, nothing is marked CLOSED without\n'
    + '        written evidence, every sprint-plan reference resolves to a real defect, and the CLOSED\n'
    + '        bar is still stated in the file.\n'
    + '        NOT PROVEN: that any defect is actually fixed, that a status is honestly assigned, or that\n'
    + '        a recurrence counter was incremented when it should have been. Those are human judgement;\n'
    + '        this gate only makes the bookkeeping impossible to break by accident.');
process.exit(fails.length ? 1 : 0);

#!/usr/bin/env node
/**
 * verify:gate-teeth — every NEW gate must prove it can fail.
 *
 * WHY THIS GATE EXISTS
 * --------------------
 * `M-001` in the QA defect ledger: three gates were found green **for the wrong reason** in
 * a single session — one of them inside the very PR that was fixing the previous instance of that
 * pattern. `verify:provider-import` P13 asserted `!('taskModels' in settings)`, which held only
 * because the import had *destroyed* the vault's own value: it passed by observing the bug it was
 * written to catch. A passing gate actively suppresses suspicion, which is why several survived
 * multiple reviews.
 *
 * A gate that has never been run against the specific bug it claims to catch is an assertion about
 * a fixture, not evidence about the product. This gate makes that claim mandatory and reviewable
 * for every gate added from here on.
 *
 * THE RATCHET
 * -----------
 * 368 verify scripts predate this rule. Requiring a record on all of them at once would be a
 * pointless red, and back-filling 368 claims nobody verified would be *worse* than nothing — it
 * would manufacture exactly the false confidence M-001 is about. So:
 *
 *   • every script listed in `scripts/gate-teeth-baseline.json` is exempt (legacy, no record)
 *   • every script NOT listed must carry a MUTATION-TESTED record
 *   • the baseline may only ever SHRINK — a script that gains a record must leave it, and the
 *     list can never grow past its original size
 *
 * So a new gate cannot land without teeth, and each legacy gate that gets hardened is permanently
 * ratcheted in. Retiring baseline entries is ordinary, welcome work.
 *
 * THE RECORD
 * ----------
 * A comment block in the gate script:
 *
 *   // MUTATION-TESTED: <what was broken> → <which check REDs>
 *
 * One line per mutation, at least one per script. It states the mutation that was actually run and
 * confirmed to RED, then restored. Write it only if you ran it — an unverified record is the
 * M-001 failure with extra steps.
 *
 * WHAT A GREEN VERDICT CLAIMS — exactly this: no gate has been added without a written
 * mutation-test record, and the legacy exemption list has not grown. It CANNOT verify that a
 * recorded mutation was actually executed, or that it RED for the stated reason. That is human
 * judgement; this gate only forces the claim to be written down where a reviewer will see it.
 */
// MUTATION-TESTED: a new scripts/verify-*.mjs added with no record and no exemption → T1 REDs
//   (this gate demanded teeth of ITSELF before this line existed — that was the first T1 red)
// MUTATION-TESTED: maxSize lowered below the exemption count (ratchet raised) → T2 REDs
// MUTATION-TESTED: a MUTATION-TESTED line added to an exempt script (verify-handle.mjs) → T3 REDs
// MUTATION-TESTED: a non-existent filename pushed into the baseline → T4 REDs
// All four restored afterwards; the suite returns GREEN on the restored tree.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { readFileSync, existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = 'scripts';
const BASELINE = join(SCRIPTS, 'gate-teeth-baseline.json');
const RECORD = /^\s*\/\/\s*MUTATION-TESTED:\s*\S/m;

const fails = [];
const passes = [];
const check = (id, ok, detail) => (ok ? passes : fails).push(`${ok ? '  ✓' : '  ✗'} ${id} — ${detail}`);

if (!existsSync(BASELINE)) {
  console.error(`FATAL: ${BASELINE} is missing — the ratchet has no floor and every legacy gate would red.`);
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const exempt = new Set(baseline.exempt || []);

const all = readdirSync(SCRIPTS).filter((f) => /^verify-.*\.mjs$/.test(f)).sort();

// ── T1: no new gate without a record ─────────────────────────────────────────
const missing = all.filter((f) => !exempt.has(f) && !RECORD.test(readFileSync(join(SCRIPTS, f), 'utf8')));
check('T1', missing.length === 0,
  missing.length
    ? `gate(s) with no MUTATION-TESTED record and no legacy exemption: ${missing.join(', ')}\n`
      + `        Add "// MUTATION-TESTED: <what was broken> → <which check REDs>" after RUNNING the mutation.`
    : `${all.length - exempt.size} non-exempt gate(s), all carrying a mutation record`);

// ── T2: the ratchet only shrinks ─────────────────────────────────────────────
const maxSize = Number(baseline.maxSize);
check('T2', Number.isFinite(maxSize) && exempt.size <= maxSize,
  !Number.isFinite(maxSize) ? 'baseline has no numeric maxSize — the ratchet cannot be enforced'
    : `exemption list is ${exempt.size} of a permanent ceiling of ${maxSize}`
      + (exempt.size < maxSize ? ` (${maxSize - exempt.size} retired)` : ' — nothing retired yet'));

// ── T3: an exempt gate that gained a record must leave the list ──────────────
const stale = [...exempt].filter((f) => existsSync(join(SCRIPTS, f)) && RECORD.test(readFileSync(join(SCRIPTS, f), 'utf8')));
check('T3', stale.length === 0,
  stale.length ? `exempt but now carrying a record — remove from the baseline so the ratchet holds: ${stale.join(', ')}`
    : 'no exempt gate is silently carrying a record');

// ── T4: the baseline references only real files ──────────────────────────────
const ghosts = [...exempt].filter((f) => !existsSync(join(SCRIPTS, f)));
check('T4', ghosts.length === 0,
  ghosts.length ? `baseline names files that do not exist (rename or deletion left it stale): ${ghosts.join(', ')}`
    : `all ${exempt.size} baseline entries resolve to real scripts`);

for (const p of passes) console.log(p);
for (const f of fails) console.log(f);
console.log('');
console.log(fails.length
  ? 'VERDICT: NO-GO'
  : 'VERDICT: GO — no gate has been added without a written mutation-test record, the legacy exemption\n'
    + '        list has not grown, and no exempt gate is quietly carrying a record it should have been\n'
    + '        retired for.\n'
    + '        NOT PROVEN: that any recorded mutation was actually executed, or that it RED for the\n'
    + '        stated reason. This gate forces the claim to be written where a reviewer will see it;\n'
    + '        it cannot verify the claim. See M-001 in the QA defect ledger.');
process.exit(fails.length ? 1 : 0);

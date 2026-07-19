// scripts/verify-mindfile-history.mjs — character-page history primitives (design §5.2/§5.6).
//
// The character page shows "who your agent has been": a list of dated snapshots
// + a diff of what changed. Two net-new primitives back that:
//   - mind-files.listSnapshots(filename) — enumerate snapshot dates, newest first.
//   - diff.lineDiff(old, new) / diffStat(ops) — the "see what changed" op list.
//
// This gate is deliberately KEY-FREE: listSnapshots is pure directory listing
// (no decrypt), so we create dated snapshot files on disk directly and assert
// enumeration/ordering/filtering; lineDiff is pure. Encrypted round-trip +
// authorship + revert are covered downstream (verify:mindfiles, verify:character-rest).

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { createMindFiles } from '../src/mindfiles/mind-files.js';
import { lineDiff, diffStat, MAX_DIFF_LINES } from '../src/mindfiles/diff.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

const root = await mkdtemp(path.join(tmpdir(), 'mindhist-'));
try {
  const mf = createMindFiles({ agentRoot: root, agentId: 'personal-agent', fs: fsp, path });

  // ── H1: no history → [] (ENOENT is honest-empty, not a throw) ──────────────
  ok((await mf.listSnapshots('self.md')).length === 0, 'H1 absent history → []');

  // ── seed three dated snapshots + a decoy non-date file ─────────────────────
  const snapDir = path.join(root, 'mind', 'snapshots', 'self.md');
  await mkdir(snapDir, { recursive: true });
  await writeFile(path.join(snapDir, '2026-07-01.md'), 'v1');
  await writeFile(path.join(snapDir, '2026-07-15.md'), 'v2');
  await writeFile(path.join(snapDir, '2026-07-03.md'), 'v3');
  await writeFile(path.join(snapDir, 'notes.md'), 'not a date');       // must be ignored
  await writeFile(path.join(snapDir, '2026-07-99.txt'), 'wrong ext');  // must be ignored
  await writeFile(path.join(snapDir, '2026-13-45.md'), 'invalid date'); // impossible date — must be ignored
  await writeFile(path.join(snapDir, '2026-00-00.md'), 'zero date');    // impossible date — must be ignored

  const dates = await mf.listSnapshots('self.md');
  // ── H2: exactly the three VALID dated entries, NEWEST FIRST ────────────────
  //    (invalid-date + wrong-ext + non-date decoys all excluded).
  ok(JSON.stringify(dates) === JSON.stringify(['2026-07-15', '2026-07-03', '2026-07-01']),
    'H2 valid dates newest-first; invalid-date/ext/non-date filtered', JSON.stringify(dates));

  // ── H3: traversal guard is FALSIFIABLE — plant real escape targets that the
  //    guard must EXCLUDE. Without the guard, '../self.md' would readdir
  //    mind/self.md/ and 'snapshots/self.md' would readdir the nested dir,
  //    both surfacing a planted dated file. (P1 review: the old H3 passed with
  //    the guard deleted because no escape target existed.)
  const escapeParent = path.join(root, 'mind', 'self.md');            // reached by '../self.md'
  await mkdir(escapeParent, { recursive: true });
  await writeFile(path.join(escapeParent, '2099-01-01.md'), 'ESCAPED-parent');
  const escapeNested = path.join(root, 'mind', 'snapshots', 'snapshots', 'self.md'); // reached by 'snapshots/self.md'
  await mkdir(escapeNested, { recursive: true });
  await writeFile(path.join(escapeNested, '2099-01-02.md'), 'ESCAPED-nested');

  ok((await mf.listSnapshots('../self.md')).length === 0, 'H3 .. escape EXCLUDED (real target planted)');
  ok((await mf.listSnapshots('snapshots/self.md')).length === 0, 'H3 slash escape EXCLUDED (real target planted)');
  ok((await mf.listSnapshots('')).length === 0, 'H3 empty rejected');
  ok((await mf.listSnapshots('self\u0000.md')).length === 0, 'H3 NUL/control-char rejected (no throw)');

  // ── H4: a different file with no snapshots stays [] (per-file isolation) ────
  ok((await mf.listSnapshots('model.md')).length === 0, 'H4 sibling file → []');

  // ── H5: lineDiff op list — add/del/ctx correctly classified ────────────────
  const ops = lineDiff('alpha\nbeta\ngamma', 'alpha\nBETA\ngamma\ndelta');
  const shape = ops.map((o) => o.type).join(',');
  // alpha ctx, beta→BETA (del+add), gamma ctx, delta add
  ok(shape === 'ctx,del,add,ctx,add', 'H5 diff op classification', shape);
  const stat = diffStat(ops);
  ok(stat.added === 2 && stat.removed === 1 && stat.changed === true, 'H5b diffStat counts',
    JSON.stringify(stat));

  // ── H6: identical text → no change (CRLF normalized, not a false diff) ──────
  ok(diffStat(lineDiff('a\nb', 'a\r\nb')).changed === false, 'H6 CRLF-only ≠ change');
  ok(diffStat(lineDiff('same', 'same')).changed === false, 'H6b identical → unchanged');

  // ── H7: DoS BOUND — a within-write-policy but degenerate line count must NOT
  //    build the O(n²) LCS table (P1 review: a ~64k-newline self.md is a legal
  //    write and OOM'd the vault). Over MAX_DIFF_LINES ⇒ a single 'omitted' op,
  //    returned fast, never allocating gigabytes.
  const huge = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line ${i}`).join('\n');
  const t0 = Date.now();
  const hugeOps = lineDiff(huge, huge + '\nextra');
  const dtMs = Date.now() - t0;
  ok(hugeOps.length === 1 && hugeOps[0].type === 'omitted', 'H7 over-cap diff omitted (no LCS table)',
    JSON.stringify(hugeOps[0]?.type));
  ok(diffStat(hugeOps).omitted === true && diffStat(hugeOps).changed === true, 'H7b omitted ⇒ changed=true');
  ok(dtMs < 500, 'H7c over-cap diff returns fast (no OOM)', `${dtMs}ms`);
  // boundary: exactly MAX_DIFF_LINES still does a real LCS diff
  const atCap = Array.from({ length: MAX_DIFF_LINES }, (_, i) => `l${i}`).join('\n');
  ok(diffStat(lineDiff(atCap, atCap)).omitted === false, 'H7d at-cap still real-diffs');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
